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
 * Graphviz `dot` as an alternative to the hand-rolled layout in
 * graph_layout.ts, behind the same `GraphLayout` shape so the pane does not
 * care which produced it.
 *
 * **SPIKE.** This is here to be looked at, not to be relied on - see
 * ARCHITECTURE.md, "Drawing the node graph" for the measurements that decide
 * whether it stays. What it buys is spline-routed edges and reference-quality
 * ranking; what it costs is a 2.1 MB dependency, roughly 15x the layout time,
 * and a wider picture.
 *
 * Two things shape the design:
 *
 * - Loading is async, laying out is not. `Graphviz.load()` instantiates a
 *   WebAssembly module; `layout()` on the result is synchronous. So the module
 *   is loaded once, off to one side, and until it arrives the caller keeps
 *   using the hand-rolled layout. No async state machine in the pane.
 * - `dot` _cannot be interrupted_. It has no time limit we can set from
 *   here, and it is genuinely capable of taking minutes: 60 ranks of a complete
 *   DAG did not finish in 90 seconds. So the decision to call it at all is made
 *   _before_ calling it, from the same edge-span estimate the hand-rolled
 *   layout budgets on. See {@link graphvizAffordable}.
 */

import {Graphviz} from '@hpcc-js/wasm-graphviz';
import type {GraphEdge, NodeId} from '../model/graph';
import type {GraphLayout, LayoutEdge, LayoutNode} from './graph_layout';
import {ARROW_GAP, DOT_RADIUS, layoutCost} from './graph_layout';

// Points per inch: dot takes node sizes in inches and reports positions in
// points, and one point is one of our layout units.
const PER_INCH = 72;
/**
 * Least space dot leaves between two nodes sharing a rank, and between ranks.
 *
 * `nodesep` is the single biggest lever on how wide the picture comes out, and
 * it is worth a lot: on a 150-node graph with 419 edges, 20 units gives 1,212
 * units of width, 14 gives 853, and 10 gives 643. `concentrate` was measured
 * too and makes it *wider* (704), so it is not used.
 *
 * 10 is deliberately tighter than the hand-rolled layout's 20, because dot
 * reserves horizontal lanes for its edge routing that the hand-rolled layout
 * does not - at equal `nodesep` it draws a much wider picture for the same
 * graph.
 */
const NODE_SEP = 10;
const RANK_SEP = 20;

/**
 * Ceilings above which `dot` is not called at all.
 *
 * Node and edge counts alone do not predict its cost - 60 nodes with 1,770
 * edges ran for over 90 seconds while 400 nodes with 40,000 ran in 7.5 - so the
 * ceiling that matters is on total edge *span*, which is what crossing
 * minimisation over many ranks actually costs. `dummies` from
 * {@link layoutCost} is exactly that sum.
 */
const MAX_NODES = 150;
const MAX_EDGES = 4_000;
const MAX_SPAN = 2_000;

let loaded: Graphviz | undefined;
let loading: Promise<void> | undefined;

// True once `dot` can be called synchronously.
export function graphvizReady(): boolean {
  return loaded !== undefined;
}

/**
 * Starts loading the WebAssembly module, at most once per session. Resolves
 * when {@link graphvizReady} turns true; the caller redraws then, and gets the
 * hand-rolled layout in the meantime.
 */
export function loadGraphviz(): Promise<void> {
  loading ??= Graphviz.load().then(
    (gv) => {
      loaded = gv;
    },
    () => {
      // A failure here is not worth surfacing: the hand-rolled layout is a
      // complete answer, and retrying a failed wasm instantiation on every
      // frame would be worse than doing without.
      loading = undefined;
    },
  );
  return loading;
}

// Whether `dot` should be asked about this graph at all. Cheap: one longest-path
// ranking pass, which the hand-rolled layout would do anyway.
export function graphvizAffordable(
  nodes: readonly NodeId[],
  edges: readonly GraphEdge[],
): boolean {
  if (nodes.length > MAX_NODES) return false;
  const cost = layoutCost(nodes, edges);
  return cost.edges <= MAX_EDGES && cost.dummies <= MAX_SPAN;
}

/**
 * Lays the graph out with `dot`, or returns undefined if it cannot - not
 * loaded, too big, or `dot` itself refused. Every caller must have a fallback.
 */
export function layoutWithGraphviz(
  nodes: readonly NodeId[],
  edges: readonly GraphEdge[],
): GraphLayout | undefined {
  const gv = loaded;
  if (gv === undefined || nodes.length === 0) return undefined;
  if (!graphvizAffordable(nodes, edges)) return undefined;

  const present = new Set(nodes);
  const drawn = edges.filter(
    (e) => present.has(e.source) && present.has(e.dest) && e.source !== e.dest,
  );

  try {
    const json = JSON.parse(gv.layout(dotSource(nodes, drawn), 'json', 'dot'));
    return readLayout(json, drawn);
  } catch {
    return undefined;
  }
}

function dotSource(
  nodes: readonly NodeId[],
  drawn: readonly GraphEdge[],
): string {
  // `shape=point` sized to the dot the pane actually draws, not to the wider
  // cell the hand-rolled layout reserves: dot stops each edge at the node's
  // boundary, so telling it the node is bigger than it looks leaves a visible
  // gap between the line and the dot at both ends.
  const size = ((DOT_RADIUS * 2) / PER_INCH).toFixed(4);
  const nodeSep = (NODE_SEP / PER_INCH).toFixed(4);
  const rankSep = (RANK_SEP / PER_INCH).toFixed(4);
  const decls = nodes.map((n) => `n${n};`).join('');
  const links = drawn.map((e) => `n${e.source}->n${e.dest};`).join('');
  return (
    `digraph{node[shape=point,width=${size},height=${size}];` +
    // arrowhead=none because the pane draws its own via `marker-end`. Left on,
    // dot reserves roughly ten points at the head end for an arrow it is not
    // drawing, which reads as the edge stopping short of its target. Costs
    // nothing in width.
    `edge[arrowhead=none];` +
    `nodesep=${nodeSep};ranksep=${rankSep};${decls}${links}}`
  );
}

