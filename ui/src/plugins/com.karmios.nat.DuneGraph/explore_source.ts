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
 * One of the mirror's tables, offered to the Data Explorer as a data source the
 * user can put on a dashboard - the mechanism shared by every such offer
 * (dir_tree_graph.ts's directories, node_source.ts's nodes). What varies
 * between them is a table name, a column list and a name; the *shape* of the
 * hand-off is all here.
 *
 * Each source becomes three serialized Data Explorer nodes:
 *
 *   sql_source (SELECT ... FROM <table>) -> modify_columns -> dashboard
 *
 * The middle node looks redundant - a source feeding the export directly is the
 * obvious graph - but it is what makes the hand-off work at all, and the reason
 * is invisible from the dashboard end:
 *
 * - A dashboard item renders nothing until its data source reports columns
 *   (`DashboardGridView` bails out with "No columns" before it would ever ask
 *   for execution), and a `DashboardNode` reports whatever its input's
 *   `finalCols` are.
 * - A `sql_source` node's `finalCols` are *discovered by running it*. They are
 *   empty on a freshly loaded graph, and a source node is `autoExecute: false`,
 *   so nothing runs it until the user presses "Run Query" in the query builder.
 *   Source -> export therefore lands the user on a dashboard that says "No
 *   columns" and needs a manual trip through the graph tab.
 * - A `modify_columns` node's `finalCols` come from its *serialized*
 *   `selectedColumns`, and its deserializer has no `postDeserializeLate` hook
 *   that would recompute them from the (still empty) input. So the columns are
 *   known the instant the graph is loaded, the grid renders, and its own
 *   wait-then-`requestExecution()` path materialises the chain - the SQL
 *   included, since it is the inner query.
 *
 * It is also the only place a column's *type* can be declared, which is what
 * decides how the grid renders it: a duration as a duration, and a node id as a
 * node chip (see node_cell.ts's renderer registry).
 *
 * Two ways to apply a source, and the difference is the whole of the panel's
 * split between opening and adding (see DATA_EXPLORER_PLAN.LOCAL.md, phase 5):
 * {@link exploreSourceGraph} builds a graph that *is* the source (the command's
 * replace-and-navigate path), while {@link appendExploreSourceToGraph} merges
 * one into a graph the user is already working in.
 *
 * The column list has to match what the SELECT returns; both come from the same
 * declaration below, so they cannot drift. The payload is otherwise *data*, so
 * a mistake in it is not a compile error but a silently dropped node - hence
 * the Data Explorer's own `SerializedNode` / `NodeType` here, and the unit test
 * that runs the result through its validators.
 */

import type {
  SerializedGraph,
  SerializedNode,
} from '../dev.perfetto.DataExplorer/json_handler';
import {NodeType} from '../dev.perfetto.DataExplorer/query_node';
import type {
  PerfettoSqlType,
  SimpleTypeKind,
} from '../../trace_processor/perfetto_sql_type';

/** One column of a source: what it is called, what it is, where it comes from. */
export interface ExploreColumn {
  readonly name: string;
  /**
   * The column's PerfettoSQL type, which is what decides how the grid renders
   * it (see `resolveColumnRenderers`): a bare {@link SimpleTypeKind} for the
   * simple cases, or a full {@link PerfettoSqlType} where the type carries more
   * than a kind - notably an id reference such as `JOINID(dune_node.node_id)`
   * (`DUNE_NODE_JOINID` in node_cell.ts), which renders as a node chip.
   *
   * An id type is a claim about *which table's* ids these are, so it has to be
   * true: a column of directory ids typed as node ids would chip each row as
   * whatever unrelated node happened to share the number.
   */
  readonly type: SimpleTypeKind | PerfettoSqlType;
  // The SELECT expression, when the column is not simply passed through.
  readonly expr?: string;
}

/**
 * A table of the mirror, as something the Data Explorer can show. The last
 * three fields are the panel's button (see panel.ts); the rest is the payload.
 */
export interface ExploreSource {
  // The relation the SELECT reads - a mirror view, e.g. `dune_dir`.
  readonly from: string;
  readonly columns: ReadonlyArray<ExploreColumn>;
  // What the exported source is called in the dashboard's source list.
  readonly exportName: string;
  readonly label: string;
  readonly icon: string;
  readonly title: string;
}

/** The three nodes a source becomes, by id. */
export interface ExploreSourceIds {
  readonly sourceNodeId: string;
  readonly columnsNodeId: string;
  readonly exportNodeId: string;
}

/** A serialized graph plus the ids the source's own nodes ended up with. */
export interface ExploreSourceGraph {
  readonly json: string;
  readonly ids: ExploreSourceIds;
}

/**
 * A column's type in the object form the serialized graph carries. The Data
 * Explorer's loader takes a `PerfettoSqlType` object as-is (a string goes
 * through `parsePerfettoSqlTypeFromString`, which is the legacy path), so an
 * id type survives the round-trip into the exported source's columns.
 */
export function exploreColumnType(col: ExploreColumn): PerfettoSqlType {
  return typeof col.type === 'string' ? {kind: col.type} : col.type;
}

/**
 * The source node's query: one SELECT, no trailing semicolon and no leading
 * statements - which is all `SqlSourceNode` accepts.
 */
export function exploreSelect(source: ExploreSource): string {
  return [
    'SELECT',
    source.columns
      .map((c) =>
        c.expr === undefined ? `  ${c.name}` : `  ${c.expr} AS ${c.name}`,
      )
      .join(',\n'),
    `FROM ${source.from}`,
  ].join('\n');
}

/**
 * A graph that is nothing but this source, with ids from zero - what the
 * "open it" path hands to `setActiveGraphJson`, replacing whatever was there.
 */
export function exploreSourceGraph(source: ExploreSource): ExploreSourceGraph {
  const {nodes, ids} = sourceNodes(source, 0, source.exportName);
  return {
    json: JSON.stringify(
      {
        nodes,
        // The source node is the only input-less node, so it is the only root.
        rootNodeIds: [ids.sourceNodeId],
        // Whoever switches to the graph tab lands on the SQL, which is the one
        // node worth reading (and editing) here.
        selectedNodeId: ids.sourceNodeId,
      },
      undefined,
      2,
    ),
    ids,
  };
}

/**
 * The same three nodes, merged into a graph the user already has - what the
 * panel's buttons hand back to `setActiveGraphJson`. Everything already in the
 * graph survives untouched, ids and all: the ids are what the user's dashboard
 * items name their data sources by, so renumbering anything would silently
 * detach them.
 *
 * @param existing The current graph JSON (`getActiveGraphJson()`), or undefined
 *     when there is no graph yet - in which case this is just a seed.
 * @param source The source to add.
 * @returns The merged graph, and the ids the new nodes were given.
 */
export function appendExploreSourceToGraph(
  existing: string | undefined,
  source: ExploreSource,
): ExploreSourceGraph {
  if (existing === undefined || existing.trim() === '') {
    return exploreSourceGraph(source);
  }
  // Throws on malformed JSON, which is the right outcome: the caller turns it
  // into a modal rather than replacing a graph it failed to understand.
  const graph = JSON.parse(existing) as Partial<SerializedGraph> | null;
  if (
    graph === null ||
    typeof graph !== 'object' ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.rootNodeIds)
  ) {
    throw new Error(
      "The Data Explorer's current graph is not in the expected format, so " +
        'nothing can be added to it.',
    );
  }
  const {nodes, ids} = sourceNodes(
    source,
    firstFreeNodeId(graph.nodes),
    uniqueExportName(graph.nodes, source.exportName),
  );
  return {
    json: JSON.stringify(
      {
        // Spread first: node layouts, labels, sidebar width and anything else
        // the format grows are the user's, and are none of our business.
        ...graph,
        nodes: [...graph.nodes, ...nodes],
        rootNodeIds: [...graph.rootNodeIds, ids.sourceNodeId],
        // Select what was just added, so the click visibly did something even
        // on the graph tab. Nothing else is disturbed by this: the whole graph
        // is rebuilt from JSON on every call anyway (see
        // data_explorer_handoff.ts), so there is no in-place edit to preserve.
        selectedNodeId: ids.sourceNodeId,
      },
      undefined,
      2,
    ),
    ids,
  };
}

