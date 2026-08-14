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
 * Materializes the in-memory {@link BuildGraph} into two Perfetto SQL tables so
 * the graph can be queried by relationship (e.g. distance between two nodes) in
 * the same SQL engine as the rest of the trace, and drives the distance query.
 *
 * - `dune_node(node_id, node, kind, orig_id, slice_id, label, forced_by_kind,
 *   forced_by_target)` — one row per node, a typed PERFETTO VIEW over the raw
 *   `_dune_node` table the rows are inserted into. `node` and `slice_id` are
 *   both the node's slice id as a `SliceTable::Id` (`JOINID(slice.id)`); `node`
 *   is the ergonomic column the query tab renders as a chip. `forced_by_kind` /
 *   `forced_by_target` mirror the node's `dune.forced_by` (the target is the
 *   forcing rule id / dep id / dune-file path, or NULL).
 * - `dune_edge(src, dst, forced, src_node_id, dst_node_id)` — a typed PERFETTO
 *   VIEW over the raw `_dune_edge(source_node_id, dest_node_id, dest_kind,
 *   source_kind, forced)` table, with `src` / `dst` the endpoints' slice ids
 *   (`JOINID(slice.id)`, chip-rendered) and the raw node_id endpoints.
 *   Directed edges where "source depends on dest" (dest is the prerequisite /
 *   upstream node):
 *     rule -> dep  (static deps, flattened dynamic deps)
 *     dep  -> rule (resolved rule)
 *     dep  -> dep  (expanded deps)
 *   `forced` is 1 iff `dest` was forced into the build by `source` (i.e. dest's
 *   `forcedBy` names source); see `isForcedEdge` in graph.ts. `source_kind`
 *   (alongside `dest_kind`) lets the relation functions below reverse the graph
 *   with a plain column swap instead of a join back to `_dune_node`. The
 *   relation functions read the raw `_dune_edge` / `_dune_node` directly (they
 *   need the node_id endpoints and the un-typed kind columns).
 *
 * Nodes live in two id namespaces (dep ids are Dune strings, rule ids are
 * stringified ints), and the stdlib graph macros require dense integer ids near
 * zero, so every node is assigned a synthetic `node_id` in [0, N). The
 * `node_id <-> GraphNode` mapping is kept so callers can translate a selected
 * node into a `node_id` and back.
 *
 * It also defines a small library of transitive-relationship SQL functions -
 * see {@link createRelationFunctions} for the full inventory (bounded/unbounded
 * x forward/reverse x all-edges/forced-only, plus one-hop wrappers).
 */

import type {Engine} from '../../trace_processor/engine';
import {NUM} from '../../trace_processor/query_result';
import type {SqlValue} from '../../trace_processor/query_result';
import {sqlValueToSqliteString} from '../../trace_processor/sql_utils';
import type {BuildGraph, GraphNode} from './graph';
import {edges, forcedByTarget, nodeKey, nodeLabel} from './graph';

// `dune_node` / `dune_edge` are typed PERFETTO VIEWS (so slice-id columns are
// real SliceTable::Ids and carry the ergonomic `node` / `src` / `dst` chip
// columns) over the raw tables we actually INSERT the rows into - a CREATE
// PERFETTO TABLE/VIEW can't be chunk-inserted, and a plain CREATE TABLE can't
// express the column types. Internal queries (relation functions, distance)
// read the raw `_dune_edge` / `_dune_node` directly.
const NODE_TABLE = 'dune_node';
const RAW_NODE_TABLE = '_dune_node';
const EDGE_TABLE = 'dune_edge';
const RAW_EDGE_TABLE = '_dune_edge';

// Rows are inserted in batches: one `INSERT ... VALUES (row), (row), ...` per
// chunk. A single statement can't materialize the whole graph at once — a long
// `UNION ALL` chain hits SQLite's compound-SELECT term limit (500) on any
// non-trivial graph.
const INSERT_CHUNK = 500;

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

export interface SqlGraph extends AsyncDisposable {
  // The dense `node_id` for a graph node, or undefined if it isn't present.
  nodeId(node: GraphNode): number | undefined;

  // Directed distances following build-dependency edges from `fromId` to
  // `toId`, or undefined if `toId` is unreachable from `fromId`.
  distances(fromId: number, toId: number): Promise<Distances | undefined>;
}

interface DroppableTable extends AsyncDisposable {
  readonly name: string;
}

