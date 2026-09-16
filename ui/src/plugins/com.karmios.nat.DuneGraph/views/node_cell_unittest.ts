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
 * The shared node cell (node_cell.ts), rendered into a DOM rather than asserted
 * on as vnodes: what matters is the markup a DataGrid ends up with - a kind
 * chip, a label, a toggle - not the shape of the mithril tree that produces it.
 *
 * The second half is the registration lifecycle. `idColumnRenderers.register`
 * throws on a table that is already registered, which is the failure mode a
 * plugin can actually cause (a registration that outlives its trace), so the
 * tests here pin both ends: it is dropped with the trace, and the next trace
 * load re-registers without throwing.
 */

import m from 'mithril';
import {afterEach, describe, expect, test} from 'vitest';
import {DisposableStack} from '../../../base/disposable_stack';
import {
  idColumnRenderers,
  resolveColumnRenderers,
} from '../../../components/widgets/datagrid/column_renderers';
import type {CellRenderResult} from '../../../components/widgets/datagrid/datagrid_schema';
import {isCellRenderResult} from '../../../components/widgets/datagrid/datagrid_schema';
import type {Trace} from '../../../public/trace';
import type {PerfettoSqlType} from '../../../trace_processor/perfetto_sql_type';
import type {SqlValue} from '../../../trace_processor/query_result';
import type {DuneGraphController} from '../controller';
import type {BuildGraph, NodeId} from '../model/graph';
import {dep, rule, testGraph} from '../model/graph_test_helper';
import {
  DUNE_DIR_JOINID,
  DUNE_DIR_TABLE,
  DUNE_NODE_ID_COLUMN,
  DUNE_NODE_JOINID,
  DUNE_NODE_TABLE,
} from '../sql/dune_tables';
import {
  dirCellLabel,
  nodeCellLabel,
  nodeForCellValue,
  registerIdColumnRenderers,
  renderDirCell,
  renderNodeCell,
  renderNodeCellActions,
} from './node_cell';

// A dep and a rule are enough: the cell only reads a node's kind, health and
// label (and a dep's label is a path, so it exercises the leading build/code
// icon too). Both are healthy, which is what almost every real node is - a bare
// `dep(...)` would resolve to `unfinished` and pick up a state marker, so the
// dep says it's a source file.
const g = testGraph([
  dep('a/b/dep1.ml', {isSource: true}),
  rule('42', {dir: 'a/b'}),
]);

// The four health states a chip can carry (see `healthOf` in graph.ts), one
// node each. Separate from `g` so the tests above stay on the common,
// marker-less case.
const health = testGraph([
  dep('ok.ml', {isSource: true}),
  dep('failed.ml', {status: 'failed'}),
  dep('cancelled.ml', {status: 'cancelled'}),
  // Nothing said about it: its span never ended.
  dep('unfinished.ml'),
  rule('7', {outcome: 'failed-action'}),
]);

// The directory paths the fake mirror knows, by id. Id 0 is the top level -
// `dune_dir` always numbers it first, and its path is the empty string (see
// model/dir_tree.ts), which is the case a blank cell would silently look right
// for.
const DIR_PATHS = ['', 'a', 'a/b'];

// Everything node_cell.ts touches on the controller. `goToNode` / `goToDir` are
// recorded rather than performed: each is a query in the real controller, and
// the point of the anchor is that clicking it asks for that node or directory.
interface FakeController {
  readonly controller: DuneGraphController;
  readonly inGraph: Set<NodeId>;
  readonly visited: NodeId[];
  readonly visitedDirs: number[];
}

function fakeController(graph: BuildGraph = g.graph): FakeController {
  const inGraph = new Set<NodeId>();
  const visited: NodeId[] = [];
  const visitedDirs: number[] = [];
  const controller = {
    graph,
    dirPath: (id: number) => DIR_PATHS[id],
    goToDir: async (id: number) => {
      visitedDirs.push(id);
    },
    nodeForNodeId: (id: number) => (graph.has(id) ? id : undefined),
    isInGraph: (node: NodeId) => inGraph.has(node),
    addToGraph: (nodes: Iterable<NodeId>) => {
      for (const n of nodes) inGraph.add(n);
    },
    removeFromGraph: (nodes: Iterable<NodeId>) => {
      for (const n of nodes) inGraph.delete(n);
    },
    goToNode: async (node: NodeId) => {
      visited.push(node);
    },
  } as unknown as DuneGraphController;
  return {controller, inGraph, visited, visitedDirs};
}

// A trace stub that is nothing but its trash, which is all a registration
// needs. Unloading a trace disposes that stack, so `unload()` is what the trace
// going away looks like from here.
function fakeTrace() {
  const trash = new DisposableStack();
  return {
    trace: {trash} as unknown as Trace,
    unload: () => trash.dispose(),
  };
}