/**
 * The three nodes themselves, numbered from `base`. Edges are written from both
 * ends (`nextNodes` plus `primaryInputId`), which the graph format requires - a
 * one-sided edge is dropped on load.
 */
function sourceNodes(
  source: ExploreSource,
  base: number,
  exportName: string,
): {nodes: SerializedNode[]; ids: ExploreSourceIds} {
  const ids: ExploreSourceIds = {
    sourceNodeId: String(base),
    columnsNodeId: String(base + 1),
    exportNodeId: String(base + 2),
  };
  const nodes: SerializedNode[] = [
    {
      nodeId: ids.sourceNodeId,
      type: NodeType.kSqlSource,
      state: {sql: exploreSelect(source)},
      nextNodes: [ids.columnsNodeId],
    },
    {
      nodeId: ids.columnsNodeId,
      type: NodeType.kModifyColumns,
      state: {
        selectedColumns: source.columns.map((c) => ({
          name: c.name,
          // Explicit: the loader defaults an omitted `checked` to false, which
          // would export no columns at all.
          checked: true,
          type: exploreColumnType(c),
          // "Don't re-derive this from upstream." Not strictly a user edit, but
          // it is the flag that means exactly that, and without it the types
          // above are transient: `ModifyColumnsNode.onPrevNodesUpdated()`
          // rebuilds `selectedColumns` from the input's `finalCols`, and a
          // `sql_source` that has just run reports its columns as names with no
          // type at all (`SqlSourceNode.setSourceColumns`). So one press of
          // "Run Query" in the query builder would otherwise turn every
          // duration back into a bare nanosecond count and every node id back
          // into a bare integer.
          typeUserModified: true,
        })),
      },
      primaryInputId: ids.sourceNodeId,
      nextNodes: [ids.exportNodeId],
    },
    {
      nodeId: ids.exportNodeId,
      type: NodeType.kDashboard,
      state: {exportName},
      primaryInputId: ids.columnsNodeId,
      nextNodes: [],
    },
  ];
  return {nodes, ids};
}

