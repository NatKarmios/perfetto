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

import {describe, expect, test} from 'vitest';
import {selectionSql} from './selection_sql';

describe('selectionSql', () => {
  test('an empty selection still clears the table and defines the function', () => {
    const sql = selectionSql([]);
    expect(sql).toHaveLength(3);
    expect(sql[1]).toContain('PERFETTO FUNCTION dune_selected()');
    expect(sql[2]).toBe('DELETE FROM _dune_selected');
  });

  test('inserts every node, chunked', () => {
    const nodes = Array.from({length: 5_001}, (_, i) => i);
    const inserts = selectionSql(nodes).slice(3);
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toMatch(
      /^INSERT INTO _dune_selected \(node_id\) VALUES \(0\), \(1\)/,
    );
    expect(inserts[1]).toBe(
      'INSERT INTO _dune_selected (node_id) VALUES (5000)',
    );
  });
});
