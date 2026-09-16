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
 * The source nodes (dune_table_source.ts), checked against the Data Explorer's
 * own registry and query builder rather than against a copy of what they
 * expect.
 *
 * Three things here can only go wrong silently. The columns are a *third* copy
 * of the mirror's shape (after sql_graph.ts and dune_tables.ts), so they are
 * asserted against the documentation they are taken from rather than spelt out
 * again. The generated query is a proto nothing type-checks against a table
 * that exists. And the tier gate is the only thing standing between a menu
 * click and a minutes-long edge build, so which entry has which gate is
 * asserted directly.
 */

import m from 'mithril';
import {afterEach, describe, expect, test} from 'vitest';
import {registerCoreNodes} from '../../dev.perfetto.DataExplorer/query_builder/core_nodes';
import {nodeRegistry} from '../../dev.perfetto.DataExplorer/query_builder/node_registry';
import {NodeIssues} from '../../dev.perfetto.DataExplorer/query_builder/node_issues';
import {DisposableStack} from '../../../base/disposable_stack';
import type {Trace} from '../../../public/trace';
import type {DuneGraphController} from '../controller';
import {DUNE_TABLES} from '../sql/dune_tables';
import {
  DuneTableSourceNode,
  duneSourceNodeType,
  duneTableSourceDescriptor,
  registerDuneSourceNodes,
} from './dune_table_source';

// The node registry is populated as a side effect of the Data Explorer's own
// module load; a unit test importing only its pieces has to do it itself. It is
// idempotent, so several test files may each do this.
registerCoreNodes();

// Registrations are global, so an assertion that throws before its `unload()`
// would poison every test after it. Registered ones are collected here instead
// and dropped between tests.
let live: DisposableStack | undefined;

afterEach(() => {
  live?.dispose();
  live = undefined;
});

// A trace stub that is nothing but its trash, which is all a registration
// needs. Unloading a trace disposes that stack, so `unload()` is what the trace
// going away looks like from here.
function registerFor(controller: DuneGraphController): void {
  const trash = new DisposableStack();
  registerDuneSourceNodes({trash} as unknown as Trace, controller);
  live = new DisposableStack();
  live.defer(() => trash.dispose());
}

// Everything these nodes read off the controller. Defaults to *no* tiers, since
// that is what a graph restored after a page reload sees.
function fakeController(
  over: Partial<DuneGraphController> = {},
): DuneGraphController {
  return {
    nodeMirrorReady: false,
    edgeMirrorReady: false,
    ...over,
  } as unknown as DuneGraphController;
}

function node(
  table: string,
  controller = fakeController({nodeMirrorReady: true}),
) {
  return new DuneTableSourceNode({table}, {}, controller);
}

function documented(table: string) {
  const entry = DUNE_TABLES.find((t) => t.name === table);
  expect(entry, `${table} is documented`).toBeDefined();
  return entry!;
}

describe('the Dune table source node', () => {
  test.each(['dune_node', 'dune_dir'])(
    '%s takes its columns from the documentation, all checked',
    (table) => {
      const cols = node(table).finalCols;
      const entry = documented(table);

      expect(cols.map((c) => c.name)).toEqual(entry.columns.map((c) => c.name));
      expect(cols.map((c) => c.type)).toEqual(entry.columns.map((c) => c.type));
      expect(cols.every((c) => c.checked)).toBe(true);
    },
  );

  test('selects every column of its table', () => {
    const n = node('dune_rule');
    const sq = n.getStructuredQuery();

    expect(sq?.table?.tableName).toBe('dune_rule');
    // No `INCLUDE PERFETTO MODULE`: the mirror's tables are simply in scope.
    expect(sq?.table?.moduleName ?? '').toBe('');
    expect(sq?.table?.columnNames).toEqual(
      documented('dune_rule').columns.map((c) => c.name),
    );
    // All columns checked, so no explicit projection on top.
    expect(sq?.selectColumns ?? []).toEqual([]);
  });

  test('narrows to the checked columns', () => {
    const n = node('dune_node');
    for (const col of n.finalCols) col.checked = col.name === 'label';

    const sq = n.getStructuredQuery();

    expect(sq?.table?.columnNames).toEqual(['label']);
    expect(sq?.selectColumns?.map((c) => c.columnName)).toEqual(['label']);
  });

  // The node's box in the graph, and the heading of its panel, are the prose
  // label the menu offered - not the table name, which is left to the SQL.
  test('is titled and documented by its menu label', () => {
    const n = node('dune_node');
    expect(n.getTitle()).toBe('Nodes');

    const el = document.createElement('div');
    m.render(el, n.nodeInfo());
    // The Data Explorer's own class for a node's documentation, which is where
    // the typography comes from.
    expect(el.querySelector('.pf-node-info')).not.toBeNull();
    expect(el.querySelector('h1')?.textContent).toBe('Nodes');
    // Column names as code spans, which is what the markdown route buys over
    // the hand-built panel this replaced.
    expect(
      Array.from(el.querySelectorAll('code')).map((c) => c.textContent),
    ).toContain('node_id');
  });

  // The table is fixed by the descriptor, so there is nothing to configure -
  // the projection is still there for a downstream node to narrow, it just has
  // no control of its own.
  test('offers no configuration section', () => {
    expect(node('dune_node').nodeSpecificModify().sections).toBeUndefined();
  });

  test('will not build a query while its tier is missing', () => {
    const issues = new NodeIssues();
    const n = new DuneTableSourceNode(
      {table: 'dune_node'},
      {issues},
      fakeController(),
    );

    expect(n.validate()).toBe(false);
    expect(n.getStructuredQuery()).toBeUndefined();
    // Names the table and the way to get it, rather than leaving the failure to
    // trace processor's "no such table".
    expect(issues.queryError?.message).toContain('dune_node');
    expect(issues.queryError?.message).toContain('side panel');
  });

  test('the edge tier node validates once that tier is built', () => {
    expect(node('dune_edge', fakeController()).validate()).toBe(false);
    expect(
      node('dune_edge', fakeController({edgeMirrorReady: true})).validate(),
    ).toBe(true);
  });
});

