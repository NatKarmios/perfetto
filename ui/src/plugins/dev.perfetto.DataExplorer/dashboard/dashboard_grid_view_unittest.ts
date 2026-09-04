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

import {brushFiltersToGridFilters, gridViewKey} from './dashboard_grid_view';
import type {DashboardBrushFilter, DashboardGrid} from './dashboard_registry';

// --- brushFiltersToGridFilters ---

describe('brushFiltersToGridFilters', () => {
  const allColumns = new Set(['x', 'y']);

  test('returns nothing for no filters', () => {
    expect(brushFiltersToGridFilters([], allColumns)).toEqual([]);
  });

  test('maps a single equality filter', () => {
    const filters: DashboardBrushFilter[] = [{column: 'x', op: '=', value: 42}];
    expect(brushFiltersToGridFilters(filters, allColumns)).toEqual([
      {field: 'x', op: '=', value: 42},
    ]);
  });

  test('folds same-column equality filters into an IN', () => {
    const filters: DashboardBrushFilter[] = [
      {column: 'x', op: '=', value: 1},
      {column: 'x', op: '=', value: 2},
    ];
    expect(brushFiltersToGridFilters(filters, allColumns)).toEqual([
      {field: 'x', op: 'in', value: [1, 2]},
    ]);
  });

  test('maps a range as two filters', () => {
    const filters: DashboardBrushFilter[] = [
      {column: 'x', op: '>=', value: 10},
      {column: 'x', op: '<', value: 20},
    ];
    expect(brushFiltersToGridFilters(filters, allColumns)).toEqual([
      {field: 'x', op: '>=', value: 10},
      {field: 'x', op: '<', value: 20},
    ]);
  });

  test('maps a null selection', () => {
    const filters: DashboardBrushFilter[] = [{column: 'x', op: 'is null'}];
    expect(brushFiltersToGridFilters(filters, allColumns)).toEqual([
      {field: 'x', op: 'is null'},
    ]);
  });

  test('drops the null when a column also has values', () => {
    // 'x IN (1) OR x IS NULL' is not expressible - the value wins.
    const filters: DashboardBrushFilter[] = [
      {column: 'x', op: '=', value: 1},
      {column: 'x', op: 'is null'},
    ];
    expect(brushFiltersToGridFilters(filters, allColumns)).toEqual([
      {field: 'x', op: '=', value: 1},
    ]);
  });

  test('keeps filters on different columns', () => {
    const filters: DashboardBrushFilter[] = [
      {column: 'x', op: '=', value: 1},
      {column: 'y', op: '=', value: 'a'},
    ];
    expect(brushFiltersToGridFilters(filters, allColumns)).toHaveLength(2);
  });

  test('drops filters on columns the source does not have', () => {
    const filters: DashboardBrushFilter[] = [
      {column: 'gone', op: '=', value: 1},
    ];
    expect(brushFiltersToGridFilters(filters, allColumns)).toEqual([]);
  });

  test('treats a missing value as NULL', () => {
    const filters: DashboardBrushFilter[] = [{column: 'x', op: '='}];
    expect(brushFiltersToGridFilters(filters, allColumns)).toEqual([
      {field: 'x', op: '=', value: null},
    ]);
  });

  test('escapes dots in column names', () => {
    const filters: DashboardBrushFilter[] = [
      {column: 'a.b', op: '=', value: 1},
    ];
    expect(brushFiltersToGridFilters(filters, new Set(['a.b']))).toEqual([
      {field: 'a..b', op: '=', value: 1},
    ]);
  });
});

// --- gridViewKey ---

describe('gridViewKey', () => {
  const grid: DashboardGrid = {id: 'g1', sourceNodeId: 'n1'};

  test('is stable for an unchanged grid', () => {
    expect(gridViewKey(grid)).toBe(gridViewKey({...grid}));
  });

  test('changes when the columns change', () => {
    expect(gridViewKey({...grid, columns: ['a']})).not.toBe(gridViewKey(grid));
    expect(gridViewKey({...grid, columns: ['a', 'b']})).not.toBe(
      gridViewKey({...grid, columns: ['a']}),
    );
  });

  test('differs between two grids', () => {
    expect(gridViewKey(grid)).not.toBe(gridViewKey({...grid, id: 'g2'}));
  });
});
