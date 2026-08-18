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
 * Materializes the in-memory {@link BuildGraph} into Perfetto SQL tables so the
 * graph can be queried by relationship (e.g. distance between two nodes) in the
 * same SQL engine as the rest of the trace, and drives the distance query.
 *
 * **Two tiers.** The mirror is built in two independently-owned halves, because
 * their costs differ by orders of magnitude (see PERF_PLAN.LOCAL.md): the node
 * tier ({@link buildNodeMirror}) is one row per node plus its per-kind detail -
 * hundreds of thousands of rows on a monorepo-scale trace - while the edge tier
 * ({@link buildEdgeMirror}) is one row per *edge*, which on the same trace is
 * tens of millions. The node tier is what the side panel and the derived
 * timeline track need; the edge tier is what the relation functions and
 * `distances()` need. The edge tier reads `_dune_node` (its view joins both
 * endpoints), so it must be built after the node tier and disposed *before* it.
 *
 * **Every stored column is an integer.** The tables the rows are INSERTed into
 * hold ids, small codes and counts and nothing else; the text a query wants is
 * reconstituted by the PERFETTO VIEW over each of them, which is also where the
 * public column names and types live. Three mechanisms do that work, and they're
 * why the mirror fits in memory at monorepo scale:
 *
 * - **`dune_string(id, str)`** is the blob's intern table, copied in whole
 *   (663k rows / 57 MB on the monorepo trace). Every path the mirror mentions -
 *   a node's label, a rule's dir, a dep's path, a forcer's target - is a dict id
 *   joined against it rather than a repeated string, which is a ~2x saving over
 *   storing the text (the same path is referenced many times) and a feature in
 *   its own right: `SELECT * FROM dune_string WHERE str GLOB '*.cmi'`.
 * - **A node's kind is its id**, since the graph numbers rules `[0, ruleCount)`
 *   and deps `[ruleCount, nodeCount)` (see graph.ts). `ruleCount` is inlined into
 *   every generated statement, so no table and no edge row carries a kind column.
 * - **Codes, not words**: an outcome / resolution / `forced_by` kind is stored as
 *   its index in the corresponding list in graph.ts and mapped back by a CASE in
 *   the view.
 *
 * The mirror is split by kind rather than one wide table: `dune_node` carries
 * only what's meaningful for *every* node (identity, slice, forcing, timing);
 * `dune_rule` / `dune_dep` / `dune_rule_target` carry kind-specific detail,
 * keyed on the same `node_id`. This avoids NULL-heavy rule-only columns on
 * `dune_node` (e.g. an action duration) and columns whose meaning differs by
 * kind (a rule's cache-hit outcome vs. a dep's resolution). The detail tables
 * are keyed *on* `node_id` rather than reached via a foreign key column on
 * `dune_node`: `kind` already discriminates which detail table applies, so an
 * FK would be redundant, and every join is a plain `... USING (node_id)`.
 *
 * - `dune_node(node_id, node, kind, orig_id, slice_id, label, forced_by_kind,
 *   forced_by_target, ts, dur_ns, n_occurrences)` — one row per node, a typed
 *   PERFETTO VIEW over the raw `_dune_node` table the rows are inserted into,
 *   joined to the timing table (`lifecycle_sql.ts`) on (kind, orig_id).
 *   `node` and `slice_id` are both the node's primary lifecycle slice id as a
 *   `SliceTable::Id` (`JOINID(slice.id)`, LEFT JOINed since a node whose timing
 *   never resolved has none); `node` is the ergonomic column the query tab
 *   renders as a chip. `ts` is the slice's own timestamp; `dur_ns` the span's
 *   duration, NULL for an unfinished span; `n_occurrences` how many same-keyed
 *   spans were seen (>1 under watch mode, or for a dep built repeatedly).
 *   `forced_by_kind` / `forced_by_target` mirror the node's `forcedBy` (the
 *   target is the forcing rule id / dep path / dune-file path, or NULL).
 * - `dune_rule(node_id, rule_id, dir, outcome, action_slice_id,
 *   action_dur_ns, n_targets, n_static_deps, n_dyn_stages)` — one row per rule
 *   node, a view over `_dune_rule`. `outcome`: `executed` | `local-cache-hit` |
 *   `shared-cache-hit` | `unfinished`.
 * - `dune_dep(node_id, dep_id, path, resolution, resolved_rule_node_id,
 *   is_source)` — one row per dep node, a view over `_dune_dep`. `resolution`:
 *   `rule` | `source` | `expanded` | `unfinished`; `resolved_rule_node_id` is set
 *   iff `resolution = 'rule'` and that rule is itself a known node.
 * - `dune_rule_target(node_id, path, is_dir)` — a rule's output targets
 *   (`target_files`/`target_dirs`, each joined onto `dir` - see `joinDir` in
 *   graph.ts), one row per target. The one place the mirror still stores text:
 *   a target path is *constructed* (`dir` + a relative name) rather than
 *   interned, so it has no dict id, and it is the documented join key onto
 *   `dune_dep.path` - keeping it stored and indexed is what makes that join a
 *   444k-row index probe instead of a cross product. Write it deps-first
 *   (`FROM dune_dep d JOIN dune_rule_target t ON t.path = d.path`, 1.4 s on the
 *   monorepo trace): `USING (path)` lets SQLite drive from `dune_rule_target`
 *   instead, and since a dep's path comes out of a join to `dune_string` there
 *   is no index on that side to probe back with - that phrasing doesn't finish.
 *   A plain table, not a view: its only id-ish column is the synthetic
 *   `node_id`, which - unlike a real trace-processor table id - `JOINID` cannot
 *   apply to.
 * - `dune_string(id, str)` — the blob's intern table (see above). Also a plain
 *   table, for the same reason.
 * - `dune_edge(src, dst, forced, edge_kind, dyn_deps_stage, src_node_id,
 *   dst_node_id)` — a typed PERFETTO VIEW over the raw
 *   `_dune_edge(src, dst, flags)` table, with `src` / `dst` the endpoints'
 *   lifecycle slice ids (`JOINID(slice.id)`, chip-rendered, LEFT JOINed for the
 *   same reason as `dune_node`) and the raw node_id endpoints. Directed edges
 *   where "source depends on dest" (dest is the prerequisite / upstream node):
 *     rule -> dep  (`edge_kind`: static | dynamic, latter carries `dyn_deps_stage`)
 *     dep  -> rule (`edge_kind`: resolved)
 *     dep  -> dep  (`edge_kind`: expanded)
 *   `forced` is 1 iff `dest` was forced into the build by `source` (i.e. dest's
 *   `forcedBy` names source); see `isForcedEdge` in graph.ts. All three of
 *   `forced` / `edge_kind` / `dyn_deps_stage` are packed into the one `flags`
 *   integer (see {@link edgeFlags}), so an edge row is three integers - at 28M
 *   rows the difference between ~50 and ~160 bytes per row decides whether the
 *   tier can be built at all. The relation functions read the raw `_dune_edge` /
 *   `_dune_node` directly (they need the node_id endpoints, not the slice ids).
 * - `_dune_node_out(node_id, first_rowid, n)` — forward adjacency as a *rowid
 *   range*. The edge rows are inserted in node-id order, i.e. in exactly the
 *   order of the in-memory CSR, so a node's out-edges are contiguous and can be
 *   found by rowid instead of through an index on `src` (see {@link edgeStep}).
 *   An index on 28M rows costs ~1.1 GB; this table costs ~15 MB.
 *
 * `node_id` **is the in-memory graph's own node id** (see graph.ts): the graph
 * numbers its nodes densely from zero for exactly the reason the stdlib graph
 * macros want them to be, so the mirror inherits that numbering rather than
 * assigning a second one, and translating a node to a `node_id` and back is
 * arithmetic rather than a pair of 800k-entry maps. Every raw table is keyed by
 * it as an `INTEGER PRIMARY KEY`, i.e. as the rowid, so none of them needs a
 * `node_id` index either.
 *
 * `dune_node.orig_id` is the trace-side id (a dep's dict id, a rule's
 * `rule_id`), so it joins to the `dep_id` / `rule_id` args on the lifecycle
 * instants - and, for a dep, straight into `dune_string`. It is *not* the
 * display string: `label` is (a dep's resolved path, a rule's id), and it's what
 * the relation functions' `src_id`/`dst_id` report.
 *
 * It also defines a small library of transitive-relationship SQL functions -
 * see {@link createRelationFunctions} for the full inventory (bounded/unbounded
 * x forward/reverse x all-edges/forced-only, plus one-hop wrappers).
 */

