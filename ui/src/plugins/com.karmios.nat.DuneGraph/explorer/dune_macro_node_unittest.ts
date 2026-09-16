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
 * The macro nodes (dune_macro_node.ts), against the Data Explorer's own
 * registry and query builder rather than against a copy of what they expect.
 *
 * The three things worth pinning down are the three that can only go wrong in a
 * browser. The emitted SQL is a string nothing type-checks against a macro that
 * exists, and the choice between the wrapped and the unwrapped dependency is a
 * correctness question for `dune_blocked!` rather than a matter of taste. The
 * scalar arguments are interpolated into that SQL, so what they render as
 * matters. And the tier gate is the only thing standing between a menu click
 * and a minutes-long edge build.
 */

import m from 'mithril';
import {afterEach, describe, expect, test} from 'vitest';
import {registerCoreNodes} from '../../dev.perfetto.DataExplorer/query_builder/core_nodes';
import {nodeRegistry} from '../../dev.perfetto.DataExplorer/query_builder/node_registry';
import {NodeIssues} from '../../dev.perfetto.DataExplorer/query_builder/node_issues';
import {StructuredQueryBuilder} from '../../dev.perfetto.DataExplorer/query_builder/structured_query_builder';
import type {
  NodeContext,
  QueryNode,
} from '../../dev.perfetto.DataExplorer/query_node';
import type {NodeModifyAttrs} from '../../dev.perfetto.DataExplorer/node_types';
import {DisposableStack} from '../../../base/disposable_stack';
import type {Trace} from '../../../public/trace';
import type {DuneGraphController} from '../controller';
import {
  DUNE_MACRO_NODES,
  DuneMacroNode,
  type DuneMacroNodeAttrs,
  duneMacroDescriptor,
  duneMacroNodeType,
  registerDuneMacroNodes,
} from './dune_macro_node';

// As in dune_table_source_unittest.ts: the registry is populated as a side
// effect of the Data Explorer's own module load, which a unit test importing
// only its pieces has to do itself. Idempotent.
registerCoreNodes();

let live: DisposableStack | undefined;

afterEach(() => {
  live?.dispose();
  live = undefined;
});

function registerFor(controller: DuneGraphController): void {
  const trash = new DisposableStack();
  registerDuneMacroNodes({trash} as unknown as Trace, controller);
  live = new DisposableStack();
  live.defer(() => trash.dispose());
}

// Everything these nodes read off the controller. Both tiers built by default,
// since the tier gate has tests of its own and everything else needs to get
// past it.
function fakeController(
  over: Partial<DuneGraphController> = {},
): DuneGraphController {
  return {
    nodeMirrorReady: true,
    edgeMirrorReady: true,
    ...over,
  } as unknown as DuneGraphController;
}

// A real, minimal QueryNode to sit above the node under test. Its structured
// query is a table query, which is what the macro node has to end up nesting
// as its named dependency.
function upstream(cols: string[], sql = true): QueryNode {
  const sq = StructuredQueryBuilder.fromTable('t', undefined, cols, 'up');
  return {
    nodeId: 'up',
    type: 'table',
    nextNodes: [],
    attrs: {},
    context: {},
    finalCols: cols.map((name) => ({name, checked: true})),
    validate: () => true,
    getTitle: () => 't',
    nodeSpecificModify: () => ({info: ''}),
    nodeDetails: () => ({content: undefined}),
    nodeInfo: () => undefined,
    clone: () => upstream(cols, sql),
    getStructuredQuery: () => (sql ? sq : undefined),
  };
}

function node(
  macro: string,
  cols: string[],
  attrs: Partial<DuneMacroNodeAttrs> = {},
  context: NodeContext = {},
  controller = fakeController(),
): DuneMacroNode {
  const n = new DuneMacroNode({...attrs, macro}, context, controller);
  n.primaryInput = upstream(cols);
  return n;
}

// The SQL the node generates, which is the whole of what a macro node is.
function sqlOf(n: DuneMacroNode): string | undefined {
  return n.getStructuredQuery()?.sql?.sql ?? undefined;
}

// The node's configuration fields, rendered, since what they are labelled is
// the thing worth asserting and a section's content is opaque mithril.
function modifyPanel(n: DuneMacroNode): HTMLElement {
  const el = document.createElement('div');
  const sections = (n.nodeSpecificModify() as NodeModifyAttrs).sections ?? [];
  m.render(
    el,
    m(
      'div',
      sections.map((s) => s.content),
    ),
  );
  return el;
}

function macroDoc(macro: string) {
  const entry = DUNE_MACRO_NODES.find((m) => m.macro === macro);
  expect(entry, `${macro} is one of the offered macros`).toBeDefined();
  return entry!;
}

