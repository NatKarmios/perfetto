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

import m from 'mithril';
import type {Deferred} from '../../../base/deferred';
import {defer} from '../../../base/deferred';
import type {Result} from '../../../base/result';
import type {Trace} from '../../../public/trace';
import type {Engine} from '../../../trace_processor/engine';
import type {
  QueryResult,
  Row,
  SqlValue,
} from '../../../trace_processor/query_result';
import type {DuneGraphController} from '../controller';
import type {BuildGraph, NodeId} from '../model/graph';
import {dep, rule, testGraph} from '../model/graph_test_helper';
import type {TreeLeafEntry} from './query_results';
import {
  DuneQueryResults,
  buildNodeTreeItems,
  formatExtraParts,
  formatExtraValue,
  sliceLink,
} from './query_results';
import type {PathTreeItem} from '../model/path_tree';

// Projects a `PathTreeItem<TreeLeafEntry>` down to a plain, easy-to-assert-on
// shape: the raw dir/leaf segments (as `sep + name`, so an empty `sep` and a
// literal `/`/`@` are both visible), the merged-row count, and the resolved
// node's label (undefined for a value that resolved to no node).
function project(
  graph: BuildGraph,
  items: readonly PathTreeItem<TreeLeafEntry>[],
) {
  return items.map((it) => ({
    dir: it.dir.map((seg) => seg.sep + seg.name),
    leaf: it.leaf.sep + it.leaf.name,
    count: it.item.count,
    node: it.item.node === undefined ? undefined : graph.labelOf(it.item.node),
  }));
}

// One graph serves every test here: `buildNodeTreeItems` only reads a node's
// kind, label and `dir`, and the `resolve` callback each test passes decides
// which node (if any) a cell's value stands for.
const g = testGraph([
  dep('a/b/dep1.ml'),
  dep('a/b/dep2.ml'),
  rule('42', {dir: 'a/b'}),
  rule('7'),
  dep('x.ml'),
  dep('9'),
]);
const graph = g.graph;

describe('buildNodeTreeItems', () => {
  it('files a dep by its raw id path, a rule by its dir + bare id', () => {
    const nodes = new Map<number, NodeId>([
      [1, g.id('a/b/dep1.ml')],
      [2, g.id('a/b/dep2.ml')],
      [3, g.id('42')],
    ]);
    const rows: Row[] = [{node_id: 1}, {node_id: 2}, {node_id: 3}];

    const items = buildNodeTreeItems(graph, rows, 'node_id', false, (v) =>
      nodes.get(Number(v)),
    );

    expect(project(graph, items)).toEqual([
      {dir: ['a', '/b'], leaf: '/dep1.ml', count: 1, node: 'a/b/dep1.ml'},
      {dir: ['a', '/b'], leaf: '/dep2.ml', count: 1, node: 'a/b/dep2.ml'},
      {dir: ['a', '/b'], leaf: '/42', count: 1, node: '42'},
    ]);
  });

  it('files a dirless rule at the top level', () => {
    const items = buildNodeTreeItems(
      graph,
      [{node_id: 5}],
      'node_id',
      false,
      () => g.id('7'),
    );
    expect(project(graph, items)).toEqual([
      {dir: [], leaf: '/7', count: 1, node: '7'},
    ]);
  });

  it('merges rows resolving to the same node into one entry when merge is on', () => {
    const rows: Row[] = [{node_id: 9}, {node_id: 9}, {node_id: 9}];
    const resolve = () => g.id('x.ml');

    expect(
      project(graph, buildNodeTreeItems(graph, rows, 'node_id', true, resolve)),
    ).toEqual([{dir: [], leaf: 'x.ml', count: 3, node: 'x.ml'}]);
  });

  it('keeps one entry per row when merge is off', () => {
    const rows: Row[] = [{node_id: 9}, {node_id: 9}];
    const resolve = () => g.id('x.ml');

    expect(
      project(
        graph,
        buildNodeTreeItems(graph, rows, 'node_id', false, resolve),
      ),
    ).toEqual([
      {dir: [], leaf: 'x.ml', count: 1, node: 'x.ml'},
      {dir: [], leaf: 'x.ml', count: 1, node: 'x.ml'},
    ]);
  });

  it('files an unresolved value at the top level, keyed by its raw value', () => {
    const rows: Row[] = [{node_id: 123}, {node_id: 123}];
    const items = buildNodeTreeItems(
      graph,
      rows,
      'node_id',
      true,
      () => undefined,
    );
    expect(project(graph, items)).toEqual([
      {dir: [], leaf: '123', count: 2, node: undefined},
    ]);
  });

  it('skips rows with a null or missing cell in the group column', () => {
    const rows: Row[] = [{node_id: 9}, {node_id: null}, {other: 1}];
    const items = buildNodeTreeItems(graph, rows, 'node_id', true, () =>
      g.id('x.ml'),
    );
    expect(project(graph, items)).toEqual([
      {dir: [], leaf: 'x.ml', count: 1, node: 'x.ml'},
    ]);
  });

  it('does not merge an unresolved value with a node sharing its string form', () => {
    const rows: Row[] = [{node_id: 9}, {node_id: 9}];
    // First row resolves, second doesn't - shouldn't be treated as the same
    // entry just because String(value) collides with the resolved node's label.
    let calls = 0;
    const resolve = () => (calls++ === 0 ? g.id('9') : undefined);
    const items = buildNodeTreeItems(graph, rows, 'node_id', true, resolve);
    expect(project(graph, items)).toEqual([
      {dir: [], leaf: '9', count: 1, node: '9'},
      {dir: [], leaf: '9', count: 1, node: undefined},
    ]);
  });
});

