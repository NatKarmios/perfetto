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
 * The Data Explorer graph and dashboard that show `dune_dir` as a collapsible
 * directory tree - the JSON half of the hand-off (data_explorer_handoff.ts is
 * the action that applies it). Kept pure and side-effect free so it can be
 * checked against the Data Explorer's own validators in a unit test, which is
 * the only place this JSON can be checked at all: it is data, so a typo in it
 * is not a compile error but a silently dropped node or item.
 *
 * The graph is three nodes:
 *
 *   sql_source (dune_dir) -> modify_columns -> dashboard
 *
 * The middle node looks redundant - the plan called for the source feeding the
 * export directly - but it is what makes the hand-off work at all, and the
 * reason is worth spelling out because nothing about it is visible from the
 * dashboard end:
 *
 * - A dashboard item renders nothing until its data source reports columns
 *   (`DashboardGridView` bails out with "No columns" before it would ever ask
 *   for execution), and a `DashboardNode` reports whatever its input's
 *   `finalCols` are.
 * - A `sql_source` node's `finalCols` are *discovered by running it*. They are
 *   empty on a freshly loaded graph, and a source node is `autoExecute: false`,
 *   so nothing runs it until the user presses "Run Query" in the query builder.
 *   Source -> export therefore lands the user on a dashboard that says "No
 *   columns" and needs a manual trip through the graph tab - exactly what this
 *   command exists to avoid.
 * - A `modify_columns` node's `finalCols` come from its *serialized*
 *   `selectedColumns`, and its deserializer has no `postDeserializeLate` hook
 *   that would recompute them from the (still empty) input. So the columns
 *   below are known the instant the graph is loaded, the grid renders, and its
 *   own wait-then-`requestExecution()` path materialises the chain - the SQL
 *   included, since it is the inner query.
 *
 * The columns therefore have to match what the SELECT returns; the unit test
 * pins that. If the SELECT and this list ever disagree, the mismatch surfaces
 * as a query error on the grid rather than as anything obviously column-shaped.
 */

import {GRID_COLUMNS} from '../dev.perfetto.DataExplorer/dashboard/dashboard_registry';
import type {DashboardItem} from '../dev.perfetto.DataExplorer/dashboard/dashboard_registry';
import type {SerializedDashboard} from '../dev.perfetto.DataExplorer/data_explorer_tabs_storage';
import type {
  PerfettoSqlType,
  SimpleTypeKind,
} from '../../trace_processor/perfetto_sql_type';

// Node ids. Numeric strings, like the Data Explorer's own: the loader bumps its
// node counter above every numeric id it sees, so these can never collide with
// nodes the user adds afterwards.
const SOURCE_NODE_ID = '0';
const COLUMNS_NODE_ID = '1';
const EXPORT_NODE_ID = '2';

// What the exported source is called in the dashboard's source list.
const EXPORT_NAME = 'Dune directories';

// Stable ids for the seeded dashboard and its one item. Stable rather than
// random so the generated payload is deterministic (and testable); nothing can
// collide with them because seeding *replaces* the tab's dashboards.
export const DIR_TREE_DASHBOARD_ID = 'dune_dir_tree';
const GRID_ITEM_ID = 'dune_dir_grid';

// How tall the grid is, in dashboard grid rows. Full width (GRID_COLUMNS) and
// deep enough to be a whole screen of tree rather than a card.
const GRID_ROW_SPAN = 18;

// The one directory row with no path: `dune_dir` files anything dune reports at
// the top level under the empty prefix, and an empty tree cell reads as a bug.
// Coalesced here, at the display layer, rather than in the mirror - `dune_dir`
// stores the directory dune actually named. (The monorepo trace happens to have
// no such row; small traces do.)
const TOP_LEVEL_LABEL = '(top level)';

export interface DirTreeColumn {
  readonly name: string;
  /**
   * The column's PerfettoSQL type, which is what decides how the grid renders
   * it (see `resolveColumnRenderers`): a bare {@link SimpleTypeKind} for the
   * simple cases, or a full {@link PerfettoSqlType} where the type carries
   * more than a kind - notably an id reference such as
   * `JOINID(dune_node.node_id)` (`DUNE_NODE_JOINID` in node_cell.ts), which
   * renders as a node chip.
   *
   * Nothing here is such a reference, and must not become one by accident:
   * `dune_dir`'s `id` / `parent_id` are *directory* ids, from a table that
   * numbers directories, not graph nodes. Typing them as node joinids would
   * chip them as whatever unrelated node happened to share the number.
   */
  readonly type: SimpleTypeKind | PerfettoSqlType;
  // The SELECT expression, when the column is not simply passed through.
  readonly expr?: string;
}

/**
 * A column's type in the object form the serialized graph carries. The Data
 * Explorer's loader takes a `PerfettoSqlType` object as-is (a string goes
 * through `parsePerfettoSqlTypeFromString`, which is the legacy path), so an
 * id type survives the round-trip into the exported source's columns.
 */
export function dirTreeColumnType(col: DirTreeColumn): PerfettoSqlType {
  return typeof col.type === 'string' ? {kind: col.type} : col.type;
}

/**
 * Every column the source node selects, in order. All of them are kept and
 * exported: `id` / `parent_id` because the tree is built from them, the rest
 * because a column the source drops cannot be added to the grid later without
 * editing the graph.
 */
