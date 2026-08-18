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
 * A minimal layered (Sugiyama-style) layout for the small, curated subgraph
 * shown in the graph view. Nodes are ranked by longest-path depth so every edge
 * points downward from a depender to its prerequisite; each rank is a row,
 * rows are centred horizontally. No crossing-minimisation yet - rows keep input
 * order - which is fine at this scale; that's the natural next improvement.
 *
 * Pure geometry, no rendering: takes node ids + edges, returns positioned boxes
 * in an abstract coordinate space that the SVG view maps through a viewBox. It
 * never needs the graph itself - a node is just its id here, and the pane
 * resolves labels for the one node it's showing a tooltip for.
 */

import type {GraphEdge, NodeId} from './graph';

// Each node renders as a small dot; these are the cell it occupies and the gap
// between cells (equal on both axes, so node-to-node distance reads the same
// horizontally and vertically), in layout units (== SVG user units).
export const NODE_WIDTH = 16;
export const NODE_HEIGHT = 16;
const GAP = 20;

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
}

export interface GraphLayout {
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly LayoutEdge[];
  // Overall content extent (before padding), used to fit the initial viewBox.
  readonly width: number;
  readonly height: number;
}

const EMPTY_LAYOUT: GraphLayout = {nodes: [], edges: [], width: 0, height: 0};

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

  // Bucket nodes into rows by rank, preserving input order within a row.
  const rows: NodeId[][] = [];
  for (const n of nodes) {
    const r = rank.get(n) ?? 0;
    (rows[r] ??= []).push(n);
  }

  // Widest row sets the content width; every row is centred within it.
  const rowWidth = (count: number) =>
    count * NODE_WIDTH + Math.max(0, count - 1) * GAP;
  const totalWidth = Math.max(...rows.map((row) => rowWidth(row.length)));

  const layoutById = new Map<NodeId, LayoutNode>();
  const layoutNodes: LayoutNode[] = [];
  rows.forEach((row, r) => {
    const xStart = (totalWidth - rowWidth(row.length)) / 2;
    const y = r * (NODE_HEIGHT + GAP);
    row.forEach((node, i) => {
      const ln: LayoutNode = {
        node,
        x: xStart + i * (NODE_WIDTH + GAP),
        y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      };
      layoutNodes.push(ln);
      layoutById.set(node, ln);
    });
  });

  const layoutEdges: LayoutEdge[] = [];
  for (const {source, dest, forced} of edges) {
    const s = layoutById.get(source);
    const d = layoutById.get(dest);
    if (s !== undefined && d !== undefined && s !== d) {
      layoutEdges.push({source: s, dest: d, forced});
    }
  }

  const height = rows.length * (NODE_HEIGHT + GAP) - GAP;
  return {nodes: layoutNodes, edges: layoutEdges, width: totalWidth, height};
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
