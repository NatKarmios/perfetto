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
 * Pure geometry, no rendering: takes nodes + edges, returns positioned boxes in
 * an abstract coordinate space that the SVG view maps through a viewBox.
 */

import type {GraphEdge, GraphNode} from './graph';
import {nodeKey} from './graph';

// Each node renders as a small dot; these are the cell it occupies and the gaps
// between cells, in layout units (== SVG user units).
export const NODE_WIDTH = 16;
export const NODE_HEIGHT = 16;
const H_GAP = 20;
const V_GAP = 44;

export interface LayoutNode {
  readonly node: GraphNode;
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
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): GraphLayout {
  if (nodes.length === 0) return EMPTY_LAYOUT;

  const keyOf = (n: GraphNode) => nodeKey(n.kind, n.id);
  const present = new Set(nodes.map(keyOf));

  // Adjacency + in-degree over just this node set.
  const out = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const n of nodes) {
    out.set(keyOf(n), []);
    inDegree.set(keyOf(n), 0);
  }
  for (const {source, dest} of edges) {
    const s = keyOf(source);
    const d = keyOf(dest);
    if (!present.has(s) || !present.has(d) || s === d) continue;
    out.get(s)?.push(d);
    inDegree.set(d, (inDegree.get(d) ?? 0) + 1);
  }

  const rank = assignRanks(nodes, keyOf, out, inDegree);

  // Bucket nodes into rows by rank, preserving input order within a row.
  const rows: GraphNode[][] = [];
  for (const n of nodes) {
    const r = rank.get(keyOf(n)) ?? 0;
    (rows[r] ??= []).push(n);
  }

  // Widest row sets the content width; every row is centred within it.
  const rowWidth = (count: number) =>
    count * NODE_WIDTH + Math.max(0, count - 1) * H_GAP;
  const totalWidth = Math.max(...rows.map((row) => rowWidth(row.length)));

  const layoutByKey = new Map<string, LayoutNode>();
  const layoutNodes: LayoutNode[] = [];
  rows.forEach((row, r) => {
    const xStart = (totalWidth - rowWidth(row.length)) / 2;
    const y = r * (NODE_HEIGHT + V_GAP);
    row.forEach((node, i) => {
      const ln: LayoutNode = {
        node,
        x: xStart + i * (NODE_WIDTH + H_GAP),
        y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      };
      layoutNodes.push(ln);
      layoutByKey.set(keyOf(node), ln);
    });
  });

  const layoutEdges: LayoutEdge[] = [];
  for (const {source, dest, forced} of edges) {
    const s = layoutByKey.get(keyOf(source));
    const d = layoutByKey.get(keyOf(dest));
    if (s !== undefined && d !== undefined && s !== d) {
      layoutEdges.push({source: s, dest: d, forced});
    }
  }

  const height = rows.length * (NODE_HEIGHT + V_GAP) - V_GAP;
  return {nodes: layoutNodes, edges: layoutEdges, width: totalWidth, height};
}

// Longest-path layering via Kahn's algorithm: roots (no in-edges) get rank 0,
// every other node sits one below its deepest predecessor. Nodes left unranked
// by a cycle keep rank 0 - defensive only, the build graph is a DAG.
function assignRanks(
  nodes: readonly GraphNode[],
  keyOf: (n: GraphNode) => string,
  out: ReadonlyMap<string, readonly string[]>,
  inDegree: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const rank = new Map<string, number>();
  const remaining = new Map(inDegree);
  const queue: string[] = [];
  for (const n of nodes) {
    const k = keyOf(n);
    rank.set(k, 0);
    if ((remaining.get(k) ?? 0) === 0) queue.push(k);
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
