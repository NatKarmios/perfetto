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

import type {GraphEdge, NodeId} from '../model/graph';
import type {GraphLayout} from './graph_layout';
import {layoutGraph, NODE_HEIGHT, NODE_WIDTH} from './graph_layout';

// The layout works on bare node ids (it never needs the graph), so the fixtures
// here are just numbers.
const [a, b, c, d, outside] = [1, 2, 3, 4, 5];

function edge(source: NodeId, dest: NodeId): GraphEdge {
  return {source, dest, forced: false};
}

function xOf(layout: GraphLayout, node: NodeId): number {
  const ln = layout.nodes.find((n) => n.node === node);
  if (ln === undefined) throw new Error(`no layout node for ${node}`);
  return ln.x;
}

/**
 * Crossings in the drawing, counted from the emitted coordinates alone: every
 * edge becomes a polyline through its bends, and two segments spanning the same
 * pair of rows cross when their endpoints are in opposite orders.
 *
 * This is the assertion the file never had, and the one that sees the whole
 * class of bug the ordering pass exists to fix.
 */
function crossings(layout: GraphLayout): number {
  interface Segment {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
  }
  const byRow = new Map<number, Segment[]>();
  for (const e of layout.edges) {
    const points = [
      {x: e.source.x + e.source.width / 2, y: e.source.y},
      ...(e.bends ?? []).map((b) => ({x: b.x, y: b.y - NODE_HEIGHT / 2})),
      {x: e.dest.x + e.dest.width / 2, y: e.dest.y},
    ];
    for (let i = 0; i + 1 < points.length; i++) {
      const from = points[i];
      const to = points[i + 1];
      const row = byRow.get(from.y) ?? [];
      row.push({x0: from.x, y0: to.y, x1: to.x});
      byRow.set(from.y, row);
    }
  }
  let total = 0;
  for (const segments of byRow.values()) {
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        const p = segments[i];
        const q = segments[j];
        if (p.y0 !== q.y0) continue;
        if ((p.x0 - q.x0) * (p.x1 - q.x1) < 0) total++;
      }
    }
  }
  return total;
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
    // Ranking is deliberately left as it was - no tightening - so this pins
    // longest-path semantics on purpose, not by accident of the old code.
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

// Four more node ids, for the fixtures that need a second strand.
const [p, q, u, v] = [6, 7, 8, 9];

describe('layoutGraph ordering', () => {
  it('orders a rank out of a forced crossing', () => {
    // p -> v and q -> u, handed over in the order that puts v and u in their
    // arrival slots and draws an X.
    const layout = layoutGraph([p, q, u, v], [edge(p, v), edge(q, u)]);

    expect(crossings(layout)).toBe(0);
  });

  it('keeps a chain straight through a wide middle rank', () => {
    // a -> b -> c, with two strands beside it that fill b's rank. The chain is
    // the only thing in the bottom rank, so before ordering and x refinement
    // that rank was centred under the widest one and c sat half the picture
    // away from b.
    const layout = layoutGraph(
      [a, b, c, p, u, q, v],
      [edge(a, b), edge(b, c), edge(p, u), edge(q, v)],
    );

    expect(xOf(layout, a)).toBe(xOf(layout, b));
    expect(xOf(layout, b)).toBe(xOf(layout, c));
    expect(crossings(layout)).toBe(0);
  });

  it('bends a rank-skipping edge through every rank it crosses', () => {
    // a -> b -> c -> d plus a -> d, which spans three ranks and so passes
    // through two.
    const layout = layoutGraph(
      [a, b, c, d],
      [edge(a, b), edge(b, c), edge(c, d), edge(a, d)],
    );

    const skipping = layout.edges.filter(
      (e) => e.source.node === a && e.dest.node === d,
    );
    expect(skipping).toHaveLength(1);
    const bends = skipping[0].bends ?? [];
    expect(bends).toHaveLength(2);
    // One per intervening rank, each on that rank's centre line.
    expect(bends.map((bend) => bend.y)).toEqual([
      yOf(layout, b) + NODE_HEIGHT / 2,
      yOf(layout, c) + NODE_HEIGHT / 2,
    ]);
    for (const bend of bends) {
      expect(bend.x).toBeGreaterThanOrEqual(0);
      expect(bend.x).toBeLessThanOrEqual(layout.width);
    }
    // The span-1 edges stay plain.
    for (const e of layout.edges) {
      if (e === skipping[0]) continue;
      expect(e.bends).toBeUndefined();
    }
  });

  it('is deterministic', () => {
    // The heuristic is order-sensitive by design - which is what makes the
    // chart's `ORDER BY node_id` worth having - so what has to hold is that the
    // same input lays out the same way, not that a permuted one does.
    const nodes = [a, b, c, d, p, q, u, v];
    const edges = [
      edge(a, b),
      edge(a, c),
      edge(b, d),
      edge(c, d),
      edge(p, u),
      edge(u, v),
      edge(q, v),
      edge(a, d),
    ];

    expect(layoutGraph(nodes, edges)).toEqual(layoutGraph(nodes, edges));
  });

  it('places everything in a wide, dense, span-1 graph', () => {
    // 400 nodes, 200 rules fanning out over 200 shared deps: 40,000 edges, all
    // of them span 1, so no dummies and nothing for the budget to catch.
    const sources = Array.from({length: 200}, (_, i) => i + 1);
    const sinks = Array.from({length: 200}, (_, i) => i + 201);
    const edges = sources.flatMap((s) => sinks.map((t) => edge(s, t)));

    const layout = layoutGraph([...sources, ...sinks], edges);

    expect(layout.nodes).toHaveLength(400);
    expect(layout.edges).toHaveLength(40_000);
  });

  it('falls back rather than manufacturing dummies without bound', () => {
    // Deep *and* wide: a complete DAG over 60 ranks, whose edge spans sum to
    // tens of thousands of dummies. The budget skips the refinement, so the
    // edges come back without bends and every node is still placed.
    const spine = Array.from({length: 60}, (_, i) => i + 1);
    const edges = spine.flatMap((s, i) =>
      spine.slice(i + 1).map((t) => edge(s, t)),
    );

    const layout = layoutGraph(spine, edges);

    expect(layout.nodes).toHaveLength(60);
    expect(layout.edges).toHaveLength(edges.length);
    expect(layout.edges.every((e) => e.bends === undefined)).toBe(true);
  });
});