describe('the Dune macro node', () => {
  test('passes its input as the macro`s table argument', () => {
    const n = node('dune_children', ['node_id']);
    const sq = n.getStructuredQuery();

    expect(sq?.sql?.sql).toBe('SELECT * FROM dune_children!($starts)');
    // The alias is the macro's own parameter name, and the dependency is the
    // input's query: that is what the generator rewrites `$starts` into.
    expect(sq?.sql?.dependencies?.map((d) => d.alias)).toEqual(['starts']);
    expect(sq?.sql?.dependencies?.[0]?.query).toBe(
      n.primaryInput?.getStructuredQuery(),
    );
    expect(sq?.sql?.columnNames).toEqual(
      macroDoc('dune_children').entry.columns.map((c) => c.name),
    );
  });

  test('takes a process set for dune_process_cmd!', () => {
    const sq = node('dune_process_cmd', ['slice_id']).getStructuredQuery();

    expect(sq?.sql?.sql).toBe('SELECT * FROM dune_process_cmd!($processes)');
    expect(sq?.sql?.dependencies?.map((d) => d.alias)).toEqual(['processes']);
  });

  test('takes an edge set for dune_blocked!', () => {
    const sq = node('dune_blocked', ['src', 'dst']).getStructuredQuery();

    expect(sq?.sql?.sql).toBe('SELECT * FROM dune_blocked!($edges)');
    expect(sq?.sql?.dependencies?.map((d) => d.alias)).toEqual(['edges']);
  });

  // The wrap exists only because the macro bodies hardcode the column they
  // read, so it has to be absent when it is not needed: for `dune_blocked!`,
  // whose body returns `e.*`, wrapping also narrows what comes through.
  test('wraps the dependency only to rename a column', () => {
    expect(sqlOf(node('dune_children', ['node_id', 'x']))).toBe(
      'SELECT * FROM dune_children!($starts)',
    );
    expect(
      sqlOf(node('dune_children', ['dst'], {cols: {node_id: 'dst'}})),
    ).toBe(
      'SELECT * FROM dune_children!((SELECT dst AS node_id FROM $starts))',
    );
    // An explicit choice that happens to be the default is still unwrapped.
    expect(
      sqlOf(node('dune_children', ['node_id'], {cols: {node_id: 'node_id'}})),
    ).toBe('SELECT * FROM dune_children!($starts)');
  });

  test('renames both endpoints for dune_blocked!', () => {
    const n = node('dune_blocked', ['a', 'b'], {cols: {src: 'a', dst: 'b'}});

    expect(sqlOf(n)).toBe(
      'SELECT * FROM dune_blocked!((SELECT a AS src, b AS dst FROM $edges))',
    );
    // And the wrap is what the output columns have to agree with: only the two
    // columns it selected survive `e.*`.
    expect(n.finalCols.map((c) => c.name)).toEqual([
      'src',
      'dst',
      'blocked_ns',
    ]);
  });

  test('takes its output columns from the documentation', () => {
    // A walk replaces the input's columns with the relation shape.
    expect(node('dune_children', ['node_id', 'x']).finalCols).toEqual(
      macroDoc('dune_children').entry.columns.map((c) => ({
        name: c.name,
        type: c.type,
        description: c.description,
        checked: true,
      })),
    );
    // So does dune_process_cmd!, whose body selects its three explicitly.
    expect(
      node('dune_process_cmd', ['slice_id', 'x']).finalCols.map((c) => c.name),
    ).toEqual(['slice_id', 'prog', 'args']);
    // dune_blocked! is the one that adds to them instead.
    expect(
      node('dune_blocked', ['src', 'dst', 'x']).finalCols.map((c) => c.name),
    ).toEqual(['src', 'dst', 'x', 'blocked_ns']);
  });

  test('has no columns without an input', () => {
    const n = new DuneMacroNode({macro: 'dune_blocked'}, {}, fakeController());
    expect(n.finalCols).toEqual([]);
  });

  test('renders the walk bounds as SQL literals', () => {
    // Unset is NULL, which is what those macros read as unbounded and either.
    expect(sqlOf(node('dune_descendants', ['node_id']))).toBe(
      'SELECT * FROM dune_descendants!($starts, NULL, NULL)',
    );
    expect(
      sqlOf(
        node('dune_ancestors', ['node_id'], {maxSteps: 3, stepKind: 'rule'}),
      ),
    ).toBe("SELECT * FROM dune_ancestors!($starts, 3, 'rule')");
    // step_kind comes from a fixed list, so nothing else can reach the SQL.
    expect(
      sqlOf(
        node('dune_descendants', ['node_id'], {
          maxSteps: 1.5,
          stepKind: "rule'; DROP TABLE x --",
        }),
      ),
    ).toBe('SELECT * FROM dune_descendants!($starts, NULL, NULL)');
  });

  test('only the two bounded walks take bounds at all', () => {
    for (const macro of DUNE_MACRO_NODES) {
      const bounded =
        macro.macro === 'dune_descendants' || macro.macro === 'dune_ancestors';
      expect(macro.extraArgs, macro.macro).toEqual(
        bounded ? ['max_steps', 'step_kind'] : [],
      );
      const sections = (
        node(macro.macro, [...macro.keyCols]).nodeSpecificModify() as
          NodeModifyAttrs | undefined
      )?.sections;
      expect(
        sections?.map((s) => s.title),
        macro.macro,
      ).toEqual(bounded ? ['Input columns', 'Walk bounds'] : ['Input columns']);
    }
  });

  // The box in the graph reads as the menu entry that made it, rather than as
  // the macro call the node happens to generate.
  test('is titled by its menu label', () => {
    expect(node('dune_children', ['node_id']).getTitle()).toBe('Children');
    expect(node('dune_blocked', ['src', 'dst']).getTitle()).toBe(
      'Blocked time',
    );
  });

  test('names its configuration fields in prose, not SQL', () => {
    expect(modifyPanel(node('dune_children', ['node_id'])).textContent).toBe(
      'Node ids: node_id',
    );
    expect(
      modifyPanel(node('dune_process_cmd', ['slice_id'])).textContent,
    ).toContain('Process slices');

    const blocked = modifyPanel(node('dune_blocked', ['src', 'dst']));
    expect(blocked.textContent).toContain('Depending node');
    expect(blocked.textContent).toContain('Node depended on');

    const bounds = modifyPanel(node('dune_descendants', ['node_id']));
    const text = bounds.textContent ?? '';
    expect(text).toContain('Maximum steps');
    expect(text).toContain('Step through');
    // The three step kinds as prose, the unset one included.
    expect(text).toContain('Rules and dependencies');
    expect(text).toContain('Rules only');
    expect(text).toContain('Dependencies only');
    // Empty means an unbounded walk, and only the placeholder says so.
    expect(bounds.querySelector('input')?.placeholder).toBe('Unbounded');
    // None of the macro's own argument names are left on show.
    expect(text).not.toContain('max_steps');
    expect(text).not.toContain('step_kind');
  });

  // The panel the core nodes get from their markdown doc files, which is what
  // makes fenced SQL and code-spanned column names format at all.
  test('renders its documentation through markdown', () => {
    const el = document.createElement('div');
    m.render(el, node('dune_children', ['node_id']).nodeInfo());

    expect(el.querySelector('.pf-node-info')).not.toBeNull();
    expect(el.querySelector('h1')?.textContent).toBe('Children');
    expect(el.querySelector('pre code')?.textContent).toContain(
      'FROM dune_children!(starts)',
    );
    expect(
      Array.from(el.querySelectorAll('code')).map((c) => c.textContent),
    ).toContain('src');
  });

  test('builds nothing on an input that cannot build itself', () => {
    const n = new DuneMacroNode({macro: 'dune_children'}, {}, fakeController());
    n.primaryInput = upstream(['node_id'], false);
    expect(n.getStructuredQuery()).toBeUndefined();
  });
});

