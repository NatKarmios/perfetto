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
 * A layered (Sugiyama-style) layout for the small, curated subgraph shown in
 * the graph view. Nodes are ranked by longest-path depth so every edge points
 * downward from a depender to its prerequisite; each rank is a row, and the
 * order within a row is chosen to keep edges from crossing rather than left as
 * the caller handed it over.
 *
 * **ARCHITECTURE.md, "Drawing the node graph", is the design** - the four
 * passes, what each one is worth, what a bend point is, and the budget above
 * which the refinement is skipped entirely.
 *
 * Pure geometry, no rendering: takes node ids + edges, returns positioned boxes
 * in an abstract coordinate space that the SVG view maps through a viewBox. It
 * never needs the graph itself - a node is just its id here, and the pane
 * resolves labels for the one node it's showing a tooltip for.
 */

import type {GraphEdge, NodeId} from '../model/graph';

// Each node renders as a small dot; these are the cell it occupies and the gap
// between cells (equal on both axes, so node-to-node distance reads the same
// horizontally and vertically), in layout units (== SVG user units).
export const NODE_WIDTH = 16;
export const NODE_HEIGHT = 16;
const GAP = 20;
// Centre-to-centre distance between two items sharing a rank.
const CELL = NODE_WIDTH + GAP;
// Down/up iterations, for the ordering sweep and again for the x refinement.
// Four is dagre's number and the point where both stop paying for themselves.
const SWEEPS = 4;

// ponytail: above either ceiling the ordering sweep, the x refinement and the
// dummy chain are all skipped, and the layout degrades to exactly what it was
// before any of them existed - arrival-order rows, centred, straight edges. The
// dummy bound is the load-bearing one (dummies are the sum of the edge spans,
// so a graph that is deep *and* wide multiplies both); the edge bound only
// keeps the sweep's cost in hand. Raise them by measuring, not by taste.
const EDGE_BUDGET = 50_000;
const DUMMY_BUDGET = 5_000;

