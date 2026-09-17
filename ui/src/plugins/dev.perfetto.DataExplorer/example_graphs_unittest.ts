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

import {
  getExampleGraphs,
  registerExampleGraph,
  type ExampleGraph,
} from './example_graphs';

describe('example graph registry', () => {
  // The registry is module state shared by every test in this file, so each
  // registration is undone again before the next test looks at the list.
  const registrations: Disposable[] = [];

  function register(example: ExampleGraph): Disposable {
    const registration = registerExampleGraph(example);
    registrations.push(registration);
    return registration;
  }

  afterEach(() => {
    for (const registration of registrations.splice(0)) {
      registration[Symbol.dispose]();
    }
  });

  const builtInNames = getExampleGraphs().map((e) => e.name);

  it('starts out as the built-ins', () => {
    expect(builtInNames).toEqual(['Learning', 'Slice Analysis Pipeline']);
  });

  it('appends a registered example after the built-ins', () => {
    register({
      name: 'Plugin Example',
      description: 'An example from another plugin',
      json: '{"nodes":[]}',
    });

    expect(getExampleGraphs().map((e) => e.name)).toEqual([
      ...builtInNames,
      'Plugin Example',
    ]);
  });

  it('accepts an example that names an asset path', () => {
    register({
      name: 'Path Example',
      description: 'An example loaded from an asset',
      jsonPath: 'assets/data_explorer/examples/whatever.json',
    });

    const registered = getExampleGraphs().find(
      (e) => e.name === 'Path Example',
    );
    expect(registered?.jsonPath).toBe(
      'assets/data_explorer/examples/whatever.json',
    );
    expect(registered?.json).toBeUndefined();
  });

  it('accepts an example that carries its graph inline', () => {
    register({
      name: 'Inline Example',
      description: 'An example that carries its own JSON',
      json: '{"nodes":[]}',
    });

    const registered = getExampleGraphs().find(
      (e) => e.name === 'Inline Example',
    );
    expect(registered?.json).toBe('{"nodes":[]}');
    expect(registered?.jsonPath).toBeUndefined();
  });

  it('drops a registered example when its registration is disposed', () => {
    const registration = register({
      name: 'Plugin Example',
      description: 'An example from another plugin',
      json: '{"nodes":[]}',
    });

    registration[Symbol.dispose]();

    expect(getExampleGraphs().map((e) => e.name)).toEqual(builtInNames);
  });

  it('keeps the built-ins when a registration is disposed twice', () => {
    const registration = register({
      name: 'Plugin Example',
      description: 'An example from another plugin',
      json: '{"nodes":[]}',
    });

    registration[Symbol.dispose]();
    registration[Symbol.dispose]();

    expect(getExampleGraphs().map((e) => e.name)).toEqual(builtInNames);
  });

  it('rejects an example with neither or both sources', () => {
    // @ts-expect-error - neither jsonPath nor json is given.
    const neither: ExampleGraph = {name: 'Neither', description: 'No graph'};
    // @ts-expect-error - json cannot be given alongside jsonPath.
    const both: ExampleGraph = {
      name: 'Both',
      description: 'Two graphs',
      jsonPath: 'assets/data_explorer/examples/whatever.json',
      json: '{"nodes":[]}',
    };

    expect(neither.name).toBe('Neither');
    expect(both.name).toBe('Both');
  });

  it('throws when a name is already registered', () => {
    register({
      name: 'Plugin Example',
      description: 'An example from another plugin',
      json: '{"nodes":[]}',
    });

    expect(() =>
      registerExampleGraph({
        name: 'Plugin Example',
        description: 'A different example under the same name',
        jsonPath: 'assets/data_explorer/examples/whatever.json',
      }),
    ).toThrow(/Example graph 'Plugin Example' is already registered/);
  });

  it('throws when a built-in name is registered again', () => {
    expect(() =>
      registerExampleGraph({
        name: 'Learning',
        description: 'Shadowing a built-in',
        json: '{"nodes":[]}',
      }),
    ).toThrow(/Example graph 'Learning' is already registered/);
  });
});