import {sqliteString} from '../../base/string_utils';
import type {Engine} from '../../trace_processor/engine';
import {NUM} from '../../trace_processor/query_result';
import type {
  BuildGraph,
  EdgeKind,
  GraphEdge,
  NodeId,
  NodeTiming,
} from './graph';
import {DEP_RESOLUTIONS, FORCED_BY_KINDS, RULE_OUTCOMES, edges} from './graph';
import {
  TIMING_TABLE,
  buildLifecycleTiming,
  timingKindCode,
} from './lifecycle_sql';
import type {PerfRun} from './perf';
import {measure, measureSync} from './perf';

// `dune_node` / `dune_rule` / `dune_dep` / `dune_edge` are typed PERFETTO VIEWS
// (so slice-id columns are real SliceTable::Ids, the ergonomic `node` / `src` /
// `dst` chip columns exist, and the stored integer codes and dict ids read back
// as text) over the raw tables we actually INSERT the rows into - a CREATE
// PERFETTO TABLE/VIEW can't be chunk-inserted, and a plain CREATE TABLE can't
// express the column types. Internal queries (relation functions, distance) read
// the raw tables directly.
const NODE_TABLE = 'dune_node';
const RAW_NODE_TABLE = '_dune_node';
const RULE_TABLE = 'dune_rule';
const RAW_RULE_TABLE = '_dune_rule';
const DEP_TABLE = 'dune_dep';
const RAW_DEP_TABLE = '_dune_dep';
const EDGE_TABLE = 'dune_edge';
const RAW_EDGE_TABLE = '_dune_edge';
// Forward adjacency as rowid ranges over RAW_EDGE_TABLE (see the file header).
const OUT_TABLE = '_dune_node_out';
// The two tables with no view over them: their columns are already exactly what
// a query wants (see the file header).
const RULE_TARGET_TABLE = 'dune_rule_target';
const STRING_TABLE = 'dune_string';

/**
 * Rows per `INSERT ... VALUES (row), (row), ...`.
 *
 * This used to be 500, on the theory that a multi-row VALUES is a compound
 * SELECT and so bounded by SQLite's 500-term compound-SELECT limit. It isn't in
 * the SQLite trace processor ships: 100,000 rows in one statement inserts 100,000
 * rows.
 *
 * 5,000 is the measured optimum, though by a much smaller margin than the
 * numbers this comment used to quote (112 s / 17 s / 10 s for 8M rows at 500 /
 * 5,000 / 20,000): those came from `trace_processor -q`, whose own per-statement
 * cost dominated them. Over the RPC path the plugin actually uses, 2M rows take
 * 4.2 / 3.8 / 6.1 s in wasm at 500 / 5,000 / 20,000 (native 3.0 / 2.3 / 2.8), so
 * this is worth a third off the build, not 6×. It also keeps a statement to
 * roughly 110 KB of SQL text, which is what has to cross into wasm.
 */
const INSERT_CHUNK = 5_000;

// Statements between yields back to the event loop (and progress reports). The
// edge tier is thousands of statements and minutes long on a large graph;
// without a real macrotask yield in there the UI can't repaint and the load
// looks like a hang. 10 statements is 50k rows - often enough to keep the
// progress line moving, rare enough that the yields themselves are noise.
const YIELD_EVERY = 10;

/**
 * Edge counts the edge tier is built against, in rows.
 *
 * Below the soft cap the tier is built as part of a plain load; above it, it has
 * to be asked for; past the hard cap it refuses, because there the build doesn't
 * get slow, it takes the engine down with it.
 *
 * Both come from measurement (see PERF_PLAN.LOCAL.md), and both were revised
 * once the build was measured *in the wasm engine* rather than extrapolated from
 * `trace_processor -q`, which turns out to overstate the per-row cost by ~4×.
 * The monorepo trace's own 28.7M edges - the case the old 10M hard cap refused -
 * build in **57 s** and take the wasm heap from 1,468 MB to 3,010 MB
 * (**~54 bytes/row** marginal), against a 4 GB ceiling on the memory32 build and
 * 16 GB on the memory64 build every current browser loads
 * (`gn/standalone/wasm.gni`). So the hard cap is set above that measured point
 * with headroom: 40M rows is ~2.2 GB of edges, which fits alongside a
 * proportionally larger trace on memory64 and is the point past which even that
 * stops being true.
 *
 * The soft cap is unchanged and is about *time*, not memory: 2M rows is ~4 s, a
 * fine thing to do inside a load, where 28.7M is a minute and a half with the
 * reverse index and wants to be asked for.
 */
export const EDGE_SOFT_LIMIT = 2_000_000;
export const EDGE_HARD_LIMIT = 40_000_000;

/**
 * Edge count above which no index on `dst` is built.
 *
 * Forward walks never need one (they read the rowid ranges in `_dune_node_out`),
 * and neither does the unbounded reverse BFS in principle
 * (`graph_reachable_bfs!` reads the edge set once however it's shaped). Only
 * the *bounded* reverse walk - `dune_ancestors` / `dune_parents` - has to look
 * an edge up by `dst`.
 *
 * This used to be 2M, on an extrapolated ~1.1 GB for the index at 28M rows.
 * Measured in the wasm engine on the monorepo trace's 28.7M edges it is **27.5 s
 * and +101 MB** - 11× cheaper than the estimate - and it is what makes the
 * reverse direction usable at all: `dune_parents` on the most-depended node goes
 * from **39.8 s to 1.2 s**, and even `dune_all_ancestors`, which was supposed
 * not to care, halves (43.4 s to 19.1 s). So the two thresholds collapse into
 * one: if the edge tier is built at all, the index is built with it.
 *
 * The threshold and {@link SqlEdgeMirror.reverseIndexed} stay rather than being
 * deleted, because the index is still the first thing to give up if a graph ever
 * turns up that the edge tier itself fits but the index doesn't.
 */
export const REVERSE_INDEX_EDGE_LIMIT = EDGE_HARD_LIMIT;

// Stored code of an edge kind: its index in this list, packed into `flags`.
// Order is part of the encoding, so only ever append.
const EDGE_KIND_CODES: readonly EdgeKind[] = [
  'static',
  'dynamic',
  'resolved',
  'expanded',
];

// Directed dependency distance between two nodes, broken down by node kind.
// `total` is the number of hops on a shortest path; `dep`/`rule` are how many
// of the traversed nodes are deps / rules (so `total === dep + rule`). Counts
// path nodes excluding `fromId` - the same "anchor-relative" convention the
// relation functions below use.
export interface Distances {
  readonly total: number;
  readonly dep: number;
  readonly rule: number;
}

/**
 * How a build reports itself while it runs. Both tiers are long enough to need
 * one (the edge tier by minutes), and the inserts yield to the event loop
 * between batches so the report can actually be painted.
 */
export interface MirrorOptions {
  // Per-phase timing breakdown; see perf.ts.
  readonly perf?: PerfRun;

  // Called with a short human-readable description of where the build is up to,
  // at most once per YIELD_EVERY statements. Cleared by the caller when the
  // build ends.
  readonly onProgress?: (detail: string) => void;
}

/**
 * The cheap tier: `dune_node` + `dune_string` + the per-kind detail tables. Node
 * ids are the graph's own (see the file header), so there is nothing to
 * translate through.
 */
export interface SqlNodeMirror extends AsyncDisposable {
  // How many nodes were mirrored (== the `node_id` space's size).
  readonly nodeCount: number;

  // How many (kind, key) rows the timing table behind the mirror's `ts` /
  // `dur_ns` / `action_*` columns holds (see lifecycle_sql.ts).
  readonly timingRowCount: number;

  // The node's lifecycle timing, read on demand - timing is no longer carried
  // on the node (see lifecycle_sql.ts). One query per call, so this is for the
  // handful of nodes a panel is actually showing, not for a sweep.
  timingFor(id: NodeId): Promise<NodeTiming>;
}

/**
 * The expensive tier: `dune_edge` plus everything that walks it (the relation
 * functions and `distances()`). Built on top of - and disposed before - the
 * {@link SqlNodeMirror} its endpoints come from.
 */
export interface SqlEdgeMirror extends AsyncDisposable {
  // How many edges were mirrored.
  readonly edgeCount: number;