export interface LayoutNode {
  readonly node: NodeId;
  // Top-left corner in layout coordinates.
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LayoutEdge {
  readonly source: LayoutNode;
  readonly dest: LayoutNode;
  // Carried through from the {@link GraphEdge} so the view can highlight forced
  // edges.
  readonly forced: boolean;
  /**
   * Waypoints for an edge that skips a rank: one per intervening rank, in
   * layout units and already *centres* (unlike {@link LayoutNode}, which is a
   * corner), so the view draws a polyline straight through them. Absent for a
   * span-1 edge, which is the common case.
   */
  readonly bends?: readonly {readonly x: number; readonly y: number}[];
}

export interface GraphLayout {
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly LayoutEdge[];
  // Overall content extent, before padding: what the initial viewBox fits.
  readonly width: number;
  readonly height: number;
}

const EMPTY_LAYOUT: GraphLayout = {nodes: [], edges: [], width: 0, height: 0};

/**
 * One cell of a rank: either a node, or a dummy standing in for a rank-skipping
 * edge as it passes through. Dummies take a slot like anything else, which is
 * what stops a long edge from being drawn under the dots of the ranks it
 * crosses, and their final positions become the edge's bend points.
 */
interface Item {
  // The node drawn here, or undefined for a dummy.
  readonly node?: NodeId;
  readonly rank: number;
  readonly up: Item[];
  readonly down: Item[];
  // Left edge in layout coordinates, before the final normalisation.
  x: number;
  // Index within its rank's current order. Kept in step with the order arrays
  // by whoever reorders them, because every median is taken over these.
  pos: number;
}

export function layoutGraph(
  nodes: readonly NodeId[],
  edges: readonly GraphEdge[],
): GraphLayout {
  if (nodes.length === 0) return EMPTY_LAYOUT;

  const present = new Set(nodes);

  // Adjacency + in-degree over just this node set.
  const out = new Map<NodeId, NodeId[]>();
  const inDegree = new Map<NodeId, number>();
  for (const n of nodes) {
    out.set(n, []);
    inDegree.set(n, 0);
  }
  for (const {source, dest} of edges) {
    if (!present.has(source) || !present.has(dest) || source === dest) continue;
    out.get(source)?.push(dest);
    inDegree.set(dest, (inDegree.get(dest) ?? 0) + 1);
  }

  const rank = assignRanks(nodes, out, inDegree);
  const rankOf = (n: NodeId) => rank.get(n) ?? 0;

  // The edges that will be drawn: the same filter the emission below applies,
  // hoisted so the budget can be taken over the real count.
  const drawn = edges.filter(
    (e) => present.has(e.source) && present.has(e.dest) && e.source !== e.dest,
  );
  const dummyCount = drawn.reduce(
    (n, e) => n + Math.max(0, rankOf(e.dest) - rankOf(e.source) - 1),
    0,
  );
  const refine = drawn.length <= EDGE_BUDGET && dummyCount <= DUMMY_BUDGET;

  // Every rank from 0 to the deepest is occupied - a rank index can never be
  // skipped, since a node's rank is one past a predecessor's - so this is the
  // row count too.
  const rankCount = Math.max(...nodes.map(rankOf)) + 1;
  const order: Item[][] = Array.from({length: rankCount}, () => []);
  const itemOf = new Map<NodeId, Item>();
  for (const node of nodes) {
    const item: Item = {
      node,
      rank: rankOf(node),
      up: [],
      down: [],
      x: 0,
      pos: 0,
    };
    order[item.rank].push(item);
    itemOf.set(node, item);
  }

  // Link the layered graph, threading a dummy through each intervening rank.
  // Parallel to `drawn`, so an edge finds its own chain by index.
  const chains: (readonly Item[] | undefined)[] = drawn.map(() => undefined);
  drawn.forEach((e, i) => {
    const source = itemOf.get(e.source);
    const dest = itemOf.get(e.dest);
    // Only a cycle could leave dest at or above source, and then there is no
    // sensible chain: the edge is still drawn, just not part of the layering.
    if (source === undefined || dest === undefined) return;
    if (dest.rank <= source.rank) return;
    let prev = source;
    const chain: Item[] = [];
    if (refine) {
      for (let r = source.rank + 1; r < dest.rank; r++) {
        const mid: Item = {rank: r, up: [], down: [], x: 0, pos: 0};
        order[r].push(mid);
        chain.push(mid);
        link(prev, mid);
        prev = mid;
      }
    }
    link(prev, dest);
    if (chain.length > 0) chains[i] = chain;
  });
  syncPos(order);

  if (refine) {
    initOrder(order);
    orderRanks(order);
  }
  placeSlots(order);
  if (refine) refineX(order);

  // Normalise: the refinement works in a floating frame, so slide the whole
  // thing back to x = 0 and take the extent from where everything landed -
  // dummies included, so a bend point is always inside the content box.
  let minX = Infinity;
  let maxX = -Infinity;
  for (const row of order) {
    for (const item of row) {
      minX = Math.min(minX, item.x);
      maxX = Math.max(maxX, item.x);
    }
  }
  const rowY = (r: number) => r * (NODE_HEIGHT + GAP);

  const layoutById = new Map<NodeId, LayoutNode>();
  const layoutNodes: LayoutNode[] = [];
  for (const row of order) {
    for (const item of row) {
      if (item.node === undefined) continue;
      const ln: LayoutNode = {
        node: item.node,
        x: item.x - minX,
        y: rowY(item.rank),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      };
      layoutNodes.push(ln);
      layoutById.set(item.node, ln);
    }
  }

  const layoutEdges: LayoutEdge[] = [];
  drawn.forEach((e, i) => {
    const source = layoutById.get(e.source);
    const dest = layoutById.get(e.dest);
    if (source === undefined || dest === undefined || source === dest) return;
    const chain = chains[i];
    const base = {source, dest, forced: e.forced};
    layoutEdges.push(
      chain === undefined
        ? base
        : {
            ...base,
            bends: chain.map((item) => ({
              x: item.x - minX + NODE_WIDTH / 2,
              y: rowY(item.rank) + NODE_HEIGHT / 2,
            })),
          },
    );
  });

  return {
    nodes: layoutNodes,
    edges: layoutEdges,
    width: maxX - minX + NODE_WIDTH,
    height: rankCount * (NODE_HEIGHT + GAP) - GAP,
  };
}

function link(from: Item, to: Item): void {
  from.down.push(to);
  to.up.push(from);
}

function syncPos(order: readonly Item[][]): void {
  for (const row of order) row.forEach((item, i) => (item.pos = i));
}

/**
 * dagre's `initOrder`: a depth-first walk from the rank-0 items in input order,
 * appending each item to its rank as it is first reached. A chain and the
 * dummies of any edge alongside it therefore start out in neighbouring slots,
 * which on its own beats the arrival order both callers supply (the chart's is
 * `ORDER BY node_id`, and a node id *is* the kind partition, so every rule
 * would sort before every dep).
 *
 * Iterative, not recursive: a deep graph's dummy chains make the walk as deep
 * as the whole layered graph.
 */
function initOrder(order: Item[][]): void {
  const seen = new Set<Item>();
  const next: Item[][] = order.map(() => []);
  const stack = [...order[0]].reverse();
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined || seen.has(item)) continue;
    seen.add(item);
    next[item.rank].push(item);
    for (let i = item.down.length - 1; i >= 0; i--) stack.push(item.down[i]);
  }
  // Only a cycle can leave an item unreachable from rank 0; it keeps its
  // arrival order, after everything the walk found.
  order.forEach((row, r) => {
    for (const item of row) if (!seen.has(item)) next[r].push(item);
  });
  order.forEach((row, r) => {
    row.length = 0;
    for (const item of next[r]) row.push(item);
  });
  syncPos(order);
}

