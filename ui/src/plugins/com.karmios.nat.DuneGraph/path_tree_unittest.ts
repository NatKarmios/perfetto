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

import type {PathTreeItem, PathTreeRow} from './path_tree';
import {
  buildPathTree,
  collectGroupKeys,
  countLeaves,
  splitEntry,
  splitPath,
} from './path_tree';

// Builds a `PathTreeItem<string>` for a plain path-like id, using the id
// itself as the payload (so assertions can just compare against the id).
function entry(id: string): PathTreeItem<string> {
  const {dir, leaf} = splitEntry(id);
  return {dir, leaf, item: id};
}

// Strips payloads and nested rows down to a compact, easy-to-assert-on shape:
// a leaf becomes its `prefix + label` display text; a group becomes
// `{[label]: [...rows]}`.
function simplify(rows: readonly PathTreeRow<string>[]): unknown[] {
  return rows.map((row) =>
    row.kind === 'leaf'
      ? row.prefix + row.label
      : {[row.label]: simplify(row.rows)},
  );
}

describe('splitPath', () => {
  it('splits on / and @, keeping the separator with the following segment', () => {
    expect(splitPath('A/B/C/D')).toEqual([
      {sep: '', name: 'A'},
      {sep: '/', name: 'B'},
      {sep: '/', name: 'C'},
      {sep: '/', name: 'D'},
    ]);
    expect(splitPath('A/B/C@E')).toEqual([
      {sep: '', name: 'A'},
      {sep: '/', name: 'B'},
      {sep: '/', name: 'C'},
      {sep: '@', name: 'E'},
    ]);
  });

  it('keeps a leading / as part of the first segment (absolute paths)', () => {
    expect(splitPath('/abs/path')).toEqual([
      {sep: '', name: '/abs'},
      {sep: '/', name: 'path'},
    ]);
  });

  it("doesn't produce a phantom trailing segment for a trailing /", () => {
    expect(splitPath('A/B/')).toEqual([
      {sep: '', name: 'A'},
      {sep: '/', name: 'B'},
    ]);
  });

  it('returns [] for an empty path', () => {
    expect(splitPath('')).toEqual([]);
  });
});

describe('buildPathTree', () => {
  it('nests only where a directory holds 2+ rows (the worked example)', () => {
    // A/B/C/D, A/B/C@E, rule "1" (dir A/B/C), A/B/F, G/H, I@J
    const items: PathTreeItem<string>[] = [
      entry('A/B/C/D'),
      entry('A/B/C@E'),
      {dir: splitPath('A/B/C'), leaf: {sep: '/', name: '1'}, item: 'rule 1'},
      entry('A/B/F'),
      entry('G/H'),
      entry('I@J'),
    ];
    const tree = buildPathTree(items);
    expect(simplify(tree)).toEqual([
      {
        // Sorted by display text via localeCompare; "@E"/"1" sort ahead of
        // "D" but their relative order isn't the point of this test.
        'A/B': [{C: ['@E', '1', 'D']}, 'F'],
      },
      'G/H',
      'I@J',
    ]);
  });

  it('renders a single item overall as one flat leaf, no group', () => {
    expect(simplify(buildPathTree([entry('A/B/C/D')]))).toEqual(['A/B/C/D']);
  });

  it('merges a long single-child chain into one label', () => {
    const tree = buildPathTree([entry('A/B/C/D'), entry('A/B/C/E')]);
    expect(simplify(tree)).toEqual([{'A/B/C': ['D', 'E']}]);
  });

  it('files an item with no dir at the top level', () => {
    const tree = buildPathTree([
      entry('A/B/C'),
      entry('A/B/D'),
      entry('top-level.ml'),
    ]);
    expect(simplify(tree)).toEqual([{'A/B': ['C', 'D']}, 'top-level.ml']);
  });

  it('keeps a dangling rule id (no dir at all) at the top level', () => {
    const tree = buildPathTree<string>([
      {dir: [], leaf: {sep: '/', name: '2'}, item: 'rule 2'},
      entry('A/B'),
    ]);
    expect(simplify(tree)).toEqual(['2', 'A/B']);
  });

  it('keeps an absolute path leading /', () => {
    const tree = buildPathTree([
      entry('/abs/path/one'),
      entry('/abs/path/two'),
    ]);
    expect(simplify(tree)).toEqual([{'/abs/path': ['one', 'two']}]);
  });

  it('interleaves groups and leaves alphabetically', () => {
    const tree = buildPathTree([
      entry('b.ml'),
      entry('a/one'),
      entry('a/two'),
      entry('c.ml'),
    ]);
    // The 'a' group sorts by its own label ('a'), alongside the leaves.
    expect(simplify(tree)).toEqual([{a: ['one', 'two']}, 'b.ml', 'c.ml']);
  });
});

describe('countLeaves', () => {
  it('counts leaves nested arbitrarily deep, ignoring group boundaries', () => {
    const tree = buildPathTree([
      entry('a/one'),
      entry('a/two'),
      entry('a/b/three'),
      entry('a/b/four'),
    ]);
    const group = tree[0];
    if (group.kind !== 'group') throw new Error('expected a group');
    expect(countLeaves(group)).toBe(4);
  });
});

describe('collectGroupKeys', () => {
  it('collects every nested group path, unprefixed', () => {
    const tree = buildPathTree([
      entry('a/one'),
      entry('a/two'),
      entry('a/b/three'),
      entry('a/b/four'),
    ]);
    expect(collectGroupKeys(tree)).toEqual(['a', 'a/b']);
  });

  it('namespaces keys with the given prefix, matching PathTreeView', () => {
    const tree = buildPathTree([entry('a/one'), entry('a/two')]);
    expect(collectGroupKeys(tree, 'Dependants')).toEqual(['Dependants:a']);
  });

  it('returns [] for a tree with no groups', () => {
    expect(collectGroupKeys(buildPathTree([entry('top-level.ml')]))).toEqual(
      [],
    );
  });
});