// Renders a cell into a detached element, as a DataGrid would. Takes what a
// `CellRenderer` returns, i.e. plain children or the rich alignment-carrying
// form (which the node cell never uses, but the type allows).
function render(children: m.Children | CellRenderResult): HTMLElement {
  const root = document.createElement('div');
  m.render(root, isCellRenderResult(children) ? children.content : children);
  return root;
}

// A node id whose graph has no node - the id space is dense and small, so this
// is well past the end of the fixture.
const UNKNOWN_ID = 9999;

afterEach(() => {
  idColumnRenderers.unregisterAllForTesting();
});

describe('nodeForCellValue', () => {
  test('resolves a numeric id of the current graph', () => {
    const {controller} = fakeController();
    const node = g.id('a/b/dep1.ml');
    expect(nodeForCellValue(controller, node)).toBe(node);
    expect(nodeForCellValue(controller, BigInt(node))).toBe(node);
  });

  test('resolves nothing for a non-node value', () => {
    const {controller} = fakeController();
    for (const value of [null, 'a/b/dep1.ml', UNKNOWN_ID] as SqlValue[]) {
      expect(nodeForCellValue(controller, value)).toBeUndefined();
    }
  });
});

describe('renderNodeCell', () => {
  test("shows a dep's kind chip, path and link", () => {
    const {controller, visited} = fakeController();
    const node = g.id('a/b/dep1.ml');
    const root = render(renderNodeCell(controller, node));

    const chip = root.querySelector('.pf-dune-graph__chip');
    expect(chip?.textContent).toBe('dep');
    expect(chip?.classList.contains('pf-dune-graph__chip--dep')).toBe(true);
    expect(root.textContent).toContain('a/b/dep1.ml');

    const anchor = root.querySelector('a');
    expect(anchor).not.toBeNull();
    anchor?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(visited).toEqual([node]);
  });

  test("shows a rule's kind chip and bare id", () => {
    const {controller} = fakeController();
    const root = render(renderNodeCell(controller, g.id('42')));
    const chip = root.querySelector('.pf-dune-graph__chip');
    expect(chip?.textContent).toBe('rule');
    expect(chip?.classList.contains('pf-dune-graph__chip--rule')).toBe(true);
    expect(root.textContent).toContain('42');
  });

  test('falls back to the raw value for an id of no node', () => {
    const {controller} = fakeController();
    const root = render(renderNodeCell(controller, UNKNOWN_ID));
    expect(root.textContent).toBe(String(UNKNOWN_ID));
    expect(root.querySelector('.pf-dune-graph__chip')).toBeNull();
  });

  test('renders NULL as an empty cell', () => {
    const {controller} = fakeController();
    expect(render(renderNodeCell(controller, null)).textContent).toBe('');
  });
});

describe('health markers', () => {
  // The marker's modifier class, or undefined when the chip carries none.
  function markerOf(name: string): string | undefined {
    const {controller} = fakeController(health.graph);
    const root = render(renderNodeCell(controller, health.id(name)));
    const icon = root.querySelector('.pf-dune-graph__health-icon');
    return icon?.className
      .split(' ')
      .find((c) => c.startsWith('pf-dune-graph__health-icon--'));
  }

  test('leaves a healthy node unmarked', () => {
    expect(markerOf('ok.ml')).toBeUndefined();
  });

  test('marks a failed dep and a failed rule', () => {
    expect(markerOf('failed.ml')).toBe('pf-dune-graph__health-icon--failed');
    expect(markerOf('7')).toBe('pf-dune-graph__health-icon--failed');
  });

  test('marks a cancelled node', () => {
    expect(markerOf('cancelled.ml')).toBe(
      'pf-dune-graph__health-icon--cancelled',
    );
  });

  test('marks a node whose span never ended', () => {
    expect(markerOf('unfinished.ml')).toBe(
      'pf-dune-graph__health-icon--unfinished',
    );
  });

  // The kind chip keeps its kind colour throughout - only the two "didn't
  // really finish" states dim it.
  test('dims the chip only for cancelled and unfinished', () => {
    function muted(name: string): boolean {
      const {controller} = fakeController(health.graph);
      const root = render(renderNodeCell(controller, health.id(name)));
      const chip = root.querySelector('.pf-dune-graph__chip');
      return chip?.classList.contains('pf-dune-graph__chip--muted') ?? false;
    }
    expect(muted('ok.ml')).toBe(false);
    expect(muted('failed.ml')).toBe(false);
    expect(muted('cancelled.ml')).toBe(true);
    expect(muted('unfinished.ml')).toBe(true);
  });
});

