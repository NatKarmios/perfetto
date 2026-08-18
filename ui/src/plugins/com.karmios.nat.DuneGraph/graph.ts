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
 * The build graph: a columnar store plus the walks over it.
 *
 * The graph has two kinds of node, both sourced from the trace's graph blob
 * (structure) and lifecycle instants (timing) - see `graph_blob.ts`,
 * `trace_graph_source.ts` and `lifecycle_sql.ts`:
 *
 * - `dep` nodes come from `graph-deps` blob records / `build-dep` instants. A
 *   dep resolves either to a rule, or to a set of further deps (an expansion),
 *   or is a source file, or is unfinished.
 * - `rule` nodes come from `graph-rules` blob records / `exec-rule` instants,
 *   which carry the rule's static deps and dynamic deps (a list of stages).
 *
 * **Every node is a dense integer {@link NodeId}**, rules in `[0, ruleCount)`
 * and deps in `[ruleCount, nodeCount)`, so a node's kind is a comparison and the
 * SQL mirror's `node_id` (see sql_graph.ts) is the same number - no maps in
 * either direction. Trace-side ids (a dep's `graph-dict` id, a rule's `rule_id`)
 * are kept as columns and indexed back to node ids by {@link IntIndex}.
 *
 * **Everything about a node lives in a typed-array column, and its edges live in
 * one CSR** (`edgeOffset` + `edgeTarget`); a {@link GraphNode} is a *view*,
 * materialised on demand for the handful of nodes a panel is actually showing.
 * The monorepo trace of the perf plan's baseline holds ~820k nodes and ~28.8M
 * edges: as objects-with-arrays that was multiple GB and never finished loading,
 * and as columns it is ~155 MB of typed arrays (plus the ~62 MB intern table),
 * built in 3.7 s (see PERF_PLAN.LOCAL.md, stage 3).
 *
 * Consequently the walks below (`descendants`, `ancestors`, `inducedEdges`, …)
 * take and return node ids, not nodes, and only the call sites that render
 * something materialise a view.
 */

import {IntIndex, Int32Vector} from './columns';
import type {RuleOutcome, StringTable} from './graph_blob';
import {EMPTY_STRING_TABLE} from './graph_blob';
import type {PerfRun} from './perf';

// A node's identity: its index in the dense node-id space (see the file header).
export type NodeId = number;

export type NodeKind = 'dep' | 'rule';

// Re-exported so callers of graph.ts don't also need to import graph_blob.ts
// for the node-facing outcome type.
export type {RuleOutcome, StringTable} from './graph_blob';

// A dep's resolution, as a short discriminator. `unfinished` doubles as the
// fallback for a dep with no resolution recorded - shouldn't happen given a
// well-formed blob, but a safe default rather than an invented fifth state.
export type DepResolutionKind = 'rule' | 'source' | 'expanded' | 'unfinished';

// Why a node was built - the `forced_by` field of its blob record. See
// {@link isForcedEdge} for how this drives forced edges, and
// `node_display.ts:forcedByText` for the display phrasing of each kind.
export type ForcedByKind =
  | 'RULE'
  | 'DEP'
  | 'DYNAMIC_INCLUDES'
  | 'GEN_RULES'
  | 'PFORM'
  | 'CONFIGURATOR'
  | 'REQUEST'
  | 'UNKNOWN';

// The stored code of an outcome / resolution / forcer kind is its index in
// these lists (`forcedByKind` is offset by one, so 0 means "not recorded").
// Order is part of the store's encoding, so only ever append.
export const RULE_OUTCOMES: readonly RuleOutcome[] = [
  'executed',
  'local-cache-hit',
  'shared-cache-hit',
  'unfinished',
];
export const DEP_RESOLUTIONS: readonly DepResolutionKind[] = [
  'rule',
  'source',
  'expanded',
  'unfinished',
];
export const FORCED_BY_KINDS: readonly ForcedByKind[] = [
  'RULE',
  'DEP',
  'DYNAMIC_INCLUDES',
  'GEN_RULES',
  'PFORM',
  'CONFIGURATOR',
  'REQUEST',
  'UNKNOWN',
];

/**
 * Every column that holds a node reference (an edge target, a forcer) encodes
 * three things in one int32:
 *
 * - a node id, `>= 0`;
 * - {@link NO_REF}, `-1`: nothing was recorded;
 * - a *dangling* reference, `<= -2`: an id the blob named but never recorded a
 *   node for, kept as `-(traceId + 2)` so the reference - and the id it names -
 *   survives for display without a node to point at.
 *
 * Dangling references are what {@link BuildGraph.outEdges}' consumers skip and
 * {@link BuildGraph.outRefs} renders as unlinked rows; they are not nodes, and
 * never reach the SQL mirror.
 */
export const NO_REF = -1;

export function dangling(traceId: number): number {
  return -traceId - 2;
}

export function danglingId(ref: number): number {
  return -ref - 2;
}

export function isDangling(ref: number): boolean {
  return ref <= -2;
}