describe('formatExtraParts', () => {
  const formatValue = (_col: string, value: SqlValue) => String(value);

  it('folds forced_by_kind/target for a RULE forcer', () => {
    const row: Row = {
      node_id: 1,
      forced_by_kind: 'RULE',
      forced_by_target: '2',
    };
    const cols = ['node_id', 'forced_by_kind', 'forced_by_target'];
    expect(formatExtraParts(cols, row, 1, formatValue)).toEqual([
      'node_id=1',
      'forced by rule 2',
    ]);
  });

  it('folds forced_by_kind/target for a DEP forcer', () => {
    const row: Row = {
      node_id: 3,
      forced_by_kind: 'DEP',
      forced_by_target: 'a/b',
    };
    const cols = ['node_id', 'forced_by_kind', 'forced_by_target'];
    expect(formatExtraParts(cols, row, 1, formatValue)).toEqual([
      'node_id=3',
      'forced by a/b',
    ]);
  });

  it('includes other columns as plain col=value alongside the special ones', () => {
    const row: Row = {
      node_id: 1,
      forced_by_kind: 'RULE',
      forced_by_target: '2',
      distance: 4,
    };
    const cols = ['node_id', 'forced_by_kind', 'forced_by_target', 'distance'];
    expect(formatExtraParts(cols, row, 1, formatValue)).toEqual([
      'node_id=1',
      'forced by rule 2',
      'distance=4',
    ]);
  });

  it('omits the forced-by part entirely when forced_by_kind is null', () => {
    const row: Row = {node_id: 1, forced_by_kind: null, forced_by_target: null};
    const cols = ['node_id', 'forced_by_kind', 'forced_by_target'];
    expect(formatExtraParts(cols, row, 1, formatValue)).toEqual(['node_id=1']);
  });

  it('degrades to a generic phrase when forced_by_target is absent', () => {
    const row: Row = {forced_by_kind: 'RULE'};
    expect(formatExtraParts(['forced_by_kind'], row, 1, formatValue)).toEqual([
      'forced by a rule',
    ]);
  });

  it('falls back to plain col=value for an unrecognised kind, keeping the target', () => {
    const row: Row = {forced_by_kind: 'SOMETHING_ELSE', forced_by_target: 'x'};
    const cols = ['forced_by_kind', 'forced_by_target'];
    expect(formatExtraParts(cols, row, 1, formatValue)).toEqual([
      'forced_by_kind=SOMETHING_ELSE',
      'forced_by_target=x',
    ]);
  });

  it('folds forced_by_target regardless of its position relative to forced_by_kind', () => {
    const row: Row = {forced_by_target: '2', forced_by_kind: 'RULE'};
    const cols = ['forced_by_target', 'forced_by_kind'];
    expect(formatExtraParts(cols, row, 1, formatValue)).toEqual([
      'forced by rule 2',
    ]);
  });

  it('prefixes a ×N count when count is greater than 1', () => {
    const row: Row = {node_id: 1};
    expect(formatExtraParts(['node_id'], row, 3, formatValue)).toEqual([
      '×3',
      'node_id=1',
    ]);
  });

  it('skips null/missing cells for ordinary columns', () => {
    const row: Row = {a: null, c: 5};
    expect(formatExtraParts(['a', 'b', 'c'], row, 1, formatValue)).toEqual([
      'c=5',
    ]);
  });
});