/**
 * Down/up median sweeps, keeping the fewest-crossings ordering seen - including
 * the one it started from, so this can only improve on {@link initOrder}.
 *
 * No transpose pass (the local adjacent-swap polish that usually follows the
 * median rule): it is the expensive half at the dense end, where a rank pair
 * costs deg x deg per candidate swap, and the median sweep is where the bulk of
 * the reduction is. It is the next thing to add if the picture needs more.
 */
function orderRanks(order: Item[][]): void {
  let best = order.map((row) => [...row]);
  let bestCrossings = countCrossings(order);
  for (let i = 0; i < SWEEPS; i++) {
    if (i % 2 === 0) {
      for (let r = 1; r < order.length; r++) sortByMedian(order[r], true);
    } else {
      for (let r = order.length - 2; r >= 0; r--) sortByMedian(order[r], false);
    }
    const crossings = countCrossings(order);
    if (crossings < bestCrossings) {
      bestCrossings = crossings;
      best = order.map((row) => [...row]);
    }
  }
  order.forEach((row, r) => {
    row.length = 0;
    for (const item of best[r]) row.push(item);
  });
  syncPos(order);
}

/**
 * The classic median rule: each item wants the median position of its
 * neighbours in the adjacent rank, and an item with no neighbours there holds
 * its slot while the rest sort around it. Stable on ties, so the walk order
 * survives wherever the medians say nothing.
 */
function sortByMedian(row: Item[], useUp: boolean): void {
  const slots: number[] = [];
  const movable: {
    readonly item: Item;
    readonly med: number;
    readonly i: number;
  }[] = [];
  row.forEach((item, i) => {
    const neighbours = useUp ? item.up : item.down;
    if (neighbours.length === 0) return;
    slots.push(i);
    movable.push({item, med: median(neighbours.map((n) => n.pos)), i});
  });
  movable.sort((a, b) => a.med - b.med || a.i - b.i);
  movable.forEach((m, k) => (row[slots[k]] = m.item));
  row.forEach((item, i) => (item.pos = i));
}

// Crossings between every pair of adjacent ranks. An edge pair crosses exactly
// when the dest positions are inverted against the source positions, so this is
// an inversion count over the dest positions read in source order (each source's
// own dests sorted, since edges sharing an endpoint never cross).
function countCrossings(order: readonly Item[][]): number {
  let total = 0;
  for (let r = 0; r + 1 < order.length; r++) {
    const seq: number[] = [];
    for (const item of order[r]) {
      const dests = item.down.map((d) => d.pos).sort((a, b) => a - b);
      for (const p of dests) seq.push(p);
    }
    total += inversions(seq, order[r + 1].length);
  }
  return total;
}

// Inversions of a sequence of positions in [0, size), via a Fenwick tree. The
// naive pairwise count is six lines shorter and quadratic, which a rank pair
// holding tens of thousands of edges - one rule fanning out over every shared
// dep - would feel.
function inversions(seq: readonly number[], size: number): number {
  const tree = new Int32Array(size + 1);
  let total = 0;
  for (let seen = 0; seen < seq.length; seen++) {
    const v = seq[seen];
    let atMost = 0;
    for (let i = v + 1; i > 0; i -= i & -i) atMost += tree[i];
    total += seen - atMost;
    for (let i = v + 1; i <= size; i += i & -i) tree[i]++;
  }
  return total;
}