// A span's timing, reconstructed by pairing a `-start` instant with its
// matching `-finish` (or reading a single collapsed `-resolved` instant). Since
// the perf plan's stage 2 that pairing happens entirely in SQL and a node's
// timing is looked up on demand rather than carried on the node - see
// `lifecycle_sql.ts`. `startSliceId`/`finishSliceId` are the instants to
// navigate to; `durNs` is absent for a span that never got a finish (an
// unfinished span flushed at EOF - see `RuleOutcome`/`DepResolutionKind`).
// `occurrenceCount` counts how many same-keyed spans were seen for this node
// (watch mode, or a dep built more than once) - the node's own timing is
// always the *first* occurrence, a pairing heuristic since lifecycle instants
// carry no occurrence index (see the plugin's reported schema gaps).
export interface SpanTiming {
  readonly startSliceId?: number;
  readonly finishSliceId?: number;
  readonly durNs?: number;
  readonly occurrenceCount: number;
}

/**
 * A node's timings, as looked up when the node is shown: its own span, plus -
 * for a rule - its `exec-rule-action` span. Per the dune doc the action timing
 * measures "action in flight", including scheduler queue wait: it is *not*
 * bounded by `-j` and should not be read as worker occupancy. Both are absent
 * for a node no lifecycle instant resolved to (and `actionTiming` for a rule
 * that ran no action, i.e. a cache hit).
 */
export interface NodeTiming {
  readonly timing?: SpanTiming;
  readonly actionTiming?: SpanTiming;
}

// The one slice a `SpanTiming` should navigate to - its lifecycle start, or its
// finish if no start instant resolved (shouldn't happen in practice, but a
// finish-only span is still navigable).
export function spanSliceId(timing?: SpanTiming): number | undefined {
  return timing?.startSliceId ?? timing?.finishSliceId;
}

/**
 * Why a node was built, as a view onto its `forced_by` columns: the kind, the
 * node it names (for a `RULE`/`DEP` forcer that is itself a known node), and the
 * display string for whatever it names (a rule id, a dep path, a dune-file
 * path) - absent for the payload-less kinds.
 */
export interface ForcedBy {
  readonly kind: ForcedByKind;
  readonly node?: NodeId;
  readonly target?: string;
}

// The fields every node view carries: its dense id, its trace-side id (a dict
// id / a `rule_id`), its display label, and why it was built.
interface NodeViewBase {
  readonly nodeId: NodeId;
  readonly id: number;
  readonly label: string;
  readonly forcedBy?: ForcedBy;
}

export interface DepNode extends NodeViewBase {
  readonly kind: 'dep';
  readonly resolution: DepResolutionKind;
  // The rule this dep resolved to, iff `resolution === 'rule'` and that rule is
  // itself a known node.
  readonly resolvedRule?: NodeId;
}

export interface RuleNode extends NodeViewBase {
  readonly kind: 'rule';
  // The rule's context directory (`targets` are relative to it), when recorded.
  readonly dir?: string;
  readonly outcome: RuleOutcome;
  readonly nStaticDeps: number;
  readonly nDynStages: number;
  readonly nTargets: number;
}

/**
 * A node as a panel shows it: materialised from the columns by
 * {@link BuildGraph.node}, never stored. Deliberately holds no id *lists* - a
 * rule's deps are its out-edges, walked from the graph, so materialising a view
 * stays O(1) even for a rule with thousands of them.
 */
export type GraphNode = DepNode | RuleNode;

// Why a forward edge exists, straight off the node that carries it: a rule's
// static/dynamic deps, or a dep's resolution (to a rule, or an expansion).
// Drives `dune_edge.edge_kind`/`dyn_deps_stage` in the SQL mirror.
export type EdgeKind = 'static' | 'dynamic' | 'resolved' | 'expanded';

/**
 * One of a node's outgoing edges, as stored: `target` is the prerequisite's node
 * id, or a {@link dangling} (negative) reference to an id the blob named but
 * never recorded. Yielded by {@link BuildGraph.outEdges}.
 */
export interface OutEdge {
  readonly target: number;
  readonly edgeKind: EdgeKind;
  // The dynamic-dep stage index, set iff `edgeKind === 'dynamic'`.
  readonly dynStage?: number;
}

/**
 * One of a node's outgoing edges, as a *display* row: the same edge as
 * {@link OutEdge} with everything a list needs resolved - the node it points at
 * (absent for a dangling reference), what kind of thing it names, its label, and
 * a rule's context dir. Backs the current-selection panel's Dependencies list.
 */
export interface OutRef {
  readonly node?: NodeId;
  readonly kind: NodeKind;
  readonly label: string;
  readonly dir?: string;
  readonly edgeKind: EdgeKind;
  readonly dynStage?: number;
  readonly forced: boolean;
}

// A directed build edge: `source` depends on `dest` (dest is the prerequisite).
export interface GraphEdge {
  readonly source: NodeId;
  readonly dest: NodeId;
  // Whether this is a *forced* edge (see {@link isForcedEdge}).
  readonly forced: boolean;
  // Set for a direct (one-hop) edge - i.e. every edge `edges()` yields.
  // Undefined for a contracted, multi-hop edge from `inducedEdges()`'s
  // hide-rules traversal, which has no single meaningful kind.
  readonly edgeKind?: EdgeKind;
  // The dynamic-dep stage index, set iff `edgeKind === 'dynamic'`.
  readonly dynDepsStage?: number;
}

