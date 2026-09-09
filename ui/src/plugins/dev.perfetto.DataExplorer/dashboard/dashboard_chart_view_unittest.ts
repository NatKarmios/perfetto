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
import {
  DashboardChartView,
  buildWhereClause,
  columnForChartType,
} from './dashboard_chart_view';
import {Dashboard, type DashboardAttrs} from './dashboard';
import {
  type DashboardBrushFilter,
  type DashboardDataSource,
  type DashboardItem,
  parseBrushFilters,
} from './dashboard_registry';
import type {ChartColumnProvider} from '../query_builder/charts/chart_renderers';
import type {ChartConfig} from '../query_builder/nodes/visualisation_node';
import type * as chartTypeRegistry from '../query_builder/charts/chart_type_registry';
import {
  type ChartTypeDefinition,
  getChartableColumns,
  registerChartType,
} from '../query_builder/charts/chart_type_registry';
import {renderChartConfigPopup} from '../query_builder/charts/chart_config_popup';
import type {ColumnInfo} from '../query_builder/column_info';
import type {Trace} from '../../../public/trace';

// `ensureLoader` hands the SQL it builds to `createChartLoaders`, and the
// adapter a chart's renderers brush through to `renderChartByType`. Intercept
// both rather than standing up an engine and a chart widget.
const {loaderQueries, adapters} = vi.hoisted(() => ({
  loaderQueries: [] as string[],
  adapters: [] as ChartColumnProvider[],
}));

vi.mock(
  '../query_builder/charts/chart_type_registry',
  async (importOriginal) => {
    const actual = await importOriginal<typeof chartTypeRegistry>();
    return {
      ...actual,
      createChartLoaders: (_engine: unknown, query: string) => {
        loaderQueries.push(query);
      },
      renderChartByType: (ctx: {node: ChartColumnProvider}) => {
        adapters.push(ctx.node);
        return null;
      },
    };
  },
);

describe('buildWhereClause', () => {
  test('returns nothing for no filters', () => {
    expect(buildWhereClause([])).toEqual('');
  });

  test('builds a numeric range', () => {
    const filters: DashboardBrushFilter[] = [
      {column: 'dur', op: '>=', value: 10},
      {column: 'dur', op: '<', value: 20},
    ];
    expect(buildWhereClause(filters)).toEqual(' WHERE dur >= 10 AND dur < 20');
  });

  test('quotes a string range', () => {
    const filters: DashboardBrushFilter[] = [
      {column: 'path', op: '>=', value: 'dir/'},
      {column: 'path', op: '<', value: 'dir0'},
    ];
    expect(buildWhereClause(filters)).toEqual(
      " WHERE path >= 'dir/' AND path < 'dir0'",
    );
  });

  test('escapes apostrophes in a string range', () => {
    const filters: DashboardBrushFilter[] = [
      {column: 'name', op: '>=', value: "it's"},
      {column: 'name', op: '<', value: "it's a lot"},
    ];
    expect(buildWhereClause(filters)).toEqual(
      " WHERE name >= 'it''s' AND name < 'it''s a lot'",
    );
  });

  test('quotes equality values', () => {
    const filters: DashboardBrushFilter[] = [
      {column: 'name', op: '=', value: "it's"},
    ];
    expect(buildWhereClause(filters)).toEqual(" WHERE name = 'it''s'");
  });

  test('folds same-column equality filters into an IN', () => {
    const filters: DashboardBrushFilter[] = [
      {column: 'name', op: '=', value: 'a'},
      {column: 'name', op: '=', value: "b'c"},
    ];
    expect(buildWhereClause(filters)).toEqual(" WHERE name IN ('a', 'b''c')");
  });

  test('combines nulls and equality with OR', () => {
    const filters: DashboardBrushFilter[] = [
      {column: 'name', op: '=', value: 'a'},
      {column: 'name', op: 'is null'},
    ];
    expect(buildWhereClause(filters)).toEqual(
      " WHERE (name = 'a' OR name IS NULL)",
    );
  });
});

