// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Node timing, entirely in SQL.
 *
 * A graph node's timing comes from the lifecycle instants on the `exec-rule` /
 * `build-dep` / `exec-rule-action` tracks: a `-start` paired with its matching
 * `-finish`, or a single collapsed `-resolved`. That pairing used to happen in
 * JS, which meant shipping every instant into the UI - 2.4M rows on the perf
 * plan's monorepo trace, each with three `extract_arg` calls, plus a ~2.4M-entry
 * `Map` from slice id back to node. It is now one SQL pipeline that produces one
 * row per (kind, key), and nothing timing-shaped crosses into JS during a load
 * (see PERF_PLAN.LOCAL.md, stage 2).
 *
 * Measured on that trace, natively: **7.2 s of engine time and no measurable
 * increase in peak RSS** over loading the trace alone, producing 386,312 rule
 * rows with 127 null durations - exactly the blob's own rule count and its 127
 * `?` (unfinished) outcomes, so the SQL reproduces what the JS pairing did.
 *
 * The pairing is deliberately join-free: `-start` and `-finish` are matched by
 * numbering each phase's instants per key (`row_number()`) and then collapsing
 * the two rows of an occurrence with a `GROUP BY`. The self-join this replaces
 * is the same shape but ran for **223 s** on the monorepo trace, so the rewrite
 * is not a stylistic one.
 *
 * Same "pair in arrival order" heuristic as the JS it replaces: instants carry
 * no occurrence index, so a key seen more than once (watch mode, or a dep built
 * repeatedly) is paired in timestamp order. See the plugin's reported schema
 * gaps.
 */

import type {Engine} from '../../trace_processor/engine';
import {
  LONG,
  LONG_NULL,
  NUM,
  NUM_NULL,
} from '../../trace_processor/query_result';
import {sqlValueToSqliteString} from '../../trace_processor/sql_utils';
import type {SpanTiming} from './graph';
import type {PerfRun} from './perf';
import {measure} from './perf';

// Which timing a row describes. `rule`/`dep` are the node's own span (keyed by
// `rule_id` / `dep_id`); `action` is a rule's `exec-rule-action` span, keyed by
// the same `rule_id`.
export type TimingKind = 'rule' | 'dep' | 'action';

// The lifecycle track each kind's instants live on.
const TRACK_BY_KIND: ReadonlyMap<TimingKind, string> = new Map([
  ['rule', 'exec-rule'],
  ['dep', 'build-dep'],
  ['action', 'exec-rule-action'],
]);

// The integer code each kind is stored under in {@link TIMING_TABLE}: the
// table's key is (kind, key), and both halves being integers is what makes the
// probe a single b-tree descent. A kind's position in the map above *is* its
// code, so a kind may be appended there but not reordered.
const KIND_CODES: readonly TimingKind[] = [...TRACK_BY_KIND.keys()];

/**
 * The code {@link TIMING_TABLE} stores `kind` as. Exported because the node
 * mirror's views join the table and so have to write the same code (see
 * `timingJoin` in sql_graph.ts).
 */
export function timingKindCode(kind: TimingKind): number {
  return KIND_CODES.indexOf(kind);
}

// One row per (kind, key): the canonical (earliest) occurrence's slice ids and
// duration, plus how many occurrences were seen in total. Queried by
// `SqlLifecycle` and joined by the node mirror's views (see sql_graph.ts).
export const TIMING_TABLE = '_dune_timing';

