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
 * The node graph chart type (node_graph_chart.ts), taken from the two ends a bug
 * could come in at: the Data Explorer's registry, which has to be able to find
 * the type and put it in the picker, and the descriptor itself, whose
 * `createLoader` and `render` are only ever called by that registry - so nothing
 * else would notice them being malformed.
 *
 * The states around the graph get the same attention as the graph, because they
 * are what a misconfigured or over-broad chart shows and each of them is a
 * different thing to fix: no graph loaded, a primary column that holds no node
 * ids, no results table yet, a query whose rows name no nodes, a query that
 * names more than the layout can draw, and a query that names more than can
 * honestly be sampled. The alternative to all six is a blank card, which says
 * none of it.
 *
 * The registration lifecycle gets the same treatment as the directory chart's:
 * registering a chart type twice throws, so the failure mode a plugin can
 * actually cause is a registration that outlives its trace. Both ends are
 * pinned - dropped with the trace, and re-registered without throwing on the
 * next load.
 */

import m from 'mithril';
import {afterEach, describe, expect, test} from 'vitest';
import {DisposableStack} from '../../base/disposable_stack';
import type {Trace} from '../../public/trace';
import type {Engine} from '../../trace_processor/engine';
import type {ChartConfig} from '../dev.perfetto.DataExplorer/query_builder/nodes/visualisation_node';
import {renderChartConfigPopup} from '../dev.perfetto.DataExplorer/query_builder/charts/chart_config_popup';
import type {
  ChartColumnProvider,
  ChartLoaderEntry,
  ChartRenderContext,
} from '../dev.perfetto.DataExplorer/query_builder/charts/chart_renderers';
import {renderChartTypePickerGrid} from '../dev.perfetto.DataExplorer/query_builder/charts/chart_type_picker';
import {
  getChartTypeDefinition,
  getChartTypes,
  getDefaultChartLabel,
  isValidChartType,
} from '../dev.perfetto.DataExplorer/query_builder/charts/chart_type_registry';
import type {DuneGraphController} from './controller';
import type {NodeId} from './graph';
import {dep, rule, testGraph} from './graph_test_helper';
import {registerNodeGraphChart} from './node_graph_chart';
import {NODE_GRAPH_HARD_LIMIT, NODE_GRAPH_SOFT_CAP} from './node_graph_source';

// The type id as the registry sees it. Spelt out rather than imported: it is
// persisted in dashboards, so a test that moved with it would not notice it
// changing under one.
const CHART_TYPE = 'dune-node-graph';

// r1 -> {a, b}: three nodes, two edges, which is all the pane needs to draw
// something recognisable.
const g = testGraph([rule('r1', {staticDeps: ['a', 'b']}), dep('a'), dep('b')]);

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
function fakeTrace() {
  const trash = new DisposableStack();
  return {
    trace: {trash} as unknown as Trace,
    unload: () => trash.dispose(),
  };
}

// Register for the duration of one test, whatever it throws at. The chart
// closes over this controller, so it is the one the pane inside it reads.
function register(controller = fakeController()) {
  const {trace, unload} = fakeTrace();
  registerNodeGraphChart(trace, controller);
  live = new DisposableStack();
  live.defer(unload);
}

// Everything the chart and the pane read off the controller. Defaults to the
// *unloaded* mirror, since a chart added before the graph is loaded is the
// common case and the one render path that needs no trace processor.
function fakeController(over: Partial<DuneGraphController> = {}) {
  return {
    graph: g.graph,
    mirrorVersion: 1,
    nodeMirrorReady: false,
    busy: false,
    hideRules: false,
    graphVersion: 0,
    requestRedraw: () => {},
    visibleIn: (nodes: readonly NodeId[]) => nodes,
    nodeForSelection: () => undefined,
    goToNode: async () => {},
    ...over,
  } as unknown as DuneGraphController;
}

// The mirror as a chart with something to draw needs it.
function loadedController() {
  return fakeController({nodeMirrorReady: true});
}

// A results node with a couple of columns, as a visualisation node dropped on a
// real query would have. `cols` is what the chart reads for the node id column.
function fakeNode(
  cols: readonly string[] = ['path', 'dur'],
  updates: Array<Partial<ChartConfig>> = [],
): ChartColumnProvider {
  const sourceCols = cols.map((name) => ({name}));
  return {
    sourceCols,
    getChartableColumns: () => sourceCols,
    clearChartFiltersForColumn: () => {},
    setBrushSelection: () => {},
    addRangeFilter: () => {},
    updateChart: (_id: string, u: Partial<ChartConfig>) => updates.push(u),
    removeChart: () => {},
    attrs: {chartConfigs: [config()]},
  } as unknown as ChartColumnProvider;
}