  // Whether `_dune_edge` is indexed by `dst`, i.e. whether the *bounded* reverse
  // walks (`dune_ancestors` / `dune_parents`) can look an edge up rather than
  // scanning for it. See REVERSE_INDEX_EDGE_LIMIT.
  readonly reverseIndexed: boolean;

  // Directed distances following build-dependency edges from `fromId` to
  // `toId`, or undefined if `toId` is unreachable from `fromId`.
  distances(fromId: number, toId: number): Promise<Distances | undefined>;
}

interface DroppableTable extends AsyncDisposable {
  readonly name: string;
}

/**
 * The node-id space the generated SQL is written against: how many nodes there
 * are, and where the rule/dep boundary falls in them. Both are inlined as
 * literals into every statement, which is what lets the mirror carry no `kind`
 * column anywhere (see the file header).
 */
interface NodeSpace {
  readonly ruleCount: number;
  readonly nodeCount: number;
}

function nodeSpace(graph: BuildGraph): NodeSpace {
  return {ruleCount: graph.ruleCount, nodeCount: graph.nodeCount};
}

// ---------------------------------------------------------------------------
// Expression fragments shared by the views and the relation functions.
// ---------------------------------------------------------------------------

// A node's kind, from its id alone (see graph.ts's id layout). `node` is an
// alias of `_dune_node`, or any relation carrying a `node_id`.
function kindExpr(node: string, space: NodeSpace): string {
  return `iif(${node}.node_id < ${space.ruleCount}, 'rule', 'dep')`;
}

// Ditto for a bare node-id expression (an `_dune_edge` endpoint, say).
function isRuleExpr(nodeId: string, space: NodeSpace): string {
  return `${nodeId} < ${space.ruleCount}`;
}

// The same kind, as the integer code the timing table is keyed by rather than
// the name the views expose (see lifecycle_sql.ts).
function timingKindExpr(node: string, space: NodeSpace): string {
  return `iif(${node}.node_id < ${space.ruleCount},
      ${timingKindCode('rule')}, ${timingKindCode('dep')})`;
}

// The LEFT JOIN {@link labelExpr} needs: a dep's label is its interned path, so
// only dep rows look anything up. `str` is the alias to bind `dune_string` to.
function labelJoin(node: string, str: string, space: NodeSpace): string {
  return `LEFT JOIN ${STRING_TABLE} ${str}
      ON ${node}.node_id >= ${space.ruleCount} AND ${str}.id = ${node}.orig_id`;
}

// A node's display label - a rule's bare id, a dep's interned path - matching
// `BuildGraph.labelOf`, `#<id>` fallback included (a dep whose dict id the blob
// never interned; a malformed blob, but visible rather than blank).
function labelExpr(node: string, str: string, space: NodeSpace): string {
  return `iif(${node}.node_id < ${space.ruleCount},
      cast(${node}.orig_id AS TEXT),
      coalesce(${str}.str, '#' || ${node}.orig_id))`;
}

// A CASE mapping a stored code column back to the text a view exposes:
// `values[i]` is the text for code `i + base`. Any other code (notably 0 for a
// `forced_by` kind that wasn't recorded) falls through to NULL.
function codeCase(col: string, values: readonly string[], base = 0): string {
  const arms = values.map((v, i) => `WHEN ${i + base} THEN '${v}'`);
  return `CASE ${col} ${arms.join(' ')} END`;
}

/**
 * SQL joining a `_dune_node` row (`node`) to the lifecycle slice its span
 * starts at, via the timing table. A node's slice id is no longer a column on
 * its row - it comes from this join (see lifecycle_sql.ts) - so every internal
 * query that wants one needs this, and every one of them also needs the slice
 * row itself, since `JOINID(slice.id)` only holds for a column read straight
 * off `slice`.
 *
 * `join` picks how a node with no timing behaves: `left` keeps it with a NULL
 * slice, `inner` drops it. Both cases existed before this and are preserved.
 *
 * This is the plugin's hottest join - the relation functions pay it twice per
 * projected row, and against a `PERFETTO TABLE` each probe is a scan of the
 * whole table, so a full `dune_node` projection on a monorepo-scale trace is
 * ~80 s. That is a known, measured cost with a known two-line fix that is *not*
 * currently affordable; see the comment on `TIMING_TABLE` in lifecycle_sql.ts
 * before touching either side of it. The `kind` side of the key is written here
 * as the integer code that table stores, not as the name the views expose.
 */
function timingJoin(
  node: string,
  timing: string,
  slice: string,
  join: 'inner' | 'left',
  space: NodeSpace,
): string {
  return `
      LEFT JOIN ${TIMING_TABLE} ${timing}
        ON ${timing}.kind = ${timingKindExpr(node, space)}
        AND ${timing}.key = ${node}.orig_id
      ${join === 'left' ? 'LEFT JOIN' : 'JOIN'} slice ${slice}
        ON ${slice}.id =
          coalesce(${timing}.start_slice_id, ${timing}.finish_slice_id)`;
}

// ---------------------------------------------------------------------------
// Inserting rows.
// ---------------------------------------------------------------------------

/**
 * A table's rows as SQL text, produced on demand: `rows()` yields one
 * `(v1, v2, …)` tuple per row and {@link materializeTable} batches them into
 * INSERT statements.
 *
 * Deliberately a generator rather than an array of row objects. The edge tier is
 * 28M rows on a monorepo-scale trace, and an array of 7-field objects for them
 * was multiple GB of JS heap *before a single row was inserted* - the largest
 * single item in the perf plan's baseline. Nothing here is ever materialized:
 * the text for one batch (see {@link INSERT_CHUNK}) is the most that exists at
 * once.
 *
 * `count` is what the row source expects to yield, used for the progress
 * report; the phase's own row count is what was actually inserted.
 */
interface RowSource {
  readonly count: number;
  rows(): Iterable<string>;
}

// A nullable integer as SQL text. Every column the mirror stores is an id, a
// code or a count, so this (plus `sqliteString` for the two text columns) is all
// the escaping the inserts need.
function int(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value)
    ? 'NULL'
    : String(Math.trunc(value));
}

// Hands the event loop back so a redraw can run mid-build. `engine.query` only
// awaits a promise, which keeps everything on the microtask queue - a load that
// never returns to the macrotask queue paints nothing for its whole duration.
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Create `name` with the given column schema and populate it from `source`
// (chunked inserts, see INSERT_CHUNK). Pre-drops so a rebuild is idempotent;
// the returned handle drops the table when disposed. A plain (non-PERFETTO)
// table is used so it can be INSERTed into and queried ad-hoc in the Query page.
async function materializeTable(
  engine: Engine,
  name: string,
  schema: string,
  columns: readonly string[],
  source: RowSource,
  opts: MirrorOptions,
): Promise<DroppableTable> {
  await measure(opts.perf, `sql: insert ${name}`, async (p) => {
    await engine.tryQuery(`DROP TABLE IF EXISTS ${name}`);
    await engine.query(`CREATE TABLE ${name} (${schema})`);
    const prefix = `INSERT INTO ${name} (${columns.join(', ')}) VALUES `;
    const batch: string[] = [];
    let inserted = 0;
    let statements = 0;
    let sqlChars = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      const sql = prefix + batch.join(', ');
      sqlChars += sql.length;
      statements++;
      inserted += batch.length;
      batch.length = 0;
      await engine.query(sql);
      if (statements % YIELD_EVERY === 0) {
        opts.onProgress?.(
          `${name}: ${inserted.toLocaleString()} of ` +
            `${source.count.toLocaleString()} rows`,
        );
        await yieldToUi();
      }
    };
    for (const row of source.rows()) {
      batch.push(row);
      if (batch.length >= INSERT_CHUNK) await flush();
    }
    await flush();
    p.rows(inserted);
    p.bytes(sqlChars);
    p.note(`${statements} statements`);
  });
  return {
    name,
    async [Symbol.asyncDispose](): Promise<void> {
      await engine.tryQuery(`DROP TABLE IF EXISTS ${name}`);
    },
  };
}

// ---------------------------------------------------------------------------
// The node tier.
// ---------------------------------------------------------------------------

function stringRows(graph: BuildGraph): RowSource {
  return {
    count: graph.stringCount,
    *rows(): Iterable<string> {
      for (const [id, str] of graph.strings()) {
        yield `(${id}, ${sqliteString(str)})`;
      }
    },
  };
}

