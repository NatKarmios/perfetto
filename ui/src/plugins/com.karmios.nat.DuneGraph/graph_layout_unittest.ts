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

import type {DepNode, GraphEdge, GraphNode, RuleNode} from './graph';
import {layoutGraph, NODE_WIDTH} from './graph_layout';

function dep(id: string): DepNode {
  return {kind: 'dep', id, sliceId: 0};
}

function rule(id: string): RuleNode {
  return {kind: 'rule', id, sliceId: 0};
}

function edge(source: GraphNode, dest: GraphNode): GraphEdge {
  return {source, dest, forced: false};
}

function yById(layout: ReturnType<typeof layoutGraph>, id: string): number {
  const ln = layout.nodes.find((n) => n.node.id === id);
  if (ln === undefined) throw new Error(`no layout node for ${id}`);
  return ln.y;
}

// Distinct row y-coordinates, low to high.
function rowYs(layout: ReturnType<typeof layoutGraph>): number[] {
  return [...new Set(layout.nodes.map((n) => n.y))].sort((a, b) => a - b);
}

describe('layoutGraph', () => {
  it('lays out an empty graph', () => {
    const layout = layoutGraph([], []);
    expect(layout.nodes).toHaveLength(0);
    expect(layout.edges).toHaveLength(0);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(0);
  });

  it('places a single node at the origin row', () => {
    const a = dep('a');
    const layout = layoutGraph([a], []);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0].x).toBe(0);
    expect(layout.nodes[0].y).toBe(0);
    expect(layout.width).toBe(NODE_WIDTH);
  });

  it('ranks a dependency chain top to bottom', () => {
    // a depends on b depends on c -> c is deepest.
    const a = dep('a');
    const b = rule('b');
    const c = dep('c');
    const layout = layoutGraph([a, b, c], [edge(a, b), edge(b, c)]);

    expect(yById(layout, 'a')).toBeLessThan(yById(layout, 'b'));
    expect(yById(layout, 'b')).toBeLessThan(yById(layout, 'c'));
    expect(rowYs(layout)).toHaveLength(3);
    expect(layout.edges).toHaveLength(2);
    // Single node per row -> every row is centred on the same x.
    expect(new Set(layout.nodes.map((n) => n.x))).toEqual(new Set([0]));
  });

  it('puts a shared dependency below both its dependers (diamond)', () => {
    // a -> b, a -> c, b -> d, c -> d.
    const a = dep('a');
    const b = dep('b');
    const c = dep('c');
    const d = rule('d');
    const layout = layoutGraph(
      [a, b, c, d],
      [edge(a, b), edge(a, c), edge(b, d), edge(c, d)],
    );

    expect(yById(layout, 'a')).toBeLessThan(yById(layout, 'b'));
    expect(yById(layout, 'b')).toBe(yById(layout, 'c'));
    expect(yById(layout, 'c')).toBeLessThan(yById(layout, 'd'));
    expect(rowYs(layout)).toHaveLength(3);
  });

  it('uses the longest path for ranking', () => {
    // a -> b -> d and a -> d: d must sit two rows below a, not one.
    const a = dep('a');
    const b = dep('b');
    const d = dep('d');
    const layout = layoutGraph([a, b, d], [edge(a, b), edge(b, d), edge(a, d)]);

    const ys = rowYs(layout);
    expect(ys).toHaveLength(3);
    expect(yById(layout, 'a')).toBe(ys[0]);
    expect(yById(layout, 'b')).toBe(ys[1]);
    expect(yById(layout, 'd')).toBe(ys[2]);
  });

  it('ignores edges to nodes outside the set', () => {
    const a = dep('a');
    const b = dep('b');
    const outside = dep('outside');
    // Only `a` and `b` are in the set; the edge to `outside` is dropped.
    const layout = layoutGraph([a, b], [edge(a, b), edge(a, outside)]);

    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges).toHaveLength(1);
  });
});
