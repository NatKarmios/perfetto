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

import type {Row, SqlValue} from '../../trace_processor/query_result';
import type {BuildGraph, NodeId} from './graph';
import {dep, rule, testGraph} from './graph_test_helper';
import type {TreeLeafEntry} from './query_tab';
import {buildNodeTreeItems, formatExtraParts} from './query_tab';
import type {PathTreeItem} from './path_tree';

// Projects a `PathTreeItem<TreeLeafEntry>` down to a plain, easy-to-assert-on
// shape: the raw dir/leaf segments (as `sep + name`, so an empty `sep` and a
// literal `/`/`@` are both visible), the merged-row count, and the resolved
// node's label (undefined for a value that resolved to no node).
function project(
  graph: BuildGraph,
  items: readonly PathTreeItem<TreeLeafEntry>[],
) {
  return items.map((it) => ({
    dir: it.dir.map((seg) => seg.sep + seg.name),
    leaf: it.leaf.sep + it.leaf.name,
    count: it.item.count,
    node: it.item.node === undefined ? undefined : graph.labelOf(it.item.node),
  }));
}

// One graph serves every test here: `buildNodeTreeItems` only reads a node's
// kind, label and `dir`, and the `resolve` callback each test passes decides
// which node (if any) a cell's value stands for.
const g = testGraph([
  dep('a/b/dep1.ml'),
  dep('a/b/dep2.ml'),
  rule('42', {dir: 'a/b'}),
  rule('7'),
  dep('x.ml'),
  dep('9'),
]);
const graph = g.graph;

describe('buildNodeTreeItems', () => {
  it('files a dep by its raw id path, a rule by its dir + bare id', () => {
    const nodes = new Map<number, NodeId>([
      [1, g.id('a/b/dep1.ml')],
      [2, g.id('a/b/dep2.ml')],
      [3, g.id('42')],
    ]);
    const rows: Row[] = [{node: 1}, {node: 2}, {node: 3}];

    const items = buildNodeTreeItems(graph, rows, 'node', false, (v) =>
      nodes.get(Number(v)),
    );

    expect(project(graph, items)).toEqual([
      {dir: ['a', '/b'], leaf: '/dep1.ml', count: 1, node: 'a/b/dep1.ml'},
      {dir: ['a', '/b'], leaf: '/dep2.ml', count: 1, node: 'a/b/dep2.ml'},
      {dir: ['a', '/b'], leaf: '/42', count: 1, node: '42'},
    ]);
  });

  it('files a dirless rule at the top level', () => {
    const items = buildNodeTreeItems(graph, [{node: 5}], 'node', false, () =>
      g.id('7'),
    );
    expect(project(graph, items)).toEqual([
      {dir: [], leaf: '/7', count: 1, node: '7'},
    ]);
  });

  it('merges rows resolving to the same node into one entry when merge is on', () => {
    const rows: Row[] = [{node: 9}, {node: 9}, {node: 9}];
    const resolve = () => g.id('x.ml');

    expect(
      project(graph, buildNodeTreeItems(graph, rows, 'node', true, resolve)),
    ).toEqual([{dir: [], leaf: 'x.ml', count: 3, node: 'x.ml'}]);
  });

  it('keeps one entry per row when merge is off', () => {
    const rows: Row[] = [{node: 9}, {node: 9}];
    const resolve = () => g.id('x.ml');

    expect(
      project(graph, buildNodeTreeItems(graph, rows, 'node', false, resolve)),
    ).toEqual([
      {dir: [], leaf: 'x.ml', count: 1, node: 'x.ml'},
      {dir: [], leaf: 'x.ml', count: 1, node: 'x.ml'},
    ]);
  });

  it('files an unresolved value at the top level, keyed by its raw value', () => {
    const rows: Row[] = [{node: 123}, {node: 123}];
    const items = buildNodeTreeItems(
      graph,
      rows,
      'node',
      true,
      () => undefined,
    );
    expect(project(graph, items)).toEqual([
      {dir: [], leaf: '123', count: 2, node: undefined},
    ]);
  });

  it('skips rows with a null or missing cell in the group column', () => {
    const rows: Row[] = [{node: 9}, {node: null}, {other: 1}];
    const items = buildNodeTreeItems(graph, rows, 'node', true, () =>
      g.id('x.ml'),
    );
    expect(project(graph, items)).toEqual([
      {dir: [], leaf: 'x.ml', count: 1, node: 'x.ml'},
    ]);
  });

  it('does not merge an unresolved value with a node sharing its string form', () => {
    const rows: Row[] = [{node: 9}, {node: 9}];
    // First row resolves, second doesn't - shouldn't be treated as the same
    // entry just because String(value) collides with the resolved node's label.
    let calls = 0;
    const resolve = () => (calls++ === 0 ? g.id('9') : undefined);
    const items = buildNodeTreeItems(graph, rows, 'node', true, resolve);
    expect(project(graph, items)).toEqual([
      {dir: [], leaf: '9', count: 1, node: '9'},
      {dir: [], leaf: '9', count: 1, node: undefined},
    ]);
  });
});