function nodeRows(graph: BuildGraph): RowSource {
  return {
    count: graph.nodeCount,
    *rows(): Iterable<string> {
      for (let id = 0; id < graph.nodeCount; id++) {
        const target = int(graph.forcedByTargetIdOf(id));
        yield `(${id}, ${int(graph.traceIdOf(id))}, ${graph.forcedByCodeOf(id)}, ${target})`;
      }
    },
  };
}

function ruleRows(graph: BuildGraph): RowSource {
  return {
    count: graph.ruleCount,
    *rows(): Iterable<string> {
      for (let id = 0; id < graph.ruleCount; id++) {
        const counts =
          `${graph.targetCount(id)}, ${graph.staticDepCount(id)}, ` +
          `${graph.dynStageCount(id)}`;
        yield `(${id}, ${int(graph.dirStrIdOf(id))}, ${graph.outcomeCodeOf(id)}, ${counts})`;
      }
    },
  };
}

function depRows(graph: BuildGraph): RowSource {
  return {
    count: graph.depCount,
    *rows(): Iterable<string> {
      for (let id = graph.ruleCount; id < graph.nodeCount; id++) {
        const resolved = int(graph.resolvedRuleOf(id));
        yield `(${id}, ${graph.resolutionCodeOf(id)}, ${resolved})`;
      }
    },
  };
}

function ruleTargetRows(graph: BuildGraph): RowSource {
  let count = 0;
  for (let id = 0; id < graph.ruleCount; id++) count += graph.targetCount(id);
  return {
    count,
    *rows(): Iterable<string> {
      for (let id = 0; id < graph.ruleCount; id++) {
        for (const {path, isDir} of graph.ruleTargets(id)) {
          yield `(${id}, ${sqliteString(path)}, ${isDir ? 1 : 0})`;
        }
      }
    },
  };
}

/**
 * Builds the node tier of the mirror (`dune_string` / `dune_node` / `dune_rule`
 * / `dune_dep` / `dune_rule_target`, plus the timing table they join) from
 * `graph` and returns a handle that answers per-node timing and drops everything
 * it made when disposed. Rebuilding is idempotent: any pre-existing tables of
 * the same name are dropped first.
 *
 * The edges live in a separate, far more expensive tier - see
 * {@link buildEdgeMirror}.
 */
export async function buildNodeMirror(
  engine: Engine,
  graph: BuildGraph,
  opts: MirrorOptions = {},
): Promise<SqlNodeMirror> {
  const {perf} = opts;
  const space = nodeSpace(graph);

  // Drop the views up front, not just before their own CREATE: they join the
  // timing table, and the rebuild below replaces it. This only matters when a
  // previous build failed part-way and left them behind (a clean rebuild always
  // goes through the caller's dispose first), but then a stale view would make
  // the timing rebuild the confusing failure instead of this one.
  const dropViews = async () => {
    for (const view of [NODE_TABLE, RULE_TABLE, DEP_TABLE]) {
      await engine.tryQuery(`DROP VIEW IF EXISTS ${view}`);
    }
  };
  await dropViews();

  // Timing comes from SQL now, and the views join it, so it has to exist before
  // they're created (and be dropped after them - see the dispose below).
  const lifecycle = await buildLifecycleTiming(engine, perf);

  // The raw/plain tables (chunked inserts; pre-dropped for idempotent reload).
  // `node_id` / `id` are declared INTEGER PRIMARY KEY, i.e. they *are* the
  // rowid, so every lookup and join on them is already a primary-key hit and
  // none of these needs an index of its own.
  const stringTable = await materializeTable(
    engine,
    STRING_TABLE,
    'id INTEGER PRIMARY KEY, str TEXT',
    ['id', 'str'],
    stringRows(graph),
    opts,
  );
  const rawNodeTable = await materializeTable(
    engine,
    RAW_NODE_TABLE,
    'node_id INTEGER PRIMARY KEY, orig_id INTEGER, ' +
      'forced_by_kind INTEGER, forced_by_target_id INTEGER',
    ['node_id', 'orig_id', 'forced_by_kind', 'forced_by_target_id'],
    nodeRows(graph),
    opts,
  );
  const rawRuleTable = await materializeTable(
    engine,
    RAW_RULE_TABLE,
    'node_id INTEGER PRIMARY KEY, dir_str_id INTEGER, outcome INTEGER, ' +
      'n_targets INTEGER, n_static_deps INTEGER, n_dyn_stages INTEGER',
    [
      'node_id',
      'dir_str_id',
      'outcome',
      'n_targets',
      'n_static_deps',
      'n_dyn_stages',
    ],
    ruleRows(graph),
    opts,
  );
  const rawDepTable = await materializeTable(
    engine,
    RAW_DEP_TABLE,
    'node_id INTEGER PRIMARY KEY, resolution INTEGER, ' +
      'resolved_rule_node_id INTEGER',
    ['node_id', 'resolution', 'resolved_rule_node_id'],
    depRows(graph),
    opts,
  );
  const targets = ruleTargetRows(graph);
  const ruleTargetTable = await materializeTable(
    engine,
    RULE_TARGET_TABLE,
    'node_id INTEGER, path TEXT, is_dir INTEGER',
    ['node_id', 'path', 'is_dir'],
    targets,
    opts,
  );

  // The only detail table with a non-rowid key, and the only text the mirror
  // stores: `path` is indexed because joining a rule's targets onto
  // `dune_dep.path` (the documented "what build-dep is this output" query) is
  // otherwise a cross product. Plain (non-PERFETTO) indexes on a plain table;
  // dropped automatically when their table is dropped.
  await measure(perf, `sql: index ${RULE_TARGET_TABLE}`, async (p) => {
    await engine.query(
      `CREATE INDEX ${RULE_TARGET_TABLE}_node_id ` +
        `ON ${RULE_TARGET_TABLE}(node_id)`,
    );
    await engine.query(
      `CREATE INDEX ${RULE_TARGET_TABLE}_path ON ${RULE_TARGET_TABLE}(path)`,
    );
    p.rows(2 * targets.count);
  });

  // Typed views over the raw tables: this is where the stored integers become
  // the public schema again - dict ids resolve through `dune_string`, codes
  // through a CASE, a node's kind from which side of `ruleCount` its id falls,
  // and the slice-id columns (plus the ergonomic `node` chip column) become
  // SliceTable::Ids, which a plain CREATE TABLE can't declare. The id columns
  // are sourced as `slice.id` from a join (not a raw INTEGER col) so they
  // genuinely carry the id type - the same way the stdlib declares JOINID
  // columns.
  //
  // All three views pick up their timing by joining the timing table on
  // (kind, orig_id), so `slice_id` / `ts` / `dur_ns` / `n_occurrences` and a
  // rule's `action_*` are computed in SQL rather than inserted from JS. Every
  // join is LEFT: a node whose timing never resolved to a lifecycle instant
  // should still get a row (with NULLs) rather than vanish from the mirror, and
  // a cache-hit rule ran no action at all.
  await measure(perf, 'sql: create node views', async () => {
    // The `forced_by` target is a rule id for a RULE forcer (printed as-is) and
    // a dict id for every other kind that names anything (resolved through the
    // intern table) - so the join is skipped for RULE, whose payload would
    // otherwise collide with an unrelated dict entry.
    const ruleForcer = FORCED_BY_KINDS.indexOf('RULE') + 1;
    await engine.query(`
      CREATE PERFETTO VIEW ${NODE_TABLE}(
        node_id LONG,
        node JOINID(slice.id),
        kind STRING,
        orig_id LONG,
        slice_id JOINID(slice.id),
        label STRING,
        forced_by_kind STRING,
        forced_by_target STRING,
        ts LONG,
        dur_ns LONG,
        n_occurrences LONG
      ) AS
      SELECT n.node_id, s.id AS node, ${kindExpr('n', space)} AS kind,
        n.orig_id, s.id AS slice_id, ${labelExpr('n', 'ls', space)} AS label,
        ${codeCase('n.forced_by_kind', FORCED_BY_KINDS, 1)} AS forced_by_kind,
        CASE
          WHEN n.forced_by_target_id IS NULL THEN NULL
          WHEN n.forced_by_kind = ${ruleForcer}
            THEN cast(n.forced_by_target_id AS TEXT)
          ELSE coalesce(fs.str, '#' || n.forced_by_target_id)
        END AS forced_by_target,
        s.ts AS ts, t.dur_ns AS dur_ns, t.occurrence_count AS n_occurrences
      FROM ${RAW_NODE_TABLE} n
      ${labelJoin('n', 'ls', space)}
      LEFT JOIN ${STRING_TABLE} fs
        ON n.forced_by_kind != ${ruleForcer} AND fs.id = n.forced_by_target_id
      ${timingJoin('n', 't', 's', 'left', space)}
    `);
    await engine.query(`
      CREATE PERFETTO VIEW ${RULE_TABLE}(
        node_id LONG,
        rule_id LONG,
        dir STRING,
        outcome STRING,
        action_slice_id JOINID(slice.id),
        action_dur_ns LONG,
        n_targets LONG,
        n_static_deps LONG,
        n_dyn_stages LONG
      ) AS
      SELECT r.node_id, n.orig_id AS rule_id, ds.str AS dir,
        ${codeCase('r.outcome', RULE_OUTCOMES)} AS outcome,
        s.id AS action_slice_id, t.dur_ns AS action_dur_ns,
        r.n_targets, r.n_static_deps, r.n_dyn_stages
      FROM ${RAW_RULE_TABLE} r
      JOIN ${RAW_NODE_TABLE} n ON n.node_id = r.node_id
      LEFT JOIN ${STRING_TABLE} ds ON ds.id = r.dir_str_id
      LEFT JOIN ${TIMING_TABLE} t
        ON t.kind = ${timingKindCode('action')} AND t.key = n.orig_id
      LEFT JOIN slice s ON s.id = coalesce(t.start_slice_id, t.finish_slice_id)
    `);
    await engine.query(`
      CREATE PERFETTO VIEW ${DEP_TABLE}(
        node_id LONG,
        dep_id LONG,
        path STRING,
        resolution STRING,
        resolved_rule_node_id LONG,
        is_source LONG
      ) AS
      SELECT d.node_id, n.orig_id AS dep_id,
        coalesce(ps.str, '#' || n.orig_id) AS path,
        ${codeCase('d.resolution', DEP_RESOLUTIONS)} AS resolution,
        d.resolved_rule_node_id,
        iif(d.resolution = ${DEP_RESOLUTIONS.indexOf('source')}, 1, 0)
          AS is_source
      FROM ${RAW_DEP_TABLE} d
      JOIN ${RAW_NODE_TABLE} n ON n.node_id = d.node_id
      LEFT JOIN ${STRING_TABLE} ps ON ps.id = n.orig_id
    `);
  });

  return {
    nodeCount: graph.nodeCount,
    timingRowCount: lifecycle.rowCount,

    async timingFor(id: NodeId): Promise<NodeTiming> {
      if (!graph.has(id)) return {};
      const isRule = graph.isRule(id);
      // A rule wants its action span alongside its own, in one query; a dep has
      // no action.
      const kinds = isRule ? (['rule', 'action'] as const) : (['dep'] as const);
      const timings = await lifecycle.timings(graph.timingKeyOf(id), kinds);
      return {
        timing: timings.get(isRule ? 'rule' : 'dep'),
        actionTiming: timings.get('action'),
      };
    },

    async [Symbol.asyncDispose](): Promise<void> {
      await dropViews();
      await rawNodeTable[Symbol.asyncDispose]();
      await rawRuleTable[Symbol.asyncDispose]();
      await rawDepTable[Symbol.asyncDispose]();
      await ruleTargetTable[Symbol.asyncDispose]();
      // After the views, all three of which resolve strings through it.
      await stringTable[Symbol.asyncDispose]();
      // Last: the views above join it.
      await lifecycle[Symbol.asyncDispose]();
    },
  };
}

