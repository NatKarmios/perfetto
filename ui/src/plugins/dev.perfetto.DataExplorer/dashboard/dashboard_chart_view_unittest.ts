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

import {buildWhereClause} from './dashboard_chart_view';
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
