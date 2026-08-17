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

import type {DepNode, GraphNode} from './graph';
import {nodesInGroup} from './node_tree_actions';
import type {PathTreeGroup, PathTreeLeaf, PathTreeRow} from './path_tree';

// A minimal leaf payload shape - deliberately distinct from both `Ref`
// (selection panel) and `TreeLeafEntry` (query tab) - to prove `nodesInGroup`
// only relies on the structural `node?: GraphNode` field, not either caller's
// concrete type.
interface Entry {
  readonly node?: GraphNode;
  readonly label: string;
}

function dep(id: string): DepNode {
  return {kind: 'dep', id, depId: 0, isSource: false, unfinished: false};
}

function leaf(label: string, node?: GraphNode): PathTreeLeaf<Entry> {
  return {kind: 'leaf', prefix: '', label, item: {node, label}};
}

function group(
  label: string,
  path: string,
  rows: readonly PathTreeRow<Entry>[],
): PathTreeGroup<Entry> {
  return {kind: 'group', path, label, rows};
}

describe('nodesInGroup', () => {
  it('collects distinct nodes across nested groups, deduped by node key', () => {
    const a = dep('a');
    const b = dep('b');
    const tree = group('root', 'root', [
      leaf('a', a),
      group('nested', 'root/nested', [leaf('b', b), leaf('a-again', a)]),
    ]);
    expect(nodesInGroup(tree)).toEqual([a, b]);
  });

  it('skips leaves with no node (dangling entries)', () => {
    const a = dep('a');
    const tree = group('root', 'root', [leaf('a', a), leaf('dangling')]);
    expect(nodesInGroup(tree)).toEqual([a]);
  });

  it('returns [] for a group with no resolvable nodes', () => {
    const tree = group('root', 'root', [leaf('x'), leaf('y')]);
    expect(nodesInGroup(tree)).toEqual([]);
  });
});
