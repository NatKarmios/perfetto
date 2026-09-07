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
 * The directory-tree chart type (dir_explorer_chart.ts), taken from the two
 * ends a bug could come in at: the Data Explorer's registry, which has to be
 * able to find the type and put it in the picker, and the descriptor itself,
 * whose `createLoader` and `render` are only ever called by that registry - so
 * nothing else would notice them being malformed.
 *
 * The states around the tree get the same attention as the tree, because they
 * are what a misconfigured chart shows and each of them is a different thing to
 * fix: no graph loaded, a primary column that holds no node ids, no results
 * table yet, and a query whose rows name no nodes. The alternative to all four
 * is an empty tree, which says none of it.
 *
 * The registration lifecycle gets the same treatment as the node column
 * renderer's (node_cell_unittest.ts): registering a chart type twice throws, so
 * the failure mode a plugin can actually cause is a registration that outlives
 * its trace. Both ends are pinned - dropped with the trace, and re-registered
 * without throwing on the next load.
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
import type {SqlValue} from '../../trace_processor/query_result';
import type {DuneGraphController} from './controller';
import {MAX_BRUSH_NODES, registerDirExplorerChart} from './dir_explorer_chart';

// The type id as the registry sees it. Spelt out rather than imported: it is
// persisted in dashboards, so a test that moved with it would not notice it
// changing under one.
const CHART_TYPE = 'dune-dir-tree';

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
// going away looks like from here. (Same shape as node_cell_unittest.ts's.)
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
  registerDirExplorerChart(trace, controller);
  live = new DisposableStack();
  live.defer(unload);
}

// The mirror as a chart with something to draw needs it.
function loadedController() {
  return fakeController({nodeMirrorReady: true});
}

// Everything the chart and the pane read off the controller. Defaults to the
// *unloaded* mirror, since a chart added before the graph is loaded is the
// common case and the one render path that needs no trace processor.
function fakeController(over: Partial<DuneGraphController> = {}) {
  return {
    mirrorVersion: 1,
    nodeMirrorReady: false,
    busy: false,
    requestRedraw: () => {},
    ...over,
  } as unknown as DuneGraphController;
}