describe('formatExtraValue', () => {
  // Stands in for the panel's `nodeLabelFor`: every id here resolves to a node,
  // so a column showing a raw value is doing so by column, not for want of a
  // node to name.
  const nodeLabel = (_col: string, value: SqlValue) => `node-${String(value)}`;

  it('labels a chip column, whose raw id means nothing on its own', () => {
    for (const col of ['node_id', 'src', 'dst']) {
      expect(formatExtraValue(col, 3, nodeLabel)).toEqual('node-3');
    }
  });

  it('keeps a slice_id raw rather than restating the node label', () => {
    expect(formatExtraValue('slice_id', 512, nodeLabel)).toEqual('512');
  });

  it('falls back to the raw id for a chip column that resolves to no node', () => {
    expect(formatExtraValue('node_id', 3, () => undefined)).toEqual('3');
  });

  it('renders a duration column as a human duration', () => {
    expect(formatExtraValue('dur_ns', 88_000_000, nodeLabel)).toEqual('88ms');
    expect(formatExtraValue('action_dur_ns', 88_000_000n, nodeLabel)).toEqual(
      '88ms',
    );
  });

  it('leaves a non-numeric duration cell as its raw value', () => {
    expect(formatExtraValue('dur_ns', null, nodeLabel)).toEqual('null');
  });

  it('leaves an ordinary column raw, however id-shaped its value', () => {
    expect(formatExtraValue('distance', 3, nodeLabel)).toEqual('3');
  });
});

// Everything `sliceLink` touches on the controller. Both jumps are recorded
// rather than performed - they're queries in the real controller, and the point
// of each anchor is which of the two it asks for.
interface FakeController {
  readonly controller: DuneGraphController;
  readonly visitedNodes: NodeId[];
  readonly visitedSlices: number[];
}

function fakeController(): FakeController {
  const visitedNodes: NodeId[] = [];
  const visitedSlices: number[] = [];
  const controller = {
    graph,
    goToNode: async (node: NodeId) => {
      visitedNodes.push(node);
    },
    goToSlice: async (sliceId: number) => {
      visitedSlices.push(sliceId);
    },
  } as unknown as DuneGraphController;
  return {controller, visitedNodes, visitedSlices};
}

// Renders a cell into a detached element, as the DataGrid (or the tree view)
// would: what matters is the markup, not the shape of the mithril tree.
function render(children: m.Children): HTMLElement {
  const root = document.createElement('div');
  m.render(root, children);
  return root;
}

// Clicks the cell's link, if it has one.
function clickLink(root: HTMLElement): void {
  root.querySelector('a')?.dispatchEvent(new MouseEvent('click'));
}