describe('formatExtraParts', () => {
  const formatValue = (_col: string, value: SqlValue) => String(value);

  it('formats node_id bare and folds forced_by_kind/target for a RULE forcer', () => {
    const row: Row = {
      node_id: 1,
      forced_by_kind: 'RULE',
      forced_by_target: '2',
    };
    const cols = ['node_id', 'forced_by_kind', 'forced_by_target'];
    expect(formatExtraParts(cols, row, 1, formatValue)).toEqual([
      '#1',
      'forced by rule 2',
    ]);
  });

  it('formats node_id bare and folds forced_by_kind/target for a DEP forcer', () => {
    const row: Row = {
      node_id: 3,
      forced_by_kind: 'DEP',
      forced_by_target: 'a/b',
    };
    const cols = ['node_id', 'forced_by_kind', 'forced_by_target'];
    expect(formatExtraParts(cols, row, 1, formatValue)).toEqual([
      '#3',
      'forced by a/b',
    ]);
  });

  it('includes other columns as plain col=value alongside the special ones', () => {
    const row: Row = {
      node_id: 1,
      forced_by_kind: 'RULE',
      forced_by_target: '2',
      distance: 4,
    };
    const cols = ['node_id', 'forced_by_kind', 'forced_by_target', 'distance'];
    expect(formatExtraParts(cols, row, 1, formatValue)).toEqual([
      '#1',
      'forced by rule 2',
      'distance=4',
    ]);
  });

  it('omits the forced-by part entirely when forced_by_kind is null', () => {
    const row: Row = {node_id: 1, forced_by_kind: null, forced_by_target: null};
    const cols = ['node_id', 'forced_by_kind', 'forced_by_target'];
    expect(formatExtraParts(cols, row, 1, formatValue)).toEqual(['#1']);
  });

  it('degrades to a generic phrase when forced_by_target is absent', () => {
    const row: Row = {forced_by_kind: 'RULE'};
    expect(formatExtraParts(['forced_by_kind'], row, 1, formatValue)).toEqual([
      'forced by a rule',
    ]);
  });

  it('falls back to plain col=value for an unrecognised kind, keeping the target', () => {
    const row: Row = {forced_by_kind: 'SOMETHING_ELSE', forced_by_target: 'x'};
    const cols = ['forced_by_kind', 'forced_by_target'];
    expect(formatExtraParts(cols, row, 1, formatValue)).toEqual([
      'forced_by_kind=SOMETHING_ELSE',
      'forced_by_target=x',
    ]);
  });

  it('folds forced_by_target regardless of its position relative to forced_by_kind', () => {
    const row: Row = {forced_by_target: '2', forced_by_kind: 'RULE'};
    const cols = ['forced_by_target', 'forced_by_kind'];
    expect(formatExtraParts(cols, row, 1, formatValue)).toEqual([
      'forced by rule 2',
    ]);
  });

  it('prefixes a ×N count when count is greater than 1', () => {
    const row: Row = {node_id: 1};
    expect(formatExtraParts(['node_id'], row, 3, formatValue)).toEqual([
      '×3',
      '#1',
    ]);
  });

  it('skips null/missing cells for ordinary columns', () => {
    const row: Row = {a: null, c: 5};
    expect(formatExtraParts(['a', 'b', 'c'], row, 1, formatValue)).toEqual([
      'c=5',
    ]);
  });
});