// A results node with a couple of columns, as a visualisation node dropped on a
// real query would have. `cols` is what the chart reads for the node id column
// and for whether a directory click has a `dir_id` to filter on.
function fakeNode(
  cols: readonly string[] = ['path', 'dur'],
  brushes: Array<{column: string; values: SqlValue[]}> = [],
  updates: Array<Partial<ChartConfig>> = [],
  clears: string[] = [],
): ChartColumnProvider {
  const sourceCols = cols.map((name) => ({name}));
  return {
    sourceCols,
    getChartableColumns: () => sourceCols,
    clearChartFiltersForColumn: (column: string) => clears.push(column),
    setBrushSelection: (column: string, values: SqlValue[]) =>
      brushes.push({column, values}),
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
 * A stub engine answering the source's three queries from one fixture: the
 * mirror's directories, the per-directory counts over the chart's input, and a
 * directory's members.
 *
 * `nodes` is the input as the *mirror* resolves it - one entry per node the
 * query named - and the counts are aggregated from it here because that is what
 * the source now asks SQL to do (see dir_chart_source.ts). Member queries get
 * the same rows back: these tests never expand a directory, so the fixture only
 * has to have the right columns.
 *
 * `filtered` is the same thing under the pane's own filter, i.e. the answer to
 * any counts or id query carrying a `WHERE`. It takes the statement so that a
 * test can give two filters different answers, which is the only way to drive
 * the pane from one filter to another.
 */
type Rows = ReadonlyArray<Record<string, unknown>>;

function stubEngine(
  nodes: Rows,
  filtered: (sql: string) => Rows = () => nodes,
): Engine {
  const dirs = [
    {
      id: 0,
      parent_id: undefined,
      name: 'lib',
      path: 'lib',
      depth: 0,
      n_rules: 1,
      n_deps: 0,
      n_failed: 0,
      t_rules: 1,
      t_deps: 0,
      t_failed: 0,
      total_dur_ns: 0n,
    },
  ];
  // The rows a narrowed query sees: the filtered fixture where a filter is
  // actually in the statement, the whole input otherwise.
  const selected = (q: string) => (q.includes('WHERE') ? filtered(q) : nodes);
  return {
    query: async (q: string) => {
      const rows = q.includes('count(*)')
        ? countRows(selected(q))
        : isBrushIdsQuery(q)
          ? selected(q)
          : q.includes('FROM dune_dir')
            ? dirs
            : nodes;
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
 * The chart as the host drives it: create the loader, render, let the load land,
 * render again.
 *
 * The two renders are the point - the first one starts the query and the second
 * one is the only one that can show what it found.
 */
interface ChartOpts {
  node: ChartColumnProvider;
  config: ChartConfig;
  nodes?: Rows;
  filtered?: (sql: string) => Rows;
}

async function renderChart(opts: ChartOpts): Promise<HTMLElement> {
  return (await chartRunner(opts)).root;
}

/**
 * The chart mounted as above, plus the means to keep driving it: `step()` lets
 * the pending queries land and re-renders, which is what an interaction with
 * the pane inside the card needs.
 *
 * Rendered into one root throughout, so the pane's component instance - and
 * with it the filter it is holding - survives between steps.
 */
async function chartRunner(
  opts: ChartOpts,
): Promise<{root: HTMLElement; step: () => Promise<void>}> {
  const def = getChartTypeDefinition(CHART_TYPE);
  const entry: ChartLoaderEntry = {key: 'k'};
  const ctx = {node: opts.node} as unknown as ChartRenderContext;
  const nodes = opts.nodes ?? [];
  def?.createLoader(
    stubEngine(nodes, opts.filtered ?? (() => nodes)),
    'SELECT * FROM results_1',
    opts.config,
    entry,
  );
  const root = document.createElement('div');
  const step = async () => {
    await new Promise((r) => setTimeout(r, 0));
    m.render(root, def?.render(ctx, opts.config, entry));
  };
  m.render(root, def?.render(ctx, opts.config, entry));
  await step();
  await step();
  return {root, step};
}

// Types `text` into the pane's filter box and submits it, the way the box's own
// handlers see it: the draft follows `input`, and only Enter applies it.
function typeFilter(root: HTMLElement, text: string): void {
  const input = root.querySelector('input');
  if (input === null) throw new Error('no filter input');
  input.value = text;
  input.dispatchEvent(new Event('input', {bubbles: true}));
  input.dispatchEvent(
    new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}),
  );
}

// The pane's per-row narrowing button, whichever way its toggle is pointing.
function narrowButton(root: HTMLElement): HTMLElement | undefined {
  return Array.from(root.querySelectorAll('button')).find((b) =>
    /narrow/i.test(b.getAttribute('title') ?? ''),
  );
}

/**
 * The brush's id query (`matchingNodeIds`), as distinct from the two other
 * queries that also select `n.node_id`.
 *
 * It has to be picked out before the `FROM dune_dir` test, because under a path
 * filter it embeds a `dune_dir` scan of its own (the rule half of a path test).
 * `n.dir_id =` is what tells it from a member query: those start from one
 * directory, this one spans the tree.
 */
function isBrushIdsQuery(sql: string): boolean {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return (
    flat.startsWith('SELECT n.node_id AS node_id FROM') &&
    !flat.includes('n.dir_id =')
  );
}

// One row of the input join, as the source's reader wants it.
function nodeRow(over: Record<string, unknown> = {}) {
  return {dir_id: 0, node_id: 1, kind: 'rule', label: 'lib:foo', ...over};
}

// The counts query's answer over a fixture: one row per (directory, kind), the
// way the `GROUP BY` the source issues would return it.
function countRows(
  nodes: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const counts = new Map<string, Record<string, unknown>>();
  for (const node of nodes) {
    const key = `${node.dir_id}/${node.kind}`;
    const row = counts.get(key);
    if (row === undefined) {
      counts.set(key, {dir_id: node.dir_id, kind: node.kind, cnt: 1});
    } else {
      row.cnt = (row.cnt as number) + 1;
    }
  }
  return [...counts.values()];
}

describe('registerDirExplorerChart', () => {
  test('makes the chart type resolvable and puts it in the picker', () => {
    register();

    expect(isValidChartType(CHART_TYPE)).toBe(true);
    const def = getChartTypeDefinition(CHART_TYPE);
    expect(def?.label).toBe('Dune Directories');
    // Registered types go after the built-ins, so ours is the last card.
    expect(getChartTypes()[getChartTypes().length - 1]).toBe(def);

    const picker = renderIntoDom(renderChartTypePickerGrid(() => {}));
    expect(picker.textContent).toContain('Dune Directories');
  });

  test('offers no pickers beyond the two the popup always shows', () => {
    register();

    // The chart aggregates and bins nothing, so every capability flag is off.
    // The popup's own type row and primary-column row are unconditional - and
    // the primary column is named for what this chart reads it as.
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

    expect(getDefaultChartLabel(config())).toBe('Dune directory tree');
  });

  test('drops the registration when the trace goes away', () => {
    const first = fakeTrace();
    registerDirExplorerChart(first.trace, fakeController());
    first.unload();

    expect(isValidChartType(CHART_TYPE)).toBe(false);

    // The next trace load, which must not trip the duplicate check.
    const second = fakeTrace();
    expect(() =>
      registerDirExplorerChart(second.trace, fakeController()),
    ).not.toThrow();
    second.unload();
  });
});

describe('the directory chart', () => {
  test('offers to load the graph when the mirror is not built', async () => {
    register();
    const root = await renderChart({node: fakeNode(), config: config()});

    expect(root.querySelector('.pf-dune-dir-chart')).not.toBeNull();
    expect(root.textContent).toContain('Directory tree not loaded');
    expect(root.textContent).toContain('Load graph');
  });

  test('offers the node id column rather than joining on a path', async () => {
    // The chart picker's default column is chosen generically and on a Dune
    // query is usually a label or a path; joining on it would match nothing and
    // draw an empty tree.
    const updates: Array<Partial<ChartConfig>> = [];
    register(loadedController());
    const root = await renderChart({
      node: fakeNode(['path', 'node_id'], [], updates),
      config: config('path'),
    });

    expect(root.textContent).toContain('Pick the node id column');
    Array.from(root.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Use node_id'))
      ?.click();
    expect(updates).toEqual([{column: 'node_id'}]);
  });

  test('takes a column it cannot second-guess at its word', async () => {
    // No `node_id` / `src` / `dst` in the query, so the configured column is
    // the only candidate there is - a query may well have aliased one.
    register(loadedController());
    const root = await renderChart({
      node: fakeNode(['rule_node', 'dur']),
      config: config('rule_node'),
      nodes: [nodeRow()],
    });

    expect(root.textContent).not.toContain('Pick the node id column');
    expect(root.querySelector('.pf-dune-explorer')).not.toBeNull();
  });

  test('renders the pane over the rows the query returned', async () => {
    register(loadedController());
    const root = await renderChart({
      node: fakeNode(['node_id']),
      config: config('node_id'),
      nodes: [nodeRow()],
    });

    expect(root.querySelector('.pf-dune-explorer')).not.toBeNull();
    expect(root.textContent).toContain('lib/');
    // The pane's own filter UI comes along: the rows are one narrowing and the
    // filter is another, and the source's queries carry both.
    expect(root.textContent).toContain('Filters');
    expect(root.querySelector('.pf-dune-explorer__filter')).not.toBeNull();
  });

  test('says when the query named no nodes at all', async () => {
    register(loadedController());
    const root = await renderChart({
      node: fakeNode(['node_id']),
      config: config('node_id'),
      nodes: [],
    });

    expect(root.textContent).toContain('No Dune nodes in these rows');
    expect(root.querySelector('.pf-dune-explorer')).toBeNull();
  });

  test('draws the whole tree however many rows the query returned', async () => {
    // Nothing is capped and nothing is warned about: the counts are aggregated
    // in SQL, so a query naming every node in the build costs the same rows on
    // the way back as one naming a handful (see dir_chart_source.ts).
    register(loadedController());
    const root = await renderChart({
      node: fakeNode(['node_id']),
      config: config('node_id'),
      nodes: Array.from({length: 60_000}, (_, i) => nodeRow({node_id: i})),
    });

    expect(root.querySelector('.pf-dune-explorer')).not.toBeNull();
    expect(root.textContent).not.toContain('no more');
  });

  test('waits for the host to produce a results table', async () => {
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

  test('narrows the rest of the surface to a clicked directory', async () => {
    const brushes: Array<{column: string; values: SqlValue[]}> = [];
    register(loadedController());
    const root = await renderChart({
      node: fakeNode(['node_id', 'dir_id'], brushes),
      config: config('node_id'),
      nodes: [nodeRow()],
    });

    Array.from(root.querySelectorAll('button'))
      .find((b) =>
        (b.getAttribute('title') ?? '').startsWith('Narrow everything else'),
      )
      ?.click();
    // Repeated `=` filters on `dir_id`, which the dashboard renders as
    // `dir_id IN (...)`.
    expect(brushes).toEqual([{column: 'dir_id', values: [0]}]);
  });

  test('withholds the narrowing button when the query has no dir_id', async () => {
    register(loadedController());
    const root = await renderChart({
      node: fakeNode(['node_id']),
      config: config('node_id'),
      nodes: [nodeRow()],
    });

    const narrow = Array.from(root.querySelectorAll('button')).find((b) =>
      (b.getAttribute('title') ?? '').startsWith('Narrow everything else'),
    );
    expect(narrow).toBeUndefined();
  });
});

/**
 * The pane's own filter brushing the dashboard.
 *
 * The failures worth pinning are the ones nobody would see: a brush that goes
 * out on the wrong column (matching nothing, silently), a truncated one (a lie
 * about what matched, also silently), and a brush left standing after the filter
 * that made it is gone (the other cards narrowed by something that is no longer
 * on screen).
 */
describe('the directory chart brushing its filter', () => {
  // Three nodes in the one directory, distinct ids, so a brush over them is
  // distinguishable from a brush over the counts or the directories.
  const THREE = [
    nodeRow({node_id: 7}),
    nodeRow({node_id: 8}),
    nodeRow({node_id: 9}),
  ];
  // Over `MAX_BRUSH_NODES`, and counted as one `GROUP BY` row so the pane's
  // match count is the fixture's length.
  const TOO_MANY = Array.from({length: MAX_BRUSH_NODES + 500}, (_, i) =>
    nodeRow({node_id: i}),
  );

  test('brushes the matching node ids on the column it was pointed at', async () => {
    const brushes: Array<{column: string; values: SqlValue[]}> = [];
    const clears: string[] = [];
    register(loadedController());
    const {root, step} = await chartRunner({
      node: fakeNode(['node_id', 'dur'], brushes, [], clears),
      config: config('node_id'),
      nodes: THREE,
    });

    // Mounting brushes nothing: the pane's filter is empty, so there is nothing
    // to narrow anything to - and nothing to clear either.
    expect(brushes).toEqual([]);
    expect(clears).toEqual([]);

    typeFilter(root, 'a');
    await step();
    await step();

    // The column is the chart's own primary column, since the ids are values of
    // it - the same thing every built-in renderer brushes.
    expect(brushes).toEqual([{column: 'node_id', values: [7, 8, 9]}]);
    // Cleared first, so a second filter replaces the first rather than unioning
    // with it.
    expect(clears).toEqual(['node_id']);
    expect(root.querySelector('.pf-dune-dir-chart__note')).toBeNull();
  });

  test('brushes the aliased column when the query named one', async () => {
    // An edge query's node ids arrive as `src`, and the chart is configured on
    // it; brushing a literal `node_id` would name a column the query has not
    // got.
    const brushes: Array<{column: string; values: SqlValue[]}> = [];
    register(loadedController());
    const {root, step} = await chartRunner({
      node: fakeNode(['src', 'dur'], brushes),
      config: config('src'),
      nodes: [nodeRow({node_id: 7})],
    });

    typeFilter(root, 'a');
    await step();
    await step();

    expect(brushes).toEqual([{column: 'src', values: [7]}]);
  });

  test('brushes nothing at all past the cap, and says so where the filter is', async () => {
    const brushes: Array<{column: string; values: SqlValue[]}> = [];
    const clears: string[] = [];
    register(loadedController());
    const {root, step} = await chartRunner({
      node: fakeNode(['node_id'], brushes, [], clears),
      config: config('node_id'),
      nodes: THREE,
      filtered: () => TOO_MANY,
    });

    typeFilter(root, 'a');
    await step();
    await step();

    // Not a truncated brush: a silently shortened one would leave the other
    // cards showing a subset with nothing saying so.
    expect(brushes).toEqual([]);
    const note = root.querySelector('.pf-dune-dir-chart__note');
    expect(note?.textContent).toContain(
      `${TOO_MANY.length.toLocaleString()} matches`,
    );
    expect(note?.textContent).toContain('too many to narrow the other cards');
    // The tree itself is drawn regardless - the note is about the rest of the
    // dashboard, not about the card.
    expect(root.querySelector('.pf-dune-explorer')).not.toBeNull();
  });

  test('clears the brush it can no longer make', async () => {
    // Left standing, the earlier brush would narrow every other card to a
    // filter that is not the one in the box.
    const brushes: Array<{column: string; values: SqlValue[]}> = [];
    const clears: string[] = [];
    register(loadedController());
    const {root, step} = await chartRunner({
      node: fakeNode(['node_id'], brushes, [], clears),
      config: config('node_id'),
      nodes: THREE,
      // Digits, so the two filters are told apart by their patterns: a typed
      // word is case-folded into character classes (`*[bB][iI][gG]*`) and a
      // digit is not (see `compileFilter`).
      filtered: (sql) => (sql.includes("'*2*'") ? TOO_MANY : THREE),
    });

    typeFilter(root, '1');
    await step();
    await step();
    expect(brushes).toHaveLength(1);

    typeFilter(root, '2');
    await step();
    await step();

    expect(brushes).toHaveLength(1);
    expect(clears).toEqual(['node_id', 'node_id']);
    expect(root.querySelector('.pf-dune-dir-chart__note')).not.toBeNull();
  });

  test('clears the brush when the filter is cleared', async () => {
    const brushes: Array<{column: string; values: SqlValue[]}> = [];
    const clears: string[] = [];
    register(loadedController());
    const {root, step} = await chartRunner({
      node: fakeNode(['node_id'], brushes, [], clears),
      config: config('node_id'),
      nodes: THREE,
    });

    typeFilter(root, 'a');
    await step();
    await step();
    expect(brushes).toHaveLength(1);

    root
      .querySelector<HTMLElement>('.pf-dune-explorer__filter-chip button')
      ?.click();
    await step();
    await step();

    // No new brush, and the column cleared again: nothing outlives the filter
    // that made it.
    expect(brushes).toHaveLength(1);
    expect(clears).toEqual(['node_id', 'node_id']);
  });
});

/**
 * The two brushes together. They are separate gestures on separate columns and
 * the dashboard ANDs them, so the thing to pin is that neither one reaches into
 * the other's column.
 */
describe('the directory chart narrowing toggle', () => {
  test('brushes a directory, then clears it on a second click', async () => {
    const brushes: Array<{column: string; values: SqlValue[]}> = [];
    const clears: string[] = [];
    register(loadedController());
    const {root, step} = await chartRunner({
      node: fakeNode(['node_id', 'dir_id'], brushes, [], clears),
      config: config('node_id'),
      nodes: [nodeRow()],
    });

    const button = () => narrowButton(root)!;
    expect(button().classList.contains('pf-active')).toBe(false);

    button().click();
    await step();

    expect(brushes).toEqual([{column: 'dir_id', values: [0]}]);
    // Pressed and filled, so the row says which directory the dashboard is
    // narrowed to.
    expect(button().classList.contains('pf-active')).toBe(true);
    expect(button().querySelector('.pf-filled')).not.toBeNull();

    button().click();
    await step();

    // The clear, and no second brush: the button is the way back.
    expect(brushes).toHaveLength(1);
    expect(clears).toEqual(['dir_id', 'dir_id']);
    expect(button().classList.contains('pf-active')).toBe(false);
    expect(button().querySelector('.pf-filled')).toBeNull();
  });

  test('leaves the filter brush alone, and is left alone by it', async () => {
    const brushes: Array<{column: string; values: SqlValue[]}> = [];
    const clears: string[] = [];
    register(loadedController());
    const {root, step} = await chartRunner({
      node: fakeNode(['node_id', 'dir_id'], brushes, [], clears),
      config: config('node_id'),
      nodes: [nodeRow({node_id: 7})],
    });

    narrowButton(root)!.click();
    await step();
    typeFilter(root, 'a');
    await step();
    await step();

    // Both out at once: "in this directory" AND "matching this filter" is what
    // the dashboard reads them as, and it is what was asked for.
    expect(brushes).toEqual([
      {column: 'dir_id', values: [0]},
      {column: 'node_id', values: [7]},
    ]);
    expect(clears).toEqual(['dir_id', 'node_id']);
    // The directory is still the narrowed one, so its button is still pressed.
    expect(narrowButton(root)!.classList.contains('pf-active')).toBe(true);

    root
      .querySelector<HTMLElement>('.pf-dune-explorer__filter-chip button')
      ?.click();
    await step();
    await step();

    // Clearing the filter clears its own column only.
    expect(clears).toEqual(['dir_id', 'node_id', 'node_id']);
    expect(narrowButton(root)!.classList.contains('pf-active')).toBe(true);
  });
});

describe("the registered chart type's default column", () => {
  // The whole point: a chart dropped on a Dune query starts on the node id
  // column instead of the host's generic first-non-numeric guess, so it draws
  // rather than asking (see chart_node_column.ts). The descriptor only exists
  // while a registration does, hence the `register()` in each test.
  const pick = (names: readonly string[]) =>
    getChartTypeDefinition(CHART_TYPE)?.defaultColumn?.(
      names.map((name) => ({name})),
    );

  test('picks node_id over a label the generic rule would have taken', () => {
    register();
    expect(pick(['label', 'node_id', 'dur'])).toEqual('node_id');
  });

  test('takes src or dst when there is no node_id, in that order', () => {
    register();
    expect(pick(['label', 'src', 'dst'])).toEqual('src');
    expect(pick(['label', 'dst'])).toEqual('dst');
  });

  test('defers to the host when the query names none of them', () => {
    register();
    expect(pick(['label', 'path', 'dur'])).toBeUndefined();
  });
});
