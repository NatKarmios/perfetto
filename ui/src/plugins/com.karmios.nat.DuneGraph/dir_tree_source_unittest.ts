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
 * The directory source (dir_tree_source.ts): its SELECT, and the types it
 * declares for the columns that SELECT returns.
 *
 * The SELECT and the column list come from one declaration, so what is checked
 * here is that the declaration says what it means to - every column selected
 * (a dropped one cannot be added to a grid without editing the graph), the
 * empty top-level directory labelled rather than blank, and no column claiming
 * to be a reference to a graph node when it is a directory id.
 *
 * The payload these become is checked against the Data Explorer's own loaders
 * in explore_source_unittest.ts, which is where the mechanism lives.
 */

import {DIR_TREE_COLUMNS, DIR_TREE_SQL} from './dir_tree_source';
import {exploreColumnType} from './explore_source';

describe('DIR_TREE_SQL', () => {
  it('is one SELECT over dune_dir, as SqlSourceNode requires', () => {
    expect(DIR_TREE_SQL.startsWith('SELECT')).toBe(true);
    expect(DIR_TREE_SQL).toContain('FROM dune_dir');
    // Zero statements before the SELECT and nothing after it.
    expect(DIR_TREE_SQL).not.toContain(';');
  });

  it('selects every declared column, aliased where it is an expression', () => {
    for (const col of DIR_TREE_COLUMNS) {
      const expected =
        col.expr === undefined
          ? `  ${col.name}`
          : `  ${col.expr} AS ${col.name}`;
      expect(DIR_TREE_SQL).toContain(expected);
    }
  });

  it('labels the empty top-level directory instead of rendering it blank', () => {
    // dune_dir keeps the directory dune named, which for the top level is the
    // empty string; the tree column must not be blank.
    expect(DIR_TREE_SQL).toContain("iif(path = '', '(top level)', path)");
    expect(DIR_TREE_SQL).toContain("iif(name = '', '(top level)', name)");
  });
});

describe('DIR_TREE_COLUMNS types', () => {
  it('declares no column as a reference to a graph node', () => {
    // `dune_dir` numbers *directories*, so its `id` / `parent_id` are directory
    // ids. Typing either as JOINID(dune_node.node_id) would render it as
    // whichever unrelated graph node happened to share the number, which is
    // worse than the plain integer it is. A directory is not a node.
    // (node_source_unittest.ts is where a column that *is* one is checked.)
    for (const col of DIR_TREE_COLUMNS) {
      const type = exploreColumnType(col);
      expect(type.kind).not.toBe('id');
      expect(type.kind).not.toBe('joinid');
    }
  });
});