// One of a rule's declared outputs: the target path (its `dir` joined onto the
// relative name the blob recorded), and whether it was declared as a directory.
export interface RuleTarget {
  readonly path: string;
  readonly isDir: boolean;
}

/**
 * The graph's storage, as produced by `graph_build.ts`. Every array is indexed
 * by node id, or by node id minus `ruleCount` for the dep-only columns (see the
 * file header for the id layout); ids the blob referred to but never recorded
 * are stored {@link dangling}.
 *
 * This is the store's on-the-wire shape, deliberately dumb data: all the
 * meaning is in {@link BuildGraph}'s accessors.
 */
export interface GraphColumns {
  // The blob's intern table: every path any node refers to, by dict id. Kept
  // whole rather than resolved into the columns - one string per distinct path
  // instead of one per reference (28M of them on the monorepo trace).
  readonly strings: StringTable;

  // Rules, indexed by node id.
  readonly ruleId: Int32Array;
  readonly ruleDirId: Int32Array; // dict id; -1 when not recorded
  readonly ruleOutcome: Uint8Array; // index into RULE_OUTCOMES
  readonly ruleStaticCount: Int32Array; // leading static edges of the rule's run
  readonly ruleTargetOffset: Int32Array; // ruleCount + 1, into ruleTargetId
  readonly ruleTargetFiles: Int32Array; // leading file targets of the rule's run
  readonly ruleTargetId: Int32Array; // dict ids, files then dirs per rule
  // Rule node id -> the end offset of each dynamic-dep stage, relative to the
  // start of the rule's dynamic edges. A map, not a column: dynamic deps are
  // rare (the monorepo trace has none at all), so this holds an entry only for
  // the rules that have any.
  readonly ruleDynStages: ReadonlyMap<NodeId, Int32Array>;

  // Deps, indexed by node id minus ruleCount.
  readonly depDictId: Int32Array;
  readonly depResolution: Uint8Array; // index into DEP_RESOLUTIONS

  // Every node, indexed by node id.
  readonly forcedByKind: Uint8Array; // 0 = not recorded, else FORCED_BY_KINDS + 1
  readonly forcedByPayload: Int32Array; // node id / dangling / dict id, by kind

  // Forward adjacency, CSR over the node-id space. A node's edges are
  // `edgeTarget[edgeOffset[id] .. edgeOffset[id + 1])`, ordered so the edge kind
  // follows from the position (see {@link BuildGraph.outEdges}).
  readonly edgeOffset: Int32Array; // nodeCount + 1
  readonly edgeTarget: Int32Vector;

  // Trace-side id -> node id (rules) / node id minus ruleCount (deps).
  readonly ruleIndex: IntIndex;
  readonly depIndex: IntIndex;
}

function emptyColumns(): GraphColumns {
  return {
    strings: EMPTY_STRING_TABLE,
    ruleId: new Int32Array(0),
    ruleDirId: new Int32Array(0),
    ruleOutcome: new Uint8Array(0),
    ruleStaticCount: new Int32Array(0),
    ruleTargetOffset: new Int32Array(1),
    ruleTargetFiles: new Int32Array(0),
    ruleTargetId: new Int32Array(0),
    ruleDynStages: new Map(),
    depDictId: new Int32Array(0),
    depResolution: new Uint8Array(0),
    forcedByKind: new Uint8Array(0),
    forcedByPayload: new Int32Array(0),
    edgeOffset: new Int32Array(1),
    edgeTarget: new Int32Vector(),
    ruleIndex: new IntIndex(),
    depIndex: new IntIndex(),
  };
}

/**
 * The extracted build graph: the columns plus everything that reads them.
 *
 * Nothing here is timing-shaped: a node's lifecycle timing, and the mapping from
 * a lifecycle slice id back to its node, are answered from SQL on demand (see
 * `lifecycle_sql.ts`) rather than transferred into JS with the graph - that
 * transfer alone was 2.4M rows on the perf plan's monorepo trace.
 */
export class BuildGraph {
  readonly ruleCount: number;
  readonly depCount: number;
  readonly nodeCount: number;

  constructor(private readonly cols: GraphColumns) {
    this.ruleCount = cols.ruleId.length;
    this.depCount = cols.depDictId.length;
    this.nodeCount = this.ruleCount + this.depCount;
  }

  // Whether `id` names a node of this graph. Every lookup that comes from
  // outside (a SQL row, a track event id) goes through this.
  has(id: NodeId): boolean {
    return Number.isInteger(id) && id >= 0 && id < this.nodeCount;
  }

  kindOf(id: NodeId): NodeKind {
    return id < this.ruleCount ? 'rule' : 'dep';
  }

  isRule(id: NodeId): boolean {
    return id < this.ruleCount;
  }

  // The node's trace-side id: a rule's `rule_id`, a dep's dict id. What the
  // lifecycle instants join on, and what `dune_node.orig_id` holds.
  traceIdOf(id: NodeId): number {
    return this.isRule(id)
      ? this.cols.ruleId[id]
      : this.cols.depDictId[id - this.ruleCount];
  }

