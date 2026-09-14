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
 * Node timing, entirely in SQL: one pipeline producing one row per (kind, key),
 * with nothing timing-shaped crossing into JS during a load.
 *
 * **ARCHITECTURE.md, "Timing", is the reference** - why the pairing is join-free,
 * why occurrences are paired in timestamp order, and why `_dune_timing` has a
 * real primary key rather than being a `PERFETTO TABLE`.
 */

import type {Engine} from '../../../trace_processor/engine';
import {
  LONG,
  LONG_NULL,
  NUM,
  NUM_NULL,
} from '../../../trace_processor/query_result';
import {sqlValueToSqliteString} from '../../../trace_processor/sql_utils';
import type {SpanTiming} from '../model/graph';
import type {PerfRun} from '../perf';
import {measure} from '../perf';

// Which timing a row describes. `rule`/`dep` are the node's own span (keyed by
// `rule_id` / `dep_id`); `action` is a rule's `exec-rule-action` span, keyed by
// the same `rule_id`. `genrules`/`dyninc` are not nodes at all - they are keyed
// by a dict id (a directory, a `dune` file), which is why the `kind`
// discriminator matters: a `genrules` key and a dep's `orig_id` share an id
// space.
type TimingKind = 'rule' | 'dep' | 'action' | 'genrules' | 'dyninc';

// The lifecycle track each kind's instants live on. Append-only: see
// {@link KIND_CODES}.
const TRACK_BY_KIND: ReadonlyMap<TimingKind, string> = new Map([
  ['rule', 'exec-rule'],
  ['dep', 'build-dep'],
  ['action', 'exec-rule-action'],
  ['genrules', 'gen-rules'],
  ['dyninc', 'dynamic-includes'],
]);

// The integer code each kind is stored under in {@link TIMING_TABLE}: the
// table's key is (kind, key), and both halves being integers is what makes the
// probe a single b-tree descent. A kind's position in the map above *is* its
// code, so a kind may be appended there but not reordered.
const KIND_CODES: readonly TimingKind[] = [...TRACK_BY_KIND.keys()];

/**
 * The name {@link buildLifecycleTiming} measures itself under.
 *
 * Exported so sql_graph.ts can name the phase without repeating the string:
 * building the timing table is one of the node tier's phases, so it appears in
 * NODE_MIRROR_PHASES and is reported to `MirrorOptions.onProgress` from there,
 * and the drift test compares those ids against the recorded phase names.
 */
export const LIFECYCLE_TIMING_PHASE = 'lifecycle: pair in SQL';

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

// A plain `WITHOUT ROWID` table keyed on (kind, key), not a `PERFETTO TABLE`.
// **ARCHITECTURE.md, "Timing", has the measurements and the page budget** - including
// why this table is the first thing to give back if the edge tier ever gets
// tight again. `kind` is stored as a code (see {@link KIND_CODES}) so both
// halves of the key are integers and the probe is one b-tree descent.
// Intermediates, dropped as soon as the table above is built - `_dune_instant`
// and `_dune_seq` are one row per instant, which is the biggest thing this
// module ever holds.
const INSTANT_TABLE = '_dune_instant';
const SEQ_TABLE = '_dune_seq';
const PAIR_TABLE = '_dune_pair';

// A lifecycle instant's join key, as read back off a slice id (see
// {@link lifecycleKeysForSliceIds}). Exported because the controller branches
// on `kind` to decide what the key names - a node, or a directory.
export interface LifecycleKey {
  readonly kind: TimingKind;
  readonly key: number;
}

/**
 * Handle on the built timing table: the node mirror's views join it, and a
 * panel asks it for one node's timing at a time.
 */
interface SqlLifecycle extends AsyncDisposable {
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
// `dep_id` on the dep track, and a dict id on the other two - `dir_path_id` for
// `gen-rules`, `dune_file_path_id` for `dynamic-includes`. A given instant
// carries exactly one of the four, so they collapse into a single column.
const KEY_EXPR = `coalesce(
  extract_arg(s.arg_set_id, 'debug.dune.rule_id'),
  extract_arg(s.arg_set_id, 'debug.dune.dep_id'),
  extract_arg(s.arg_set_id, 'debug.dune.dir_path_id'),
  extract_arg(s.arg_set_id, 'debug.dune.dune_file_path_id'))`;

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

  const rowCount = await measure(perf, LIFECYCLE_TIMING_PHASE, async (p) => {
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
      //
      // Declared rather than `CREATE ... AS SELECT` so it can carry a real
      // primary key on (kind, key), which is the only thing that makes the
      // mirror's hottest join cheap - see the comment on the table above.
      await engine.query(`
        CREATE TABLE ${TIMING_TABLE}(
          kind INTEGER NOT NULL,
          key INTEGER NOT NULL,
          start_slice_id INTEGER,
          finish_slice_id INTEGER,
          dur_ns INTEGER,
          occurrence_count INTEGER NOT NULL,
          PRIMARY KEY (kind, key)
        ) WITHOUT ROWID
      `);
      await engine.query(`
        INSERT INTO ${TIMING_TABLE}
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
