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
 * The graph's nodes themselves - `dune_node` - as a Data Explorer source (see
 * explore_source.ts for what that means and how it is applied).
 *
 * This is the source that makes the renderer registry pay off: `node_id` is
 * declared as `JOINID(dune_node.node_id)`, which is what node_cell.ts's
 * registration keys on, so every row of every grid built from this source draws
 * the same node chip - kind, label, link to the slice, ＋/－ graph toggle - that
 * the query tab draws. Nothing else in this file is doing anything the dir-tree
 * source doesn't; the type on that one column is the point.
 */

import type {ExploreColumn, ExploreSource} from './explore_source';
import {DUNE_NODE_JOINID, DUNE_NODE_TABLE} from './node_cell';
import type {PerfettoSqlType} from '../../trace_processor/perfetto_sql_type';

/**
 * A reference to a trace slice. Not one of ours: `slice` is one of the tables
 * the DataGrid renders ids of out of the box (`BUILT_IN_ID_COLUMN_RENDERERS`),
 * as a link that selects the slice on the timeline - so declaring the type is
 * all it takes to get that.
 */
const SLICE_JOINID: PerfettoSqlType = {
  kind: 'joinid',
  source: {table: 'slice', column: 'id'},
};

/**
 * Every column `dune_node` has, in the order the grid shows them.
 *
 * All of them, deliberately: `dune_node` is already the *narrow* table - the
 * mirror splits per-kind detail out into `dune_rule` / `dune_dep` precisely so
 * that what's left is meaningful for every node (see sql_graph.ts) - and a
 * column the source drops cannot be added to a grid later without editing the
 * graph, whereas one it exports is a click away in the grid's column menu.
 * The typing *is* a choice, though, and it is what the grid renders from:
 *
 * - `node_id` as a node reference: the chip, and the reason for this source.
 * - `slice_id` as a slice reference: a timeline link, for free (see above).
 * - `ts` / `dur` as timestamp and duration, so they read as times rather than
 *   as 19-digit integers. `dur_ns` is aliased to `dur` for the same reason the
 *   dir tree drops the suffix: the cell says "1.2ms", so a header saying `_ns`
 *   is a lie.
 * - everything else plainly. `orig_id` in particular is *not* a node reference:
 *   it is the trace-side id (a rule's dune id, a dep's dict id), which collides
 *   with unrelated `node_id`s by construction.
 */
export const DUNE_NODE_COLUMNS: ReadonlyArray<ExploreColumn> = [
  {name: 'node_id', type: DUNE_NODE_JOINID},
  {name: 'kind', type: 'string'},
  {name: 'label', type: 'string'},
  {name: 'orig_id', type: 'int'},
  {name: 'slice_id', type: SLICE_JOINID},
  {name: 'forced_by_kind', type: 'string'},
  {name: 'forced_by_target', type: 'string'},
  {name: 'ts', type: 'timestamp'},
  {name: 'dur', type: 'duration', expr: 'dur_ns'},
  {name: 'occurrences', type: 'int', expr: 'n_occurrences'},
];

/**
 * The build graph's nodes, as a Data Explorer source. No dashboard to go with
 * it: one flat table of nodes has no single obvious presentation the way the
 * directory tree does, and the point of adding it is that the user is already
 * building something to put it in.
 */
export const NODE_SOURCE: ExploreSource = {
  from: DUNE_NODE_TABLE,
  columns: DUNE_NODE_COLUMNS,
  exportName: 'Dune nodes',
  label: 'Nodes',
  // Not the dir tree's account_tree: this is the flat node table, and two
  // buttons side by side want telling apart at a glance.
  icon: 'hub',
  title:
    "Add the build graph's nodes - rules and dependencies, with their " +
    'timing - to the current Data Explorer graph, as a source you can put on ' +
    'a dashboard. Node ids render as chips, as they do in the Dune query tab',
};
