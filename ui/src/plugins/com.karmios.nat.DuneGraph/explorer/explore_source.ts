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
 * One of the mirror's tables, offered to the Data Explorer as a data source -
 * the mechanism shared by dir_tree_source.ts's directories and
 * node_source.ts's nodes. What varies between them is a table name, a column
 * list and a name; the *shape* of the hand-off is here.
 *
 * **README.md, "The four surfaces", explains the shape**: why each source
 * becomes a `sql_source -> modify_columns` chain in a group, and why nothing is
 * exported to a dashboard.
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
} from '../../dev.perfetto.DataExplorer/json_handler';
import {NodeType} from '../../dev.perfetto.DataExplorer/query_node';
import type {
  PerfettoSqlType,
  SimpleTypeKind,
} from '../../../trace_processor/perfetto_sql_type';

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

/**
 * The chain a source always becomes, by id: the two inner nodes, and the group
 * wrapped over them. {@link chainNodes} numbers the inner pair and the group is
 * added on top afterwards, so that step works in the `Omit` of this.
 */
interface ExploreSourceIds {
  readonly sourceNodeId: string;
  readonly columnsNodeId: string;
  readonly groupNodeId: string;
}

/** A serialized graph plus the ids the source's own nodes ended up with. */
interface ExploreSourceGraph {
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

// The chain merged into the graph the user already has (see the README for why
// it is grouped and why nothing is exported). `existing` is undefined when
// there is no graph yet, in which case this is just a seed in the same shape.
//
// The group survives the round-trip: a `group` node serializes as its name plus
// `innerNodeIds`, and its end node - the `modify_columns`, the only inner node
// with no inner successor - becomes its output port, so it can be connected
// onwards like any node.
export function appendExploreSourceToGraph(
  existing: string | undefined,
  source: ExploreSource,
): ExploreSourceGraph {
  const graph = parseGraph(existing);
  const base = firstFreeNodeId(graph.nodes);
  const {nodes, ids} = chainNodes(source, base);
  const groupNodeId = String(base + 2);
  nodes.push({
    nodeId: groupNodeId,
    type: NodeType.kGroup,
    state: {name: uniqueName(groupNames(graph.nodes), source.exportName)},
    // Order matters only in that the end node must be discoverable; the
    // loader finds it by looking for the inner node with no inner successor.
    innerNodeIds: [ids.sourceNodeId, ids.columnsNodeId],
    nextNodes: [],
  });
  return {
    json: JSON.stringify(
      {
        // Spread first: node layouts, labels, sidebar width and anything else
        // the format grows are the user's, and are none of our business.
        ...graph,
        nodes: [...graph.nodes, ...nodes],
        // The group is the root, not the source node inside it: inner nodes
        // are reached by traversing the group, and listing one as a root would
        // draw it in the outer graph as well.
        rootNodeIds: [...graph.rootNodeIds, groupNodeId],
        // Select what was just added, so the click visibly did something even
        // on the graph tab. Nothing else is disturbed by this: the whole graph
        // is rebuilt from JSON on every call anyway (see
        // data_explorer_handoff.ts), so there is no in-place edit to preserve.
        selectedNodeId: groupNodeId,
      },
      undefined,
      2,
    ),
    ids: {...ids, groupNodeId},
  };
}

/**
 * The graph to append to: the parsed `existing`, or an empty one when there is
 * nothing there yet. Throws on anything else, which is the right outcome - the
 * caller turns it into a modal rather than replacing a graph it failed to
 * understand.
 */
function parseGraph(existing: string | undefined): SerializedGraph {
  if (existing === undefined || existing.trim() === '') {
    return {nodes: [], rootNodeIds: []};
  }
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
  return graph as SerializedGraph;
}

/**
 * The chain itself, numbered from `base`. Its one edge is written from both
 * ends (`nextNodes` plus `primaryInputId`), which the graph format requires - a
 * one-sided edge is dropped on load. Nothing follows the columns node: what is
 * done with the source is the user's call (see
 * {@link appendExploreSourceToGraph}).
 */
function chainNodes(
  source: ExploreSource,
  base: number,
): {nodes: SerializedNode[]; ids: Omit<ExploreSourceIds, 'groupNodeId'>} {
  const ids: Omit<ExploreSourceIds, 'groupNodeId'> = {
    sourceNodeId: String(base),
    columnsNodeId: String(base + 1),
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

/** The names the graph's groups already use, for {@link uniqueName}. */
function groupNames(nodes: ReadonlyArray<SerializedNode>): Set<string> {
  return new Set(
    nodes
      .filter((n) => n.type === NodeType.kGroup)
      .map((n) => (n.state as {name?: string}).name)
      .filter((name): name is string => name !== undefined),
  );
}

/**
 * The name to use, given what is already taken. Adding the same source twice is
 * legitimate (two views of the same table, filtered differently), but two
 * identically titled groups - or two identically named entries in the
 * dashboard's source picker - are indistinguishable, so later ones are
 * numbered.
 */
function uniqueName(taken: ReadonlySet<string>, wanted: string): string {
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; ; i++) {
    const candidate = `${wanted} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
