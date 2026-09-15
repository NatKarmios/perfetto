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
 * {@link PROCESS_SOURCE}: `dune_process` as a table the user can add to a Data
 * Explorer graph and query. What the panel's "Processes" button appends;
 * explore_source.ts is the mechanism, data_explorer_handoff.ts the action.
 *
 * Whole-build, like the other two buttons, rather than scoped to the selection:
 * the selection panel's `Processes (N)` accordion already covers that, and
 * `node_id` chips here, so narrowing to one rule inside the Data Explorer is a
 * click.
 *
 * Pure and side-effect free so the payload can be checked against the Data
 * Explorer's own validators in a unit test - the only place it can be checked
 * at all, since it is data, so a typo is a silently dropped node rather than a
 * compile error.
 */

import type {ExploreColumn, ExploreSource} from './explore_source';
import {DUNE_NODE_JOINID} from '../views/node_cell';
import {SLICE_JOINID} from './node_source';

/**
 * Every column `dune_process` has, in the order the grid shows them - row
 * identity first, then timing. All of them: a column the source drops cannot be
 * added to a grid later without editing the graph, whereas one it exports is a
 * click away in the column menu.
 *
 * The typing is the point of the source. `node_id` really is a
 * `dune_node.node_id` - the view LEFT-JOINs it - so it chips, and a NULL from
 * that join renders as an empty cell. `rule_id` is deliberately *not* a node
 * reference: it is dune's own rule id, which collides with unrelated `node_id`s
 * by construction, the same argument as `orig_id` in node_source.ts. `dur_ns`
 * is aliased to `dur` because the cell says "1.2 ms", so a header saying `_ns`
 * would be a lie.
 */
export const PROCESS_COLUMNS: ReadonlyArray<ExploreColumn> = [
  {name: 'slice_id', type: SLICE_JOINID},
  {name: 'node_id', type: DUNE_NODE_JOINID},
  {name: 'rule_id', type: 'int'},
  {name: 'ts', type: 'timestamp'},
  {name: 'dur', type: 'duration', expr: 'dur_ns'},
];

/**
 * The processes the build spawned, as a Data Explorer source - one row per
 * process, joined to the rule that forced it. What the panel's "Processes"
 * button adds to the user's graph (see explore_source.ts).
 */
export const PROCESS_SOURCE: ExploreSource = {
  from: 'dune_process',
  columns: PROCESS_COLUMNS,
  exportName: 'Dune processes',
  label: 'Processes',
  // Not account_tree or hub: three buttons side by side want telling apart at
  // a glance, and these rows are commands the build ran.
  icon: 'terminal',
  title:
    'Add the processes the build spawned - with their timing and the rule ' +
    'that forced each one - to the current Data Explorer graph, as a group ' +
    'you can query further or export to a dashboard. Node ids render as ' +
    'chips, as they do in the Dune query tab',
};