  // The node a `rule_id` / a dep's dict id belongs to, or undefined if the blob
  // recorded no such node. Both are also the timing table's join keys, so this
  // is how a lifecycle slice resolves back to a node (see controller.ts).
  nodeForRuleId(ruleId: number): NodeId | undefined {
    const id = this.cols.ruleIndex.get(ruleId);
    return id < 0 ? undefined : id;
  }

  nodeForDepId(dictId: number): NodeId | undefined {
    const index = this.cols.depIndex.get(dictId);
    return index < 0 ? undefined : this.ruleCount + index;
  }

  // The path a dict id interns to. Falls back to `#<id>` for an id the blob's
  // dict doesn't hold - a malformed blob, since every referenced id should be
  // interned - so a dangling reference is visible rather than silently blank.
  path(dictId: number): string {
    return this.cols.strings.get(dictId) ?? `#${dictId}`;
  }

  // How many strings the blob interned; shown as a load statistic.
  get stringCount(): number {
    return this.cols.strings.size;
  }

  /**
   * Every string the blob interned, by dict id - what the SQL mirror's
   * `dune_string` table is built from (see sql_graph.ts). Nothing else walks
   * the whole intern table; {@link BuildGraph.path} is the per-id lookup. Pairs
   * come in ascending id order.
   */
  strings(): Iterable<readonly [number, string]> {
    return this.cols.strings.entries();
  }

  /**
   * Human-readable label for a node, used in lists, chips and the SQL `label`
   * column: a dep's interned path, a rule's bare id (its kind is conveyed by a
   * chip alongside, so the label doesn't repeat it).
   */
  labelOf(id: NodeId): string {
    return this.isRule(id)
      ? String(this.cols.ruleId[id])
      : this.path(this.cols.depDictId[id - this.ruleCount]);
  }

  // A rule's context directory as its dict id; undefined for a dep, or for a
  // rule that didn't record one. The id form of {@link dirOf}, and what the SQL
  // mirror stores (see sql_graph.ts).
  dirStrIdOf(id: NodeId): number | undefined {
    if (!this.isRule(id)) return undefined;
    const dictId = this.cols.ruleDirId[id];
    return dictId < 0 ? undefined : dictId;
  }

  // A rule's context directory, resolved through the dict; undefined for a dep,
  // or for a rule that didn't record one.
  dirOf(id: NodeId): string | undefined {
    const dictId = this.dirStrIdOf(id);
    return dictId === undefined ? undefined : this.path(dictId);
  }

  // The stored codes behind {@link outcomeOf} / {@link resolutionOf}: an index
  // into RULE_OUTCOMES / DEP_RESOLUTIONS. The SQL mirror stores these rather
  // than the words and maps them back in its views (see sql_graph.ts).
  outcomeCodeOf(id: NodeId): number {
    return this.cols.ruleOutcome[id];
  }

  resolutionCodeOf(id: NodeId): number {
    return this.cols.depResolution[id - this.ruleCount];
  }

  outcomeOf(id: NodeId): RuleOutcome {
    return RULE_OUTCOMES[this.outcomeCodeOf(id)] ?? 'unfinished';
  }

  resolutionOf(id: NodeId): DepResolutionKind {
    return DEP_RESOLUTIONS[this.resolutionCodeOf(id)] ?? 'unfinished';
  }

  // The rule a dep resolved to, if it resolved to one that is itself a node.
  resolvedRuleOf(id: NodeId): NodeId | undefined {
    if (this.isRule(id) || this.resolutionOf(id) !== 'rule') return undefined;
    const start = this.outStart(id);
    if (start >= this.outEnd(id)) return undefined; // dangling or unrecorded
    const target = this.cols.edgeTarget.at(start);
    return target < 0 ? undefined : target;
  }

  // How many of a rule's out-edges are static deps / how many dynamic stages it
  // recorded / how many targets it declared. These are the counts the SQL
  // mirror's `dune_rule` reports.
  staticDepCount(id: NodeId): number {
    return this.cols.ruleStaticCount[id];
  }

  dynStageCount(id: NodeId): number {
    return this.cols.ruleDynStages.get(id)?.length ?? 0;
  }

  targetCount(id: NodeId): number {
    return this.cols.ruleTargetOffset[id + 1] - this.cols.ruleTargetOffset[id];
  }

  /**
   * A rule's declared output targets: each recorded relative name joined onto
   * the rule's `dir` (see {@link joinDir}), files first then directories.
   *
   * Target paths share the dep *path* namespace, so a target names the build-dep
   * node of the same path when one exists - but the joined path is not itself a
   * dict id, so it can't be resolved back to a dep node by id (sql_graph.ts
   * joins them as text instead). These are outputs, not dependency edges, so
   * they are deliberately absent from `edges()`.
   *
   * @yields each declared target as a {@link RuleTarget}.
   */
  *ruleTargets(id: NodeId): Iterable<RuleTarget> {
    if (!this.isRule(id)) return;
    const dir = this.dirOf(id);
    const start = this.cols.ruleTargetOffset[id];
    const end = this.cols.ruleTargetOffset[id + 1];
    const files = start + this.cols.ruleTargetFiles[id];
    for (let i = start; i < end; i++) {
      yield {
        path: joinDir(dir, this.path(this.cols.ruleTargetId[i])),
        isDir: i >= files,
      };
    }
  }