interface DotObject {
  readonly name?: string;
  readonly pos?: string;
}

interface DotEdge {
  readonly tail?: number;
  readonly head?: number;
  readonly pos?: string;
}

interface DotJson {
  readonly bb?: string;
  readonly objects?: readonly DotObject[];
  readonly edges?: readonly DotEdge[];
}

function readLayout(
  json: DotJson,
  drawn: readonly GraphEdge[],
): GraphLayout | undefined {
  const bb = (json.bb ?? '').split(',').map(Number);
  if (bb.length !== 4) return undefined;
  const [, , width, height] = bb;

  // dot's y axis points up and ours points down, so every y is mirrored in the
  // bounding box before it leaves this file.
  const flip = (y: number) => height - y;

  const objects = json.objects ?? [];
  const byIndex: (LayoutNode | undefined)[] = [];
  const byNode = new Map<NodeId, LayoutNode>();
  objects.forEach((o, i) => {
    const centre = point(o.pos);
    const id = Number((o.name ?? '').slice(1));
    if (centre === undefined || !Number.isFinite(id)) {
      byIndex[i] = undefined;
      return;
    }
    // Sized to what dot actually reserved (see dotSource), not to the wider
    // cell the hand-rolled layout uses. The pane reads a dot's centre as
    // `x + width / 2`, so these have to agree or the box overhangs the
    // bounding box and every extent - the initial fit included - is off.
    const ln: LayoutNode = {
      node: id as NodeId,
      x: centre.x - DOT_RADIUS,
      y: flip(centre.y) - DOT_RADIUS,
      width: DOT_RADIUS * 2,
      height: DOT_RADIUS * 2,
    };
    byIndex[i] = ln;
    byNode.set(ln.node, ln);
  });

  // `forced` is matched back on by endpoints rather than by position in the
  // array: dot is under no obligation to report edges in declaration order, and
  // an index that silently slips colours the wrong edges red.
  const forced = new Set<string>();
  for (const e of drawn) if (e.forced) forced.add(`${e.source}>${e.dest}`);

  const edges: LayoutEdge[] = [];
  for (const e of json.edges ?? []) {
    const source = e.tail === undefined ? undefined : byIndex[e.tail];
    const dest = e.head === undefined ? undefined : byIndex[e.head];
    if (source === undefined || dest === undefined) continue;
    const spline = readSpline(e.pos, flip);
    edges.push({
      source,
      dest,
      forced: forced.has(`${source.node}>${dest.node}`),
      ...(spline !== undefined && {spline}),
    });
  }

  return {nodes: [...byNode.values()], edges, width, height};
}

/**
 * dot's edge `pos`: an optional `e,x,y` arrowhead tip and `s,x,y` start, then a
 * start point followed by groups of three cubic Bézier control points. Returned
 * in that same flat form - `[p0, c1, c2, p1, c3, c4, p2, ...]`.
 *
 * **The `e,` tip is deliberately not part of the chain.** It is where the
 * arrowhead points, a unit or two past the curve's own last point, and adding
 * it makes the count `3n + 2` - which fails the check below, drops the spline,
 * and leaves the pane drawing a straight line through whatever the edge was
 * routed around. `marker-end` puts the arrowhead at the path's end anyway.
 */
function readSpline(
  pos: string | undefined,
  flip: (y: number) => number,
): readonly {x: number; y: number}[] | undefined {
  if (pos === undefined) return undefined;
  let tip: {x: number; y: number} | undefined;
  const points: {x: number; y: number}[] = [];
  for (const token of pos.trim().split(/\s+/)) {
    if (token.startsWith('e,')) {
      tip = point(token.slice(2));
      continue;
    }
    // `s,x,y` marks a start point; treat it as one.
    const p = point(token.startsWith('s,') ? token.slice(2) : token);
    if (p !== undefined) points.push(p);
  }
  // One on-curve point plus n groups of three: anything else is not a spline
  // this can draw, so the pane falls back to a straight segment.
  if (points.length < 4 || (points.length - 1) % 3 !== 0) return undefined;

  // The curve stops a little short of the tip, so carry it the rest of the way
  // as one more segment - held back by ARROW_GAP, which is the room the pane's
  // own arrowhead needs. Repeating the point three times makes a degenerate
  // cubic, which draws as a straight line and keeps the 3n+1 count intact.
  if (tip !== undefined) {
    const from = points[points.length - 1];
    const end = pullBack(tip, from, ARROW_GAP);
    points.push(end, end, end);
  }
  return points.map((p) => ({x: p.x, y: flip(p.y)}));
}

// `to` moved `dist` units back towards `from`.
function pullBack(
  to: {x: number; y: number},
  from: {x: number; y: number},
  dist: number,
): {x: number; y: number} {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  if (len <= dist) return to;
  return {
    x: to.x + ((from.x - to.x) / len) * dist,
    y: to.y + ((from.y - to.y) / len) * dist,
  };
}

function point(s: string | undefined): {x: number; y: number} | undefined {
  if (s === undefined) return undefined;
  const [x, y] = s.split(',').map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return {x, y};
}
