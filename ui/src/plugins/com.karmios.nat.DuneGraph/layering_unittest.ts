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

import {describe, expect, test} from 'vitest';

/**
 * The plugin's directories are layers, and imports may only point downward.
 * This is the test that says so, because nothing else can: the repo's eslint
 * has no import-boundary plugin, and adding a dependency to upstream's lint
 * config for a rule that governs one plugin is not a trade worth making.
 *
 * The sources are read through Vite's `import.meta.glob` rather than `node:fs`
 * - `tools/check_imports` allows `node:fs` only under `ui/src/test/`, and this
 * belongs beside the code it governs. The same mechanism is what
 * `frontend/plugins.ts` uses to discover plugins.
 */

// Lower numbers are further down. The three modules at the plugin root are
// three different layers despite sharing a directory, so they are named
// individually: `perf.ts` is a leaf utility everything may use, `controller.ts`
// orchestrates the tiers below it, and `index.ts` is the entry point that
// registers everything.
const LAYER_OF_DIR: ReadonlyMap<string, number> = new Map([
  ['model', 1],
  ['sql', 2],
  ['views', 4],
  ['explorer', 4],
]);
const LAYER_OF_ROOT_FILE: ReadonlyMap<string, number> = new Map([
  ['perf', 0],
  ['controller', 3],
  ['index', 5],
]);

// `views/` and `explorer/` share a layer deliberately: the panel reaches the
// Data Explorer hand-off and the hand-off reaches the panel's own tree, so
// ordering them against each other would only manufacture violations.

/**
 * Edges that point the wrong way and are known to. Empty is the goal; each
 * entry is a debt with a reason, not a permission.
 */
const ALLOWED_UPWARD: ReadonlyArray<readonly [string, string]> = [
  // controller.ts registers the timeline tracks, builds the family relations
  // and assembles the arrow overlay - it owns the timeline's presentation, so
  // it reaches the modules that draw it. Those modules no longer reach back:
  // they take `GraphHost` (views/graph_host.ts), which the controller
  // satisfies structurally, so nothing here is a cycle any more. Emptying the
  // list means moving timeline-workspace ownership out of the controller,
  // which is a design change rather than a cleanup.
  ['controller', 'views/graph_track'],
  ['controller', 'views/arrows'],
  ['controller', 'views/family'],
];

interface Edge {
  readonly from: string;
  readonly to: string;
}

const sources = import.meta.glob('./**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// './views/panel.ts' -> 'views/panel'; './controller.ts' -> 'controller'.
function moduleId(globKey: string): string {
  return globKey.replace(/^\.\//, '').replace(/\.ts$/, '');
}

function layerOf(id: string): number | undefined {
  const slash = id.lastIndexOf('/');
  if (slash < 0) return LAYER_OF_ROOT_FILE.get(id);
  return LAYER_OF_DIR.get(id.slice(0, slash));
}

// Resolve a relative specifier against the importing module's directory.
function resolve(fromId: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const dir = fromId.includes('/')
    ? fromId.slice(0, fromId.lastIndexOf('/'))
    : '';
  const parts = (dir === '' ? [] : dir.split('/')).concat(spec.split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

function edges(): Edge[] {
  const out: Edge[] = [];
  for (const [key, text] of Object.entries(sources)) {
    const from = moduleId(key);
    // Tests may import anything: they exist to reach in.
    if (from.endsWith('_unittest') || from.endsWith('test_helper')) continue;
    for (const m of text.matchAll(/from ['"](\.[^'"]*)['"]/g)) {
      const to = resolve(from, m[1]);
      if (to === undefined || layerOf(to) === undefined) continue;
      if (to !== from) out.push({from, to});
    }
  }
  return out;
}

describe('the plugin imports downward', () => {
  test('every module is in a known layer', () => {
    const unplaced = Object.keys(sources)
      .map(moduleId)
      .filter((id) => !id.endsWith('_unittest') && !id.endsWith('test_helper'))
      .filter((id) => layerOf(id) === undefined);
    expect(unplaced).toEqual([]);
  });

  test('no import points at a higher layer', () => {
    const allowed = new Set(ALLOWED_UPWARD.map(([f, t]) => `${f} -> ${t}`));
    const violations = new Set<string>();
    for (const {from, to} of edges()) {
      const a = layerOf(from);
      const b = layerOf(to);
      if (a === undefined || b === undefined) continue;
      const edge = `${from} -> ${to}`;
      if (b > a && !allowed.has(edge)) violations.add(edge);
    }
    expect([...violations].sort()).toEqual([]);
  });

  test('every allowed-upward entry is still a real edge', () => {
    // So the list shrinks as the debts are paid instead of going stale.
    const present = new Set(edges().map(({from, to}) => `${from} -> ${to}`));
    const stale = ALLOWED_UPWARD.map(([f, t]) => `${f} -> ${t}`).filter(
      (e) => !present.has(e),
    );
    expect(stale).toEqual([]);
  });
});