  // The key a node's timing is filed under in the timing table: a rule's
  // `rule_id`, a dep's dict id (see lifecycle_sql.ts).
  timingKeyOf(id: NodeId): number {
    return this.traceIdOf(id);
  }

  forcedByOf(id: NodeId): ForcedBy | undefined {
    const code = this.cols.forcedByKind[id];
    if (code === 0) return undefined;
    const kind = FORCED_BY_KINDS[code - 1] ?? 'UNKNOWN';
    const payload = this.cols.forcedByPayload[id];
    switch (kind) {
      case 'RULE':
        if (payload >= 0) {
          return {kind, node: payload, target: this.labelOf(payload)};
        }
        // A forcer the blob named but never recorded still shows its id; one it
        // wrote unreadably shows as a bare "a rule" (see `forcedByText`).
        return isDangling(payload)
          ? {kind, target: String(danglingId(payload))}
          : {kind};
      case 'DEP':
        if (payload >= 0) {
          return {kind, node: payload, target: this.labelOf(payload)};
        }
        return isDangling(payload)
          ? {kind, target: this.path(danglingId(payload))}
          : {kind};
      case 'DYNAMIC_INCLUDES':
      case 'GEN_RULES':
      case 'PFORM':
        return {kind, target: this.path(payload)};
      default:
        return {kind};
    }
  }

  /**
   * The node's `forced_by` kind as its stored code - 0 when nothing was
   * recorded, else its index in {@link FORCED_BY_KINDS} plus one. The form the
   * SQL mirror stores: `dune_node.forced_by_kind` reconstitutes the text with a
   * CASE in the view rather than repeating it on every row.
   */
  forcedByCodeOf(id: NodeId): number {
    return this.cols.forcedByKind[id];
  }

  /**
   * The trace-side id the node's `forced_by` names - a forcing rule's `rule_id`,
   * or the dict id of a dep path / dune-file path - or undefined for the
   * payload-less kinds and for a payload the blob wrote unusably.
   *
   * This is the id form of {@link ForcedBy.target}: the mirror stores it and its
   * `dune_node.forced_by_target` resolves it through `dune_string` exactly as
   * {@link BuildGraph.forcedByOf} resolves it through the dict.
   */
  forcedByTargetIdOf(id: NodeId): number | undefined {
    const payload = this.cols.forcedByPayload[id];
    switch (FORCED_BY_KINDS[this.cols.forcedByKind[id] - 1]) {
      case 'RULE':
      case 'DEP':
        // A recorded forcer is stored as the node it names, so its trace-side
        // id comes back off that node; one the blob never recorded kept its id
        // in the dangling encoding.
        if (payload >= 0) return this.traceIdOf(payload);
        return isDangling(payload) ? danglingId(payload) : undefined;
      case 'DYNAMIC_INCLUDES':
      case 'GEN_RULES':
      case 'PFORM':
        return payload < 0 ? undefined : payload;
      default:
        return undefined;
    }
  }

  /**
   * The node that forced `id` into the build, or a negative value if none did,
   * the forcer isn't itself a node, or it names a non-node kind (a dune file,
   * the top-level request, …). This is the whole of {@link isForcedEdge}: since
   * each node records a single forcer, one column read answers "is this edge
   * forced".
   */
  forcerOf(id: NodeId): NodeId {
    const code = this.cols.forcedByKind[id];
    const kind = FORCED_BY_KINDS[code - 1];
    if (kind !== 'RULE' && kind !== 'DEP') return -1;
    return this.cols.forcedByPayload[id];
  }

  // A node as a panel shows it (see {@link GraphNode}).
  node(id: NodeId): GraphNode {
    const base = {
      nodeId: id,
      id: this.traceIdOf(id),
      label: this.labelOf(id),
      forcedBy: this.forcedByOf(id),
    };
    return this.isRule(id)
      ? {
          ...base,
          kind: 'rule',
          dir: this.dirOf(id),
          outcome: this.outcomeOf(id),
          nStaticDeps: this.staticDepCount(id),
          nDynStages: this.dynStageCount(id),
          nTargets: this.targetCount(id),
        }
      : {
          ...base,
          kind: 'dep',
          resolution: this.resolutionOf(id),
          resolvedRule: this.resolvedRuleOf(id),
        };
  }

  // ---------------------------------------------------------------------
  // Forward adjacency. The CSR is public API: the walks below read it
  // directly rather than through an iterator, since at 28M edges the
  // per-edge object an iterator yields is itself the cost.
  // ---------------------------------------------------------------------

  get edgeCount(): number {
    return this.cols.edgeTarget.length;
  }

  outStart(id: NodeId): number {
    return this.cols.edgeOffset[id];
  }

  outEnd(id: NodeId): number {
    return this.cols.edgeOffset[id + 1];
  }