describe('validating a Dune macro node', () => {
  function issuesFor(
    macro: string,
    cols: string[],
    attrs: Partial<DuneMacroNodeAttrs> = {},
    controller = fakeController(),
  ): {ok: boolean; message?: string} {
    const issues = new NodeIssues();
    const n = node(macro, cols, attrs, {issues}, controller);
    return {ok: n.validate(), message: issues.queryError?.message};
  }

  test('needs an input', () => {
    const issues = new NodeIssues();
    const n = new DuneMacroNode(
      {macro: 'dune_children'},
      {issues},
      fakeController(),
    );
    expect(n.validate()).toBe(false);
    expect(issues.queryError?.message).toContain('input');
  });

  test('needs the column the macro reads', () => {
    expect(issuesFor('dune_children', ['node_id']).ok).toBe(true);

    const missing = issuesFor('dune_children', ['dst']);
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain('node_id');

    // And the configured column rather than the default one, once set.
    expect(
      issuesFor('dune_children', ['dst'], {cols: {node_id: 'dst'}}).ok,
    ).toBe(true);
    // Both endpoints, for the two-column macro.
    const endpoints = issuesFor('dune_blocked', ['src']);
    expect(endpoints.ok).toBe(false);
    expect(endpoints.message).toContain('dst');
  });

  // A graph restored after a reload comes back with no tiers, and has to say so
  // rather than fail on SQL naming a macro that does not exist.
  test('needs its tier', () => {
    const walk = issuesFor(
      'dune_children',
      ['node_id'],
      {},
      fakeController({edgeMirrorReady: false}),
    );
    expect(walk.ok).toBe(false);
    expect(walk.message).toContain('side panel');

    const table = issuesFor(
      'dune_process_cmd',
      ['slice_id'],
      {},
      fakeController({nodeMirrorReady: false}),
    );
    expect(table.ok).toBe(false);
    expect(table.message).toContain('dune_process_cmd!');
    expect(table.message).toContain('side panel');

    // The node tier is not what the walks are waiting for.
    expect(
      issuesFor(
        'dune_children',
        ['node_id'],
        {},
        fakeController({nodeMirrorReady: false}),
      ).ok,
    ).toBe(true);
  });
});

