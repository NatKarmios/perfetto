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

import {DashboardChartView, buildWhereClause} from './dashboard_chart_view';
import type {DashboardBrushFilter} from './dashboard_registry';

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
  // chart with nothing below a divider was filtering itself. The adapter
  // therefore remembers which columns it brushed; `ensureLoader` excludes them.
  const source = {
    nodeId: 's1',
    columns: [{name: 'node_id'}, {name: 'dur'}],
  };

  function adapter() {
    const callbacks = {
      brushFilters: new Map<string, DashboardBrushFilter[]>(),
      onBrushFiltersChange: () => {},
      allSources: [source],
    };
    return new DashboardChartView.Adapter(source as never, callbacks as never, {
      id: 'c1',
      column: 'node_id',
      chartType: 'bar',
    });
  }

  test('claims a column it brushes', () => {
    const a = adapter();
    expect([...a.brushedColumns]).toEqual([]);
    a.setBrushSelection('node_id', [1, 2]);
    expect([...a.brushedColumns]).toEqual(['node_id']);
  });

  test('claims a column it range-filters', () => {
    const a = adapter();
    a.addRangeFilter('dur', 10, 20);
    expect([...a.brushedColumns]).toEqual(['dur']);
  });

  test('gives the column back when it clears it', () => {
    // So the chart can consume a filter another chart later puts on it.
    const a = adapter();
    a.setBrushSelection('node_id', [1]);
    a.clearChartFiltersForColumn('node_id');
    expect([...a.brushedColumns]).toEqual([]);
  });

  test('does not claim a column it brushed nothing on', () => {
    const a = adapter();
    a.setBrushSelection('node_id', []);
    expect([...a.brushedColumns]).toEqual([]);
  });
});
