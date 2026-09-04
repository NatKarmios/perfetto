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
 * Two things, both about the build's directories in the Data Explorer:
 *
 * - {@link DIR_TREE_SOURCE}, `dune_dir` as a table the user can add to a graph
 *   and query - its SELECT and its column types. This is what the panel's
 *   "Directory tree" button appends.
 * - The graph and dashboard the *command* seeds ({@link dirTreeGraphJson},
 *   {@link dirTreeDashboards}), which land the user in front of the directory
 *   tree with nothing to configure. That tree is the `dune-dir-tree` chart
 *   (dir_explorer_chart.ts), and the chart draws the directories its *input
 *   rows* fall in - so what the seeded graph selects is not this file's
 *   directory source at all but node_source.ts's `dune_node`, which is the one
 *   that has a node id column for the chart to join on.
 *
 * data_explorer_handoff.ts is the action that applies either. Kept pure and
 * side-effect free so it can be checked against the Data Explorer's own
 * validators in a unit test, which is the only place this JSON can be checked
 * at all: it is data, so a typo in it is not a compile error but a silently
 * dropped node or item.
 *
 * The graph itself - a `sql_source` -> `modify_columns` -> `dashboard` chain -
 * is built by explore_source.ts, which is also where the reason for that middle
 * node is written down.
 */

import {GRID_COLUMNS} from '../dev.perfetto.DataExplorer/dashboard/dashboard_registry';
import type {DashboardItem} from '../dev.perfetto.DataExplorer/dashboard/dashboard_registry';
import type {SerializedDashboard} from '../dev.perfetto.DataExplorer/data_explorer_tabs_storage';
import {DIR_TREE_CHART_TYPE} from './dir_explorer_chart';
import type {ExploreColumn, ExploreSource} from './explore_source';
import {exploreSelect, exploreSourceGraph} from './explore_source';
import {NODE_SOURCE} from './node_source';

// Stable ids for the seeded dashboard and its one item. Stable rather than
// random so the generated payload is deterministic (and testable); nothing can
// collide with them because seeding *replaces* the tab's dashboards.
export const DIR_TREE_DASHBOARD_ID = 'dune_dir_tree';
const CHART_ITEM_ID = 'dune_dir_chart';

// How tall the chart is, in dashboard grid rows. Full width (GRID_COLUMNS) and
// deep enough to be a whole screen of tree rather than a card.
const CHART_ROW_SPAN = 18;

/**
 * The column the seeded chart reads as a `dune_node.node_id`, which is how it
 * maps each row to a place in the tree (see dir_explorer_chart.ts). It has to
 * be one {@link NODE_SOURCE} exports, and one the chart recognises as
 * node-bearing - otherwise the card renders its "pick the node id column"
 * prompt instead of a tree.
 */
const CHART_NODE_ID_COLUMN = 'node_id';

// The one directory row with no path: `dune_dir` files anything dune reports at
// the top level under the empty prefix, and an empty tree cell reads as a bug.
// Coalesced here, at the display layer, rather than in the mirror - `dune_dir`
// stores the directory dune actually named. (The monorepo trace happens to have
// no such row; small traces do.)
const TOP_LEVEL_LABEL = '(top level)';

/**
 * Every column the source selects, in order. All of them are kept and exported:
 * a column the source drops cannot be added to a grid later without editing the
 * graph, whereas one it exports is a click away in the grid's column menu.
 *
 * Nothing here is an id *reference*, and nothing may become one by accident:
 * `dune_dir`'s `id` / `parent_id` are *directory* ids, from a table that numbers
 * directories, not graph nodes (see {@link ExploreColumn.type}).
 */
export const DIR_TREE_COLUMNS: ReadonlyArray<ExploreColumn> = [
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
 * The build's directories, as a Data Explorer source - one row per directory,
 * with its rollups. What the panel's button adds to the user's graph (see
 * explore_source.ts). Not what the command seeds: the tree it opens is drawn
 * from nodes, not from these rows (see {@link dirTreeGraphJson}).
 */
export const DIR_TREE_SOURCE: ExploreSource = {
  from: 'dune_dir',
  columns: DIR_TREE_COLUMNS,
  exportName: 'Dune directories',
  label: 'Directory tree',
  icon: 'account_tree',
  title:
    "Add the build's directories - with per-directory rule, dependency, " +
    'failure and duration rollups - to the current Data Explorer graph, as a ' +
    'group you can query further or export to a dashboard',
};

/** The directory source's SELECT, as its `sql_source` node carries it. */
export const DIR_TREE_SQL = exploreSelect(DIR_TREE_SOURCE);

/**
 * The graph, in the format documented by the Data Explorer's `graph_format.ts`
 * and accepted by `setActiveGraphJson`. This is the *replacing* payload - the
 * one the command hands over, alongside {@link dirTreeDashboards}; the panel's
 * button appends instead (see explore_source.ts).
 *
 * A query over `dune_node`, not over `dune_dir`: the chart on the other end is
 * a view of *rows*, and the rows it can place are ones carrying a node id.
 * Every node in the build, which is the tree in full - and a query the user can
 * then narrow in the graph tab, with the tree following it.
 */
export function dirTreeGraphJson(): string {
  return dirTreeGraph().json;
}

/**
 * The dashboard to seed alongside the graph: one full-width directory-tree
 * chart over the exported source. Same serialized shape the tab export/import
 * path uses, so `setActiveGraphJson`'s third argument takes it as-is.
 */
export function dirTreeDashboards(): SerializedDashboard[] {
  const chart: DashboardItem = {
    kind: 'chart',
    // Points at the *export* node, which is what publishes the data source -
    // taken from the graph rather than written out again, since a dashboard
    // naming a node that isn't there renders nothing and says nothing.
    sourceNodeId: dirTreeGraph().ids.exportNodeId,
    config: {
      id: CHART_ITEM_ID,
      column: CHART_NODE_ID_COLUMN,
      chartType: DIR_TREE_CHART_TYPE,
    },
    col: 0,
    row: 0,
    colSpan: GRID_COLUMNS,
    rowSpan: CHART_ROW_SPAN,
  };
  return [{id: DIR_TREE_DASHBOARD_ID, items: [chart]}];
}

// The seeded graph, built the same way twice rather than shared as state: it is
// a pure function of the constants above, so both callers see the same ids.
function dirTreeGraph() {
  return exploreSourceGraph(NODE_SOURCE);
}
