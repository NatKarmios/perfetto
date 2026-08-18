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
import type {
  BuildGraph,
  GraphSource,
  GraphStats,
  NodeId,
  NodeTiming,
} from './graph';
import {
  ancestors,
  descendants,
  directParents,
  EMPTY_GRAPH,
  forcers,
  ReverseIndex,
  spanSliceId,
} from './graph';
import {lifecycleKeysForSliceIds} from './lifecycle_sql';
import {
  createGraphTrackRenderer,
  GRAPH_TRACK_NAME,
  GRAPH_TRACK_URI,
} from './graph_track';
import {TraceGraphSource} from './trace_graph_source';
import {measure, PerfRun} from './perf';
import type {Distances, SqlEdgeMirror, SqlNodeMirror} from './sql_graph';
import {
  EDGE_HARD_LIMIT,
  EDGE_SOFT_LIMIT,
  buildEdgeMirror,
  buildNodeMirror,
} from './sql_graph';

const TIMELINE_WORKSPACE_NAME = 'Dune graph';

/**
 * Estimated-edge count below which the graph loads itself as soon as the trace
 * opens, rather than waiting for the user to ask (see {@link
 * DuneGraphController.init}). Above it, opening a trace costs nothing and the
 * side panel shows what a load would involve instead.
 *
 * The estimate comes from the blob's byte size, not from a parse (see
 * `GraphStats.estimatedEdges`), so it's available before any expensive work
 * has happened. It's the same number as the edge tier's own soft limit, and for
 * the same reason: the edge tier is what makes a load expensive, so a graph
 * small enough to mirror its edges without being asked is exactly one small
 * enough to load without being asked.
 */
const AUTO_LOAD_EDGE_LIMIT = EDGE_SOFT_LIMIT;

// How many slice ids `nodesForSliceIds` resolves per query.
const SLICE_LOOKUP_BATCH = 5_000;