describe('renderDirCell', () => {
  test("shows a directory's chip, path and link", () => {
    const {controller, visitedDirs} = fakeController();
    const root = render(renderDirCell(controller, 2));

    const chip = root.querySelector('.pf-dune-graph__chip');
    expect(chip?.textContent).toBe('dir');
    expect(chip?.classList.contains('pf-dune-graph__chip--dir')).toBe(true);
    expect(root.textContent).toContain('a/b');

    const anchor = root.querySelector('a');
    expect(anchor).not.toBeNull();
    anchor?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(visitedDirs).toEqual([2]);
  });

  test('labels the top level rather than drawing a blank link', () => {
    const {controller, visitedDirs} = fakeController();
    const root = render(renderDirCell(controller, 0));
    expect(root.querySelector('a')?.textContent).toContain('(top level)');
    root
      .querySelector('a')
      ?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(visitedDirs).toEqual([0]);
  });

  test('takes a bigint cell too', () => {
    const {controller} = fakeController();
    expect(render(renderDirCell(controller, BigInt(1))).textContent).toContain(
      'a',
    );
  });

  test('falls back to the raw value for an id of no directory', () => {
    const {controller} = fakeController();
    const root = render(renderDirCell(controller, UNKNOWN_ID));
    expect(root.textContent).toBe(String(UNKNOWN_ID));
    expect(root.querySelector('.pf-dune-graph__chip')).toBeNull();
  });

  test('renders NULL as an empty cell', () => {
    const {controller} = fakeController();
    expect(render(renderDirCell(controller, null)).textContent).toBe('');
  });

  // A directory is not a graph node, so the cell deliberately carries no
  // membership toggle - the one place it differs from the node cell.
  test('carries no add/remove button', () => {
    const {controller} = fakeController();
    expect(render(renderDirCell(controller, 2)).querySelector('button')).toBe(
      null,
    );
  });
});

describe('dirCellLabel', () => {
  test("exports a directory's path, the top level labelled", () => {
    const {controller} = fakeController();
    expect(dirCellLabel(controller, 2)).toBe('a/b');
    expect(dirCellLabel(controller, 0)).toBe('(top level)');
  });

  test('falls back to the raw value, NULL included', () => {
    const {controller} = fakeController();
    expect(dirCellLabel(controller, UNKNOWN_ID)).toBe(String(UNKNOWN_ID));
    expect(dirCellLabel(controller, null)).toBe('null');
  });
});

describe('nodeCellLabel', () => {
  test("is the node's label, for exports", () => {
    const {controller} = fakeController();
    expect(nodeCellLabel(controller, g.id('a/b/dep1.ml'))).toBe('a/b/dep1.ml');
    expect(nodeCellLabel(controller, g.id('42'))).toBe('42');
  });

  test('falls back to the raw value, NULL included', () => {
    const {controller} = fakeController();
    expect(nodeCellLabel(controller, UNKNOWN_ID)).toBe(String(UNKNOWN_ID));
    expect(nodeCellLabel(controller, null)).toBe('null');
  });
});

describe('renderNodeCellActions', () => {
  test('toggles a node into and out of the graph', () => {
    const {controller, inGraph} = fakeController();
    const node = g.id('a/b/dep1.ml');

    const add = render(renderNodeCellActions(controller, node));
    add.querySelector('button')?.click();
    expect([...inGraph]).toEqual([node]);

    // Re-rendered after the membership change, the same cell removes it again.
    const remove = render(renderNodeCellActions(controller, node));
    remove.querySelector('button')?.click();
    expect([...inGraph]).toEqual([]);
  });

  test('offers nothing for a cell that names no node', () => {
    const {controller} = fakeController();
    expect(renderNodeCellActions(controller, UNKNOWN_ID)).toBeUndefined();
    expect(renderNodeCellActions(controller, null)).toBeUndefined();
  });
});