// Create `name` with the given column schema and populate it with `rows`
// (chunked inserts, see INSERT_CHUNK). Pre-drops so a rebuild is idempotent;
// the returned handle drops the table when disposed. A plain (non-PERFETTO)
// table is used so it can be INSERTed into and queried ad-hoc in the Query page.
async function materializeTable(
  engine: Engine,
  name: string,
  schema: string,
  columns: readonly string[],
  rows: readonly Record<string, SqlValue>[],
): Promise<DroppableTable> {
  await engine.tryQuery(`DROP TABLE IF EXISTS ${name}`);
  await engine.query(`CREATE TABLE ${name} (${schema})`);
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const values = rows
      .slice(i, i + INSERT_CHUNK)
      .map(
        (row) =>
          `(${columns
            .map((c) => sqlValueToSqliteString(row[c] ?? null))
            .join(', ')})`,
      )
      .join(', ');
    await engine.query(
      `INSERT INTO ${name} (${columns.join(', ')}) VALUES ${values}`,
    );
  }
  return {
    name,
    async [Symbol.asyncDispose](): Promise<void> {
      await engine.tryQuery(`DROP TABLE IF EXISTS ${name}`);
    },
  };
}

/**
 * Builds the `dune_node` / `dune_edge` tables from `graph` and returns a handle
 * that can compute distances and drops both tables when disposed. Rebuilding is
 * idempotent: any pre-existing tables of the same name are dropped first.
 */
