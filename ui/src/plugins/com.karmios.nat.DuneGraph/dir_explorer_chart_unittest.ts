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
 * whose `render` and `defaultLabel` are only ever called by that registry - so
 * nothing else would notice them being malformed.
 *
 * The registration lifecycle gets the same treatment as the node column
 * renderer's (node_cell_unittest.ts): registering a chart type twice throws, so
 * the failure mode a plugin can actually cause is a registration that outlives
 * its trace. Both ends are pinned - dropped with the trace, and re-registered
 * without throwing on the next load.
 */

import m from 'mithril';
import {describe, expect, test} from 'vitest';
import {DisposableStack} from '../../base/disposable_stack';
import type {Trace} from '../../public/trace';
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
import {registerDirExplorerChart} from './dir_explorer_chart';

// The type id as the registry sees it. Spelt out rather than imported: it is
// persisted in dashboards, so a test that moved with it would not notice it
// changing under one.
const CHART_TYPE = 'dune-dir-tree';

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

// Everything the pane reads off the controller before the mirror exists: it
// renders its "not loaded" prompt and asks nothing else of it. Deliberately the
// unloaded state - a chart added before the graph is loaded is the common case,
// and it is the one render path here that needs no trace processor.
function fakeController(): DuneGraphController {
  return {
    mirrorVersion: 0,
    nodeMirrorReady: false,
    busy: false,
  } as unknown as DuneGraphController;
}

// A results node with a couple of columns, as a visualisation node dropped on
// a real query would have. The chart ignores them; the config popup does not.
function fakeNode(): ChartColumnProvider {
  return {
    sourceCols: [{name: 'path'}, {name: 'dur'}],
    getChartableColumns: () => [{name: 'path'}, {name: 'dur'}],
    clearChartFiltersForColumn: () => {},
    setBrushSelection: () => {},
    addRangeFilter: () => {},
    updateChart: () => {},
    removeChart: () => {},
    attrs: {chartConfigs: [config()]},
  } as unknown as ChartColumnProvider;
}

function config(): ChartConfig {
  return {id: 'chart-1', column: 'path', chartType: CHART_TYPE};
}

function renderIntoDom(children: m.Children): HTMLElement {
  const root = document.createElement('div');
  m.render(root, children);
  return root;
}

describe('registerDirExplorerChart', () => {
  test('makes the chart type resolvable and puts it in the picker', () => {
    const {trace, unload} = fakeTrace();
    registerDirExplorerChart(trace, fakeController());

    expect(isValidChartType(CHART_TYPE)).toBe(true);
    const def = getChartTypeDefinition(CHART_TYPE);
    expect(def?.label).toBe('Dune Directories');
    // Registered types go after the built-ins, so ours is the last card.
    expect(getChartTypes()[getChartTypes().length - 1]).toBe(def);

    const picker = renderIntoDom(renderChartTypePickerGrid(() => {}));
    expect(picker.textContent).toContain('Dune Directories');

    unload();
  });

  test('offers no pickers beyond the two the popup always shows', () => {
    const {trace, unload} = fakeTrace();
    registerDirExplorerChart(trace, fakeController());

    // The chart configures nothing, so every capability flag is off. The
    // popup's own type and primary-column rows are unconditional and stay.
    const popup = renderIntoDom(
      renderChartConfigPopup({node: fakeNode()}, config(), () => {}),
    );
    const labels = Array.from(popup.querySelectorAll('label')).map(
      (el) => el.querySelector('span')?.textContent,
    );
    expect(labels).toEqual(['Chart Type', 'Column']);

    unload();
  });

  test('renders the directory pane', () => {
    const {trace, unload} = fakeTrace();
    registerDirExplorerChart(trace, fakeController());

    const ctx = {trace, node: fakeNode()} as unknown as ChartRenderContext;
    const entry: ChartLoaderEntry = {key: ''};
    const root = renderIntoDom(
      getChartTypeDefinition(CHART_TYPE)?.render(ctx, config(), entry),
    );

    expect(root.querySelector('.pf-dune-dir-chart')).not.toBeNull();
    expect(root.querySelector('.pf-dune-explorer')).not.toBeNull();
    // The unloaded controller's prompt, i.e. the pane really did render.
    expect(root.textContent).toContain('Directory tree not loaded');

    unload();
  });

  test('labels a chart of this type without reading its config', () => {
    const {trace, unload} = fakeTrace();
    registerDirExplorerChart(trace, fakeController());

    expect(getDefaultChartLabel(config())).toBe('Dune directory tree');

    unload();
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
