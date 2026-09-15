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
 * The graphviz adapter (graph_layout_graphviz.ts).
 *
 * Unlike the rest of the plugin's SQL and layout tests, these run the real
 * thing: the wasm module is embedded in the package and instantiates fine under
 * jsdom, so there is no reason to assert on a generated string when the actual
 * coordinates are available.
 *
 * What is worth pinning here is the *translation*, not dot's own quality. Every
 * bug this file has caught so far has been in reading dot's output back -
 * mis-parsing a spline, mis-matching an edge - and each one degraded silently
 * into a plausible-looking but wrong picture rather than an error.
 */

import {beforeAll, describe, expect, it} from 'vitest';
import type {GraphEdge, NodeId} from '../model/graph';
import {ARROW_GAP, DOT_RADIUS} from './graph_layout';
import {
  graphvizAffordable,
  graphvizReady,
  layoutWithGraphviz,
  loadGraphviz,
} from './graph_layout_graphviz';

function edge(source: NodeId, dest: NodeId, forced = false): GraphEdge {
  return {source, dest, forced};
}

const [a, b, c, d] = [1, 2, 3, 4] as NodeId[];

// a -> b -> c -> d, plus a -> d skipping the two ranks between.
const CHAIN = [a, b, c, d];
const CHAIN_EDGES = [edge(a, b), edge(b, c), edge(c, d), edge(a, d)];

function layout(nodes: readonly NodeId[], edges: readonly GraphEdge[]) {
  const l = layoutWithGraphviz(nodes, edges);
  if (l === undefined) throw new Error('expected graphviz to lay this out');
  return l;
}

function nodeAt(
  l: ReturnType<typeof layout>,
  node: NodeId,
): {x: number; y: number} {
  const ln = l.nodes.find((n) => n.node === node);
  if (ln === undefined) throw new Error(`no layout node for ${node}`);
  return {x: ln.x + ln.width / 2, y: ln.y + ln.height / 2};
}

beforeAll(async () => {
  await loadGraphviz();
});