function config(column = 'path'): ChartConfig {
  return {id: 'chart-1', column, chartType: CHART_TYPE};
}

function renderIntoDom(children: m.Children): HTMLElement {
  const root = document.createElement('div');
  m.render(root, children);
  return root;
}

/**
 * A stub engine answering the source's one query. `total` is what
 * `count(*) OVER ()` would have put on every row, so it can outrun the rows
 * themselves - which is exactly what the cap looks like from here.
 */
function stubEngine(nodes: readonly NodeId[], total = nodes.length): Engine {
  const rows = nodes.map((id) => ({node_id: id, total}));
  return {
    query: async () => {
      let i = 0;
      const it = {
        valid: () => i < rows.length,
        next: () => {
          i++;
        },
      };
      return {
        iter: () =>
          new Proxy(it, {
            get: (target, prop) => {
              if (prop in target) return target[prop as keyof typeof target];
              return (rows[i] as Record<string, unknown> | undefined)?.[
                prop as string
              ];
            },
          }),
      };
    },
  } as unknown as Engine;
}

/**
 * The chart as the host drives it: create the loader, render, let the load
 * land, render again.
 *
 * The two renders are the point - the first one starts the query and the second
 * one is the only one that can show what it found.
 */
async function renderChart(opts: {
  node: ChartColumnProvider;
  config: ChartConfig;
  nodes?: readonly NodeId[];
  total?: number;
}): Promise<HTMLElement> {
  const def = getChartTypeDefinition(CHART_TYPE);
  const entry: ChartLoaderEntry = {key: 'k'};
  const ctx = {node: opts.node} as unknown as ChartRenderContext;
  const nodes = opts.nodes ?? [];
  def?.createLoader(
    stubEngine(nodes, opts.total ?? nodes.length),
    'SELECT * FROM results_1',
    opts.config,
    entry,
  );
  const root = document.createElement('div');
  m.render(root, def?.render(ctx, opts.config, entry));
  await new Promise((r) => setTimeout(r, 0));
  m.render(root, def?.render(ctx, opts.config, entry));
  return root;
}

describe('registerNodeGraphChart', () => {
  test('makes the chart type resolvable and puts it in the picker', () => {
    register();

    expect(isValidChartType(CHART_TYPE)).toBe(true);
    const def = getChartTypeDefinition(CHART_TYPE);
    expect(def?.label).toBe('Dune Node Graph');
    // Registered types go after the built-ins, so ours is the last card.
    expect(getChartTypes()[getChartTypes().length - 1]).toBe(def);

    const picker = renderIntoDom(renderChartTypePickerGrid(() => {}));
    expect(picker.textContent).toContain('Dune Node Graph');
  });

  test('offers no pickers beyond the two the popup always shows', () => {
    register();

    // Nothing is aggregated or binned - a node is drawn or it isn't - so every
    // capability flag is off. The popup's own type row and primary-column row
    // are unconditional, and the primary column is named for what this chart
    // reads it as.
    const popup = renderIntoDom(
      renderChartConfigPopup({node: fakeNode()}, config(), () => {}),
    );
    const labels = Array.from(popup.querySelectorAll('label')).map(
      (el) => el.querySelector('span')?.textContent,
    );
    expect(labels).toEqual(['Chart Type', 'Node id column']);
  });

  test('labels a chart of this type without reading its config', () => {
    register();

    expect(getDefaultChartLabel(config())).toBe('Dune node graph');
  });

  test('coexists with the directory chart rather than clashing with it', () => {
    // Both are registered from the same onTraceLoad, so a shared type id or a
    // shared registration would surface as a throw on the second one.
    register();
    expect(isValidChartType('dune-dir-tree')).toBe(false);
    expect(isValidChartType(CHART_TYPE)).toBe(true);
  });

  test('drops the registration when the trace goes away', () => {
    const first = fakeTrace();
    registerNodeGraphChart(first.trace, fakeController());
    first.unload();

    expect(isValidChartType(CHART_TYPE)).toBe(false);

    // The next trace load, which must not trip the duplicate check.
    const second = fakeTrace();
    expect(() =>
      registerNodeGraphChart(second.trace, fakeController()),
    ).not.toThrow();
    second.unload();
  });
});

