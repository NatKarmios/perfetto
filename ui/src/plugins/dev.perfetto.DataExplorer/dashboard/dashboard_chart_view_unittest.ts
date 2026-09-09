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
import {buildWhereClause, columnForChartType} from './dashboard_chart_view';
import {Dashboard, type DashboardAttrs} from './dashboard';
import type {
  DashboardBrushFilter,
  DashboardDataSource,
  DashboardItem,
} from './dashboard_registry';
import type {ChartColumnProvider} from '../query_builder/charts/chart_renderers';
import type {ChartConfig} from '../query_builder/nodes/visualisation_node';
import {
  type ChartTypeDefinition,
  getChartableColumns,
  registerChartType,
} from '../query_builder/charts/chart_type_registry';
import {renderChartConfigPopup} from '../query_builder/charts/chart_config_popup';
import type {ColumnInfo} from '../query_builder/column_info';
import type {Trace} from '../../../public/trace';

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

describe('the column a chart carries across a type switch', () => {
  // Both places a chart's type can be switched - the dashboard's edit panel
  // and the chart config popup - defer to `columnForChartType`, so a type that
  // reads its primary column as something specific (a node id, say) is not
  // left on whatever the previous type happened to point at.
  //
  // No built-in chart type implements `defaultColumn` - the types that do live
  // in plugins - so the hook is exercised through a locally registered type.
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
      // Every column counts as chartable, which is exactly why "the current
      // column is still valid" cannot be the whole answer.
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

  /** A type whose primary column means something specific. */
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