describe('sliceLink', () => {
  const node = g.id('a/b/dep1.ml');

  it('links a node-backed slice id through its node', () => {
    const {controller, visitedNodes, visitedSlices} = fakeController();
    const root = render(sliceLink(controller, node, 7, '7'));

    expect(root.textContent).toContain('7');
    clickLink(root);
    expect(visitedNodes).toEqual([node]);
    expect(visitedSlices).toEqual([]);
  });

  it('links a slice id of no node straight to the slice', () => {
    const {controller, visitedNodes, visitedSlices} = fakeController();
    const root = render(sliceLink(controller, undefined, 7, '7'));

    expect(root.textContent).toContain('7');
    clickLink(root);
    expect(visitedSlices).toEqual([7]);
    expect(visitedNodes).toEqual([]);
  });

  it('links a bigint slice id too', () => {
    const {controller, visitedSlices} = fakeController();
    const root = render(sliceLink(controller, undefined, 7n, '7'));
    clickLink(root);
    expect(visitedSlices).toEqual([7]);
  });

  it('leaves a NULL cell as inert text', () => {
    const {controller} = fakeController();
    const root = render(sliceLink(controller, undefined, null, ''));
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toBe('');
  });

  it('leaves a non-numeric cell as inert text', () => {
    // Nothing `resolveSqlEvents` could find, so a link would visibly do nothing.
    const {controller} = fakeController();
    const root = render(sliceLink(controller, undefined, 'not-an-id', 'x'));
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toBe('x');
  });
});

// A panel wired to an engine and a controller that answer nothing on their own:
// `queries` collects one deferred per SQL query issued (via the engine, so
// `runQueryForQueryTable` runs for real), `sliceLookups` one per follow-up
// `slice_id` resolution. Nothing settles until a test says so, which is what
// lets these tests stop inside `runQuery` - between the query coming back and
// its slice ids resolving - and look at what the panel would draw there.
interface QueryHarness {
  readonly results: DuneQueryResults;
  readonly queries: Deferred<Result<QueryResult>>[];
  readonly sliceLookups: Deferred<Map<number, NodeId>>[];
}

function queryHarness(): QueryHarness {
  const queries: Deferred<Result<QueryResult>>[] = [];
  const sliceLookups: Deferred<Map<number, NodeId>>[] = [];
  const trace = {
    engine: {
      tryQuery: () => {
        const d = defer<Result<QueryResult>>();
        queries.push(d);
        return d;
      },
    } as unknown as Engine,
  } as unknown as Trace;
  const controller = {
    graph,
    // A loaded node mirror, so `missingTables` lets the query through.
    nodeMirrorReady: true,
    graphStep: {error: undefined},
    nodesForSliceIds: () => {
      const d = defer<Map<number, NodeId>>();
      sliceLookups.push(d);
      return d;
    },
    nodeForNodeId: () => undefined,
    goToNode: async () => {},
    goToSlice: async () => {},
  } as unknown as DuneGraphController;
  return {
    results: new DuneQueryResults(trace, controller),
    queries,
    sliceLookups,
  };
}

// The engine's answer to one query: `rows`' own keys as the result columns,
// read back through a cursor, as `runQueryForQueryTable` expects. Only the
// methods it calls are here - a real `QueryResult` is a wasm protobuf reader
// with no plain-object constructor (see controller_unittest.ts).
function okRows(rows: readonly Row[]): Result<QueryResult> {
  const value = {
    columns: () => Object.keys(rows[0] ?? {}),
    numRows: () => rows.length,
    elapsedTimeMs: () => 0,
    error: () => undefined,
    statementCount: () => 1,
    statementWithOutputCount: () => 1,
    lastStatementSql: () => 'select …',
    iter: () => {
      let i = 0;
      return {
        valid: () => i < rows.length,
        next: () => {
          i++;
        },
        get: (col: string) => rows[i][col],
      };
    },
  };
  return {ok: true, value: value as unknown as QueryResult};
}

// A query that never ran: trace processor's own refusal, which
// `runQueryForQueryTable` turns into a response carrying `error`.
function queryFailure(message: string): Result<QueryResult> {
  return {ok: false, error: message, value: undefined};
}