describe('a chart does not filter itself by its own brush', () => {
  // `brushFilters` is keyed by *source* node, and a chart's own selection is
  // written into its own source's entry, so a chart reading that entry back as
  // an input filter re-runs its own query on its own brush. `isDriverChart`
  // was meant to prevent that but is only true once a consumer exists, so a
  // chart with nothing below a divider was filtering itself. Each chart
  // therefore stamps its id on the filters it pushes, and `ensureLoader`
  // excludes the ones bearing its own - so ownership lasts exactly as long as
  // the filter it describes, and survives a reload with it.
  const source = {
    nodeId: 's1',
    columns: [{name: 'node_id'}, {name: 'dur'}],
    tableName: 'tbl',
  };

  function config(id: string, column = 'node_id'): ChartConfig {
    return {id, column, chartType: 'bar'};
  }

  /**
   * One dashboard tab: the brush-filter state it owns, plus its charts as
   * long-lived component instances - the frame-to-frame identity that the
   * "I once brushed this" bookkeeping used to live in.
   */
  function dashboard(configs: ChartConfig[]) {
    let brushFilters = new Map<string, DashboardBrushFilter[]>();
    const charts = configs.map((c) => ({
      config: c,
      component: new DashboardChartView(),
    }));
    return {
      /** Filters currently on the shared source. */
      filters: () => brushFilters.get(source.nodeId) ?? [],
      /** Install filters as a reload would, with no brushing this session. */
      restore(raw: unknown[]) {
        brushFilters = parseBrushFilters({[source.nodeId]: raw});
      },
      /** Render one chart, returning its loader SQL and its own adapter. */
      frame(idx: number) {
        loaderQueries.length = 0;
        adapters.length = 0;
        const {config: cfg, component} = charts[idx];
        component.view({
          attrs: {
            trace: {engine: {}},
            source,
            config: cfg,
            dashboardId: 'd1',
            items: [],
            allSources: [source],
            brushFilters,
            onItemsChange: () => {},
            onBrushFiltersChange: (f: Map<string, DashboardBrushFilter[]>) => {
              brushFilters = f;
            },
          },
        } as never);
        return {
          query: loaderQueries[loaderQueries.length - 1],
          node: adapters[adapters.length - 1],
        };
      },
    };
  }

  test('stamps its own id on a brush selection', () => {
    const d = dashboard([config('c1')]);
    d.frame(0).node.setBrushSelection('node_id', [1, 2]);
    expect(d.filters()).toEqual([
      {column: 'node_id', op: '=', value: 1, chartId: 'c1'},
      {column: 'node_id', op: '=', value: 2, chartId: 'c1'},
    ]);
  });

  test('stamps its own id on a range filter', () => {
    const d = dashboard([config('c1', 'dur')]);
    d.frame(0).node.addRangeFilter('dur', 10, 20);
    expect(d.filters()).toEqual([
      {column: 'dur', op: '>=', value: 10, chartId: 'c1'},
      {column: 'dur', op: '<', value: 20, chartId: 'c1'},
    ]);
  });

  test('leaves nothing of its own behind when it clears a column', () => {
    const d = dashboard([config('c1')]);
    const chart = d.frame(0).node;
    chart.setBrushSelection('node_id', [1]);
    chart.clearChartFiltersForColumn('node_id');
    expect(d.filters()).toEqual([]);
  });

  test('stamps nothing when the brush selects nothing', () => {
    const d = dashboard([config('c1')]);
    d.frame(0).node.setBrushSelection('node_id', []);
    expect(d.filters()).toEqual([]);
  });

  test('does not re-run its own query on its own brush', () => {
    const d = dashboard([config('c1')]);
    const first = d.frame(0);
    expect(first.query).toEqual('SELECT * FROM tbl');
    first.node.setBrushSelection('node_id', [1]);
    // Its own filter is not one of its inputs, so its query is unchanged and
    // no new loader is built for it (an undefined query means none was).
    expect(d.frame(0).query).toBeUndefined();
  });

  test('consumes the filter that replaced its own on the same column', () => {
    // Two charts on one source and one column, no divider between them. The
    // second brush replaces the first, so the first chart is now an ordinary
    // consumer of it - it must not go on excluding the column just because it
    // was the one that brushed it last time.
    const d = dashboard([config('c1'), config('c2')]);
    d.frame(0).node.setBrushSelection('node_id', [1]);
    d.frame(1).node.setBrushSelection('node_id', [2]);
    expect(d.frame(0).query).toEqual('SELECT * FROM tbl WHERE node_id = 2');
    expect(d.frame(1).query).toEqual('SELECT * FROM tbl');
  });

  test('excludes a filter it owns in state restored from a reload', () => {
    // The whole point of stamping the filter: nothing was brushed in this
    // session, so there is no in-memory record of who owns what.
    const d = dashboard([config('c1'), config('c2')]);
    d.restore([{column: 'node_id', op: '=', value: 1, chartId: 'c1'}]);
    expect(d.frame(0).query).toEqual('SELECT * FROM tbl');
    expect(d.frame(1).query).toEqual('SELECT * FROM tbl WHERE node_id = 1');
  });

  test('consumes an unowned filter, as everything saved before this did', () => {
    const d = dashboard([config('c1')]);
    d.restore([{column: 'node_id', op: '=', value: 1}]);
    expect(d.frame(0).query).toEqual('SELECT * FROM tbl WHERE node_id = 1');
  });
});