/**
 * The lowest id the new nodes can take without colliding with anything, now or
 * later: one above the highest number any existing id parses as. That is the
 * same rule the Data Explorer's own loader applies to its node counter
 * (`ensureCounterAbove`), so ids allocated this way are also above the counter
 * and cannot collide with a node the user adds afterwards either.
 */
function firstFreeNodeId(nodes: ReadonlyArray<SerializedNode>): number {
  let next = 0;
  for (const node of nodes) {
    // Ids are strings and need not be numeric at all; a non-numeric one can't
    // collide with a number, so it just doesn't constrain the choice.
    const num = Number.parseInt(node.nodeId, 10);
    if (Number.isFinite(num) && num >= next) next = num + 1;
  }
  return next;
}

/**
 * The export name to use, given what the graph already exports. Adding the same
 * source twice is legitimate (two views of the same table, filtered
 * differently), but two identically-named entries in the dashboard's source
 * picker are indistinguishable, so later ones are numbered.
 */
function uniqueExportName(
  nodes: ReadonlyArray<SerializedNode>,
  wanted: string,
): string {
  const taken = new Set(
    nodes
      .filter((n) => n.type === NodeType.kDashboard)
      .map((n) => (n.state as {exportName?: string}).exportName),
  );
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; ; i++) {
    const candidate = `${wanted} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
