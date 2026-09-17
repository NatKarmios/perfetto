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
 * The recipes (dune_recipes.ts), loaded the way the Solutions card loads them.
 *
 * A recipe is static JSON naming node types, macro names and column names,
 * none of which a compiler sees. Rename `dune_rule.dir`, or the node type a
 * source registers under, and everything here still builds - the graph loads,
 * and the card fails at query time on a trace nobody has yet opened. So the
 * assertion is not that the JSON parses. It is that every node comes back
 * valid, which is the same question the node's own panel asks before it will
 * build SQL, and which is where a rename shows up.
 *
 * The tiers are both faked ready. A recipe cannot be validated without that -
 * a Dune source node whose tier is missing correctly refuses - and the
 * descriptors capture the controller at registration, so the fake has to be in
 * place before the graph is deserialized, not after.
 */

import {afterEach, describe, expect, test} from 'vitest';
import {DisposableStack} from '../../../base/disposable_stack';
import type {Trace} from '../../../public/trace';
import {
  getExampleGraphs,
  type ExampleGraph,
} from '../../dev.perfetto.DataExplorer/example_graphs';
import {isSerializedTabExport} from '../../dev.perfetto.DataExplorer/graph_io';
import {
  deserializeState,
  validateSerializedGraph,
} from '../../dev.perfetto.DataExplorer/json_handler';
import {registerCoreNodes} from '../../dev.perfetto.DataExplorer/query_builder/core_nodes';
import {getAllNodes} from '../../dev.perfetto.DataExplorer/query_builder/graph_utils';
import type {SqlModules} from '../../dev.perfetto.SqlModules/sql_modules';
import type {DuneGraphController} from '../controller';
import {registerDuneMacroNodes} from './dune_macro_node';
import {DUNE_RECIPES, registerDuneRecipes} from './dune_recipes';
import {registerDuneSourceNodes} from './dune_table_source';

registerCoreNodes();

// How many nodes each recipe is, asserted rather than derived: a recipe that
// quietly lost a branch would otherwise still pass everything below.
const NODE_COUNT: ReadonlyMap<string, number> = new Map([
  ['Build time by directory', 3],
  ['Process Analysis', 12],
]);

// Registrations are global, so anything registered by a test is collected here
// and dropped afterwards, as dune_table_source_unittest.ts does.
let live: DisposableStack | undefined;

afterEach(() => {
  live?.dispose();
  live = undefined;
});

// A trace stub that is nothing but its trash, which is all a registration
// needs; disposing the stack is what the trace going away looks like.
function traceStub(): Trace {
  const trash = new DisposableStack();
  live ??= new DisposableStack();
  live.defer(() => trash.dispose());
  return {trash} as unknown as Trace;
}

// Both tiers built, which is the only state in which a recipe spanning them
// can be validated at all.
const BUILT = {
  nodeMirrorReady: true,
  edgeMirrorReady: true,
} as unknown as DuneGraphController;

// Everything deserialization needs off a trace, which for these graphs is the
// title alone; no node here reaches the engine or the stdlib catalogue.
const DESERIALIZE_TRACE = {
  traceInfo: {traceTitle: 'test_trace'},
} as unknown as Trace;
const DESERIALIZE_SQL_MODULES = {} as unknown as SqlModules;

// The node types a recipe names, registered against tiers that exist.
function registerNodeTypes(): void {
  const trace = traceStub();
  registerDuneSourceNodes(trace, BUILT);
  registerDuneMacroNodes(trace, BUILT);
}

// The graph a Solutions card would deserialize: the inner graph of a whole-tab
// export, or the JSON itself when it is a bare graph. Both shapes reach
// `deserializeState` this way in graph_io.ts's loadExampleGraph.
function graphOf(recipe: ExampleGraph): string {
  expect(recipe.json, `${recipe.name} carries its JSON inline`).toBeDefined();
  const parsed: unknown = JSON.parse(recipe.json!);
  return isSerializedTabExport(parsed) ? parsed.graph : recipe.json!;
}

describe.each(DUNE_RECIPES.map((r) => [r.name, r] as const))(
  'the %s recipe',
  (name, recipe) => {
    test('loads, and every node it loads is valid', () => {
      registerNodeTypes();

      // Ahead of the load, because `deserializeState` tolerates what this
      // catches: an edge set on one node and not the other leaves a node
      // unreachable, and it is simply dropped rather than reported.
      expect(validateSerializedGraph(graphOf(recipe)).errors).toEqual([]);

      const state = deserializeState(
        graphOf(recipe),
        DESERIALIZE_TRACE,
        DESERIALIZE_SQL_MODULES,
      );
      const nodes = getAllNodes(state.rootNodes);

      expect(nodes.length).toBe(NODE_COUNT.get(name));
      // Named rather than counted, so a failure says which node broke and why
      // instead of "expected 12, got 11".
      expect(
        nodes
          .filter((n) => !n.validate())
          .map(
            (n) => `${n.nodeId} (${n.type}): ${n.context.issues?.queryError}`,
          ),
      ).toEqual([]);
    });

    test('opens on a node, in a tab named after the card', () => {
      registerNodeTypes();

      const state = deserializeState(
        graphOf(recipe),
        DESERIALIZE_TRACE,
        DESERIALIZE_SQL_MODULES,
      );
      // An unselected graph opens on an empty panel, which is the wrong first
      // impression for something offered as a worked answer.
      expect(state.selectedNodes.size).toBe(1);

      // The tab is named from the export's own `title`, and only falls back to
      // the registry entry's name when there is none - so an export-shaped
      // recipe whose title drifts opens under a name the card does not use.
      const parsed: unknown = JSON.parse(recipe.json!);
      if (isSerializedTabExport(parsed)) {
        expect(parsed.title).toBe(name);
      }
    });
  },
);

describe('the recipe registrations', () => {
  test('offer both, and take them away with the trace', () => {
    const before = getExampleGraphs().length;
    registerDuneRecipes(traceStub());

    expect(getExampleGraphs().map((e) => e.name)).toEqual(
      expect.arrayContaining(DUNE_RECIPES.map((r) => r.name)),
    );
    expect(getExampleGraphs().length).toBe(before + DUNE_RECIPES.length);

    live?.dispose();
    live = undefined;
    expect(getExampleGraphs().length).toBe(before);
  });
});