// Slot placement: item i of a rank sits i cells along, and each rank is centred
// in the widest one. This is the whole of the pre-refinement layout, and the
// starting point (and fallback) for what follows.
function placeSlots(order: readonly Item[][]): void {
  const rowWidth = (count: number) =>
    count * NODE_WIDTH + Math.max(0, count - 1) * GAP;
  const totalWidth = Math.max(...order.map((row) => rowWidth(row.length)));
  for (const row of order) {
    const xStart = (totalWidth - rowWidth(row.length)) / 2;
    row.forEach((item, i) => (item.x = xStart + i * CELL));
  }
}

/**
 * Down/up barycentre passes over the x coordinates, keeping the arrangement
 * with the lowest weighted edge displacement - the slot placement included, so
 * this too can only improve on what it was handed.
 *
 * The weighting is what keeps a long edge straight: a segment touching a dummy
 * counts double, and one between two dummies eight times, so the chain carrying
 * a rank-skipping edge outbids the real nodes competing for the same x.
 */
function refineX(order: readonly Item[][]): void {
  const snapshot = () => order.map((row) => row.map((item) => item.x));
  let best = snapshot();
  let bestCost = edgeCost(order);
  for (let i = 0; i < SWEEPS; i++) {
    if (i % 2 === 0) {
      for (let r = 1; r < order.length; r++) alignRank(order[r], true);
    } else {
      for (let r = order.length - 2; r >= 0; r--) alignRank(order[r], false);
    }
    const cost = edgeCost(order);
    if (cost < bestCost) {
      bestCost = cost;
      best = snapshot();
    }
  }
  order.forEach((row, r) => row.forEach((item, i) => (item.x = best[r][i])));
}

// Move a rank's items to the median x of their neighbours in the adjacent rank,
// packed left to right so nothing ends up closer than a cell.
function alignRank(row: readonly Item[], useUp: boolean): void {
  if (row.length === 0) return;
  const want = row.map((item) => {
    const neighbours = useUp ? item.up : item.down;
    return neighbours.length === 0
      ? item.x
      : median(neighbours.map((n) => n.x));
  });
  let x = want[0];
  row[0].x = x;
  for (let i = 1; i < row.length; i++) {
    x = Math.max(want[i], x + CELL);
    row[i].x = x;
  }
  // Packing can only push right, which would drift the rank away from what it
  // asked for; sliding it back by the median error centres it on that instead.
  const shift = median(row.map((item, i) => item.x - want[i]));
  if (shift !== 0) for (const item of row) item.x -= shift;
}

// Total horizontal edge displacement over the layered graph - the thing the
// barycentre passes are trying to reduce. See refineX for the weighting.
function edgeCost(order: readonly Item[][]): number {
  let total = 0;
  for (const row of order) {
    for (const item of row) {
      for (const dest of item.down) {
        const dummies =
          (item.node === undefined ? 1 : 0) + (dest.node === undefined ? 1 : 0);
        const weight = dummies === 2 ? 8 : dummies === 1 ? 2 : 1;
        total += weight * Math.abs(item.x - dest.x);
      }
    }
  }
  return total;
}

// Interpolated median - the midpoint of the two middles for an even count, so a
// node with two neighbours sits between them rather than under one of them.
// Never called with an empty list.
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Longest-path layering via Kahn's algorithm: roots (no in-edges) get rank 0,
// every other node sits one below its deepest predecessor. Nodes left unranked
// by a cycle keep rank 0 - defensive only, the build graph is a DAG.
function assignRanks(
  nodes: readonly NodeId[],
  out: ReadonlyMap<NodeId, readonly NodeId[]>,
  inDegree: ReadonlyMap<NodeId, number>,
): ReadonlyMap<NodeId, number> {
  const rank = new Map<NodeId, number>();
  const remaining = new Map(inDegree);
  const queue: NodeId[] = [];
  for (const n of nodes) {
    rank.set(n, 0);
    if ((remaining.get(n) ?? 0) === 0) queue.push(n);
  }
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i];
    if (u === undefined) continue;
    for (const v of out.get(u) ?? []) {
      rank.set(v, Math.max(rank.get(v) ?? 0, (rank.get(u) ?? 0) + 1));
      const left = (remaining.get(v) ?? 0) - 1;
      remaining.set(v, left);
      if (left === 0) queue.push(v);
    }
  }
  return rank;
}
