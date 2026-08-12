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

import type {Trace} from '../../public/trace';
import type {BuildGraph, GraphNode, GraphSource, ReverseIndex} from './graph';
import {
  ancestors,
  buildReverseIndex,
  directParents,
  EMPTY_GRAPH,
  nodeKey,
} from './graph';
import {SliceArgsGraphSource} from './slice_args_graph_source';
import type {Distances, SqlGraph} from './sql_graph';
import {buildSqlGraph} from './sql_graph';

/**
 * Holds the extracted build graph plus the active source, and knows how to
 * (re)load it. The sidebar panel reads state directly off this each render.
 */
export class DuneGraphController {
  private source: GraphSource;
  // Mirror of `graph` materialized as SQL tables; also runs distance queries.
  private sqlGraph?: SqlGraph;

  loading = false;
  graph: BuildGraph = EMPTY_GRAPH;
  error?: string;

  // The nodes chosen to appear in the rendered graph, keyed for de-dup. The
  // graph area renders whatever is in here; the graph rendering itself is a
  // later step.
  private readonly selection = new Map<string, GraphNode>();
  // Reverse adjacency (dependents), built lazily and dropped on reload.
  private reverseIndex?: ReverseIndex;

  constructor(private readonly trace: Trace) {
    this.source = this.makeSource();
  }

  get sourceDescription(): string {
    return this.source.description;
  }

  // The node corresponding to the current timeline selection, if a "build-dep"
  // or "exec-rule" slice is selected. For slice tracks the selection's eventId
  // is the slice id, which is what the reverse index is keyed on.
  nodeForSelection(): GraphNode | undefined {
    const selection = this.trace.selection.selection;
    if (selection.kind !== 'track_event') return undefined;
    return this.graph.bySliceId.get(selection.eventId);
  }

  // Nodes currently chosen for the graph.
  get selectedNodes(): readonly GraphNode[] {
    return [...this.selection.values()];
  }

  // Add nodes to the graph selection (dedup is by node key).
  addToGraph(nodes: Iterable<GraphNode>): void {
    for (const node of nodes) {
      this.selection.set(nodeKey(node.kind, node.id), node);
    }
  }

  // Remove nodes from the graph selection.
  removeFromGraph(nodes: Iterable<GraphNode>): void {
    for (const node of nodes) {
      this.selection.delete(nodeKey(node.kind, node.id));
    }
  }

  // Remove every node from the graph selection.
  clearGraph(): void {
    this.selection.clear();
  }

  // Whether a node is currently in the graph selection.
  isInGraph(node: GraphNode): boolean {
    return this.selection.has(nodeKey(node.kind, node.id));
  }

  // The graph node a "build-dep"/"exec-rule" slice id maps to, if any.
  nodeForSliceId(sliceId: number): GraphNode | undefined {
    return this.graph.bySliceId.get(sliceId);
  }

  // The dense SQL `node_id` for a node - the value the `dune_descendants` /
  // `dune_ancestors` functions take - or undefined if the SQL mirror isn't
  // built yet (still loading / failed).
  nodeIdOf(node: GraphNode): number | undefined {
    return this.sqlGraph?.nodeId(node);
  }

  // Parents/ancestors are walked in-memory over the reverse index. The same
  // dependents could be computed in SQL via `graph_reachable_bfs!` over the
  // reversed `dune_edge` table (the mirror `distances()` already uses).
  // TODO(nat): once testing on larger traces, compare the two - if the reverse
  // BFS gets slow in-memory, switch ancestorsOf() to the SQL path (needs a
  // node_id -> GraphNode reverse map and makes the callers async).
  //
  // Nodes that directly depend on `node` (its immediate parents).
  parentsOf(node: GraphNode): readonly GraphNode[] {
    return directParents(this.reverse(), node);
  }

  // All nodes that transitively depend on `node` (its ancestors).
  ancestorsOf(node: GraphNode): readonly GraphNode[] {
    return ancestors(this.reverse(), node);
  }

  // Select the slice `node` was extracted from and scroll it into view - the
  // node -> slice half of the bidirectional link.
  //
  // We resolve the track and reveal its ancestor groups *before* selecting so
  // that the track's DOM element exists by the time the selection's scroll
  // runs. Otherwise scrollToSelection's vertical scroll silently no-ops when
  // the track sits in a collapsed group (the horizontal/time scroll still works
  // as it doesn't depend on the track being in the DOM).
  async goToNode(node: GraphNode): Promise<void> {
    const match = (
      await this.trace.selection.resolveSqlEvents('slice', [node.sliceId])
    )[0];
    if (match === undefined) return;
    this.trace.currentWorkspace.getTrackByUri(match.trackUri)?.reveal();
    this.trace.selection.selectTrackEvent(match.trackUri, match.eventId, {
      scrollToSelection: true,
    });
  }

  // The reverse-edge index for the current graph, built on first use.
  private reverse(): ReverseIndex {
    return (this.reverseIndex ??= buildReverseIndex(this.graph));
  }

  // The single seam to swap while experimenting with where the graph comes
  // from - everything else only sees the GraphSource contract.
  private makeSource(): GraphSource {
    return new SliceArgsGraphSource(this.trace.engine);
  }

  // Directed dependency distances between two nodes (see {@link Distances}), or
  // undefined if either node is unknown or `to` is unreachable from `from`.
  async distances(
    from: GraphNode,
    to: GraphNode,
  ): Promise<Distances | undefined> {
    const sqlGraph = this.sqlGraph;
    if (sqlGraph === undefined) return undefined;
    const fromId = sqlGraph.nodeId(from);
    const toId = sqlGraph.nodeId(to);
    if (fromId === undefined || toId === undefined) return undefined;
    return sqlGraph.distances(fromId, toId);
  }

  async reload(): Promise<void> {
    this.loading = true;
    this.error = undefined;
    // The graph is being rebuilt: drop the selection and the derived index so
    // neither outlives the nodes it refers to.
    this.selection.clear();
    this.reverseIndex = undefined;
    // Drop the previous SQL tables before rebuilding so reload is idempotent.
    await this.sqlGraph?.[Symbol.asyncDispose]();
    this.sqlGraph = undefined;
    try {
      this.graph = await this.source.load();
      this.sqlGraph = await buildSqlGraph(this.trace.engine, this.graph);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.graph = EMPTY_GRAPH;
    } finally {
      this.loading = false;
    }
  }
}