describe('the graphviz adapter', () => {
  it('loads the embedded wasm module', () => {
    // If this fails nothing else in the file means anything: every assertion
    // below would be testing the "not loaded" path returning undefined.
    expect(graphvizReady()).toBe(true);
  });

  it('gives every edge a spline', () => {
    // The regression this file exists for. dot reports an `e,x,y` arrowhead tip
    // alongside the curve's own control points; counting it as one of them
    // makes the total 3n+2, which fails the chain's own validity check, drops
    // the spline, and leaves the pane drawing a straight line through whatever
    // the edge was routed around. Silent, and it looks like a layout fault.
    const l = layout(CHAIN, CHAIN_EDGES);

    expect(l.edges).toHaveLength(4);
    for (const e of l.edges) {
      expect(e.spline).toBeDefined();
      // One on-curve point plus three per cubic segment.
      expect((e.spline ?? []).length % 3).toBe(1);
      expect((e.spline ?? []).length).toBeGreaterThanOrEqual(4);
    }
  });

  it('ranks dependencies downwards', () => {
    const l = layout(CHAIN, CHAIN_EDGES);

    expect(nodeAt(l, a).y).toBeLessThan(nodeAt(l, b).y);
    expect(nodeAt(l, b).y).toBeLessThan(nodeAt(l, c).y);
    expect(nodeAt(l, c).y).toBeLessThan(nodeAt(l, d).y);
  });

  it('keeps everything inside the reported bounding box', () => {
    // dot's y axis points up and ours points down, so every coordinate is
    // mirrored on the way out. Get that wrong and the graph renders off-screen
    // or upside down - which the extent check below is what catches.
    const l = layout(CHAIN, CHAIN_EDGES);

    expect(l.width).toBeGreaterThan(0);
    expect(l.height).toBeGreaterThan(0);
    for (const n of l.nodes) {
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y + n.height).toBeLessThanOrEqual(l.height + 1);
    }
    for (const e of l.edges) {
      for (const p of e.spline ?? []) {
        expect(p.y).toBeGreaterThanOrEqual(-1);
        expect(p.y).toBeLessThanOrEqual(l.height + 1);
      }
    }
  });

  it('routes a rank-skipping edge clear of the ranks it crosses', () => {
    const l = layout(CHAIN, CHAIN_EDGES);
    const skipping = l.edges.find(
      (e) => e.source.node === a && e.dest.node === d,
    );
    const spline = skipping?.spline ?? [];

    // It has to leave the chain's column to get past b and c; if it did not,
    // it would be drawn straight through both of them.
    const chainX = nodeAt(l, b).x;
    const straying = spline.filter((p) => Math.abs(p.x - chainX) > DOT_RADIUS);
    expect(straying.length).toBeGreaterThan(0);
  });

  it('ends an edge a hair short of the dot it points at', () => {
    // The arrowhead is the pane's, drawn with `marker-end` at the path's end,
    // so the path has to stop ARROW_GAP clear of the dot rather than at its
    // centre or well short of it. Two earlier mistakes both showed up here:
    // telling dot the node was wider than it is drawn, and leaving dot's own
    // arrowhead on so it reserved room for an arrow it never drew.
    const l = layout(CHAIN, CHAIN_EDGES);
    const e = l.edges.find((x) => x.source.node === a && x.dest.node === b);
    const spline = e?.spline ?? [];
    const last = spline[spline.length - 1];
    const centre = nodeAt(l, b);
    const gap = Math.hypot(last.x - centre.x, last.y - centre.y);

    // Snug against the dot's edge, plus the arrowhead's room, and nowhere near
    // the ~10pt dot reserves for an arrowhead of its own.
    expect(gap).toBeGreaterThanOrEqual(DOT_RADIUS);
    expect(gap).toBeLessThanOrEqual(DOT_RADIUS + ARROW_GAP + 2);
  });

  it('matches `forced` by endpoint rather than by position', () => {
    // dot is under no obligation to report edges in declaration order, so
    // zipping its output against the input by index silently colours the wrong
    // edges red. Only the b -> c edge is forced here.
    const l = layout(CHAIN, [
      edge(a, b),
      edge(b, c, true),
      edge(c, d),
      edge(a, d),
    ]);

    const forced = l.edges.filter((e) => e.forced);
    expect(forced).toHaveLength(1);
    expect(forced[0].source.node).toBe(b);
    expect(forced[0].dest.node).toBe(c);
  });

  it('drops edges pointing outside the node set', () => {
    const outside = 99 as NodeId;
    const l = layout([a, b], [edge(a, b), edge(a, outside)]);

    expect(l.nodes).toHaveLength(2);
    expect(l.edges).toHaveLength(1);
  });

  it('refuses a graph whose edges span too many ranks', () => {
    // dot cannot be interrupted once started, and this shape is the one that
    // runs away: a complete DAG over 60 ranks did not finish in 90 seconds,
    // while 400 nodes with 40,000 span-1 edges took 7.5. So the refusal is on
    // total edge span, not on a node or edge count, and it has to happen
    // before dot is called rather than as a timeout.
    const spine = Array.from({length: 60}, (_, i) => (i + 1) as NodeId);
    const dense = spine.flatMap((s, i) =>
      spine.slice(i + 1).map((t) => edge(s, t)),
    );

    expect(graphvizAffordable(spine, dense)).toBe(false);
    expect(layoutWithGraphviz(spine, dense)).toBeUndefined();
  });

  it('accepts a graph the pane can really produce', () => {
    // The other side of that ceiling: wide and shallow is cheap, however many
    // edges it has, because no edge spans more than one rank.
    const sources = Array.from({length: 30}, (_, i) => (i + 1) as NodeId);
    const sinks = Array.from({length: 30}, (_, i) => (i + 31) as NodeId);
    const edges = sources.flatMap((s) => sinks.map((t) => edge(s, t)));

    expect(graphvizAffordable([...sources, ...sinks], edges)).toBe(true);
  });
});