// ---------------------------------------------------------------------------
// The edge tier.
// ---------------------------------------------------------------------------

/**
 * An edge's `forced` flag, kind and dynamic-dep stage packed into one integer:
 * bit 0 is `forced`, bits 1-2 the {@link EDGE_KIND_CODES} index, the rest the
 * stage (meaningful only for a `dynamic` edge). Three integer columns instead of
 * seven mixed ones is the difference between ~50 and ~160 bytes per row, and at
 * 28M rows that decides whether the tier can be built at all.
 */
function edgeFlags(edge: GraphEdge): number {
  const kind = EDGE_KIND_CODES.indexOf(edge.edgeKind ?? 'static');
  return (
    (edge.forced ? 1 : 0) |
    (Math.max(kind, 0) << 1) |
    ((edge.dynDepsStage ?? 0) << 3)
  );
}

/**
 * Where each node's out-edges start in the edge table, as a running total: the
 * count of every *stored* edge (dangling references never reach SQL, so this is
 * not the in-memory CSR's own offset array) preceding node `id`'s run.
 * `offsets[nodeCount]` is therefore the total row count, and `offsets[id] + 1`
 * the rowid the node's first edge lands on - rows are inserted in this same node
 * order into a freshly created table, so SQLite's rowids run 1..N with it.
 */
function edgeOffsets(graph: BuildGraph): Int32Array {
  const offsets = new Int32Array(graph.nodeCount + 1);
  let total = 0;
  for (let id = 0; id < graph.nodeCount; id++) {
    offsets[id] = total;
    for (let i = graph.outStart(id); i < graph.outEnd(id); i++) {
      if (graph.outTarget(i) >= 0) total++;
    }
  }
  offsets[graph.nodeCount] = total;
  return offsets;
}

function edgeRows(graph: BuildGraph, count: number): RowSource {
  return {
    count,
    *rows(): Iterable<string> {
      for (const edge of edges(graph)) {
        yield `(${edge.source}, ${edge.dest}, ${edgeFlags(edge)})`;
      }
    },
  };
}

// One row per node that has any out-edges, mapping it to the rowid range of its
// run in the edge table (see {@link edgeOffsets}). Nodes with none are simply
// absent, which is exactly what a join against this wants.
function outRows(offsets: Int32Array): RowSource {
  const nodeCount = offsets.length - 1;
  let count = 0;
  for (let id = 0; id < nodeCount; id++) {
    if (offsets[id + 1] > offsets[id]) count++;
  }
  return {
    count,
    *rows(): Iterable<string> {
      for (let id = 0; id < nodeCount; id++) {
        const n = offsets[id + 1] - offsets[id];
        if (n > 0) yield `(${id}, ${offsets[id] + 1}, ${n})`;
      }
    },
  };
}

/**
 * Builds the edge tier of the mirror (`dune_edge` + the relation functions +
 * `distances()`) on top of an already-built {@link SqlNodeMirror}, whose
 * `node_id` space the edge endpoints live in.
 *
 * This is the expensive half - one row per edge, tens of millions of them on a
 * monorepo-scale trace (see PERF_PLAN.LOCAL.md) - so it is built as its own
 * step, and the caller decides when (or whether) to pay for it. Past
 * {@link EDGE_HARD_LIMIT} rows it refuses outright rather than taking the engine
 * down: there is no partial state to leave behind, since nothing has been
 * created yet at that point.
 *
 * Rebuilding is idempotent. The returned handle must be disposed *before* the
 * node mirror it was built against: its view joins `_dune_node`, and the
 * relation functions read it too.
 */