export async function buildSqlGraph(
  engine: Engine,
  graph: BuildGraph,
): Promise<SqlGraph> {
  // Assign a dense node_id to every node, deps first then rules.
  const idByKey = new Map<string, number>();
  const nodeRows: Record<string, SqlValue>[] = [];
  const addNode = (node: GraphNode) => {
    const key = nodeKey(node.kind, node.id);
    const id = idByKey.size;
    idByKey.set(key, id);
    nodeRows.push({
      node_id: id,
      kind: node.kind,
      orig_id: node.id,
      slice_id: node.sliceId,
      label: nodeLabel(node),
      forced_by_kind: node.forcedBy?.kind ?? null,
      forced_by_target:
        node.forcedBy === undefined ? null : forcedByTarget(node.forcedBy),
    });
  };
  for (const dep of graph.deps.values()) addNode(dep);
  for (const rule of graph.rules.values()) addNode(rule);

  // One row per edge from the shared edge set. Endpoints are always present
  // (every node was added above); the guard is just for type-narrowing.
  // `source_kind` (alongside `dest_kind`) lets the relation functions reverse
  // the graph with a column swap instead of a join back to `_dune_node`.
  const edgeRows: Record<string, SqlValue>[] = [];
  for (const {source, dest, forced} of edges(graph)) {
    const sourceId = idByKey.get(nodeKey(source.kind, source.id));
    const destId = idByKey.get(nodeKey(dest.kind, dest.id));
    if (sourceId === undefined || destId === undefined) continue;
    edgeRows.push({
      source_node_id: sourceId,
      dest_node_id: destId,
      dest_kind: dest.kind,
      source_kind: source.kind,
      forced: forced ? 1 : 0,
    });
  }

  // Materialize the raw tables (chunked inserts; pre-dropped for idempotent
  // reload). Drop the views first: they read from the raw tables that
  // materializeTable recreates.
  await engine.tryQuery(`DROP VIEW IF EXISTS ${NODE_TABLE}`);
  await engine.tryQuery(`DROP VIEW IF EXISTS ${EDGE_TABLE}`);
  const rawNodeTable = await materializeTable(
    engine,
    RAW_NODE_TABLE,
    'node_id INTEGER, kind TEXT, orig_id TEXT, slice_id INTEGER, label TEXT, ' +
      'forced_by_kind TEXT, forced_by_target TEXT',
    [
      'node_id',
      'kind',
      'orig_id',
      'slice_id',
      'label',
      'forced_by_kind',
      'forced_by_target',
    ],
    nodeRows,
  );
  const rawEdgeTable = await materializeTable(
    engine,
    RAW_EDGE_TABLE,
    'source_node_id INTEGER, dest_node_id INTEGER, dest_kind TEXT, ' +
      'source_kind TEXT, forced INTEGER',
    ['source_node_id', 'dest_node_id', 'dest_kind', 'source_kind', 'forced'],
    edgeRows,
  );

  // Indexes on the raw tables: without these, the recursive walk in
  // `boundedBody` does a full scan of `_dune_edge` per frontier row (the
  // stdlib BFS-backed functions get away without them, since the underlying
  // C++ BFS reads the edge table once). Plain (non-PERFETTO) indexes on plain
  // tables; dropped along with the table on the next reload.
  await engine.query(
    `CREATE INDEX ${RAW_EDGE_TABLE}_src ON ${RAW_EDGE_TABLE}(source_node_id)`,
  );
  await engine.query(
    `CREATE INDEX ${RAW_EDGE_TABLE}_dst ON ${RAW_EDGE_TABLE}(dest_node_id)`,
  );
  await engine.query(
    `CREATE INDEX ${RAW_NODE_TABLE}_id ON ${RAW_NODE_TABLE}(node_id)`,
  );

  // Typed view over the raw node table so `slice_id` (and the ergonomic `node`
  // chip column) are SliceTable::Ids (joinable / clickable / chip-rendered),
  // which a plain CREATE TABLE can't declare. The id columns are sourced as
  // `slice.id` from a join (not the raw INTEGER col) so they genuinely carry the
  // id type - the same way the stdlib declares JOINID columns. Every raw
  // slice_id came from the slice table, so the inner join keeps all rows.
  await engine.query(`
    CREATE PERFETTO VIEW ${NODE_TABLE}(
      node_id LONG,
      node JOINID(slice.id),
      kind STRING,
      orig_id STRING,
      slice_id JOINID(slice.id),
      label STRING,
      forced_by_kind STRING,
      forced_by_target STRING
    ) AS
    SELECT n.node_id, s.id AS node, n.kind, n.orig_id, s.id AS slice_id, n.label,
      n.forced_by_kind, n.forced_by_target
    FROM ${RAW_NODE_TABLE} n
    JOIN slice s ON s.id = n.slice_id
  `);
  // Typed view over the raw edge table exposing `src` / `dst` as SliceTable::Ids
  // (chip-rendered node columns) plus `forced`, and the raw node_id endpoints
  // (`src_node_id` / `dst_node_id`, hidden by default in the query tab but handy
  // for joining back to `dune_node.node_id`). The graph macros read the raw
  // `_dune_edge` directly.
  await engine.query(`
    CREATE PERFETTO VIEW ${EDGE_TABLE}(
      src JOINID(slice.id),
      dst JOINID(slice.id),
      forced LONG,
      src_node_id LONG,
      dst_node_id LONG
    ) AS
    SELECT ss.id AS src, sd.id AS dst, e.forced AS forced,
      e.source_node_id AS src_node_id, e.dest_node_id AS dst_node_id
    FROM ${RAW_EDGE_TABLE} e
    JOIN ${RAW_NODE_TABLE} sn ON sn.node_id = e.source_node_id
    JOIN slice ss ON ss.id = sn.slice_id
    JOIN ${RAW_NODE_TABLE} dn ON dn.node_id = e.dest_node_id
    JOIN slice sd ON sd.id = dn.slice_id
  `);

  // graph_reachable_bfs! lives in this stdlib module.
  await engine.query('INCLUDE PERFETTO MODULE graphs.search');

  // Parameterized transitive-relationship functions + list-macro wrappers.
  await createRelationFunctions(engine, nodeRows.length);

  return {
    nodeId(node: GraphNode): number | undefined {
      return idByKey.get(nodeKey(node.kind, node.id));
    },

    async distances(
      fromId: number,
      toId: number,
    ): Promise<Distances | undefined> {
      const result = await engine.query(distanceQuery(fromId, toId));
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
      // after the raw tables are dropped fails opaquely - "no such table:
      // _dune_edge" - on the next ad-hoc query instead of cleanly), then the
      // views, then the raw tables they read from. Macros can't be dropped -
      // there's no `DROP PERFETTO MACRO` - but CREATE OR REPLACE on the next
      // reload handles them.
      for (const {name} of RELATION_FUNCTIONS) {
        await engine.tryQuery(`DROP TABLE IF EXISTS ${name}`);
      }
      await engine.tryQuery(`DROP VIEW IF EXISTS ${NODE_TABLE}`);
      await engine.tryQuery(`DROP VIEW IF EXISTS ${EDGE_TABLE}`);
      await rawEdgeTable[Symbol.asyncDispose]();
      await rawNodeTable[Symbol.asyncDispose]();
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

// Edge set for a directed walk, consistently shaped as (source_node_id,
// dest_node_id, dest_kind) regardless of direction: 'up' reverses the graph by
// swapping the endpoint columns (and `source_kind` becomes `dest_kind`) rather
// than joining back to `_dune_node`. `forcedOnly` restricts to forced edges
// (`dune_forcers` / `dune_forced`), so every row a caller gets back is forced
// by construction.
function edgeSet(dir: Direction, opts: {forcedOnly?: boolean} = {}): string {
  const where = opts.forcedOnly ? ' WHERE forced' : '';
  return dir === 'down'
    ? `(SELECT source_node_id, dest_node_id, dest_kind
        FROM ${RAW_EDGE_TABLE}${where})`
    : `(SELECT dest_node_id AS source_node_id, source_node_id AS dest_node_id,
        source_kind AS dest_kind FROM ${RAW_EDGE_TABLE}${where})`;
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
function relationProjection(dir: Direction, param: string): string {
  const cols =
    dir === 'down'
      ? `a.node_id AS src_node_id, sa.id AS src_slice_id, a.kind AS src_kind, a.orig_id AS src_id,
      w.node_id AS dst_node_id, sw.id AS dst_slice_id, wn.kind AS dst_kind, wn.orig_id AS dst_id`
      : `w.node_id AS src_node_id, sw.id AS src_slice_id, wn.kind AS src_kind, wn.orig_id AS src_id,
      a.node_id AS dst_node_id, sa.id AS dst_slice_id, a.kind AS dst_kind, a.orig_id AS dst_id`;
  return `
    SELECT
      ${cols},
      w.distance AS distance, w.rule_distance AS rule_distance, w.dep_distance AS dep_distance
    FROM walk w
    JOIN ${RAW_NODE_TABLE} wn ON wn.node_id = w.node_id
    JOIN slice sw ON sw.id = wn.slice_id
    JOIN ${RAW_NODE_TABLE} a ON a.node_id = ${param}
    JOIN slice sa ON sa.id = a.slice_id
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
function boundedBody(dir: Direction, param: string, nodeCount: number): string {
  return `
    WITH RECURSIVE
    states(node_id, distance, rule_distance, dep_distance) AS (
      SELECT node_id, 0, 0, 0 FROM ${RAW_NODE_TABLE}
      WHERE node_id = ${param}
        AND ($step_kind IS NULL OR $step_kind IN ('dep', 'rule'))
      UNION
      SELECT e.dest_node_id, s.distance + 1,
        s.rule_distance + iif(e.dest_kind = 'rule', 1, 0),
        s.dep_distance + iif(e.dest_kind = 'dep', 1, 0)
      FROM states s
      JOIN ${edgeSet(dir)} e ON e.source_node_id = s.node_id
      WHERE ($max_steps IS NULL OR (${countedExpr('s.')}) < $max_steps)
        AND s.distance < ${nodeCount}
    ),
    walk AS (
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
    ${relationProjection(dir, param)}`;
}

// The unbounded fast path backing `dune_all_descendants` / `dune_all_ancestors`
// / `dune_forcers` / `dune_forced`: the stdlib's cycle-safe C++
// `graph_reachable_bfs!` (over `edgeSet`, forced-only when `opts.forcedOnly`)
// followed by a walk of its parent tree that adds up the traversed nodes' kinds
// - reading `dest_kind` straight off the matching edge rather than joining back
// to `_dune_node`.
function bfsBody(
  dir: Direction,
  param: string,
  opts: {forcedOnly?: boolean} = {},
): string {
  return `
    WITH RECURSIVE
    bfs AS (
      SELECT node_id, parent_node_id FROM graph_reachable_bfs!(
        (SELECT source_node_id, dest_node_id FROM ${edgeSet(dir, opts)}),
        (SELECT ${param} AS node_id))
    ),
    walk(node_id, distance, rule_distance, dep_distance) AS (
      SELECT node_id, 0, 0, 0 FROM bfs WHERE node_id = ${param}
      UNION ALL
      SELECT b.node_id, w.distance + 1,
        w.rule_distance + iif(e.dest_kind = 'rule', 1, 0),
        w.dep_distance + iif(e.dest_kind = 'dep', 1, 0)
      FROM bfs b
      JOIN walk w ON b.parent_node_id = w.node_id
      JOIN ${edgeSet(dir, opts)} e
        ON e.source_node_id = b.parent_node_id AND e.dest_node_id = b.node_id
    )
    ${relationProjection(dir, param)}`;
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
  nodeCount: number,
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
    boundedBody('down', '$node_id', nodeCount),
  );
  await define(
    'dune_ancestors',
    'node_id LONG, max_steps LONG, step_kind STRING',
    boundedBody('up', '$node_id', nodeCount),
  );

  // Unbounded fast path.
  await define(
    'dune_all_descendants',
    'node_id LONG',
    bfsBody('down', '$node_id'),
  );
  await define('dune_all_ancestors', 'node_id LONG', bfsBody('up', '$node_id'));

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
    bfsBody('up', '$node_id', {forcedOnly: true}),
  );
  await define(
    'dune_forced',
    'node_id LONG',
    bfsBody('down', '$node_id', {forcedOnly: true}),
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
function distanceQuery(fromId: number, toId: number): string {
  return `
    WITH
    bfs AS (
      SELECT node_id, parent_node_id
      FROM graph_reachable_bfs!(
        (SELECT source_node_id, dest_node_id FROM ${RAW_EDGE_TABLE}),
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
      (SELECT count(*) FROM path p JOIN ${RAW_NODE_TABLE} n USING (node_id)
        WHERE p.node_id != ${fromId} AND n.kind = 'dep') AS dep,
      (SELECT count(*) FROM path p JOIN ${RAW_NODE_TABLE} n USING (node_id)
        WHERE p.node_id != ${fromId} AND n.kind = 'rule') AS rule
  `;
}