describe('registerIdColumnRenderers', () => {
  test('makes a JOINID(dune_node.node_id) column render a chip', () => {
    const {controller} = fakeController();
    const {trace} = fakeTrace();
    registerIdColumnRenderers(trace, controller);

    const renderers = resolveColumnRenderers(trace, DUNE_NODE_JOINID, 'src');
    expect(renderers.columnType).toBe('identifier');

    const root = render(renderers.cellRenderer?.(g.id('42'), {}));
    expect(root.querySelector('.pf-dune-graph__chip')?.textContent).toBe(
      'rule',
    );
    expect(renderers.actions?.(g.id('42'), {})).toBeDefined();
  });

  test("also handles dune_node's own id column", () => {
    const {controller} = fakeController();
    const {trace} = fakeTrace();
    registerIdColumnRenderers(trace, controller);

    const idType: PerfettoSqlType = {
      kind: 'id',
      source: {table: DUNE_NODE_TABLE, column: DUNE_NODE_ID_COLUMN},
    };
    expect(
      resolveColumnRenderers(trace, idType, 'node_id').cellRenderer,
    ).toBeDefined();
  });

  test('makes a JOINID(dune_dir.dir_id) column render a directory chip', () => {
    const {controller} = fakeController();
    const {trace} = fakeTrace();
    registerIdColumnRenderers(trace, controller);

    const renderers = resolveColumnRenderers(
      trace,
      DUNE_DIR_JOINID,
      'parent_dir_id',
    );
    expect(renderers.columnType).toBe('identifier');

    const root = render(renderers.cellRenderer?.(2, {}));
    expect(root.querySelector('.pf-dune-graph__chip--dir')?.textContent).toBe(
      'dir',
    );
    expect(root.textContent).toContain('a/b');
    // A directory is not a graph node, so there is no ＋/－ to offer.
    expect(renderers.actions).toBeUndefined();
  });

  test('leaves a reference to another dune_dir column alone', () => {
    const {controller} = fakeController();
    const {trace} = fakeTrace();
    registerIdColumnRenderers(trace, controller);

    // dune_dir.n_rules is a count, not a directory id.
    const countRef: PerfettoSqlType = {
      kind: 'joinid',
      source: {table: DUNE_DIR_TABLE, column: 'n_rules'},
    };
    expect(
      resolveColumnRenderers(trace, countRef, 'n_rules').cellRenderer,
    ).toBeUndefined();
  });

  test('leaves a reference to another dune_node column alone', () => {
    const {controller} = fakeController();
    const {trace} = fakeTrace();
    registerIdColumnRenderers(trace, controller);

    // dune_node.slice_id holds slice ids, not node ids: chipping one would name
    // whichever node happened to share the number.
    const sliceRef: PerfettoSqlType = {
      kind: 'joinid',
      source: {table: DUNE_NODE_TABLE, column: 'slice_id'},
    };
    const renderers = resolveColumnRenderers(trace, sliceRef, 'slice_id');
    expect(renderers.cellRenderer).toBeUndefined();
    expect(renderers.actions).toBeUndefined();
  });

  test('a cell renders against the controller it was registered with', () => {
    // Two traces' registrations must not be confusable: the renderer resolves
    // ids against its own controller's graph, so the same id can be a node in
    // one and nothing in the other.
    const first = fakeController();
    const other = testGraph([dep('x.ml')]);
    const second = fakeController(other.graph);
    const node = g.id('a/b/dep1.ml');

    const traceA = fakeTrace();
    registerIdColumnRenderers(traceA.trace, first.controller);
    const withFirst = resolveColumnRenderers(
      traceA.trace,
      DUNE_NODE_JOINID,
      'node_id',
    ).cellRenderer;
    expect(render(withFirst?.(node, {})).textContent).toContain('a/b/dep1.ml');
    traceA.unload();

    const traceB = fakeTrace();
    registerIdColumnRenderers(traceB.trace, second.controller);
    const withSecond = resolveColumnRenderers(
      traceB.trace,
      DUNE_NODE_JOINID,
      'node_id',
    ).cellRenderer;
    expect(render(withSecond?.(node, {})).textContent).not.toContain(
      'a/b/dep1.ml',
    );
  });

  test('unloading the trace drops the registration', () => {
    const {controller} = fakeController();
    const {trace, unload} = fakeTrace();
    registerIdColumnRenderers(trace, controller);
    expect(idColumnRenderers.has(DUNE_NODE_TABLE)).toBe(true);
    expect(idColumnRenderers.has(DUNE_DIR_TABLE)).toBe(true);

    unload();
    expect(idColumnRenderers.has(DUNE_NODE_TABLE)).toBe(false);
    expect(idColumnRenderers.has(DUNE_DIR_TABLE)).toBe(false);
    expect(
      resolveColumnRenderers(trace, DUNE_NODE_JOINID, 'node_id').cellRenderer,
    ).toBeUndefined();
  });

  test('a second trace load does not throw', () => {
    const {controller} = fakeController();
    const first = fakeTrace();
    registerIdColumnRenderers(first.trace, controller);
    // A trace is unloaded (disposing its trash) before the next one loads.
    first.unload();

    const second = fakeTrace();
    expect(() =>
      registerIdColumnRenderers(second.trace, fakeController().controller),
    ).not.toThrow();
    expect(idColumnRenderers.has(DUNE_NODE_TABLE)).toBe(true);
  });

  test('registering while a live registration stands throws', () => {
    // Not a case the plugin should reach - it is what a registration leaked
    // past its trace would look like, and the throw is how it stays visible.
    const {controller} = fakeController();
    registerIdColumnRenderers(fakeTrace().trace, controller);
    expect(() =>
      registerIdColumnRenderers(fakeTrace().trace, controller),
    ).toThrowError(/already registered/);
  });
});
