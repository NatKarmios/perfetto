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
 * {@link DIR_TREE_SOURCE}: `dune_dir` as a table the user can add to a Data
 * Explorer graph and query - its SELECT and its column types. This is what the
 * panel's "Directory tree" button appends; explore_source.ts is the mechanism
 * that turns it into graph nodes, and data_explorer_handoff.ts is the action
 * that applies it.
 *
 * Kept pure and side-effect free so the payload can be checked against the Data
 * Explorer's own validators in a unit test, which is the only place it can be
 * checked at all: it is data, so a typo in it is not a compile error but a
 * silently dropped node or column.
 *
 * The build's directories are also a *chart* - the `dune-dir-tree` type
 * registered in dir_explorer_chart.ts - but that is a view of whatever rows the
 * chart's query returns, and quite separate from this table.
 */

import type {ExploreColumn, ExploreSource} from './explore_source';
import {exploreSelect} from './explore_source';

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
 * explore_source.ts).
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
