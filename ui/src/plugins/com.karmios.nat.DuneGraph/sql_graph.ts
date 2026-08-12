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
 *   forced)` table, with `src` / `dst` the endpoints' slice ids
 *   (`JOINID(slice.id)`, chip-rendered) and the raw node_id endpoints.
 *   Directed edges where "source depends on dest" (dest is the prerequisite /
 *   upstream node):
 *     rule -> dep  (static deps, flattened dynamic deps)
 *     dep  -> rule (resolved rule)
 *     dep  -> dep  (expanded deps)
 *   `forced` is 1 iff `dest` was forced into the build by `source` (i.e. dest's
 *   `forcedBy` names source); see `isForcedEdge` in graph.ts. The graph macros
 *   read the raw `_dune_edge` (they need the node_id endpoints).
 *
 * Nodes live in two id namespaces (dep ids are Dune strings, rule ids are
 * stringified ints), and the stdlib graph macros require dense integer ids near
 * zero, so every node is assigned a synthetic `node_id` in [0, N). The
 * `node_id <-> GraphNode` mapping is kept so callers can translate a selected
 * node into a `node_id` and back.
 *
 * It also defines the transitive-relationship SQL helpers
 * `dune_descendants`/`dune_ancestors` (+ `!` list-macro wrappers) - see
 * {@link createRelationFunctions}.
 */

import type {Engine} from '../../trace_processor/engine';
import {NUM} from '../../trace_processor/query_result';
import type {SqlValue} from '../../trace_processor/query_result';
import {sqlValueToSqliteString} from '../../trace_processor/sql_utils';
import type {BuildGraph, ForcedBy, GraphNode} from './graph';
import {edges, nodeKey, nodeLabel} from './graph';

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
// of the traversed nodes are deps / rules (so `total === dep + rule`).
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

// The rule id / dep id / dune-file path a `forcedBy` points at, for the
// `dune_node.forced_by_target` column. Payload-less kinds (CONFIGURATOR,
// REQUEST, UNKNOWN) have no target.
function forcedByTarget(fb: ForcedBy): string | null {
  switch (fb.kind) {
    case 'RULE':
      return fb.rule;
    case 'DEP':
      return fb.dep;
    case 'DYNAMIC_INCLUDES':
      return fb.dynamicIncludes;
    case 'GEN_RULES':
      return fb.genRules;
    case 'PFORM':
      return fb.pform;
    default:
      return null;
  }
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
  const edgeRows: Record<string, SqlValue>[] = [];
  for (const {source, dest, forced} of edges(graph)) {
    const sourceId = idByKey.get(nodeKey(source.kind, source.id));
    const destId = idByKey.get(nodeKey(dest.kind, dest.id));
    if (sourceId === undefined || destId === undefined) continue;
    edgeRows.push({
      source_node_id: sourceId,
      dest_node_id: destId,
      dest_kind: dest.kind,
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
      'forced INTEGER',
    ['source_node_id', 'dest_node_id', 'dest_kind', 'forced'],
    edgeRows,
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
  await createRelationFunctions(engine);

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
      // Drop the views before the raw tables they read from.
      await engine.tryQuery(`DROP VIEW IF EXISTS ${NODE_TABLE}`);
      await engine.tryQuery(`DROP VIEW IF EXISTS ${EDGE_TABLE}`);
      await rawEdgeTable[Symbol.asyncDispose]();
      await rawNodeTable[Symbol.asyncDispose]();
    },
  };
}

/**
 * Defines the parameterized transitive-relationship helpers, exposed for ad-hoc
 * SQL (e.g. via the query tab). All-pairs closure doesn't scale, so these are
 * single-source:
 *
 * - `dune_descendants(node_id)` / `dune_ancestors(node_id)` — one BFS returning
 *   every node the argument transitively depends on / is depended on by, as
 *   (src_*, dst_*, distance, rule_distance, dep_distance, forced). `src` is the
 *   ancestor (depender), `dst` the descendant (prerequisite); `distance` counts
 *   path nodes excluding the ancestor, split by kind (distance == rule + dep).
 *   `forced` is 1 iff the descendant is reachable through forced edges only
 *   (some src->dst path where every hop was forced).
 * - `dune_descendants!(starts)` / `dune_ancestors!(starts)` — run the function
 *   for each `node_id` in a table/subquery and union the results.
 *
 * Descendants walks forward edges counting the child's kind; ancestors walks
 * reversed edges counting the parent's (the node being extended from) kind, so
 * both report the kind split of the path's non-ancestor nodes. CREATE OR REPLACE
 * keeps reload idempotent.
 */
async function createRelationFunctions(engine: Engine): Promise<void> {
  const cols = `
    src_node_id LONG, src_slice_id JOINID(slice.id), src_kind STRING, src_id STRING,
    dst_node_id LONG, dst_slice_id JOINID(slice.id), dst_kind STRING, dst_id STRING,
    distance LONG, rule_distance LONG, dep_distance LONG, forced LONG`;

  // Forward: BFS along source->dest; the walk adds the CHILD's kind each hop.
  // `fbfs` is the same BFS but restricted to forced edges, so `forced` is 1 iff
  // the descendant is reachable from the ancestor through forced edges only
  // (i.e. some path where every hop was forced).
  await engine.query(`
    CREATE OR REPLACE PERFETTO FUNCTION dune_descendants(src_node_id LONG)
    RETURNS TABLE(${cols}) AS
    WITH RECURSIVE
    bfs AS (
      SELECT node_id, parent_node_id FROM graph_reachable_bfs!(
        (SELECT source_node_id, dest_node_id FROM ${RAW_EDGE_TABLE}),
        (SELECT $src_node_id AS node_id))),
    fbfs AS (
      SELECT node_id FROM graph_reachable_bfs!(
        (SELECT source_node_id, dest_node_id FROM ${RAW_EDGE_TABLE} WHERE forced),
        (SELECT $src_node_id AS node_id))),
    walk(node_id, distance, rule_distance, dep_distance) AS (
      SELECT node_id, 0, 0, 0 FROM bfs WHERE node_id = $src_node_id
      UNION ALL
      SELECT b.node_id, w.distance + 1,
        w.rule_distance + iif(c.kind = 'rule', 1, 0),
        w.dep_distance + iif(c.kind = 'dep', 1, 0)
      FROM bfs b
      JOIN walk w ON b.parent_node_id = w.node_id
      JOIN ${RAW_NODE_TABLE} c ON c.node_id = b.node_id)
    SELECT
      s.node_id AS src_node_id, ss.id AS src_slice_id, s.kind AS src_kind, s.orig_id AS src_id,
      d.node_id AS dst_node_id, sd.id AS dst_slice_id, d.kind AS dst_kind, d.orig_id AS dst_id,
      w.distance AS distance, w.rule_distance AS rule_distance, w.dep_distance AS dep_distance,
      iif(w.node_id IN (SELECT node_id FROM fbfs), 1, 0) AS forced
    FROM walk w
    JOIN ${RAW_NODE_TABLE} s ON s.node_id = $src_node_id
    JOIN slice ss ON ss.id = s.slice_id
    JOIN ${RAW_NODE_TABLE} d ON d.node_id = w.node_id
    JOIN slice sd ON sd.id = d.slice_id
    WHERE w.distance > 0`);

  // Reverse: BFS along dest->source; the walk adds the PARENT's kind each hop.
  // `fbfs` walks the reversed forced edges, so `forced` is 1 iff the ancestor
  // reaches the descendant through forced edges only.
  await engine.query(`
    CREATE OR REPLACE PERFETTO FUNCTION dune_ancestors(dst_node_id LONG)
    RETURNS TABLE(${cols}) AS
    WITH RECURSIVE
    bfs AS (
      SELECT node_id, parent_node_id FROM graph_reachable_bfs!(
        (SELECT dest_node_id AS source_node_id, source_node_id AS dest_node_id FROM ${RAW_EDGE_TABLE}),
        (SELECT $dst_node_id AS node_id))),
    fbfs AS (
      SELECT node_id FROM graph_reachable_bfs!(
        (SELECT dest_node_id AS source_node_id, source_node_id AS dest_node_id FROM ${RAW_EDGE_TABLE} WHERE forced),
        (SELECT $dst_node_id AS node_id))),
    walk(node_id, distance, rule_distance, dep_distance) AS (
      SELECT node_id, 0, 0, 0 FROM bfs WHERE node_id = $dst_node_id
      UNION ALL
      SELECT b.node_id, w.distance + 1,
        w.rule_distance + iif(p.kind = 'rule', 1, 0),
        w.dep_distance + iif(p.kind = 'dep', 1, 0)
      FROM bfs b
      JOIN walk w ON b.parent_node_id = w.node_id
      JOIN ${RAW_NODE_TABLE} p ON p.node_id = w.node_id)
    SELECT
      a.node_id AS src_node_id, sa.id AS src_slice_id, a.kind AS src_kind, a.orig_id AS src_id,
      b.node_id AS dst_node_id, sb.id AS dst_slice_id, b.kind AS dst_kind, b.orig_id AS dst_id,
      w.distance AS distance, w.rule_distance AS rule_distance, w.dep_distance AS dep_distance,
      iif(w.node_id IN (SELECT node_id FROM fbfs), 1, 0) AS forced
    FROM walk w
    JOIN ${RAW_NODE_TABLE} a ON a.node_id = w.node_id
    JOIN slice sa ON sa.id = a.slice_id
    JOIN ${RAW_NODE_TABLE} b ON b.node_id = $dst_node_id
    JOIN slice sb ON sb.id = b.slice_id
    WHERE w.distance > 0`);

  // List wrappers: run the function per `node_id` in `starts` and union.
  await engine.query(`
    CREATE OR REPLACE PERFETTO MACRO dune_descendants(starts TableOrSubquery)
    RETURNS TableOrSubquery AS
    (SELECT d.* FROM ($starts) s JOIN dune_descendants(s.node_id) d)`);
  await engine.query(`
    CREATE OR REPLACE PERFETTO MACRO dune_ancestors(starts TableOrSubquery)
    RETURNS TableOrSubquery AS
    (SELECT d.* FROM ($starts) s JOIN dune_ancestors(s.node_id) d)`);
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