export async function buildEdgeMirror(
  engine: Engine,
  graph: BuildGraph,
  nodes: SqlNodeMirror,
  opts: MirrorOptions = {},
): Promise<SqlEdgeMirror> {
  const {perf} = opts;
  // The node-id space the generated statements are written against is the
  // *mirrored* one, which is where the endpoints have to exist.
  const space: NodeSpace = {
    ruleCount: graph.ruleCount,
    nodeCount: nodes.nodeCount,
  };

  // The offsets double as the exact row count, so the cap is checked against
  // what will really be inserted rather than against the CSR's slot count
  // (which includes references to nodes the blob never recorded).
  const offsets = measureSync(perf, 'sql: edge offsets', (p) => {
    const computed = edgeOffsets(graph);
    p.rows(computed[graph.nodeCount]);
    return computed;
  });
  const edgeCount = offsets[graph.nodeCount];
  if (edgeCount > EDGE_HARD_LIMIT) {
    throw new Error(
      `This graph has ${edgeCount.toLocaleString()} edges, past the ` +
        `${EDGE_HARD_LIMIT.toLocaleString()} the edge tables can be built ` +
        'for - materializing them would exhaust the trace processor heap and ' +
        'take the whole trace down with it. The graph itself, the node ' +
        'tables and the side panel all work without them.',
    );
  }

  // Drop the view first: it reads from the raw table materializeTable
  // recreates.
  await engine.tryQuery(`DROP VIEW IF EXISTS ${EDGE_TABLE}`);
  const rawEdgeTable = await materializeTable(
    engine,
    RAW_EDGE_TABLE,
    'src INTEGER, dst INTEGER, flags INTEGER',
    ['src', 'dst', 'flags'],
    edgeRows(graph, edgeCount),
    opts,
  );
  const outTable = await materializeTable(
    engine,
    OUT_TABLE,
    'node_id INTEGER PRIMARY KEY, first_rowid INTEGER, n INTEGER',
    ['node_id', 'first_rowid', 'n'],
    outRows(offsets),
    opts,
  );

  // Forward adjacency needs no index at all - `_dune_node_out` turns a node
  // into a rowid range over the edge table, which is stored in exactly that
  // order. Only the *bounded* reverse walk looks an edge up by `dst`, and that
  // index is affordable only on a small enough graph (see
  // REVERSE_INDEX_EDGE_LIMIT). Plain (non-PERFETTO) index on a plain table;
  // dropped automatically when the table is dropped.
  const reverseIndexed = edgeCount <= REVERSE_INDEX_EDGE_LIMIT;
  if (reverseIndexed) {
    await measure(perf, `sql: index ${RAW_EDGE_TABLE}`, async (p) => {
      await engine.query(
        `CREATE INDEX ${RAW_EDGE_TABLE}_dst ON ${RAW_EDGE_TABLE}(dst)`,
      );
      p.rows(edgeCount);
      p.note('dst');
    });
  }

  // Typed view over the raw edge table exposing `src` / `dst` as SliceTable::Ids
  // (chip-rendered node columns) plus the unpacked
  // `forced`/`edge_kind`/`dyn_deps_stage`, and the raw node_id endpoints
  // (`src_node_id` / `dst_node_id`, hidden by default in the query tab but handy
  // for joining back to `dune_node.node_id`). The graph macros read the raw
  // `_dune_edge` directly. LEFT JOINed to `slice` for the same reason as
  // `dune_node` above - the join to `_dune_node` itself stays INNER, since every
  // edge's endpoints are nodes in the node mirror.
  await measure(perf, 'sql: create edge view', async () => {
    const kindCode = '((e.flags >> 1) & 3)';
    await engine.query(`
      CREATE PERFETTO VIEW ${EDGE_TABLE}(
        src JOINID(slice.id),
        dst JOINID(slice.id),
        forced LONG,
        edge_kind STRING,
        dyn_deps_stage LONG,
        src_node_id LONG,
        dst_node_id LONG
      ) AS
      SELECT ss.id AS src, sd.id AS dst, (e.flags & 1) AS forced,
        ${codeCase(kindCode, EDGE_KIND_CODES)} AS edge_kind,
        iif(${kindCode} = ${EDGE_KIND_CODES.indexOf('dynamic')},
          e.flags >> 3, NULL) AS dyn_deps_stage,
        e.src AS src_node_id, e.dst AS dst_node_id
      FROM ${RAW_EDGE_TABLE} e
      JOIN ${RAW_NODE_TABLE} sn ON sn.node_id = e.src
      ${timingJoin('sn', 'st', 'ss', 'left', space)}
      JOIN ${RAW_NODE_TABLE} dn ON dn.node_id = e.dst
      ${timingJoin('dn', 'dt', 'sd', 'left', space)}
    `);
  });

  await measure(perf, 'sql: create relation functions', async () => {
    // graph_reachable_bfs! lives in this stdlib module.
    await engine.query('INCLUDE PERFETTO MODULE graphs.search');
    // Parameterized transitive-relationship functions + list-macro wrappers.
    await createRelationFunctions(engine, space);
  });

  return {
    edgeCount,
    reverseIndexed,

    async distances(
      fromId: number,
      toId: number,
    ): Promise<Distances | undefined> {
      const result = await engine.query(distanceQuery(fromId, toId, space));
      const row = result.firstRow({
        reachable: NUM,
        total: NUM,
        dep: NUM,
        rule: NUM,
      });
      if (row.reachable === 0) return undefined;
      return {total: row.total, dep: row.dep, rule: row.rule};
    },

    async [Symbol.asyncDispose](): Promise<void> {
      // Drop the relation function/macro vtabs first (a stale one left around
      // after the raw table is dropped fails opaquely - "no such table:
      // _dune_edge" - on the next ad-hoc query instead of cleanly), then the
      // view, then the raw tables they (or the query tab) read from.
      // Macros can't be dropped - there's no `DROP PERFETTO MACRO` - but
      // CREATE OR REPLACE on the next reload handles them.
      for (const {name} of RELATION_FUNCTIONS) {
        await engine.tryQuery(`DROP TABLE IF EXISTS ${name}`);
      }
      await engine.tryQuery(`DROP VIEW IF EXISTS ${EDGE_TABLE}`);
      await outTable[Symbol.asyncDispose]();
      await rawEdgeTable[Symbol.asyncDispose]();
    },
  };
}

// A directed walk direction: 'down' follows edges forward (descendants - what
// `node_id` depends on), 'up' follows them in reverse (ancestors - what
// depends on `node_id`).
type Direction = 'down' | 'up';

// Shared 11-column result shape for every relation function below. `src` is
// the depender (upstream), `dst` the prerequisite, regardless of which
// direction the function walks.
const RELATION_COLS = `
    src_node_id LONG, src_slice_id JOINID(slice.id), src_kind STRING, src_id STRING,
    dst_node_id LONG, dst_slice_id JOINID(slice.id), dst_kind STRING, dst_id STRING,
    distance LONG, rule_distance LONG, dep_distance LONG`;

// Every relation function, and the extra scalar args (beyond `node_id`) its
// `!` list-macro wrapper forwards. Also doubles as the drop-list on dispose.
const RELATION_FUNCTIONS: ReadonlyArray<{
  readonly name: string;
  readonly extraArgs: readonly string[];
}> = [
  {name: 'dune_descendants', extraArgs: ['max_steps', 'step_kind']},
  {name: 'dune_ancestors', extraArgs: ['max_steps', 'step_kind']},
  {name: 'dune_all_descendants', extraArgs: []},
  {name: 'dune_all_ancestors', extraArgs: []},
  {name: 'dune_children', extraArgs: []},
  {name: 'dune_parents', extraArgs: []},
  {name: 'dune_forcers', extraArgs: []},
  {name: 'dune_forced', extraArgs: []},
];

// The whole edge set for a directed walk, shaped the way `graph_reachable_bfs!`
// wants it: 'up' reverses the graph by swapping the endpoint columns. Only the
// unbounded fast path uses this - the BFS reads the edge set once and in full,
// so there is nothing an index or a rowid range could save it. `forcedOnly`
// restricts to forced edges (`dune_forcers` / `dune_forced`), so every row a
// caller gets back is forced by construction.
function edgeSet(dir: Direction, opts: {forcedOnly?: boolean} = {}): string {
  const where = opts.forcedOnly ? ' WHERE (flags & 1)' : '';
  return dir === 'down'
    ? `(SELECT src AS source_node_id, dst AS dest_node_id
        FROM ${RAW_EDGE_TABLE}${where})`
    : `(SELECT dst AS source_node_id, src AS dest_node_id
        FROM ${RAW_EDGE_TABLE}${where})`;
}

/**
 * Joins `_dune_edge e` to the edges leaving `source` (a node-id expression) in
 * direction `dir`, and names the endpoint column the edge lands on.
 *
 * This is where the edge tier's "no index on the endpoints" design lands. A
 * 'down' step reads the CSR the table is *stored* in: `_dune_node_out` turns a
 * node into the contiguous rowid range of its out-edges, so the lookup is a
 * rowid range scan and no index on `src` exists. An 'up' step has to find rows
 * by `dst`, which is indexed only below {@link REVERSE_INDEX_EDGE_LIMIT}; above
 * it, the two functions that take one (`dune_ancestors` / `dune_parents`) scan
 * per hop and `dune_all_ancestors` is the fast answer instead.
 */