/**
 * Why this is a `PERFETTO TABLE` and not a plain, indexed SQLite table, even
 * though a plain one answers the mirror's hottest join ~1,000× faster.
 *
 * Every read of this table is an equality lookup on (kind, key), and
 * `dune_node` joins it that way for every row it projects. A `PERFETTO TABLE`
 * serves that probe by *scanning the whole table per driving row*, at 94 µs a
 * probe natively (~205 µs in wasm); a `PERFETTO INDEX` on (kind, key) does not
 * change that, and neither does making `kind` an integer. On the monorepo
 * trace's 818k nodes that is 78 s to project `dune_node` once.
 *
 * The relation functions used to pay it twice per projected row (the timing of
 * both endpoints), which cost 31 s for `dune_children` on a 156k-child rule
 * whose walk itself takes under 0.1 s. They no longer read this table at all:
 * their endpoints are `node_id`s, so there is no slice to look up. `dune_node`
 * is the only caller left.
 *
 * Moving the table to `CREATE TABLE ... WITHOUT ROWID` with
 * `PRIMARY KEY (kind, key)` fixes exactly that: measured on the same trace, same
 * rows out, 818k probes drop from 77 s to 0.08 s and `dune_node` to 1.0 s (and,
 * at the time, that `dune_children` to 0.53 s). It was landed and then
 * **reverted**, because it
 * costs the edge tier more than it is worth:
 *
 * - The plain table is only 33.7 MB of SQLite pages (8,240 pages, ~28 B/row for
 *   1.2M rows) and adds **nothing** to the wasm heap when it is built - it lands
 *   inside the arena freed after the trace parse, exactly like the node tier.
 * - But it takes 33.7 MB *of that arena*, and on the monorepo trace the edge
 *   tier has no margin left: with the plain table, `CREATE INDEX _dune_edge_dst`
 *   over 28.7M rows fails with `database or disk is full` at a 4,125 MB heap,
 *   where the `PERFETTO TABLE` version finishes at 3,110 MB.
 * - It is not this table's shape that does it. Keeping the `PERFETTO TABLE` and
 *   adding a *dummy* rowid table holding the same 1.2M rows fails the same
 *   statement, at 3,110 MB. **Any** ~34 MB of extra SQLite pages present before
 *   the edge index is built is enough. The monorepo edge tier is at zero margin
 *   today, and that is the thing to fix before this table can be made fast.
 *
 * So the fast shape is a two-line change away and is known to work - see the
 * plan's write-up - but it needs headroom in the edge tier first. Do not re-land
 * it without re-running the wasm harness end to end on the monorepo trace.
 */
// Intermediates, dropped as soon as the table above is built - `_dune_instant`
// and `_dune_seq` are one row per instant, which is the biggest thing this
// module ever holds.
const INSTANT_TABLE = '_dune_instant';
const SEQ_TABLE = '_dune_seq';
const PAIR_TABLE = '_dune_pair';

// A lifecycle instant's join key, as read back off a slice id (see
// {@link lifecycleKeysForSliceIds}).
export interface LifecycleKey {
  readonly kind: TimingKind;
  readonly key: number;
}

/**
 * Handle on the built timing table: the node mirror's views join it, and a
 * panel asks it for one node's timing at a time.
 */
export interface SqlLifecycle extends AsyncDisposable {
  // How many (kind, key) rows the table holds.
  readonly rowCount: number;

  /**
   * The timing for `key` under each of `kinds`, in one query - a node's own
   * span and (for a rule) its action span are always wanted together. Kinds
   * with no matching row are simply absent from the result.
   */
  timings(
    key: number,
    kinds: readonly TimingKind[],
  ): Promise<Map<TimingKind, SpanTiming>>;
}

// The `CASE` mapping a lifecycle track name to its kind's stored code, shared by
// the pipeline and the reverse lookup so the two can't drift. Both sides read it
// back through {@link KIND_CODES}, so the code never surfaces outside SQL.
function kindExpr(trackCol: string): string {
  const arms = [...TRACK_BY_KIND].map(
    ([kind, track]) => `WHEN '${track}' THEN ${timingKindCode(kind)}`,
  );
  return `CASE ${trackCol} ${arms.join(' ')} END`;
}

// A kind read back off a SQL row, or undefined if the code isn't one we wrote.
function kindOfCode(code: number | null): TimingKind | undefined {
  return code === null ? undefined : KIND_CODES[code];
}

function trackList(): string {
  return [...TRACK_BY_KIND.values()].map((t) => `'${t}'`).join(', ');
}

