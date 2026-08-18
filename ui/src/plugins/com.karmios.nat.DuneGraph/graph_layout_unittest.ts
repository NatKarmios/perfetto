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

import type {GraphEdge, NodeId} from './graph';
import {layoutGraph, NODE_WIDTH} from './graph_layout';

// The layout works on bare node ids (it never needs the graph), so the fixtures
// here are just numbers.
const [a, b, c, d, outside] = [1, 2, 3, 4, 5];

function edge(source: NodeId, dest: NodeId): GraphEdge {
  return {source, dest, forced: false};
}

// The laid-out row of a node.
function yOf(layout: ReturnType<typeof layoutGraph>, node: NodeId): number {
  const ln = layout.nodes.find((n) => n.node === node);
  if (ln === undefined) throw new Error(`no layout node for ${node}`);
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
    const layout = layoutGraph([a], []);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0].x).toBe(0);
    expect(layout.nodes[0].y).toBe(0);
    expect(layout.width).toBe(NODE_WIDTH);
  });

  it('ranks a dependency chain top to bottom', () => {
    // a depends on b depends on c -> c is deepest.
    const layout = layoutGraph([a, b, c], [edge(a, b), edge(b, c)]);

    expect(yOf(layout, a)).toBeLessThan(yOf(layout, b));
    expect(yOf(layout, b)).toBeLessThan(yOf(layout, c));
    expect(rowYs(layout)).toHaveLength(3);
    expect(layout.edges).toHaveLength(2);
    // Single node per row -> every row is centred on the same x.
    expect(new Set(layout.nodes.map((n) => n.x))).toEqual(new Set([0]));
  });

  it('puts a shared dependency below both its dependers (diamond)', () => {
    // a -> b, a -> c, b -> d, c -> d.
    const layout = layoutGraph(
      [a, b, c, d],
      [edge(a, b), edge(a, c), edge(b, d), edge(c, d)],
    );

    expect(yOf(layout, a)).toBeLessThan(yOf(layout, b));
    expect(yOf(layout, b)).toBe(yOf(layout, c));
    expect(yOf(layout, c)).toBeLessThan(yOf(layout, d));
    expect(rowYs(layout)).toHaveLength(3);
  });

  it('uses the longest path for ranking', () => {
    // a -> b -> d and a -> d: d must sit two rows below a, not one.
    const layout = layoutGraph([a, b, d], [edge(a, b), edge(b, d), edge(a, d)]);

    const ys = rowYs(layout);
    expect(ys).toHaveLength(3);
    expect(yOf(layout, a)).toBe(ys[0]);
    expect(yOf(layout, b)).toBe(ys[1]);
    expect(yOf(layout, d)).toBe(ys[2]);
  });

  it('ignores edges to nodes outside the set', () => {
    // Only `a` and `b` are in the set; the edge to `outside` is dropped.
    const layout = layoutGraph([a, b], [edge(a, b), edge(a, outside)]);

    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges).toHaveLength(1);
  });
});