function edgeStep(
  dir: Direction,
  source: string,
  opts: {forcedOnly?: boolean} = {},
): {readonly join: string; readonly dest: string} {
  const forced = opts.forcedOnly ? ' AND (e.flags & 1)' : '';
  if (dir === 'down') {
    return {
      join: `JOIN ${OUT_TABLE} o ON o.node_id = ${source}
        JOIN ${RAW_EDGE_TABLE} e
          ON e.rowid >= o.first_rowid
          AND e.rowid < o.first_rowid + o.n${forced}`,
      dest: 'e.dst',
    };
  }
  return {
    join: `JOIN ${RAW_EDGE_TABLE} e ON e.dst = ${source}${forced}`,
    dest: 'e.src',
  };
}

// The value `step_kind` selects as the walk's step-budget counter: every hop
// (`distance`) when NULL, else only hops landing on that kind. `prefix` lets
// the same expression be written against a correlated row alias (e.g. `s.`)
// inside the recursive term, or bare column names in a plain SELECT outside it.
function countedExpr(prefix: string): string {
  return `CASE $step_kind
        WHEN 'dep' THEN ${prefix}dep_distance
        WHEN 'rule' THEN ${prefix}rule_distance
        ELSE ${prefix}distance END`;
}

// Projects a `walk(node_id, distance, rule_distance, dep_distance)` CTE (one
// row per reached node) into the shared 11-column relation shape, placing the
// anchor (`param`) on the correct side - `src` for a 'down' walk (anchor is the
// depender), `dst` for an 'up' walk (anchor is the prerequisite) - and
// excluding the anchor itself (`distance > 0`) from the result.
function relationProjection(
  dir: Direction,
  param: string,
  space: NodeSpace,
): string {
  // The walked node (`wn`, joined via the `walk` CTE) and the anchor (`a`), each
  // needing its kind and label reconstituted from its id and the intern table.
  const walkedKind = kindExpr('wn', space);
  const walkedLabel = labelExpr('wn', 'wl', space);
  const anchorKind = kindExpr('a', space);
  const anchorLabel = labelExpr('a', 'al', space);
  const cols =
    dir === 'down'
      ? `a.node_id AS src_node_id, sa.id AS src_slice_id,
      ${anchorKind} AS src_kind, ${anchorLabel} AS src_id,
      w.node_id AS dst_node_id, sw.id AS dst_slice_id,
      ${walkedKind} AS dst_kind, ${walkedLabel} AS dst_id`
      : `w.node_id AS src_node_id, sw.id AS src_slice_id,
      ${walkedKind} AS src_kind, ${walkedLabel} AS src_id,
      a.node_id AS dst_node_id, sa.id AS dst_slice_id,
      ${anchorKind} AS dst_kind, ${anchorLabel} AS dst_id`;
  return `
    SELECT
      ${cols},
      w.distance AS distance, w.rule_distance AS rule_distance, w.dep_distance AS dep_distance
    FROM walk w
    JOIN ${RAW_NODE_TABLE} wn ON wn.node_id = w.node_id
    ${labelJoin('wn', 'wl', space)}
    ${timingJoin('wn', 'wt', 'sw', 'inner', space)}
    JOIN ${RAW_NODE_TABLE} a ON a.node_id = ${param}
    ${labelJoin('a', 'al', space)}
    ${timingJoin('a', 'at', 'sa', 'inner', space)}
    WHERE w.distance > 0`;
}

// The recursive bounded walk backing `dune_descendants` / `dune_ancestors`.
//
// `step_kind` selects which already-tracked column acts as the step counter -
// there are only two node kinds, so no extra walk state is needed. A node
// expands (takes another hop) only while its OWN counted value is still short
// of the budget, i.e. the budget is tested "stop at the boundary": with
// `step_kind='dep', max_steps=3` a node reached at dep_distance=3 does not
// expand further, so its own children are excluded, but a node it already
// reached via a *free* (non-counted) hop earlier is still included. Concretely,
// on an alternating dep/rule chain this includes the rule that produced the
// 3rd dep, but not a 4th dep past it. `max_steps=0` returns no rows for any
// `step_kind` (the seed can't expand). An invalid `step_kind` (anything but
// NULL/'dep'/'rule') returns no rows rather than silently meaning "every hop
// counts".
//
// `UNION` (not ALL) dedupes states so the walk terminates on repeated visits;
// `nodeCount` (the graph's total node count, inlined as a literal - cheaper
// than a per-row subquery) is an unconditional depth cap independent of
// `max_steps`: a simple path can have at most `nodeCount - 1` hops, so this can
// never change the result on a DAG, but protects against a cyclic input graph
// (built from trace args at runtime, so not guaranteed acyclic) - without it, a
// cycle increments `distance` every lap forever and nothing in the UI can
// interrupt a runaway query.
//
// Multiple states can reach the same node at different (rule_distance,
// dep_distance) splits (a min-hop path need not be a min-`step_kind`-count
// path), so `walk` collapses to one row per node via `row_number()`, ordered by
// the counted column first - the reported split is the node's minimum under
// whichever metric `step_kind` selects, not necessarily its minimum `distance`.
//
// `walk` is MATERIALIZED, and that is not a hint - it is the difference between
// 0.3 s and >90 s for `dune_children` on merlin's widest rule (1,266 children).
// Left to itself the planner drives the projection below from `slice` (the
// `sw.id = coalesce(...)` join can't be probed by id off a LEFT JOINed timing
// row) and re-runs the whole recursive walk per slice. Materializing it makes
// the walk run once and the projection a lookup per reached node.
function boundedBody(dir: Direction, param: string, space: NodeSpace): string {
  const {join, dest} = edgeStep(dir, 's.node_id');
  return `
    WITH RECURSIVE
    states(node_id, distance, rule_distance, dep_distance) AS (
      SELECT node_id, 0, 0, 0 FROM ${RAW_NODE_TABLE}
      WHERE node_id = ${param}
        AND ($step_kind IS NULL OR $step_kind IN ('dep', 'rule'))
      UNION
      SELECT ${dest}, s.distance + 1,
        s.rule_distance + iif(${isRuleExpr(dest, space)}, 1, 0),
        s.dep_distance + iif(${isRuleExpr(dest, space)}, 0, 1)
      FROM states s
      ${join}
      WHERE ($max_steps IS NULL OR (${countedExpr('s.')}) < $max_steps)
        AND s.distance < ${space.nodeCount}
    ),
    walk AS MATERIALIZED (
      SELECT node_id, distance, rule_distance, dep_distance FROM (
        SELECT node_id, distance, rule_distance, dep_distance,
          row_number() OVER (
            PARTITION BY node_id
            ORDER BY (${countedExpr('')}), distance, rule_distance
          ) AS rn
        FROM states
      )
      WHERE rn = 1
    )
    ${relationProjection(dir, param, space)}`;
}

// The unbounded fast path backing `dune_all_descendants` / `dune_all_ancestors`
// / `dune_forcers` / `dune_forced`: the stdlib's cycle-safe C++
// `graph_reachable_bfs!` (over `edgeSet`, forced-only when `opts.forcedOnly`)
// followed by a walk of its parent tree that adds up the traversed nodes' kinds
// - reading each node's kind off its id rather than joining back to
// `_dune_node`.
//
// `bfs` is MATERIALIZED for the same reason `walk` is in `boundedBody`, and with
// the same order of magnitude at stake: it is referenced from inside the
// recursive parent-tree walk, so without the hint the C++ BFS is re-run once per
// iteration of it (`dune_all_descendants` on merlin's widest rule: 2.3 s
// against 0.3 s).
function bfsBody(
  dir: Direction,
  param: string,
  space: NodeSpace,
  opts: {forcedOnly?: boolean} = {},
): string {
  const {join, dest} = edgeStep(dir, 'w.node_id', opts);
  return `
    WITH RECURSIVE
    bfs AS MATERIALIZED (
      SELECT node_id, parent_node_id FROM graph_reachable_bfs!(
        ${edgeSet(dir, opts)},
        (SELECT ${param} AS node_id))
    ),
    walk(node_id, distance, rule_distance, dep_distance) AS (
      SELECT node_id, 0, 0, 0 FROM bfs WHERE node_id = ${param}
      UNION ALL
      SELECT b.node_id, w.distance + 1,
        w.rule_distance + iif(${isRuleExpr('b.node_id', space)}, 1, 0),
        w.dep_distance + iif(${isRuleExpr('b.node_id', space)}, 0, 1)
      FROM walk w
      JOIN bfs b ON b.parent_node_id = w.node_id
      ${join} AND ${dest} = b.node_id
    )
    ${relationProjection(dir, param, space)}`;
}