// The join key of a lifecycle instant: `rule_id` on the rule/action tracks,
// `dep_id` on the dep track - only ever one of the two is set, so they collapse
// into a single column.
const KEY_EXPR = `coalesce(
  extract_arg(s.arg_set_id, 'debug.dune.rule_id'),
  extract_arg(s.arg_set_id, 'debug.dune.dep_id'))`;

/**
 * Builds {@link TIMING_TABLE} from the trace's lifecycle instants and returns a
 * handle that drops it when disposed. Rebuilding is idempotent: anything left
 * from a previous build is dropped first.
 */
export async function buildLifecycleTiming(
  engine: Engine,
  perf?: PerfRun,
): Promise<SqlLifecycle> {
  const dropIntermediates = async () => {
    for (const name of [PAIR_TABLE, SEQ_TABLE, INSTANT_TABLE]) {
      await engine.tryQuery(`DROP TABLE IF EXISTS ${name}`);
    }
  };

  const rowCount = await measure(perf, 'lifecycle: pair in SQL', async (p) => {
    await engine.tryQuery(`DROP TABLE IF EXISTS ${TIMING_TABLE}`);
    await dropIntermediates();
    try {
      // One row per lifecycle instant, tagged with the kind of timing it feeds
      // and its join key. `phase` 3 is an instant whose name matches none of
      // the three suffixes - dropped below, exactly as the JS pairing ignored
      // it, rather than being read as a collapsed span.
      await engine.query(`
        CREATE PERFETTO TABLE ${INSTANT_TABLE} AS
        SELECT s.id AS slice_id, s.ts AS ts,
          ${kindExpr('t.name')} AS kind,
          CASE
            WHEN s.name GLOB '*-start' THEN 0
            WHEN s.name GLOB '*-finish' THEN 1
            WHEN s.name GLOB '*-resolved' THEN 2
            ELSE 3 END AS phase,
          ${KEY_EXPR} AS key,
          extract_arg(s.arg_set_id, 'debug.dune.dur_ns') AS dur_ns
        FROM slice s JOIN track t ON s.track_id = t.id
        WHERE t.name IN (${trackList()})
      `);

      // Number each key's instants within its phase, so the Nth `-start` pairs
      // with the Nth `-finish`. `solo` keeps a `-resolved` instant (a span
      // collapsed to a point) in its own numbering: it is a whole occurrence by
      // itself and must not be merged into a start/finish pair's group below.
      await engine.query(`
        CREATE PERFETTO TABLE ${SEQ_TABLE} AS
        SELECT slice_id, ts, kind, key, phase, dur_ns,
          iif(phase = 2, 1, 0) AS solo,
          row_number() OVER (
            PARTITION BY kind, key, phase ORDER BY ts, slice_id) AS occ
        FROM ${INSTANT_TABLE}
        WHERE key IS NOT NULL AND phase < 3
      `);

      // Collapse each occurrence's rows into one. A start with no finish keeps
      // NULL slice/duration (an unfinished span, flushed at EOF); a finish with
      // no start is dropped by the HAVING, matching the JS pairing, which only
      // ever emitted an occurrence per start (or per resolved).
      await engine.query(`
        CREATE PERFETTO TABLE ${PAIR_TABLE} AS
        SELECT kind, key, solo, occ,
          min(iif(phase != 1, ts, NULL)) AS ts,
          min(iif(phase != 1, slice_id, NULL)) AS start_slice_id,
          min(iif(phase != 0, slice_id, NULL)) AS finish_slice_id,
          min(iif(phase != 0, dur_ns, NULL)) AS dur_ns
        FROM ${SEQ_TABLE}
        GROUP BY kind, key, solo, occ
        HAVING min(iif(phase != 1, ts, NULL)) IS NOT NULL
      `);

      // The node's canonical timing is its earliest occurrence, with the total
      // occurrence count alongside (the `×N` hint in the UI).
      await engine.query(`
        CREATE PERFETTO TABLE ${TIMING_TABLE} AS
        SELECT kind, key, start_slice_id, finish_slice_id, dur_ns,
          occurrence_count
        FROM (
          SELECT kind, key, ts, start_slice_id, finish_slice_id, dur_ns,
            count(*) OVER (PARTITION BY kind, key) AS occurrence_count,
            row_number() OVER (
              PARTITION BY kind, key ORDER BY ts, start_slice_id) AS rn
          FROM ${PAIR_TABLE}
        )
        WHERE rn = 1
      `);

      // Every read of this table is an equality lookup on (kind, key). This
      // index does *not* make a join probe against it cheap - see the comment on
      // the table above - but it does serve the single-key `timings()` lookup.
      await engine.query(
        `CREATE PERFETTO INDEX ${TIMING_TABLE}_key ` +
          `ON ${TIMING_TABLE}(kind, key)`,
      );
    } finally {
      // Free the per-instant intermediates whether or not the build finished.
      await dropIntermediates();
    }
    const count = await engine.query(
      `SELECT count(*) AS n FROM ${TIMING_TABLE}`,
    );
    const rows = count.firstRow({n: NUM}).n;
    p.rows(rows);
    return rows;
  });

  return {
    rowCount,

    async timings(
      key: number,
      kinds: readonly TimingKind[],
    ): Promise<Map<TimingKind, SpanTiming>> {
      const result = new Map<TimingKind, SpanTiming>();
      if (kinds.length === 0 || !Number.isFinite(key)) return result;
      const wanted = kinds.map((k) => timingKindCode(k)).join(', ');
      const rows = await engine.query(`
        SELECT kind, start_slice_id, finish_slice_id, dur_ns, occurrence_count
        FROM ${TIMING_TABLE}
        WHERE kind IN (${wanted}) AND key = ${Math.trunc(key)}
      `);
      const it = rows.iter({
        kind: NUM_NULL,
        start_slice_id: LONG_NULL,
        finish_slice_id: LONG_NULL,
        dur_ns: LONG_NULL,
        occurrence_count: LONG,
      });
      for (; it.valid(); it.next()) {
        const kind = kindOfCode(it.kind);
        if (kind === undefined) continue;
        result.set(kind, {
          startSliceId: numberOrUndefined(it.start_slice_id),
          finishSliceId: numberOrUndefined(it.finish_slice_id),
          durNs: numberOrUndefined(it.dur_ns),
          occurrenceCount: Number(it.occurrence_count),
        });
      }
      return result;
    },

    async [Symbol.asyncDispose](): Promise<void> {
      await engine.tryQuery(`DROP TABLE IF EXISTS ${TIMING_TABLE}`);
    },
  };
}