  // The target at CSR index `i`: a node id, or a {@link dangling} reference.
  outTarget(i: number): number {
    return this.cols.edgeTarget.at(i);
  }

  /**
   * A node's outgoing edges - the prerequisites it depends on - tagged with why
   * each exists. The kind follows from the position in the node's CSR run rather
   * than from a per-edge column: a rule's run is its static deps followed by its
   * dynamic stages in order, and a dep's run is either the single rule it
   * resolved to or the deps it expanded to.
   *
   * @yields each prerequisite as an {@link OutEdge}, dangling references
   *     included (`target < 0`) - callers that want only real edges skip those.
   */
  *outEdges(id: NodeId): Iterable<OutEdge> {
    const start = this.outStart(id);
    const end = this.outEnd(id);
    if (!this.isRule(id)) {
      const edgeKind =
        this.resolutionOf(id) === 'rule' ? 'resolved' : 'expanded';
      for (let i = start; i < end; i++) {
        yield {target: this.outTarget(i), edgeKind};
      }
      return;
    }
    const dynStart = start + this.cols.ruleStaticCount[id];
    for (let i = start; i < dynStart; i++) {
      yield {target: this.outTarget(i), edgeKind: 'static'};
    }
    // Stage boundaries are cumulative ends relative to `dynStart`, so walking
    // them alongside the edges keeps this a single pass. An empty stage (`||` in
    // the blob) is skipped over here but still counted by `dynStageCount`.
    const stages = this.cols.ruleDynStages.get(id);
    let stage = 0;
    for (let i = dynStart; i < end; i++) {
      const offset = i - dynStart;
      while (
        stages !== undefined &&
        stage < stages.length - 1 &&
        offset >= stages[stage]
      ) {
        stage++;
      }
      yield {target: this.outTarget(i), edgeKind: 'dynamic', dynStage: stage};
    }
  }

  // The nodes `id` directly depends on, dangling references dropped. Not
  // deduped: a rule that lists the same dep both statically and dynamically
  // depends on it twice, and that is what the blob recorded.
  outTargets(id: NodeId): NodeId[] {
    const targets: NodeId[] = [];
    for (let i = this.outStart(id); i < this.outEnd(id); i++) {
      const target = this.outTarget(i);
      if (target >= 0) targets.push(target);
    }
    return targets;
  }

  /**
   * A node's outgoing edges as display rows, including the references the blob
   * made to nodes it never recorded (which render as unlinked entries rather
   * than silently vanishing).
   *
   * @yields each outgoing edge as an {@link OutRef}.
   */
  *outRefs(id: NodeId): Iterable<OutRef> {
    for (const {target, edgeKind, dynStage} of this.outEdges(id)) {
      const kind: NodeKind = edgeKind === 'resolved' ? 'rule' : 'dep';
      if (target < 0) {
        const traceId = danglingId(target);
        yield {
          kind,
          label: kind === 'rule' ? String(traceId) : this.path(traceId),
          edgeKind,
          dynStage,
          forced: false,
        };
        continue;
      }
      yield {
        node: target,
        kind,
        label: this.labelOf(target),
        dir: this.dirOf(target),
        edgeKind,
        dynStage,
        forced: this.forcerOf(target) === id,
      };
    }
  }
}

export const EMPTY_GRAPH = new BuildGraph(emptyColumns());

/**
 * Whether the build edge `source -> dest` is *forced*: i.e. `dest` was forced
 * into the build by `source`, meaning `dest`'s `forcedBy` names `source`. Since
 * each node records a single forcer, forced edges pick out - per node - the one
 * dependency that caused it to be built (a spanning forest of the graph).
 *
 * `source` depends on `dest`, so `source` is the potential forcer: a rule forces
 * the deps it lists, a dep forces the rule it resolves to and the deps it
 * expands to. The other `forcedBy` kinds name non-node forcers (dune files, the
 * top-level request, …) and so never mark an edge forced.
 */
export function isForcedEdge(
  graph: BuildGraph,
  source: NodeId,
  dest: NodeId,
): boolean {
  return graph.forcerOf(dest) === source;
}

// Pluralise a count, e.g. `1 dep` / `2 deps`.
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

// Join a target path (a `target_files` / `target_dirs` entry) onto a rule's
// `dir`. An absent, empty or `.` dir leaves the relative path unchanged;
// otherwise a single `/` is inserted (tolerating a `dir` that already ends in
// one).
export function joinDir(dir: string | undefined, rel: string): string {
  if (dir === undefined || dir === '' || dir === '.') return rel;
  return dir.endsWith('/') ? `${dir}${rel}` : `${dir}/${rel}`;
}

/**
 * The whole graph's edge set (source depends on dest), dangling references
 * dropped. The SQL edge mirror (sql_graph.ts) is the only consumer at full
 * scale - 28.7M edges on the monorepo trace, so this is a generator rather than
 * an array, and even so the per-edge object is why materialising that mirror is
 * an opt-in step.
 *
 * @yields each build edge as a {@link GraphEdge}.
 */
