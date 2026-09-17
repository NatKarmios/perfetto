// Copyright (C) 2025 The Android Open Source Project
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
 * Where an example's serialized graph comes from: an asset path to fetch it
 * from, or the serialized JSON itself. Exactly one of the two.
 *
 * The built-ins live under assets/data_explorer/examples/, which belongs to
 * this plugin. A plugin contributing an example has no asset directory of its
 * own, so it carries its graph inline instead. Either way the JSON is what
 * `deserializeState` reads, so both go through the same validation.
 */
export type ExampleGraphSource =
  | {readonly jsonPath: string; readonly json?: never}
  | {readonly json: string; readonly jsonPath?: never};

/**
 * An entry in the Solutions list and in the Example Graphs modal.
 *
 * Other plugins add their own entries by calling `registerExampleGraph`, which
 * hands back a disposable so that a registration made for one trace goes away
 * with it.
 */
export type ExampleGraph = {
  /** Human-readable label — unique across the registry. */
  readonly name: string;

  /** One-line summary shown under the name. */
  readonly description: string;
} & ExampleGraphSource;

const BUILT_IN_EXAMPLE_GRAPHS: readonly ExampleGraph[] = [
  {
    name: 'Learning',
    description:
      'Interactive tutorial covering node docking, filtering, adding nodes, and multi-child workflows',
    jsonPath: 'assets/data_explorer/examples/learning.json',
  },
  {
    name: 'Slice Analysis Pipeline',
    description:
      'Example data analysis of finding the total duration of specific process slices when any CPU was active ',
    jsonPath: 'assets/data_explorer/examples/slices_example.json',
  },
];

/**
 * The live set of examples: the built-ins, followed by whatever has been
 * registered. Only registered entries are ever removed again, so the built-ins
 * stay at the front and cannot be lost by a plugin's clean-up.
 */
const exampleGraphs: ExampleGraph[] = [...BUILT_IN_EXAMPLE_GRAPHS];

/**
 * Add an example graph to the registry.
 *
 * Registered examples appear after the built-ins everywhere the registry drives
 * the UI (the Solutions section of the navigation side panel and the Example
 * Graphs modal).
 *
 * The registry is global and outlives a trace, so a plugin registering from
 * onTraceLoad must dispose of its registration when the trace goes away:
 *
 *   trace.trash.use(registerExampleGraph(example));
 *
 * Registering a name that is already registered throws. The name is the entry's
 * identity in both surfaces, so this is what makes a leaked registration
 * visible on the next trace load rather than silently winning or losing.
 *
 * @param example The example to add
 * @returns A disposable that removes this registration again.
 */
export function registerExampleGraph(example: ExampleGraph): Disposable {
  if (exampleGraphs.some((e) => e.name === example.name)) {
    throw new Error(`Example graph '${example.name}' is already registered`);
  }
  exampleGraphs.push(example);
  return {
    [Symbol.dispose]: () => {
      // Found by identity, not by name: disposing a stale registration must not
      // clobber whatever has replaced it in the meantime.
      const index = exampleGraphs.indexOf(example);
      if (index !== -1) {
        exampleGraphs.splice(index, 1);
      }
    },
  };
}

/**
 * All currently known examples, in UI order.
 *
 * Call this rather than caching the result at module scope: registrations come
 * and go with the traces that made them, long after this module is first
 * imported.
 */
export function getExampleGraphs(): readonly ExampleGraph[] {
  return exampleGraphs;
}