describe('the registry entries', () => {
  test('register one node per offered table, and unregister with the trace', () => {
    const before = nodeRegistry.list().length;
    registerFor(fakeController());

    const ids = nodeRegistry
      .list()
      .map(([id]) => id)
      .filter((id) => id.startsWith('dune_source_'));
    expect(ids.length).toBe(9);
    expect(nodeRegistry.list().length).toBe(before + 9);
    expect(
      nodeRegistry.getByNodeType(duneSourceNodeType('dune_node')),
    ).toBeDefined();

    live?.dispose();
    live = undefined;
    expect(nodeRegistry.list().length).toBe(before);
  });

  test('all sit in the Dune menu group and off the landing page', () => {
    registerFor(fakeController());

    for (const [id, d] of nodeRegistry.list()) {
      if (!id.startsWith('dune_source_')) continue;
      expect(d.type).toBe('source');
      expect(d.inputs).toBe('none');
      expect(d.category).toBe('Dune');
      // The core nodes' orange (#ffe0b2), so a Dune node does not read as some
      // other kind of thing.
      expect(d.hue).toBe(30);
      expect(d.showOnLandingPage).toBe(false);
      expect(d.allowedChildren).toBeUndefined();
    }
  });

  // The asymmetry this file mostly exists for: the node tier is built by
  // picking the menu item, the edge tier is never started from a menu at all.
  test('the node tier entries build their tier and are always pickable', () => {
    const controller = fakeController();
    for (const table of ['dune_node', 'dune_rule', 'dune_process']) {
      const d = duneTableSourceDescriptor(controller, 'X', table);
      expect(d.available).toBeUndefined();
      expect(d.preCreate).toBeDefined();
    }
  });

  // The other half of that gate: picking a node-tier entry is what loads the
  // graph, and a load that failed has to abort the creation rather than leave
  // a node behind that can only fail validation.
  test('picking a node tier entry loads the graph, and aborts if that fails', async () => {
    const loaded = {
      nodeMirrorReady: false,
      load: async () => {
        loaded.nodeMirrorReady = true;
      },
    };
    const d = duneTableSourceDescriptor(
      loaded as unknown as DuneGraphController,
      'Nodes',
      'dune_node',
    );
    expect(await d.preCreate?.({} as never)).toEqual({});
    expect(loaded.nodeMirrorReady).toBe(true);

    const failed = duneTableSourceDescriptor(
      {nodeMirrorReady: false, load: async () => {}} as never,
      'Nodes',
      'dune_node',
    );
    expect(await failed.preCreate?.({} as never)).toBeNull();
  });

  test('the edge tier entry is greyed out with a reason until it is built', () => {
    const unbuilt = duneTableSourceDescriptor(
      fakeController(),
      'Node edges',
      'dune_edge',
    );
    expect(unbuilt.preCreate).toBeUndefined();
    expect(unbuilt.available?.()).toContain('side panel');

    const built = duneTableSourceDescriptor(
      fakeController({edgeMirrorReady: true}),
      'Node edges',
      'dune_edge',
    );
    expect(built.available?.()).toBeUndefined();
  });

  // `available()` is consulted on every menu render, so the entry has to
  // recover on its own once something else builds the tier.
  test('the edge tier entry recovers without re-registering', () => {
    let ready = false;
    // Not through `fakeController`: spreading a getter would read it once, and
    // reading it once is the bug this guards against.
    const controller = {
      nodeMirrorReady: false,
      get edgeMirrorReady() {
        return ready;
      },
    } as unknown as DuneGraphController;
    const d = duneTableSourceDescriptor(controller, 'Node edges', 'dune_edge');

    expect(d.available?.()).toBeDefined();
    ready = true;
    expect(d.available?.()).toBeUndefined();
  });
});