export function* edges(graph: BuildGraph): Iterable<GraphEdge> {
  for (let source = 0; source < graph.nodeCount; source++) {
    for (const {target, edgeKind, dynStage} of graph.outEdges(source)) {
      if (target < 0) continue;
      yield {
        source,
        dest: target,
        forced: graph.forcerOf(target) === source,
        edgeKind,
        dynDepsStage: dynStage,
      };
    }
  }
}

/**
 * The edges of the subgraph induced by `nodes`: every edge whose source and
 * dest are both in the set. Walks each node's out-edges (not the whole graph),
 * so it stays cheap when the selection is small.
 *
 * If `isHidden` is given, hidden nodes in the set are never emitted as an edge
 * endpoint but are still traversed *through*: an edge is emitted from each
 * visible source to the nearest visible node(s) reachable via hidden nodes
 * only, contracting the hidden run. This is how the graph pane implements
 * "hide rules" - a chain `dep -> rule -> dep` with the rule hidden collapses to
 * a single `dep -> dep` edge. Traversal never leaves `nodes` (only nodes
 * already in the selection are ever walked through), so hiding a kind can only
 * ever remove nodes from view, never surface a connection that wasn't already
 * reachable within the selection.
 */
export function inducedEdges(
  graph: BuildGraph,
  nodes: readonly NodeId[],
  isHidden?: (id: NodeId) => boolean,
): readonly GraphEdge[] {
  const inSet = new Set(nodes);
  const hidden = (id: NodeId) => isHidden?.(id) ?? false;

  const result: GraphEdge[] = [];
  for (const source of nodes) {
    if (hidden(source)) continue;
    // dest -> best edge found to it, so a diamond of hidden paths (or a rule
    // listing the same dep both statically and dynamically) yields one edge,
    // preferring a forced one if any path to that dest is forced.
    const bestByDest = new Map<NodeId, GraphEdge>();
    // DFS over the induced subgraph, only stepping into nodes that are in the
    // selection; `forced` tracks whether every hop of the current path so far
    // was a forced edge. Visited is keyed by node+forced-so-far (hence the
    // `2 * id`), since a path that's still forced can reach further than one
    // that already lost it.
    const seen = new Set<number>([2 * source + 1]);
    const stack: Array<{node: NodeId; forced: boolean}> = [
      {node: source, forced: true},
    ];
    while (stack.length > 0) {
      const {node: current, forced} = stack.pop()!;
      for (let i = graph.outStart(current); i < graph.outEnd(current); i++) {
        const next = graph.outTarget(i);
        if (next < 0 || !inSet.has(next)) continue; // dangling, or outside
        const nextForced = forced && graph.forcerOf(next) === current;
        if (hidden(next)) {
          const key = 2 * next + (nextForced ? 1 : 0);
          if (seen.has(key)) continue;
          seen.add(key);
          stack.push({node: next, forced: nextForced});
          continue;
        }
        if (next === source) continue; // drop self-edges from contraction
        const existing = bestByDest.get(next);
        if (existing === undefined || (nextForced && !existing.forced)) {
          bestByDest.set(next, {source, dest: next, forced: nextForced});
        }
      }
    }
    result.push(...bestByDest.values());
  }
  return result;
}

/**
 * Reverse adjacency of the build graph: the nodes that directly depend on each
 * node (i.e. that have a build edge pointing at it). Built once per graph, on
 * first use, and dropped with it.
 *
 * Same CSR shape as the forward edges, produced by a counting sort over them -
 * as ~28M string-keyed map entries (one per edge, keyed by node key) this was
 * simply not buildable at monorepo scale, which is why dependants and ancestors
 * didn't work there at all before the perf plan's stage 3.
 *
 * Duplicate edges stay duplicated here (see {@link BuildGraph.outTargets});
 * {@link directParents} de-dups the small list it hands to a caller.
 */
export class ReverseIndex {
  private constructor(
    private readonly offset: Int32Array,
    private readonly target: Int32Vector,
  ) {}

  static build(graph: BuildGraph, perf?: PerfRun): ReverseIndex {
    const build = () => {
      const nodes = graph.nodeCount;
      const offset = new Int32Array(nodes + 1);
      for (let i = 0; i < graph.edgeCount; i++) {
        const target = graph.outTarget(i);
        if (target >= 0) offset[target + 1]++;
      }
      for (let i = 0; i < nodes; i++) offset[i + 1] += offset[i];
      // Per-node write cursor, consumed as the edges are placed.
      const cursor = offset.slice(0, nodes);
      const target = Int32Vector.ofLength(offset[nodes]);
      for (let source = 0; source < nodes; source++) {
        for (let i = graph.outStart(source); i < graph.outEnd(source); i++) {
          const dest = graph.outTarget(i);
          if (dest >= 0) target.set(cursor[dest]++, source);
        }
      }
      return new ReverseIndex(offset, target);
    };
    if (perf === undefined) return build();
    return perf.phaseSync('graph: reverse index', (p) => {
      const index = build();
      p.rows(index.target.length);
      return index;
    });
  }

  get nodeCount(): number {
    return this.offset.length - 1;
  }