describe('the Dune macro registry entries', () => {
  test('register one node per macro, and unregister with the trace', () => {
    const before = nodeRegistry.list().length;
    registerFor(fakeController());

    const ids = nodeRegistry
      .list()
      .map(([id]) => id)
      .filter((id) => id.startsWith('dune_macro_'));
    expect(ids.length).toBe(10);
    expect(nodeRegistry.list().length).toBe(before + 10);
    expect(
      nodeRegistry.getByNodeType(duneMacroNodeType('dune_children')),
    ).toBeDefined();

    live?.dispose();
    live = undefined;
    expect(nodeRegistry.list().length).toBe(before);
  });

  // Without this every connection into one of these is rejected, so the node
  // could be registered and still be unreachable.
  test('are all addable under another node while registered', () => {
    // No descriptor for this type, so the registry answers with the default
    // allowed-children list - which is the list these have to be in.
    const defaults = () => nodeRegistry.getAllowedChildrenFor('no_such_node');
    const ids = DUNE_MACRO_NODES.map((m) => duneMacroNodeType(m.macro));

    for (const id of ids) expect(defaults()).not.toContain(id);
    registerFor(fakeController());
    for (const id of ids) expect(defaults()).toContain(id);

    live?.dispose();
    live = undefined;
    for (const id of ids) expect(defaults()).not.toContain(id);
  });

  test('all sit in the Dune menu group', () => {
    registerFor(fakeController());

    for (const [id, d] of nodeRegistry.list()) {
      if (!id.startsWith('dune_macro_')) continue;
      expect(d.type).toBe('modification');
      expect(d.inputs).toBe('primary');
      expect(d.category).toBe('Dune');
      // The source nodes' hue, which is the core nodes' orange (#ffe0b2).
      expect(d.hue).toBe(30);
    }
  });

  // The gate this file mostly exists for: a node-tier macro is built by picking
  // it, an edge-tier one is never started from a menu at all.
  test('the node tier entries build their tier and are always pickable', () => {
    for (const macro of DUNE_MACRO_NODES.filter((m) => m.tier === 'node')) {
      const d = duneMacroDescriptor(fakeController(), macro);
      expect(d.available, macro.macro).toBeUndefined();
      expect(d.preCreate, macro.macro).toBeDefined();
    }
  });

  test('the edge tier entries are greyed out with a reason, and never build', () => {
    const walks = DUNE_MACRO_NODES.filter((m) => m.tier === 'edge');
    expect(walks.length).toBe(8);

    for (const macro of walks) {
      const unbuilt = duneMacroDescriptor(
        fakeController({edgeMirrorReady: false}),
        macro,
      );
      expect(unbuilt.preCreate, macro.macro).toBeUndefined();
      expect(unbuilt.available?.(), macro.macro).toContain('side panel');
      expect(
        duneMacroDescriptor(fakeController(), macro).available?.(),
        macro.macro,
      ).toBeUndefined();
    }
  });

  // `available()` is consulted on every menu render, so the entry has to
  // recover by itself once something else builds the tier.
  test('an edge tier entry recovers without re-registering', () => {
    let ready = false;
    // Not through `fakeController`: spreading a getter would read it once, and
    // reading it once is the bug this guards against.
    const controller = {
      nodeMirrorReady: true,
      get edgeMirrorReady() {
        return ready;
      },
    } as unknown as DuneGraphController;
    const d = duneMacroDescriptor(controller, macroDoc('dune_children'));

    expect(d.available?.()).toBeDefined();
    ready = true;
    expect(d.available?.()).toBeUndefined();
  });

  // `attrs` is the whole of the persisted state, so every macro argument has to
  // come back off it - and the macro itself off the descriptor.
  test('restore their arguments from the serialized state', () => {
    const d = duneMacroDescriptor(
      fakeController(),
      macroDoc('dune_descendants'),
    );
    const restored = d.deserialize(
      {cols: {node_id: 'dst'}, maxSteps: 2, stepKind: 'dep'},
      undefined as unknown as Trace,
      undefined as never,
    ) as DuneMacroNode;
    restored.primaryInput = upstream(['dst']);

    expect(restored.type).toBe(duneMacroNodeType('dune_descendants'));
    expect(sqlOf(restored)).toBe(
      "SELECT * FROM dune_descendants!((SELECT dst AS node_id FROM $starts), 2, 'dep')",
    );
  });
});