// Yields to the event loop, draining the microtasks a just-settled deferred
// woke, so `runQuery` has reached its next unsettled await by the time the test
// looks at the panel again.
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// What the results pane would show right now, as text.
function renderText(results: DuneQueryResults): string {
  return render(results.render()).textContent ?? '';
}

describe('DuneQueryResults.runQuery', () => {
  // The pane's "nothing has been run yet" state, which a settled or in-flight
  // query must never show.
  const EMPTY_STATE = 'Run a SQL query';

  it('stays loading across the slice_id lookup, never showing the empty state', async () => {
    const h = queryHarness();
    const frames: string[] = [];

    const done = h.results.runQuery('select slice_id from dune_node');
    await settle();
    frames.push(renderText(h.results));

    // The window the pane used to flash its empty state in: the query is back,
    // its slice ids are not.
    h.queries[0].resolve(okRows([{slice_id: 222}]));
    await settle();
    expect(h.results.isLoading).toBe(true);
    frames.push(renderText(h.results));

    h.sliceLookups[0].resolve(new Map());
    await done;
    frames.push(renderText(h.results));

    expect(frames[0]).toContain('Running query…');
    expect(frames[1]).toContain('Running query…');
    for (const frame of frames) expect(frame).not.toContain(EMPTY_STATE);
    expect(h.results.isLoading).toBe(false);
    expect(frames[2]).toContain('Returned 1 rows');
  });

  it('shows a failed slice_id lookup as an error instead of rejecting', async () => {
    const h = queryHarness();

    const done = h.results.runQuery('select slice_id from dune_node');
    await settle();
    h.queries[0].resolve(okRows([{slice_id: 222}]));
    await settle();
    h.sliceLookups[0].reject(new Error('no such table: dune_slice'));

    // Every caller fires `runQuery` with `void`, so a rejection here would go
    // unhandled and leave the pane with nothing to show.
    await expect(done).resolves.toBeUndefined();
    expect(h.results.isLoading).toBe(false);
    const text = renderText(h.results);
    expect(text).toContain('Could not resolve the slice_id column');
    expect(text).toContain('no such table: dune_slice');
    expect(text).not.toContain(EMPTY_STATE);
  });

  it('keeps a superseded query’s result out of the pane', async () => {
    const h = queryHarness();

    // Two queries in flight: the Run button disables itself while one runs,
    // but Mod+Enter and the history's play button don't.
    const first = h.results.runQuery('select 111');
    await settle();
    const second = h.results.runQuery('select 222');
    await settle();
    expect(h.queries.length).toBe(2);

    // The newer one settles all the way through first…
    h.queries[1].resolve(okRows([{slice_id: 222}]));
    await settle();
    h.sliceLookups[0].resolve(new Map());
    await second;

    // …and only then does the older one come back, with a differently-shaped
    // result.
    h.queries[0].resolve(okRows([{slice_id: 111}, {slice_id: 112}]));
    await settle();

    // Dropped before it even asks for its own slice ids, which is also why
    // awaiting it below returns rather than hanging on a second lookup.
    expect(h.sliceLookups.length).toBe(1);
    const text = renderText(h.results);
    expect(text).toContain('select 222');
    expect(text).not.toContain('select 111');
    expect(text).toContain('Returned 1 rows');
    await first;
  });

  it('keeps a superseded query’s failure out of the pane', async () => {
    const h = queryHarness();

    const first = h.results.runQuery('select 111');
    await settle();
    const second = h.results.runQuery('select 222');
    await settle();

    h.queries[1].resolve(okRows([{slice_id: 222}]));
    await settle();
    h.sliceLookups[0].resolve(new Map());
    await second;

    // `render` checks `error` before the result, so an error landing here would
    // read as the newer, successful query having failed.
    h.queries[0].resolve(queryFailure('no such column: 111'));
    await first;

    const text = renderText(h.results);
    expect(text).not.toContain('no such column: 111');
    expect(text).toContain('select 222');
    expect(text).toContain('Returned 1 rows');
  });
});