  // The nodes that directly depend on `id`, de-duped (a node reachable by two
  // edges from the same parent is one dependant).
  parents(id: NodeId): readonly NodeId[] {
    const seen = new Set<NodeId>();
    for (let i = this.offset[id]; i < this.offset[id + 1]; i++) {
      seen.add(this.target.at(i));
    }
    return [...seen];
  }

  // All nodes that transitively depend on `id` (its ancestors), excluding `id`
  // itself. Depth-first over the reverse edges with a visited bitmap - build
  // graphs are DAGs, but the guard keeps us safe against accidental cycles.
  ancestors(id: NodeId): readonly NodeId[] {
    const seen = new Uint8Array(this.nodeCount);
    seen[id] = 1;
    const result: NodeId[] = [];
    const stack: NodeId[] = [id];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (let i = this.offset[current]; i < this.offset[current + 1]; i++) {
        const parent = this.target.at(i);
        if (seen[parent] === 1) continue;
        seen[parent] = 1;
        result.push(parent);
        stack.push(parent);
      }
    }
    return result;
  }
}

// Nodes that directly depend on `id` (its immediate parents).
export function directParents(
  index: ReverseIndex,
  id: NodeId,
): readonly NodeId[] {
  return index.parents(id);
}

// All nodes that transitively depend on `id`, excluding `id` itself.
export function ancestors(index: ReverseIndex, id: NodeId): readonly NodeId[] {
  return index.ancestors(id);
}

// All nodes `id` transitively depends on (its descendants), excluding `id`
// itself. Mirror of {@link ancestors}, but forward over the graph's own CSR - no
// index needed, since forward edges are already directly addressable.
export function descendants(graph: BuildGraph, id: NodeId): readonly NodeId[] {
  const seen = new Uint8Array(graph.nodeCount);
  seen[id] = 1;
  const result: NodeId[] = [];
  const stack: NodeId[] = [id];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (let i = graph.outStart(current); i < graph.outEnd(current); i++) {
      const child = graph.outTarget(i);
      if (child < 0 || seen[child] === 1) continue;
      seen[child] = 1;
      result.push(child);
      stack.push(child);
    }
  }
  return result;
}

/**
 * The chain of nodes that transitively forced `id` into the build, walking
 * `forcedBy` up to its root (excluding `id` itself). Since each node records a
 * single forcer, this is a single-parent walk, not a search: it stops as soon as
 * `forcedBy` is absent, names a non-node kind (a dune file / the request / the
 * configurator - see {@link ForcedBy}), or names an id the blob never recorded.
 * A visited set guards against a cyclic `forcedBy` even though that shouldn't
 * happen in practice.
 *
 * This walks the same spanning forest as {@link isForcedEdge}, so its result is
 * a subset of `ancestors(id)` wherever the forcer also lists `id` as a
 * dependency; a `forcedBy` that doesn't (a trace inconsistency) still yields the
 * node here, faithfully reflecting what the trace recorded.
 */
export function forcers(graph: BuildGraph, id: NodeId): readonly NodeId[] {
  const seen = new Set<NodeId>([id]);
  const result: NodeId[] = [];
  let current = id;
  for (;;) {
    const forcer = graph.forcerOf(current);
    if (forcer < 0 || seen.has(forcer)) break;
    seen.add(forcer);
    result.push(forcer);
    current = forcer;
  }
  return result;
}

/**
 * Where the build graph comes from.
 *
 * Deliberately an interface so the source can be swapped while we work out how
 * the graph reaches the trace (slice args today; possibly a metadata packet or
 * a separate dump later). Everything downstream depends only on this contract.
 */
export interface GraphSource {
  // Short human-readable description of the active source, surfaced in the UI.
  readonly description: string;

  // Extract the whole graph. Called on trace load and on explicit reload.
  // `perf`, when given, collects a per-phase breakdown of the load (see
  // perf.ts); a source is free to ignore it.
  load(perf?: PerfRun): Promise<BuildGraph>;

  // What a `load()` of this trace would involve, without doing any of it - the
  // one thing the plugin is allowed to ask of a trace it hasn't been told to
  // load (see controller.ts's init()). Throws for the same reasons `load()`
  // would refuse outright (e.g. no graph in this trace at all).
  stats(): Promise<GraphStats>;
}

/**
 * How big this trace's graph is, measured without parsing it - so the UI can
 * say what a load would cost before committing to one, and the controller can
 * decide whether to start one unprompted.
 */
export interface GraphStats {
  // Per raw section of the source's payload, in the order the source reports.
  readonly sections: readonly GraphSectionStats[];

  // Total payload size across every section.
  readonly bytes: number;

  // Lifecycle instants that would be read to time the nodes.
  readonly lifecycleInstants: number;

  /**
   * Roughly how many dependency edges the graph holds. **An estimate**, derived
   * from the payload's size rather than its contents (see
   * `trace_graph_source.ts`): it's what's available before a parse, and it's
   * the number that predicts whether a load fits in memory at all.
   */
  readonly estimatedEdges: number;
}

// One section of the source's raw payload: how much of it there is, and how
// many pieces it arrived in.
export interface GraphSectionStats {
  readonly name: string;
  readonly chunks: number;
  readonly bytes: number;
}