export const DIR_TREE_COLUMNS: ReadonlyArray<DirTreeColumn> = [
  {name: 'id', type: 'int'},
  {name: 'parent_id', type: 'int'},
  {
    name: 'path',
    type: 'string',
    expr: `iif(path = '', '${TOP_LEVEL_LABEL}', path)`,
  },
  {
    name: 'name',
    type: 'string',
    expr: `iif(name = '', '${TOP_LEVEL_LABEL}', name)`,
  },
  {name: 'depth', type: 'int'},
  // `dune_dir`'s own names are terse (`n_` for this directory, `t_` for its
  // whole subtree) because they are column names in a mirror nobody reads
  // directly. In a grid they are headers, so they are aliased to say which is
  // which. The `_ns` suffixes go too: the duration columns render through the
  // duration widget, so a nanosecond marker would be misleading.
  {name: 'rules_here', type: 'int', expr: 'n_rules'},
  {name: 'deps_here', type: 'int', expr: 'n_deps'},
  {name: 'failed_here', type: 'int', expr: 'n_failed'},
  {name: 'rules_subtree', type: 'int', expr: 't_rules'},
  {name: 'deps_subtree', type: 'int', expr: 't_deps'},
  {name: 'failed_subtree', type: 'int', expr: 't_failed'},
  {name: 'dur_here', type: 'duration', expr: 'self_dur_ns'},
  {name: 'dur_subtree', type: 'duration', expr: 'total_dur_ns'},
];

/**
 * The columns the grid shows, in display order: the tree column, then the
 * subtree rollups (a collapsed row's interesting number is its subtree's), then
 * the directory's own counts. `id` / `parent_id` / `depth` / `path` /
 * `failed_here` stay hidden - plumbing, or redundant next to the column beside
 * them - but remain in the data source, so the grid's column menu can bring
 * them back.
 */
export const DIR_TREE_GRID_COLUMNS: ReadonlyArray<string> = [
  'name',
  'rules_subtree',
  'deps_subtree',
  'failed_subtree',
  'dur_subtree',
  'rules_here',
  'deps_here',
  'dur_here',
];

/**
 * The tree configuration: `dune_dir` is shaped for exactly this (see
 * sql_graph.ts), with a NULL `parent_id` on each root.
 */
export const DIR_TREE_GRID_TREE = {
  idField: 'id',
  parentIdField: 'parent_id',
  // The segment, not the full path: the tree's indentation already carries the
  // ancestry, and these paths reach depth 19, so repeating every ancestor in
  // every row makes the column enormous and hard to scan. `path` is still in
  // the source for anyone who wants to add it back.
  treeColumn: 'name',
} as const;

/**
 * The source node's query. One SELECT, no trailing semicolon and no leading
 * statements - which is all `SqlSourceNode` accepts.
 */
export const DIR_TREE_SQL = [
  'SELECT',
  DIR_TREE_COLUMNS.map((c) =>
    c.expr === undefined ? `  ${c.name}` : `  ${c.expr} AS ${c.name}`,
  ).join(',\n'),
  'FROM dune_dir',
].join('\n');

/**
 * The graph, in the format documented by the Data Explorer's `graph_format.ts`
 * and accepted by `setActiveGraphJson`. Edges are written from both ends
 * (`nextNodes` plus `primaryInputId`), which that format requires - a one-sided
 * edge is dropped on load.
 */
export function dirTreeGraphJson(): string {
  return JSON.stringify(
    {
      nodes: [
        {
          nodeId: SOURCE_NODE_ID,
          type: 'sql_source',
          state: {sql: DIR_TREE_SQL},
          nextNodes: [COLUMNS_NODE_ID],
        },
        {
          nodeId: COLUMNS_NODE_ID,
          type: 'modify_columns',
          state: {
            selectedColumns: DIR_TREE_COLUMNS.map((c) => ({
              name: c.name,
              // Explicit: the loader defaults an omitted `checked` to false,
              // which would export no columns at all.
              checked: true,
              type: dirTreeColumnType(c),
            })),
          },
          primaryInputId: SOURCE_NODE_ID,
          nextNodes: [EXPORT_NODE_ID],
        },
        {
          nodeId: EXPORT_NODE_ID,
          type: 'dashboard',
          state: {exportName: EXPORT_NAME},
          primaryInputId: COLUMNS_NODE_ID,
          nextNodes: [],
        },
      ],
      // The source node is the only input-less node, so it is the only root.
      rootNodeIds: [SOURCE_NODE_ID],
      // Whoever switches to the graph tab lands on the SQL, which is the one
      // node worth reading (and editing) here.
      selectedNodeId: SOURCE_NODE_ID,
    },
    undefined,
    2,
  );
}

/**
 * The dashboard to seed alongside the graph: one full-width grid in tree mode
 * over the exported source. Same serialized shape the tab export/import path
 * uses, so `setActiveGraphJson`'s third argument takes it as-is.
 */
export function dirTreeDashboards(): SerializedDashboard[] {
  const grid: DashboardItem = {
    kind: 'grid',
    id: GRID_ITEM_ID,
    // Points at the *export* node, which is what publishes the data source.
    sourceNodeId: EXPORT_NODE_ID,
    columns: DIR_TREE_GRID_COLUMNS,
    tree: DIR_TREE_GRID_TREE,
    col: 0,
    row: 0,
    colSpan: GRID_COLUMNS,
    rowSpan: GRID_ROW_SPAN,
  };
  return [{id: DIR_TREE_DASHBOARD_ID, items: [grid]}];
}