// One-hop wrapper body for `dune_children` / `dune_parents`: the bounded walk
// with `max_steps=1`. More correct than a raw single join on `dune_edge` would
// be, since the walk's dedup collapses any duplicate edges.
function wrapperBody(fn: string, param: string): string {
  return `SELECT * FROM ${fn}(${param}, 1, NULL)`;
}

/**
 * Defines the parameterized transitive-relationship helpers, exposed for ad-hoc
 * SQL (e.g. via the query tab). All-pairs closure doesn't scale, so these are
 * all single-source, and each is implemented the way its question wants to be
 * answered rather than routed through one general-purpose walk:
 *
 * - `dune_descendants(node_id, max_steps, step_kind)` /
 *   `dune_ancestors(node_id, max_steps, step_kind)` — the general bounded walk
 *   (recursive CTE; see `boundedBody`). `max_steps` NULL means unbounded;
 *   `step_kind` NULL means every hop counts, 'dep'/'rule' means only hops
 *   landing on that kind count.
 * - `dune_all_descendants(node_id)` / `dune_all_ancestors(node_id)` — the
 *   unbounded fast path, built on the stdlib's cycle-safe `graph_reachable_bfs!`
 *   rather than the hand-rolled recursive walk.
 * - `dune_children(node_id)` / `dune_parents(node_id)` — one hop (see
 *   `wrapperBody`).
 * - `dune_forcers(node_id)` / `dune_forced(node_id)` — the unbounded fast path
 *   restricted to forced edges only, so every row returned is forced by
 *   construction; `dune_forcers` walks up (what transitively forced
 *   `node_id`), `dune_forced` walks down (what `node_id` transitively forced).
 *
 * All eight return the same 11-column shape (`RELATION_COLS`):
 *   (src_*, dst_*, distance, rule_distance, dep_distance)
 * `src` is the depender (upstream), `dst` the prerequisite, regardless of which
 * direction the function walks; `distance == rule_distance + dep_distance`.
 * The distances are anchor-relative: they count the path nodes traversed AWAY
 * FROM `node_id`, excluding `node_id` itself. (This is a behaviour change for
 * ancestors, which used to count away from the *far* end of the path instead -
 * the two directions already agreed on `distance` for a shared (src, dst) pair
 * but could disagree on the rule/dep split whenever `kind(src) != kind(dst)`.
 * Anchor-relative counting is required for the `step_kind` budget to mean the
 * same thing in both directions; the cost is that the two directions can now
 * disagree on the split for a pair they both report.)
 *
 * There's no `forced` column any more - dropping it halves the work of every
 * unbounded call, which used to run a second forced-only BFS just to compute
 * it. Per-edge forcing is still on `dune_edge.forced`; to annotate a result
 * with transitive forced-reachability, join against `dune_forced`/`dune_forcers`:
 *   SELECT d.*, f.dst_node_id IS NOT NULL AS forced
 *   FROM dune_descendants(42, NULL, NULL) d
 *   LEFT JOIN dune_forced(42) f USING (dst_node_id)
 *
 * `dune_descendants`/`dune_ancestors` used to take a single `node_id` arg; that
 * form is gone - a `RETURNS TABLE` function is registered as a virtual table
 * keyed by name only, so the old and new arity can't coexist. Use
 * `dune_all_descendants`/`dune_all_ancestors` for the old unbounded behaviour.
 *
 * Every function above has a same-named `!` list-macro wrapper taking
 * `starts TableOrSubquery` in place of `node_id` (plus any trailing scalar
 * args, see `RELATION_FUNCTIONS`): runs the function once per `node_id` in
 * `starts` and unions the results, e.g.
 * `dune_descendants!(starts, max_steps, step_kind)`, `dune_parents!(starts)`.
 * CREATE OR REPLACE keeps reload idempotent for both functions and macros
 * (macros can't be dropped - there's no `DROP PERFETTO MACRO` - so a stale one
 * would otherwise survive a graph rebuild anyway).
 */
async function createRelationFunctions(
  engine: Engine,
  space: NodeSpace,
): Promise<void> {
  const define = (name: string, args: string, body: string) =>
    engine.query(`
      CREATE OR REPLACE PERFETTO FUNCTION ${name}(${args})
      RETURNS TABLE(${RELATION_COLS}) AS
      ${body}`);

  // Base bounded walk.
  await define(
    'dune_descendants',
    'node_id LONG, max_steps LONG, step_kind STRING',
    boundedBody('down', '$node_id', space),
  );
  await define(
    'dune_ancestors',
    'node_id LONG, max_steps LONG, step_kind STRING',
    boundedBody('up', '$node_id', space),
  );

  // Unbounded fast path.
  await define(
    'dune_all_descendants',
    'node_id LONG',
    bfsBody('down', '$node_id', space),
  );
  await define(
    'dune_all_ancestors',
    'node_id LONG',
    bfsBody('up', '$node_id', space),
  );

  // One hop.
  await define(
    'dune_children',
    'node_id LONG',
    wrapperBody('dune_descendants', '$node_id'),
  );
  await define(
    'dune_parents',
    'node_id LONG',
    wrapperBody('dune_ancestors', '$node_id'),
  );

  // Forced-edge closure.
  await define(
    'dune_forcers',
    'node_id LONG',
    bfsBody('up', '$node_id', space, {forcedOnly: true}),
  );
  await define(
    'dune_forced',
    'node_id LONG',
    bfsBody('down', '$node_id', space, {forcedOnly: true}),
  );

  // `!` list-macro wrappers: run the function per `node_id` in `starts` and
  // union the results, forwarding any trailing scalar args unchanged.
  for (const {name, extraArgs} of RELATION_FUNCTIONS) {
    const macroParams = [
      'starts TableOrSubquery',
      ...extraArgs.map((a) => `${a} Expr`),
    ];
    const callArgs = ['s.node_id', ...extraArgs.map((a) => `$${a}`)];
    await engine.query(`
      CREATE OR REPLACE PERFETTO MACRO ${name}(${macroParams.join(', ')})
      RETURNS TableOrSubquery AS
      (SELECT d.* FROM ($starts) s JOIN ${name}(${callArgs.join(', ')}) d)`);
  }
}

// Single-source directed BFS from `fromId`, then walk the BFS parent tree back
// up from `toId` to reconstruct one shortest path and count its nodes by kind.
//
// The BFS macro yields each reachable node once with the id of its first
// encountered predecessor, so `path` is a simple parent walk (no cycles, no
// exponential blow-up) that terminates on reaching `fromId` or a self/NULL
// parent. `reachable` distinguishes an unreachable `toId` (no row) from a
// genuine distance of 0 (fromId == toId).
//
// This reports the dep/rule split *of a shortest total-hop path*. Minimizing
// dep-only or rule-only counts independently would be a different weighting and
// a separate query.
//
// `bfs` is MATERIALIZED for the reason spelled out in `bfsBody`: it is read from
// inside the recursive `path` walk, and without the hint the C++ BFS runs again
// for every hop of the path it is reconstructing.
function distanceQuery(fromId: number, toId: number, space: NodeSpace): string {
  return `
    WITH
    bfs AS MATERIALIZED (
      SELECT node_id, parent_node_id
      FROM graph_reachable_bfs!(
        ${edgeSet('down')},
        (SELECT ${fromId} AS node_id)
      )
    ),
    path(node_id, parent_node_id) AS (
      SELECT node_id, parent_node_id FROM bfs WHERE node_id = ${toId}
      UNION ALL
      SELECT b.node_id, b.parent_node_id
      FROM bfs b JOIN path p ON b.node_id = p.parent_node_id
      WHERE p.node_id != ${fromId}
        AND p.parent_node_id IS NOT NULL
        AND p.parent_node_id != p.node_id
    )
    SELECT
      (SELECT count(*) FROM bfs WHERE node_id = ${toId}) AS reachable,
      (SELECT count(*) FROM path WHERE node_id != ${fromId}) AS total,
      (SELECT count(*) FROM path
        WHERE node_id != ${fromId}
          AND NOT (${isRuleExpr('node_id', space)})) AS dep,
      (SELECT count(*) FROM path
        WHERE node_id != ${fromId}
          AND ${isRuleExpr('node_id', space)}) AS rule
  `;
}
