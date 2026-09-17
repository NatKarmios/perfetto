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
 * Two ready-made graphs in the Data Explorer's Solutions list, so the nodes and
 * charts the rest of `explorer/` offers have somewhere to be seen doing
 * something. A source node and a macro node each answer "what can I start
 * from"; a recipe answers "and then what", which is the harder question and the
 * one a menu cannot.
 *
 * The fourth offer into that plugin - **ARCHITECTURE.md, "Data Explorer" lists
 * all of them**.
 *
 * The two are deliberately not alike. "Dune: Build time by directory" is three
 * nodes, all node tier, so it answers something the moment a trace opens.
 * "Dune: Process Analysis" is twelve nodes over three branches, all three laid
 * out on one dashboard, and one of those branches walks `dune_parents`, which
 * needs the edge tier - a build nobody starts by accident. Opening it before
 * that tier exists is not a failure to hide: the node says what is missing and
 * where to build it, and the other two branches run regardless.
 *
 * The risk a recipe carries is that it is static JSON naming node types and
 * column names. Rename either and nothing here stops compiling; the graph
 * loads and the card fails at query time, on someone else's trace. That is what
 * dune_recipes_unittest.ts exists for, and why `DUNE_RECIPES` is exported: the
 * test deserializes every entry of it through the Data Explorer's own loader.
 */

import type {Trace} from '../../../public/trace';
import type {ExampleGraph} from '../../dev.perfetto.DataExplorer/example_graphs';
import {registerExampleGraph} from '../../dev.perfetto.DataExplorer/example_graphs';
import type {SerializedGraph} from '../../dev.perfetto.DataExplorer/json_handler';
import {PROCESS_ANALYSIS_GRAPH} from './process_analysis_graph';

/**
 * `dune_rule` grouped by `dir_id`, ranked by the action time in it. Grouping on
 * the id rather than a path string is what makes the result's directory column
 * a chip that joins to `dune_dir`.
 *
 * A bare `SerializedGraph` rather than the whole-tab export shape the other
 * recipe uses: there are no dashboards to carry, and `loadExampleGraph` accepts
 * either. Written here rather than exported from the UI because three nodes are
 * quicker to write than to build, and because being written means the group-by
 * and the sort key can be read off the page.
 *
 * No `nodeLayouts`: a chain with no layout is a docked stack under its source,
 * which is what this would look like if it had been built in the UI, and an
 * absent map is also what makes the canvas lay it out itself. `rootNodeIds` is
 * the source alone for the same reason - it is the seed the canvas renders
 * from and traverses out of, not the list of input-less nodes it reads like.
 */
const BUILD_TIME_BY_DIRECTORY: SerializedGraph = {
  nodes: [
    {
      nodeId: '1',
      type: 'dune_source_dune_rule',
      state: {table: 'dune_rule'},
      nextNodes: ['2'],
    },
    {
      nodeId: '2',
      type: 'aggregation',
      // `action_dur_ns` is NULL for a cache hit, which ran no action at all,
      // so the sum is time actually spent and the count is every rule in the
      // directory whether it ran or not. The difference between the two is the
      // useful part of the answer.
      state: {
        groupByColumns: [
          {
            name: 'dir_id',
            type: {
              kind: 'joinid',
              source: {table: 'dune_dir', column: 'dir_id'},
            },
            checked: true,
          },
        ],
        aggregations: [
          {
            column: {name: 'action_dur_ns', type: {kind: 'duration'}},
            aggregationOp: 'SUM',
            newColumnName: 'action_dur_ns_total',
          },
          {aggregationOp: 'COUNT(*)', newColumnName: 'rules'},
        ],
      },
      nextNodes: ['3'],
      primaryInputId: '1',
    },
    {
      nodeId: '3',
      type: 'sort',
      state: {
        sortCriteria: [{colName: 'action_dur_ns_total', direction: 'DESC'}],
      },
      nextNodes: [],
      primaryInputId: '2',
    },
  ],
  rootNodeIds: ['1'],
  // The answer, rather than the source, so the card opens on a result.
  selectedNodeId: '3',
};

/**
 * The recipes, in the order they appear under the built-in examples. Exported
 * for the test, which needs the entries themselves rather than whatever the
 * global registry happens to hold.
 *
 * Both names carry a `Dune: ` prefix, because the Solutions list is shared with
 * Perfetto's own examples and a bare "Process Analysis" there does not say
 * whose processes.
 */
export const DUNE_RECIPES: readonly ExampleGraph[] = [
  {
    name: 'Dune: Build time by directory',
    // One line each, as the built-in examples' are: this is the subtitle on a
    // card, not the documentation.
    description:
      'Every rule grouped by its directory and ranked by the action time in ' +
      'each. The grouped column is a directory chip, and joins to the ' +
      'Directories source. Needs only the node tier.',
    json: JSON.stringify(BUILD_TIME_BY_DIRECTORY),
  },
  {
    name: 'Dune: Process Analysis',
    description:
      'Every process the build ran: how many at once over time, the thirty ' +
      'longest with the rule and command behind each, and a duration ' +
      'histogram. The thirty longest need the edge tier.',
    json: PROCESS_ANALYSIS_GRAPH,
  },
];

// Registered for as long as `trace` lives, for the reason
// registerDuneSourceNodes() gives: the example registry is global and outlives
// a trace. Registering a name twice throws by design, so a leaked registration
// surfaces on the next trace load rather than quietly doubling the list.
export function registerDuneRecipes(trace: Trace): void {
  for (const recipe of DUNE_RECIPES) {
    trace.trash.use(registerExampleGraph(recipe));
  }
}
