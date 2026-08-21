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
 * The graph itself - a `sql_source` -> `modify_columns` -> `dashboard` chain -
 * is built by explore_source.ts, which is also where the reason for that middle
 * node is written down. This file is the *directory* source: its SELECT, its
 * column types, and the one thing only it has - a seeded dashboard, with the
 * grid in tree mode over the exported source.
 */

import {GRID_COLUMNS} from '../dev.perfetto.DataExplorer/dashboard/dashboard_registry';
import type {DashboardItem} from '../dev.perfetto.DataExplorer/dashboard/dashboard_registry';
import type {SerializedDashboard} from '../dev.perfetto.DataExplorer/data_explorer_tabs_storage';
import type {ExploreColumn, ExploreSource} from './explore_source';
import {exploreSelect, exploreSourceGraph} from './explore_source';

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

/**
 * Every column the source node selects, in order. All of them are kept and
 * exported: `id` / `parent_id` because the tree is built from them, the rest
 * because a column the source drops cannot be added to the grid later without
 * editing the graph.
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
 * The build's directories, as a Data Explorer source. Shared by the command
 * that opens a fresh tree and by the panel's button that adds one to the graph
 * the user already has (see explore_source.ts).
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
    'source you can put on a dashboard',
};

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

/** The source node's query. */
export const DIR_TREE_SQL = exploreSelect(DIR_TREE_SOURCE);

/**
 * The graph, in the format documented by the Data Explorer's `graph_format.ts`
 * and accepted by `setActiveGraphJson`. This is the *replacing* payload - the
 * one the command hands over, alongside {@link dirTreeDashboards}; the panel's
 * button appends instead (see explore_source.ts).
 */
export function dirTreeGraphJson(): string {
  return dirTreeGraph().json;
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
    // Points at the *export* node, which is what publishes the data source -
    // taken from the graph rather than written out again, since a dashboard
    // naming a node that isn't there renders nothing and says nothing.
    sourceNodeId: dirTreeGraph().ids.exportNodeId,
    columns: DIR_TREE_GRID_COLUMNS,
    tree: DIR_TREE_GRID_TREE,
    col: 0,
    row: 0,
    colSpan: GRID_COLUMNS,
    rowSpan: GRID_ROW_SPAN,
  };
  return [{id: DIR_TREE_DASHBOARD_ID, items: [grid]}];
}

// The seeded graph, built the same way twice rather than shared as state: it is
// a pure function of the constants above, so both callers see the same ids.
function dirTreeGraph() {
  return exploreSourceGraph(DIR_TREE_SOURCE);
}