describe('the node graph chart', () => {
  test('offers to load the graph when it is not built', async () => {
    register();
    const root = await renderChart({node: fakeNode(), config: config()});

    expect(root.querySelector('.pf-dune-node-chart')).not.toBeNull();
    expect(root.textContent).toContain('Build graph not loaded');
    expect(root.textContent).toContain('Load graph');
  });

  test('offers the node id column rather than joining on a path', async () => {
    // The chart picker's default column is chosen generically and on a Dune
    // query is usually a label or a path; joining on it would match nothing.
    const updates: Array<Partial<ChartConfig>> = [];
    register(loadedController());
    const root = await renderChart({
      node: fakeNode(['path', 'src'], updates),
      config: config('path'),
    });

    expect(root.textContent).toContain('Pick the node id column');
    Array.from(root.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Use src'))
      ?.click();
    expect(updates).toEqual([{column: 'src'}]);
  });

  test('takes a column it cannot second-guess at its word', async () => {
    // No `node_id` / `src` / `dst` in the query, so the configured column is
    // the only candidate there is - a query may well have aliased one.
    register(loadedController());
    const root = await renderChart({
      node: fakeNode(['rule_node', 'dur']),
      config: config('rule_node'),
      nodes: [g.id('a')],
    });

    expect(root.textContent).not.toContain('Pick the node id column');
    expect(root.querySelector('circle')).not.toBeNull();
  });

  test('draws the nodes the query returned, and their edges', async () => {
    register(loadedController());
    const root = await renderChart({
      node: fakeNode(['node_id']),
      config: config('node_id'),
      nodes: [g.id('r1'), g.id('a'), g.id('b')],
    });

    expect(root.querySelectorAll('circle').length).toBe(3);
    // r1 -> a and r1 -> b, induced over the returned set.
    expect(root.querySelectorAll('line').length).toBe(2);
    expect(root.textContent).toContain('3 nodes');
  });

  test('leaves out the actions that are about the graph selection', async () => {
    // "Timeline" and "Clear" act on the side panel's selection, which is not
    // what this card is drawing.
    register(loadedController());
    const root = await renderChart({
      node: fakeNode(['node_id']),
      config: config('node_id'),
      nodes: [g.id('a')],
    });

    const labels = Array.from(root.querySelectorAll('button')).map(
      (b) => b.textContent ?? '',
    );
    expect(labels.some((l) => l.includes('Fit'))).toBe(true);
    expect(labels.some((l) => l.includes('Timeline'))).toBe(false);
    expect(labels.some((l) => l.includes('Clear'))).toBe(false);
  });

  test('says when the query named no nodes at all', async () => {
    register(loadedController());
    const root = await renderChart({
      node: fakeNode(['node_id']),
      config: config('node_id'),
      nodes: [],
    });

    expect(root.textContent).toContain('No Dune nodes in these rows');
    expect(root.querySelector('circle')).toBeNull();
  });

  test('draws the capped set and says how much it is of', async () => {
    // The soft cap has bitten: the card still draws, but the count in its own
    // toolbar is the honest one rather than the size of what came back.
    register(loadedController());
    const root = await renderChart({
      node: fakeNode(['node_id']),
      config: config('node_id'),
      nodes: [g.id('a'), g.id('b')],
      total: NODE_GRAPH_HARD_LIMIT - 1,
    });

    expect(root.querySelectorAll('circle').length).toBe(2);
    expect(root.textContent).toContain(
      `2 of ${NODE_GRAPH_HARD_LIMIT - 1} node`,
    );
  });

  test('refuses a query that names more than it can sample', async () => {
    // Past the hard limit the capped set is under a tenth of the answer, so
    // almost every edge in it would point at a node that isn't there.
    register(loadedController());
    const root = await renderChart({
      node: fakeNode(['node_id']),
      config: config('node_id'),
      nodes: [g.id('a'), g.id('b')],
      total: NODE_GRAPH_HARD_LIMIT + 1,
    });

    expect(root.textContent).toContain('Too many nodes to draw');
    expect(root.textContent).toContain(String(NODE_GRAPH_HARD_LIMIT + 1));
    expect(root.textContent).toContain(String(NODE_GRAPH_SOFT_CAP));
    // Nothing is drawn: the refusal is the whole card.
    expect(root.querySelector('circle')).toBeNull();
  });

  test('waits for the host to produce a results table', () => {
    register(loadedController());
    const def = getChartTypeDefinition(CHART_TYPE);
    // No `createLoader` call at all, which is what the host does before the
    // upstream node has run.
    const root = renderIntoDom(
      def?.render(
        {node: fakeNode(['node_id'])} as unknown as ChartRenderContext,
        config('node_id'),
        {key: ''},
      ),
    );

    expect(root.textContent).toContain('Waiting for results');
  });
});