// State of one load step. Steps are independent: the graph can be loaded while
// the edge mirror isn't built, and either mirror can fail on its own.
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * One step of the load, as the side panel sees it. `label` names the step in
 * the UI; `error` is set only in the `error` status; `detail` is where the step
 * has got to while it runs (the SQL tiers report their insert progress through
 * it - see sql_graph.ts's `MirrorOptions.onProgress`).
 */
export class LoadStep {
  status: LoadStatus = 'idle';
  error?: string;
  detail?: string;

  constructor(readonly label: string) {}

  get ready(): boolean {
    return this.status === 'ready';
  }

  get busy(): boolean {
    return this.status === 'loading';
  }

  reset(): void {
    this.status = 'idle';
    this.error = undefined;
    this.detail = undefined;
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Holds the extracted build graph plus the active source, and knows how to
 * (re)load it. The sidebar panel reads state directly off this each render.
 *
 * **Loading is explicit and staged.** Nothing loads when the trace opens (see
 * `init()`): on a monorepo-scale trace the load is minutes long and would
 * hold up the whole UI, so the plugin's work is off the critical path and the
 * side panel offers it as an action instead. The work splits into three steps,
 * cheapest first, each separately reported and separately re-runnable:
 *
 * 1. `loadGraph()` - blob -> the in-memory {@link BuildGraph}.
 * 2. `buildNodeMirror()` - the cheap SQL tier (`dune_node` + detail).
 * 3. `buildEdgeMirror()` - the expensive SQL tier (`dune_edge` + the relation
 *    functions), one row per edge. Only step 3 is *not* part of `load()` on a
 *    large graph: past {@link EDGE_SOFT_LIMIT} edges it has to be asked for by
 *    name, and past {@link EDGE_HARD_LIMIT} it refuses (see
 *    {@link DuneGraphController.edgeTierIsCheap} / {@link DuneGraphController.edgeTierRefused}).
 *
 * Each step is idempotent (already-`ready` is a no-op) and pulls in the steps
 * it depends on, so any of them can be called from cold. They all run through
 * one queue - they mutate the same SQL table names, so two must never overlap -
 * and a `reload()` bumps a generation counter that drops whatever was
 * queued behind it rather than letting it rebuild on top of fresh state.
 */
export class DuneGraphController {
  private source: GraphSource;
  // Mirror of `graph` materialized as SQL tables, in two tiers (see
  // sql_graph.ts). The edge tier reads the node tier's tables, so it is always
  // built after - and dropped before - the node tier.
  private nodeMirror?: SqlNodeMirror;
  private edgeMirror?: SqlEdgeMirror;

  // The load steps, in dependency order. Public so the panel can render each
  // one's status/error individually.
  readonly graphStep = new LoadStep('Graph');
  readonly nodeMirrorStep = new LoadStep('Node tables');
  readonly edgeMirrorStep = new LoadStep('Edge tables');
  // The cheap headline counts shown before (and instead of) a load.
  readonly statsStep = new LoadStep('Trace stats');
  private statsValue?: GraphStats;
  private statsPending?: Promise<void>;

  // Bumped by reload() so work queued against the previous graph is dropped
  // instead of running against the new one.
  private generation = 0;
  // Serializes every load step; see the class comment.
  private queue: Promise<unknown> = Promise.resolve();

  graph: BuildGraph = EMPTY_GRAPH;

  // The nodes chosen to appear in the rendered graph, in the order they were
  // added (which is the order the graph pane lays them out within a row). The
  // graph area renders whatever is in here.
  private readonly selection = new Set<NodeId>();
  // Reverse adjacency (dependants), built lazily and dropped on reload.
  private reverseIndex?: ReverseIndex;

  // The current timeline selection's node, cached against the selection it was
  // resolved for - see nodeForSelection(), which has to answer synchronously
  // while the lookup itself is a query. Cleared whenever the graph changes.
  private selectionNode?: {readonly key: string; readonly node?: NodeId};

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
  get visibleNodes(): readonly NodeId[] {
    const nodes = this.selectedNodes;
    return this.hideRulesFlag
      ? nodes.filter((id) => !this.graph.isRule(id))
      : nodes;
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
    if (previous !== undefined) void this.onWorkspaceChanged(previous);
  }

  // Keeps a "build-dep"/"exec-rule" selection visible across a workspace
  // switch, mirroring goToNode()'s two branches: entering the Dune workspace
  // re-points the selection at the derived track (only if the node is
  // actually rendered there - see visibleNodes()); leaving it resolves back
  // to the node's real originating track. A selection that isn't currently on
  // the relevant track is left untouched - it needs no fixing.
  private async onWorkspaceChanged(previous: Workspace): Promise<void> {
    const selection = this.trace.selection.selection;
    if (selection.kind !== 'track_event') return;

    if (this.showingTimeline) {
      const node = await this.nodeForSliceId(selection.eventId);
      // The derived track has no rows at all until the node mirror is built, so
      // there'd be nothing to select on it.
      if (
        node !== undefined &&
        this.nodeMirrorReady &&
        this.visibleNodes.includes(node)
      ) {
        this.selectOnGraphTrack(node);
      }
    } else if (previous === this.timelineWorkspace) {
      if (selection.trackUri === GRAPH_TRACK_URI) {
        // The derived track's event id is a `node_id`, not a slice id.
        const node = this.nodeForNodeId(selection.eventId);
        const sliceId =
          node === undefined ? undefined : await this.sliceIdOf(node);
        if (sliceId !== undefined) await this.selectOnOriginalTrack(sliceId);
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

  /**
   * The node corresponding to the current timeline selection, if a "build-dep"
   * or "exec-rule" slice is selected - or, on the derived "Dune graph" track, if
   * a node's projected interval is selected. The two tracks key their events
   * differently (a real slice id vs. the SQL mirror's `node_id`), so this
   * branches on which track the selection is on.
   *
   * Stays synchronous - it's read from a mithril view on every frame - but a
   * real slice id now resolves through SQL (see `nodesForSliceIds`), so the
   * answer for a *new* selection arrives one redraw later: the lookup is kicked
   * off here, cached against the selection it was for, and a redraw requested
   * when it lands. A stale result can therefore never be shown, only a
   * momentary "no node".
   */
  nodeForSelection(): NodeId | undefined {
    const selection = this.trace.selection.selection;
    if (selection.kind !== 'track_event') {
      this.selectionNode = undefined;
      return undefined;
    }
    if (selection.trackUri === GRAPH_TRACK_URI) {
      return this.nodeForNodeId(selection.eventId);
    }
    const key = `${selection.trackUri}#${selection.eventId}`;
    if (this.selectionNode?.key === key) return this.selectionNode.node;
    // Recorded before the lookup starts, so a second frame doesn't re-issue it.
    this.selectionNode = {key};
    void this.resolveSelectionNode(key, selection.eventId);
    return undefined;
  }

  private async resolveSelectionNode(
    key: string,
    sliceId: number,
  ): Promise<void> {
    const node = await this.nodeForSliceId(sliceId);
    if (this.selectionNode?.key !== key) return; // superseded meanwhile
    this.selectionNode = {key, node};
    this.changed();
  }

  // Nodes currently chosen for the graph.
  get selectedNodes(): readonly NodeId[] {
    return [...this.selection];
  }

  // Add nodes to the graph selection.
  addToGraph(nodes: Iterable<NodeId>): void {
    for (const node of nodes) this.selection.add(node);
    this.version++;
  }

  // Remove nodes from the graph selection.
  removeFromGraph(nodes: Iterable<NodeId>): void {
    for (const node of nodes) this.selection.delete(node);
    this.version++;
  }

  // Remove every node from the graph selection.
  clearGraph(): void {
    this.selection.clear();
    this.version++;
  }

  // Whether a node is currently in the graph selection.
  isInGraph(node: NodeId): boolean {
    return this.selection.has(node);
  }

  // The graph node a "build-dep"/"exec-rule" slice id maps to, if any.
  async nodeForSliceId(sliceId: number): Promise<NodeId | undefined> {
    return (await this.nodesForSliceIds([sliceId])).get(sliceId);
  }

  /**
   * The graph nodes a batch of lifecycle slice ids map to. This replaces the
   * ~2.4M-entry slice-id index the load used to build in JS: the slice's
   * `rule_id` / `dep_id` arg is read back from the trace on demand (see
   * `lifecycleKeysForSliceIds`) and resolved against the graph's own maps.
   *
   * Batched because the callers that need many at once (the query tab, over a
   * whole result) would otherwise issue a query per row. Ids that aren't
   * lifecycle instants, or whose node isn't in the graph, are simply absent.
   */
  async nodesForSliceIds(
    sliceIds: readonly number[],
  ): Promise<Map<number, NodeId>> {
    const nodes = new Map<number, NodeId>();
    if (sliceIds.length === 0 || !this.graphStep.ready) return nodes;
    // Each batch becomes one `IN (...)` list, and a query result is not row
    // limited, so a big result gets several queries rather than one enormous
    // statement.
    for (let i = 0; i < sliceIds.length; i += SLICE_LOOKUP_BATCH) {
      const keys = await lifecycleKeysForSliceIds(
        this.trace.engine,
        sliceIds.slice(i, i + SLICE_LOOKUP_BATCH),
      );
      for (const [sliceId, {kind, key}] of keys) {
        // 'rule' and 'action' instants both key on `rule_id`, so both resolve
        // to the rule node; only 'dep' keys on a dict id.
        const node =
          kind === 'dep'
            ? this.graph.nodeForDepId(key)
            : this.graph.nodeForRuleId(key);
        if (node !== undefined) nodes.set(sliceId, node);
      }
    }
    return nodes;
  }

  /**
   * The node's lifecycle timing (its own span, plus a rule's action span),
   * looked up on demand - timing lives in SQL rather than on the node since the
   * perf plan's stage 2. Empty until the node mirror is built, which is what
   * owns the timing table (see sql_graph.ts).
   */
  async timingFor(node: NodeId): Promise<NodeTiming> {
    return (await this.nodeMirror?.timingFor(node)) ?? {};
  }

  // The lifecycle slice a node's "go to slice" should land on - its span's
  // start, or its finish if only that resolved.
  async sliceIdOf(node: NodeId): Promise<number | undefined> {
    return spanSliceId((await this.timingFor(node)).timing);
  }

  // The graph node a `node_id` from outside names - the derived "Dune graph"
  // track's event id (see graph_track.ts), a `dune_node.node_id` a query
  // returned - or undefined if it isn't a node of the current graph. The SQL
  // mirror's ids are the graph's own (see sql_graph.ts), so this is a range
  // check rather than a lookup.
  nodeForNodeId(nodeId: number): NodeId | undefined {
    return this.graph.has(nodeId) ? nodeId : undefined;
  }

  // Whether the cheap SQL tier (`dune_node` and the per-kind detail tables) is
  // queryable right now. Anything that puts those table names into SQL has to
  // check first - they simply don't exist until the mirror is built (see
  // graph_track.ts, query_tab.ts).
  get nodeMirrorReady(): boolean {
    return this.nodeMirror !== undefined;
  }

  // Whether the expensive SQL tier (`dune_edge` + the relation functions) is
  // queryable right now.
  get edgeMirrorReady(): boolean {
    return this.edgeMirror !== undefined;
  }

  // ---------------------------------------------------------------------
  // What the edge tier would cost, so the panel can explain itself before
  // anyone pays for it. All of these are meaningless until the graph is
  // loaded - the edge count comes from the graph, not from an estimate.
  // ---------------------------------------------------------------------

  // How many dependency edges the edge tier would mirror. A slight over-count:
  // it includes references to nodes the blob never recorded, which are dropped
  // on the way into SQL.
  get edgeCount(): number {
    return this.graph.edgeCount;
  }

  // Whether the edge tier is small enough to build as part of a plain load
  // rather than only when explicitly asked for.
  get edgeTierIsCheap(): boolean {
    return this.graphStep.ready && this.edgeCount <= EDGE_SOFT_LIMIT;
  }

  // Whether the edge tier is so large that building it would take the trace
  // processor down - in which case asking for it refuses instead (see
  // sql_graph.ts's EDGE_HARD_LIMIT).
  get edgeTierRefused(): boolean {
    return this.graphStep.ready && this.edgeCount > EDGE_HARD_LIMIT;
  }

  get edgeHardLimit(): number {
    return EDGE_HARD_LIMIT;
  }

  // Whether the built edge tier indexes `dst`, i.e. whether `dune_ancestors` /
  // `dune_parents` can look an edge up rather than scanning for it. False on a
  // graph too big to afford the index; the unbounded `dune_all_ancestors` is
  // the fast answer there (see sql_graph.ts's REVERSE_INDEX_EDGE_LIMIT).
  get reverseWalksIndexed(): boolean {
    return this.edgeMirror?.reverseIndexed ?? false;
  }

  // Parents/ancestors are walked in-memory over the reverse index; children/
  // descendants forward over the graph's own CSR (no index needed); forcers
  // walk the single-parent `forcedBy` chain. The same relations could be
  // computed in SQL via `dune_parents`/`dune_all_ancestors`/`dune_children`/
  // `dune_all_descendants`/`dune_forcers` over the `dune_edge` table (the
  // mirror `distances()` already uses `graph_reachable_bfs!` similarly) - now
  // that node ids are shared, that's a pure swap, but it costs the opt-in edge
  // tier and makes every caller async, so the in-memory walk stays the default.
  //
  // Nodes that directly depend on `node` (its immediate parents).
  parentsOf(node: NodeId): readonly NodeId[] {
    return directParents(this.reverse(), node);
  }

  // Nodes `node` directly depends on (its immediate children).
  childrenOf(node: NodeId): readonly NodeId[] {
    return this.graph.outTargets(node);
  }

  // All nodes that transitively depend on `node` (its ancestors).
  ancestorsOf(node: NodeId): readonly NodeId[] {
    return ancestors(this.reverse(), node);
  }

  // All nodes `node` transitively depends on (its descendants).
  descendantsOf(node: NodeId): readonly NodeId[] {
    return descendants(this.graph, node);
  }

  // The chain of nodes that transitively forced `node` into the build.
  forcersOf(node: NodeId): readonly NodeId[] {
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
  async goToNode(node: NodeId): Promise<void> {
    // While the timeline is showing the "Dune graph" workspace, the node's
    // original track isn't present there - resolveSqlEvents would resolve it
    // anyway (it isn't scoped to the current workspace) and both reveal() and
    // the scroll would silently no-op. Select directly on the derived track
    // instead, as long as the node is actually rendered on it.
    if (
      this.showingTimeline &&
      this.nodeMirrorReady &&
      this.visibleNodes.includes(node)
    ) {
      this.selectOnGraphTrack(node);
      return;
    }
    const sliceId = await this.sliceIdOf(node);
    if (sliceId !== undefined) await this.selectOnOriginalTrack(sliceId);
  }

  // Select `nodeId` on the derived "Dune graph" track - the half of
  // goToNode()/onWorkspaceChanged() used while that workspace is current. The
  // track's rows are keyed by the SQL mirror's `node_id` (see graph_track.ts),
  // not a slice id. Callers must ensure the id is actually rendered there (see
  // visibleNodes()).
  private selectOnGraphTrack(nodeId: number): void {
    this.trace.currentWorkspace.getTrackByUri(GRAPH_TRACK_URI)?.reveal();
    this.trace.selection.selectTrackEvent(GRAPH_TRACK_URI, nodeId, {
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

  // The reverse-edge index for the current graph, built on first use. Its own
  // PerfRun, since it's built when a panel first asks for dependants rather
  // than during a load - so it doesn't belong to any load's breakdown, but on a
  // large graph it's still 100+ MB and worth a line in the console.
  private reverse(): ReverseIndex {
    if (this.reverseIndex === undefined) {
      const perf = new PerfRun('dune graph: reverse index');
      try {
        this.reverseIndex = ReverseIndex.build(this.graph, perf);
      } finally {
        perf.finish();
      }
    }
    return this.reverseIndex;
  }

  // The single seam to swap while experimenting with where the graph comes
  // from - everything else only sees the GraphSource contract.
  private makeSource(): GraphSource {
    return new TraceGraphSource(this.trace.engine);
  }

  // Directed dependency distances between two nodes (see {@link Distances}), or
  // undefined if either node is unknown, the edge mirror isn't built, or `to`
  // is unreachable from `from`.
  async distances(from: NodeId, to: NodeId): Promise<Distances | undefined> {
    const edgeMirror = this.edgeMirror;
    if (edgeMirror === undefined) return undefined;
    if (!this.graph.has(from) || !this.graph.has(to)) return undefined;
    return edgeMirror.distances(from, to);
  }

  // ---------------------------------------------------------------------
  // Loading. See the class comment for the staging rules.
  // ---------------------------------------------------------------------

  /**
   * Called once when the trace opens. Deliberately does no graph work on the
   * critical path: it reads only the cheap headline counts (see `stats`),
   * and auto-starts a full load when the trace is small enough that waiting to
   * be asked would just be an extra click.
   */
  async init(): Promise<void> {
    await this.loadStats();
    if (this.autoLoads) await this.load();
  }

  // The trace's headline graph counts, or undefined until they've been read
  // (see statsStep for why, if they're missing).
  get stats(): GraphStats | undefined {
    return this.statsValue;
  }

  // Whether a load of this trace would start by itself (see
  // AUTO_LOAD_EDGE_LIMIT). False until the stats are in.
  get autoLoads(): boolean {
    return (
      this.statsValue !== undefined &&
      this.statsValue.estimatedEdges <= AUTO_LOAD_EDGE_LIMIT
    );
  }

  // The point past which a load isn't started unprompted, so the panel can
  // explain the decision in the same units the estimate is in.
  get autoLoadEdgeLimit(): number {
    return AUTO_LOAD_EDGE_LIMIT;
  }

  // Whether any load step is currently running.
  get busy(): boolean {
    return (
      this.statsStep.busy ||
      this.graphStep.busy ||
      this.nodeMirrorStep.busy ||
      this.edgeMirrorStep.busy
    );
  }

  // Reads the cheap headline counts. Idempotent, and shared by concurrent
  // callers - the panel renders them, and init() decides whether to auto-load
  // from them.
  loadStats(): Promise<void> {
    if (this.statsStep.ready) return Promise.resolve();
    return (this.statsPending ??= (async () => {
      this.statsStep.status = 'loading';
      this.statsStep.error = undefined;
      this.changed();
      try {
        this.statsValue = await this.source.stats();
        this.statsStep.status = 'ready';
      } catch (e) {
        this.statsStep.status = 'error';
        this.statsStep.error = errorMessage(e);
      } finally {
        this.statsPending = undefined;
        this.changed();
      }
    })());
  }

  /**
   * The whole load: the graph, then the node tier, then - only when it's cheap
   * (see {@link DuneGraphController.edgeTierIsCheap}) - the edge tier. What the panel's "Load
   * graph" button runs. Steps that are already done are skipped, so this
   * doubles as "finish whatever is missing".
   *
   * The edge tier is one SQL row per *edge*, tens of millions of them on a
   * monorepo-scale trace, so past the soft limit it is not part of a load at
   * all: it has to be asked for by name (see {@link DuneGraphController.buildEdgeMirror}), and the
   * panel says so. Everything except `dune_edge` and the relation functions
   * works without it.
   */
  load(): Promise<void> {
    return this.run('dune graph: load', async (perf) => {
      await this.doLoadGraph(perf);
      await this.doBuildNodeMirror(perf);
      if (this.edgeTierIsCheap) await this.doBuildEdgeMirror(perf);
    });
  }

  // Step 1: blob -> in-memory graph. Everything else depends on this.
  loadGraph(): Promise<void> {
    return this.run('dune graph: load graph', (perf) => this.doLoadGraph(perf));
  }

  // Step 2: the cheap SQL tier. Loads the graph first if it isn't loaded.
  buildNodeMirror(): Promise<void> {
    return this.run('dune graph: build node mirror', async (perf) => {
      await this.doLoadGraph(perf);
      await this.doBuildNodeMirror(perf);
    });
  }

  // Step 3: the expensive SQL tier. Pulls in steps 1 and 2 if needed.
  buildEdgeMirror(): Promise<void> {
    return this.run('dune graph: build edge mirror', async (perf) => {
      await this.doLoadGraph(perf);
      await this.doBuildNodeMirror(perf);
      await this.doBuildEdgeMirror(perf);
    });
  }

  /**
   * Throw away everything loaded so far and load it again from the trace.
   * Anything queued behind this (an in-flight step's continuation, a second
   * click on "Load graph") is dropped rather than run against the new state.
   */
  reload(): Promise<void> {
    this.generation++;
    return this.run('dune graph: reload', async (perf) => {
      await measure(perf, 'drop previous mirror', () => this.dropLoaded());
      await this.doLoadGraph(perf);
      await this.doBuildNodeMirror(perf);
      if (this.edgeTierIsCheap) await this.doBuildEdgeMirror(perf);
    });
  }

  // Runs `fn` as one measured, serialized unit of load work. Loading is the
  // plugin's whole performance story (see PERF_PLAN.LOCAL.md), so every one of
  // these is measured: `perf` collects a per-phase breakdown and prints it when
  // the work ends - including when it fails, so a failed load still shows where
  // it got to - and `Dune: dump load stats` re-prints the last few runs (see
  // perf.ts).
  private run(
    label: string,
    fn: (perf: PerfRun) => Promise<void>,
  ): Promise<void> {
    const generation = this.generation;
    const task = async () => {
      // Superseded by a reload() while queued: the state this was going to
      // build on is gone, and the reload rebuilds it anyway.
      if (generation !== this.generation) return;
      const perf = new PerfRun(label);
      try {
        await fn(perf);
      } catch (e) {
        // The step bodies record their own failures, so reaching here means
        // something outside them broke (a failed DROP on reload, say). Nothing
        // in the UI owns that message; keep it out of the caller's face - these
        // are called from `void`-ed click handlers - but don't swallow it.
        const message = errorMessage(e);
        perf.fail(message);
        console.error(`${label} failed:`, e);
      } finally {
        perf.finish();
        this.changed();
      }
    };
    const next = this.queue.then(task, task);
    // Keep the queue itself unrejectable, so one failed step doesn't wedge
    // every later one. Each step records its own failure in its LoadStep.
    this.queue = next.catch(() => {});
    return next;
  }

  // Step bodies. Each is a no-op once its step is `ready`, and each records its
  // own failure rather than throwing, so a later step can decide for itself
  // whether its prerequisite is there.
  private async doLoadGraph(perf: PerfRun): Promise<void> {
    if (this.graphStep.ready) return;
    this.beginStep(this.graphStep);
    try {
      this.graph = await this.source.load(perf);
      // The node set changed: drop the derived index and the cached selection
      // so neither can outlive the nodes it refers to.
      this.reverseIndex = undefined;
      this.selectionNode = undefined;
      this.version++;
      this.graphStep.status = 'ready';
    } catch (e) {
      this.failStep(this.graphStep, perf, e);
      this.graph = EMPTY_GRAPH;
    }
    this.changed();
  }

  private async doBuildNodeMirror(perf: PerfRun): Promise<void> {
    if (this.nodeMirrorStep.ready || !this.graphStep.ready) return;
    this.beginStep(this.nodeMirrorStep);
    try {
      this.nodeMirror = await buildNodeMirror(this.trace.engine, this.graph, {
        perf,
        onProgress: this.progressFor(this.nodeMirrorStep),
      });
      this.completeStep(this.nodeMirrorStep);
      // The timeline track's dataset is empty until the mirror exists, so it
      // has to be told to re-query now that it does.
      this.version++;
    } catch (e) {
      this.failStep(this.nodeMirrorStep, perf, e);
    }
    this.changed();
  }

  private async doBuildEdgeMirror(perf: PerfRun): Promise<void> {
    if (this.edgeMirrorStep.ready || !this.nodeMirrorStep.ready) return;
    const nodeMirror = this.nodeMirror;
    if (nodeMirror === undefined) return;
    this.beginStep(this.edgeMirrorStep);
    try {
      this.edgeMirror = await buildEdgeMirror(
        this.trace.engine,
        this.graph,
        nodeMirror,
        {perf, onProgress: this.progressFor(this.edgeMirrorStep)},
      );
      this.completeStep(this.edgeMirrorStep);
    } catch (e) {
      this.failStep(this.edgeMirrorStep, perf, e);
    }
    this.changed();
  }

  private beginStep(step: LoadStep): void {
    step.status = 'loading';
    step.error = undefined;
    step.detail = undefined;
    this.changed();
  }

  private completeStep(step: LoadStep): void {
    step.status = 'ready';
    step.detail = undefined;
  }

  // A step's progress sink. The inserts yield to the event loop before each
  // report (see sql_graph.ts), so asking for a redraw here actually paints one.
  private progressFor(step: LoadStep): (detail: string) => void {
    return (detail: string) => {
      step.detail = detail;
      this.changed();
    };
  }

  private failStep(step: LoadStep, perf: PerfRun, e: unknown): void {
    step.status = 'error';
    step.error = errorMessage(e);
    step.detail = undefined;
    perf.fail(`${step.label}: ${step.error}`);
  }

  // Drops everything a load built, in reverse dependency order: the edge tier's
  // view and relation functions read the node tier's tables (see sql_graph.ts),
  // so it has to go first.
  private async dropLoaded(): Promise<void> {
    await this.edgeMirror?.[Symbol.asyncDispose]();
    this.edgeMirror = undefined;
    await this.nodeMirror?.[Symbol.asyncDispose]();
    this.nodeMirror = undefined;
    this.graph = EMPTY_GRAPH;
    // The nodes these refer to are gone.
    this.selection.clear();
    this.reverseIndex = undefined;
    this.selectionNode = undefined;
    this.graphStep.reset();
    this.nodeMirrorStep.reset();
    this.edgeMirrorStep.reset();
    this.version++;
    this.changed();
  }

  // Ask for a redraw. Panels poll this controller rather than being pushed to,
  // so anything that resolves between frames - a load step finishing, or one of
  // the on-demand SQL lookups above - has to say so.
  requestRedraw(): void {
    this.changed();
  }

  // Load state is polled by the panel rather than pushed, so a transition that
  // happens between frames needs to ask for one.
  private changed(): void {
    this.trace.raf.scheduleFullRedraw();
  }
}