describe('the column a chart carries across a type switch', () => {
  // Both places a chart's type can be switched - the dashboard's edit panel
  // and the chart config popup - defer to `columnForChartType`, so a type that
  // reads its primary column as something specific (a node id, say) is not
  // left on whatever the previous type happened to point at.
  const cols: ColumnInfo[] = [
    {name: 'name', checked: false, type: {kind: 'string'}},
    {name: 'dur', checked: false, type: {kind: 'int'}},
    {name: 'node_id', checked: false, type: {kind: 'int'}},
  ];

  const TEST_TYPE = 'test-switch-chart';
  const TEST_LABEL = 'Test Switch Chart';

  function makeDefinition(
    overrides: Partial<ChartTypeDefinition> = {},
  ): ChartTypeDefinition {
    return {
      type: TEST_TYPE,
      label: TEST_LABEL,
      icon: 'science',
      supportsAggregation: false,
      supportsBinning: false,
      // As both Dune chart types are: every column counts as chartable, which
      // is exactly why "the current column is still valid" cannot be the whole
      // answer.
      requiresNumericDimension: false,
      primaryColumnLabel: 'Node id column',
      supportsYColumn: false,
      supportsGroupColumn: false,
      supportsSizeColumn: false,
      description: `Description for ${TEST_TYPE}`,
      createLoader: () => {},
      render: () => null,
      defaultLabel: (config) => `Test: ${config.column}`,
      ...overrides,
    };
  }

  /** A type that asks for `node_id`, as the Dune chart types do. */
  function registerTypeWantingNodeId(): Disposable {
    return registerChartType(makeDefinition({defaultColumn: () => 'node_id'}));
  }

  function render(child: m.Children): HTMLElement {
    const root = document.createElement('div');
    m.render(root, child);
    return root;
  }

  test('is what the new type asks for, over a valid current column', () => {
    using _reg = registerTypeWantingNodeId();

    expect(columnForChartType(TEST_TYPE, 'name', cols)).toEqual('node_id');
  });

  test('is the current column for a type that asks for nothing', () => {
    using _reg = registerChartType(makeDefinition());

    expect(columnForChartType(TEST_TYPE, 'name', cols)).toEqual('name');
  });

  test('is nothing when the new type cannot chart the current column', () => {
    // A histogram needs a numeric dimension, and `name` is a string.
    expect(columnForChartType('histogram', 'name', cols)).toEqual('');
  });

  test('is what the config popup switches to', () => {
    using _reg = registerTypeWantingNodeId();

    const config: ChartConfig = {id: 'c1', column: 'name', chartType: 'bar'};
    const updates: Partial<Omit<ChartConfig, 'id'>>[] = [];
    const node: ChartColumnProvider = {
      sourceCols: cols,
      getChartableColumns: (type) => getChartableColumns(type, cols),
      clearChartFiltersForColumn: () => {},
      setBrushSelection: () => {},
      addRangeFilter: () => {},
      updateChart: (_id, update) => updates.push(update),
      removeChart: () => {},
      attrs: {chartConfigs: [config]},
    };

    const root = render(renderChartConfigPopup({node}, config, () => {}));
    // The type picker is the one <select> offering chart types rather than
    // columns.
    const select = Array.from(root.querySelectorAll('select')).find(
      (s) => s.querySelector(`option[value="${TEST_TYPE}"]`) !== null,
    );
    expect(select).not.toBeUndefined();
    select!.value = TEST_TYPE;
    select!.dispatchEvent(new Event('change'));

    expect(updates).toEqual([{chartType: TEST_TYPE, column: 'node_id'}]);
  });

  test('is what the dashboard edit panel switches to', () => {
    using _reg = registerTypeWantingNodeId();

    const source: DashboardDataSource = {
      name: 'src',
      nodeId: 's1',
      graphId: 'g1',
      tableName: 'tbl',
      columns: cols.map(({name, type}) => ({name, type})),
    };
    const config: ChartConfig = {id: 'c1', column: 'name', chartType: 'bar'};
    let updated: ChartConfig | undefined;
    const attrs: DashboardAttrs = {
      dashboardId: 'd1',
      trace: {engine: {}} as unknown as Trace,
      items: [{kind: 'chart', sourceNodeId: source.nodeId, config}],
      sources: [source],
      brushFilters: new Map(),
      onItemsChange: (newItems: DashboardItem[]) => {
        const item = newItems.find((i) => i.kind === 'chart');
        updated = item?.kind === 'chart' ? item.config : undefined;
      },
      onBrushFiltersChange: () => {},
    };

    // Which chart the panel edits, and the panel itself, are the dashboard's
    // own state: reach past it rather than drive the whole canvas.
    const dashboard = new Dashboard() as unknown as {
      editingChart: {itemId: string; source: DashboardDataSource};
      renderEditPanel: (attrs: DashboardAttrs) => m.Children;
    };
    dashboard.editingChart = {itemId: config.id, source};

    const root = render(dashboard.renderEditPanel(attrs));
    const card = Array.from(
      root.querySelectorAll<HTMLElement>('button.pf-chart-type-picker__card'),
    ).find((b) => b.textContent?.includes(TEST_LABEL));
    expect(card).not.toBeUndefined();
    card!.click();

    expect(updated).toEqual({
      id: config.id,
      column: 'node_id',
      chartType: TEST_TYPE,
    });
  });
});
