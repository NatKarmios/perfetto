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
import type {Workspace} from '../../public/workspace';
import {TrackNode} from '../../public/workspace';
import type {BuildGraph, GraphNode, GraphSource, ReverseIndex} from './graph';
import {
  ancestors,
  buildReverseIndex,
  descendants,
  directParents,
  EMPTY_GRAPH,
  forcers,
  nodeKey,
  outEdges,
} from './graph';
import {
  createGraphTrackRenderer,
  GRAPH_TRACK_NAME,
  GRAPH_TRACK_URI,
} from './graph_track';
import {SliceArgsGraphSource} from './slice_args_graph_source';
import type {Distances, SqlGraph} from './sql_graph';
import {buildSqlGraph} from './sql_graph';

const TIMELINE_WORKSPACE_NAME = 'Dune graph';

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

  // Whether rule nodes are hidden from both the graph pane and the timeline
  // track (see visibleNodes()). Lives here (not in GraphPanel) so it survives
  // panel remounts and the timeline track can see it too.
  private hideRulesFlag = false;

  // Bumped by every mutation that can change `visibleNodes`: the single
  // invalidation key shared by the graph pane's layout cache and the
  // timeline track's dataset (see graph_track.ts).
  private version = 0;

  // The dedicated workspace + track projecting the graph selection onto the
  // timeline, installed once via installTimeline().
  private timelineWorkspace?: Workspace;
  // The workspace as of the last onFrame() poll, so a change can be detected
  // (see installTimeline()/onFrame()). There is no workspace-change event in
  // Perfetto - not even switchWorkspace() itself is the only way the current
  // workspace can change (removeWorkspace() also reverts to the default
  // workspace) - so this has to be polled.
  private lastWorkspace?: Workspace;

  constructor(private readonly trace: Trace) {
    this.source = this.makeSource();
  }

  // Whether rule nodes are currently hidden.
  get hideRules(): boolean {
    return this.hideRulesFlag;
  }

  toggleHideRules(): void {
    this.hideRulesFlag = !this.hideRulesFlag;
    this.version++;
  }

  // Monotonic version of the visible node set - bump on every mutation that
  // can change it.
  get graphVersion(): number {
    return this.version;
  }

  // The nodes the graph pane and timeline track should actually show: the
  // selection, minus rules while hideRules is on. Rules are contracted, not
  // removed from the underlying selection - see graph.ts's inducedEdges().
  get visibleNodes(): readonly GraphNode[] {
    const nodes = this.selectedNodes;
    return this.hideRulesFlag ? nodes.filter((n) => n.kind !== 'rule') : nodes;
  }

  // Registers the "Dune graph" timeline track and creates the dedicated
  // workspace it lives in. Called once from index.ts's onTraceLoad(); the
  // workspace + track stay live for the lifetime of the trace, so showing the
  // timeline is just a switchWorkspace() away (see showTimeline()).
  installTimeline(): void {
    this.trace.tracks.registerTrack({
      uri: GRAPH_TRACK_URI,
      renderer: createGraphTrackRenderer(this.trace, this),
    });
    const ws = this.trace.workspaces.createEmptyWorkspace(
      TIMELINE_WORKSPACE_NAME,
    );
    ws.addChildLast(
      new TrackNode({uri: GRAPH_TRACK_URI, name: GRAPH_TRACK_NAME}),
    );
    this.timelineWorkspace = ws;

    // Poll for workspace switches (there's no event for it - see
    // lastWorkspace's comment) so the selection can follow across them. Any
    // switchWorkspace()/removeWorkspace() call site is inside a mithril click
    // handler or command callback, which already triggers a redraw next
    // frame, so this fires within one frame of every real transition -
    // same mechanism core panels use for their own per-frame hooks (e.g.
    // dev.perfetto.Timeline's minimap).
    this.lastWorkspace = this.trace.currentWorkspace;
    this.trace.trash.use(
      this.trace.raf.addCanvasRedrawCallback(() => this.onFrame()),
    );
  }

  private onFrame(): void {
    const current = this.trace.currentWorkspace;
    if (current === this.lastWorkspace) return;
    const previous = this.lastWorkspace;
    this.lastWorkspace = current;
    if (previous !== undefined) this.onWorkspaceChanged(previous);
  }

  // Keeps a "build-dep"/"exec-rule" selection visible across a workspace
  // switch, mirroring goToNode()'s two branches: entering the Dune workspace
  // re-points the selection at the derived track (only if the node is
  // actually rendered there - see visibleNodes()); leaving it resolves back
  // to the node's real originating track. A selection that isn't currently on
  // the relevant track is left untouched - it needs no fixing.
  private onWorkspaceChanged(previous: Workspace): void {
    const selection = this.trace.selection.selection;
    if (selection.kind !== 'track_event') return;

    if (this.showingTimeline) {
      const node = this.nodeForSliceId(selection.eventId);
      const isVisible =
        node !== undefined &&
        this.visibleNodes.some(
          (n) => nodeKey(n.kind, n.id) === nodeKey(node.kind, node.id),
        );
      if (isVisible) this.selectOnGraphTrack(node.sliceId);
    } else if (previous === this.timelineWorkspace) {
      if (selection.trackUri === GRAPH_TRACK_URI) {
        void this.selectOnOriginalTrack(selection.eventId);
      }
    }
  }

  // Switch the timeline to the dedicated "Dune graph" workspace. Getting back
  // to the default workspace is the core workspace switcher's job - this is a
  // one-way action, not a toggle.
  showTimeline(): void {
    if (this.timelineWorkspace === undefined) return;
    this.trace.workspaces.switchWorkspace(this.timelineWorkspace);
  }

  // Whether the timeline is currently showing the "Dune graph" workspace. Not
  // used for button state (showTimeline() is a plain action) - only so
  // goToNode() knows whether to select on the derived track or resolve the
  // node's original track.
  private get showingTimeline(): boolean {
    return this.trace.currentWorkspace === this.timelineWorkspace;
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
    this.version++;
  }

  // Remove nodes from the graph selection.
  removeFromGraph(nodes: Iterable<GraphNode>): void {
    for (const node of nodes) {
      this.selection.delete(nodeKey(node.kind, node.id));
    }
    this.version++;
  }

  // Remove every node from the graph selection.
  clearGraph(): void {
    this.selection.clear();
    this.version++;
  }

  // Whether a node is currently in the graph selection.
  isInGraph(node: GraphNode): boolean {
    return this.selection.has(nodeKey(node.kind, node.id));
  }

  // The graph node a "build-dep"/"exec-rule" slice id maps to, if any.
  nodeForSliceId(sliceId: number): GraphNode | undefined {
    return this.graph.bySliceId.get(sliceId);
  }

  // The dense SQL `node_id` for a node - the value the `dune_*` relation
  // functions (`dune_descendants`, `dune_ancestors`, `dune_children`,
  // `dune_parents`, `dune_forcers`, `dune_forced`, see sql_graph.ts) take - or
  // undefined if the SQL mirror isn't built yet (still loading / failed).
  nodeIdOf(node: GraphNode): number | undefined {
    return this.sqlGraph?.nodeId(node);
  }

  // Parents/ancestors are walked in-memory over the reverse index; children/
  // descendants forward over the graph directly (no index needed); forcers
  // walk the single-parent `forcedBy` chain. The same relations could be
  // computed in SQL via `dune_parents`/`dune_all_ancestors`/`dune_children`/
  // `dune_all_descendants`/`dune_forcers` over the `dune_edge` table (the
  // mirror `distances()` already uses `graph_reachable_bfs!` similarly).
  // TODO(nat): once testing on larger traces, compare the two - if the reverse
  // BFS gets slow in-memory, switch to the SQL path (needs a node_id ->
  // GraphNode reverse map and makes the callers async).
  //
  // Nodes that directly depend on `node` (its immediate parents).
  parentsOf(node: GraphNode): readonly GraphNode[] {
    return directParents(this.reverse(), node);
  }

  // Nodes `node` directly depends on (its immediate children).
  childrenOf(node: GraphNode): readonly GraphNode[] {
    return [...outEdges(this.graph, node)];
  }

  // All nodes that transitively depend on `node` (its ancestors).
  ancestorsOf(node: GraphNode): readonly GraphNode[] {
    return ancestors(this.reverse(), node);
  }

  // All nodes `node` transitively depends on (its descendants).
  descendantsOf(node: GraphNode): readonly GraphNode[] {
    return descendants(this.graph, node);
  }

  // The chain of nodes that transitively forced `node` into the build.
  forcersOf(node: GraphNode): readonly GraphNode[] {
    return forcers(this.graph, node);
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
    // While the timeline is showing the "Dune graph" workspace, the node's
    // original track isn't present there - resolveSqlEvents would resolve it
    // anyway (it isn't scoped to the current workspace) and both reveal() and
    // the scroll would silently no-op. Select directly on the derived track
    // instead, as long as the node is actually rendered on it. Compared by key
    // (not reference) to match how the rest of the plugin dedups nodes.
    const isVisible = this.visibleNodes.some(
      (n) => nodeKey(n.kind, n.id) === nodeKey(node.kind, node.id),
    );
    if (this.showingTimeline && isVisible) {
      this.selectOnGraphTrack(node.sliceId);
      return;
    }
    await this.selectOnOriginalTrack(node.sliceId);
  }

  // Select `sliceId` on the derived "Dune graph" track - the half of
  // goToNode()/onWorkspaceChanged() used while that workspace is current.
  // Callers must ensure the id is actually rendered there (see visibleNodes()).
  private selectOnGraphTrack(sliceId: number): void {
    this.trace.currentWorkspace.getTrackByUri(GRAPH_TRACK_URI)?.reveal();
    this.trace.selection.selectTrackEvent(GRAPH_TRACK_URI, sliceId, {
      scrollToSelection: true,
    });
  }

  // Resolve `sliceId` back to whatever real track it originated from and
  // select it there - the half of goToNode()/onWorkspaceChanged() used
  // outside the "Dune graph" workspace.
  private async selectOnOriginalTrack(sliceId: number): Promise<void> {
    const match = (
      await this.trace.selection.resolveSqlEvents('slice', [sliceId])
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
    this.version++;
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