/**
 * The lifecycle key behind each of `sliceIds` - the reverse of the timing
 * table, i.e. "which node does this slice belong to". Reads `slice`/`track`
 * directly rather than the timing table, so (a) it resolves *every* occurrence
 * of a repeated key rather than only the canonical one, and (b) it needs no
 * table at all: a lookup by `slice.id` is a primary-key hit.
 *
 * Slice ids that aren't lifecycle instants (or whose key arg is missing) are
 * simply absent from the result.
 */
export async function lifecycleKeysForSliceIds(
  engine: Engine,
  sliceIds: readonly number[],
): Promise<Map<number, LifecycleKey>> {
  const keys = new Map<number, LifecycleKey>();
  if (sliceIds.length === 0) return keys;
  const result = await engine.query(`
    SELECT s.id AS slice_id, ${kindExpr('t.name')} AS kind, ${KEY_EXPR} AS key
    FROM slice s JOIN track t ON s.track_id = t.id
    WHERE s.id IN (${sqlValueToSqliteString(sliceIds)})
      AND t.name IN (${trackList()})
  `);
  const it = result.iter({slice_id: NUM, kind: NUM_NULL, key: LONG_NULL});
  for (; it.valid(); it.next()) {
    const kind = kindOfCode(it.kind);
    if (kind === undefined || it.key === null) continue;
    keys.set(it.slice_id, {kind, key: Number(it.key)});
  }
  return keys;
}

function numberOrUndefined(value: bigint | null): number | undefined {
  return value === null ? undefined : Number(value);
}
