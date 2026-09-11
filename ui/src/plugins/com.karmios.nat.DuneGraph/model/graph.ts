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
 * **README.md, "The graph model", is the reference**: the two kinds of node and
 * where each comes from, why every node is a dense integer {@link NodeId} that
 * the SQL mirror reuses verbatim, why everything lives in typed-array columns
 * with the edges in one CSR, and why the small enums below are append-only.
 *
 * The walks here (`descendants`, `ancestors`, `inducedEdges`, …) take and
 * return node ids; only a call site that renders something materialises a
 * {@link GraphNode} view.
 */

import {IntIndex, Int32Vector} from './columns';
import type {DepStatus, RuleOutcome, StringTable} from './graph_blob';
import {EMPTY_STRING_TABLE} from './graph_blob';
import type {PerfRun} from '../perf';

// A node's identity: its index in the dense node-id space (see the file header).
export type NodeId = number;

export type NodeKind = 'dep' | 'rule';

// Re-exported so callers of graph.ts don't also need to import graph_blob.ts
// for the node-facing outcome type.
export type {DepStatus, RuleOutcome, StringTable} from './graph_blob';

/**
 * A dep's resolution, as a short discriminator: what the dep turned out to be.
 *
 * `unknown` is dune saying it couldn't tell (the dep's own build failed or was
 * cancelled first - pair it with {@link BuildGraph.statusOf} to see which);
 * `unfinished` is the span never having ended, i.e. a truncated trace. It also
 * doubles as the fallback for a dep with no resolution recorded at all.
 */
export type DepResolutionKind =
  'rule' | 'source' | 'expanded' | 'unknown' | 'unfinished';

/**
 * Why a node was built - the `forced_by` field of its blob record. See
 * {@link isForcedEdge} for how this drives forced edges, and
 * `node_display.ts:forcedByText` for the display phrasing of each kind.
 *
 * `RULE_RECOVERY` is a rule that forced this node while *recovering* its own
 * deps after failing; it names a rule exactly as `RULE` does, and is treated
 * identically everywhere the payload is resolved - only the phrasing differs.
 */
export type ForcedByKind =
  | 'RULE'
  | 'DEP'
  | 'DYNAMIC_INCLUDES'
  | 'GEN_RULES'
  | 'PFORM'
  | 'CONFIGURATOR'
  | 'REQUEST'
  | 'UNKNOWN'
  | 'RULE_RECOVERY';

// The stored code of an outcome / resolution / status / forcer kind is its
// index in these lists (`forcedByKind` is offset by one, so 0 means "not
// recorded"). Order is part of the store's encoding, so only ever append -
// which is why the codes added with dune's failure states sit after the
// fallbacks rather than beside their siblings.
export const RULE_OUTCOMES: readonly RuleOutcome[] = [
  'executed',
  'local-cache-hit',
  'shared-cache-hit',
  'unfinished',
  'failed-deps',
  'failed-action',
  'cancelled',
];
export const DEP_RESOLUTIONS: readonly DepResolutionKind[] = [
  'rule',
  'source',
  'expanded',
  'unfinished',
  'unknown',
];
export const DEP_STATUSES: readonly DepStatus[] = ['ok', 'failed', 'cancelled'];
export const FORCED_BY_KINDS: readonly ForcedByKind[] = [
  'RULE',
  'DEP',
  'DYNAMIC_INCLUDES',
  'GEN_RULES',
  'PFORM',
  'CONFIGURATOR',
  'REQUEST',
  'UNKNOWN',
  'RULE_RECOVERY',
];

// The codes an unreadable/absent field falls back to. Named rather than
// derived from the lists' ends, which stopped being the fallbacks the moment
// dune's failure states were appended.
export const OUTCOME_UNFINISHED = RULE_OUTCOMES.indexOf('unfinished');
export const RESOLUTION_UNFINISHED = DEP_RESOLUTIONS.indexOf('unfinished');
export const STATUS_OK = DEP_STATUSES.indexOf('ok');

/**
 * What counts as a failure, for a rule and for a dep respectively - the single
 * source of truth behind {@link BuildGraph.healthOf}, the dir explorer's
 * failure filter and `n_failed` in sql_graph.ts.
 *
 * Only dune's two real failures qualify. A `cancelled` or `unfinished` node is
 * not a failure: an interrupted or truncated build is not a broken one.
 */
export const FAILED_OUTCOMES: readonly RuleOutcome[] = [
  'failed-deps',
  'failed-action',
];
export const FAILED_STATUSES: readonly DepStatus[] = ['failed'];

/**
 * How a node ended, as the one word both kinds can be asked for - see
 * {@link BuildGraph.healthOf}, which is the only thing that should produce one.
 *
 * `cancelled` is dune's own report that the node was torn down with the rest of
 * the build; `unfinished` is the absence of a report at all (a span that never
 * ended, i.e. a truncated trace), not a build state.
 */
export type NodeHealth = 'ok' | 'failed' | 'cancelled' | 'unfinished';

// Every column holding a node reference (an edge target, a forcer) encodes
// three things in one int32: a node id (`>= 0`), {@link NO_REF} (`-1`, nothing
// recorded), or a *dangling* reference (`<= -2`, an id the blob named but
// recorded no node for, kept as `-(traceId + 2)` so both the reference and the
// id survive for display). `outEdges`' consumers skip dangling refs and
// `outRefs` renders them as unlinked rows; they never reach the SQL mirror.
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

// A span's timing, paired in SQL and looked up on demand rather than carried on
// the node (see lifecycle_sql.ts). `durNs` is absent for a span that never got
// a finish. `occurrenceCount` counts same-keyed spans (watch mode, or a dep
// built more than once); the node's own timing is always the *first*, a
// heuristic because lifecycle instants carry no occurrence index.
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

interface DepNode extends NodeViewBase {
  readonly kind: 'dep';
  readonly resolution: DepResolutionKind;
  // How building the dep itself ended, independently of what it resolved to.
  readonly status: DepStatus;
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
  // Whether the blob reported the rule's deps as undeterminable (see
  // {@link BuildGraph.depsUnknownOf}); `nStaticDeps` is 0 either way.
  readonly depsUnknown: boolean;
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
type EdgeKind = 'static' | 'dynamic' | 'resolved' | 'expanded';

/**
 * One of a node's outgoing edges, as stored: `target` is the prerequisite's node
 * id, or a {@link dangling} (negative) reference to an id the blob named but
 * never recorded. Yielded by {@link BuildGraph.outEdges}.
 */
interface OutEdge {
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
interface RuleTarget {
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

  readonly ruleId: Int32Array;
  readonly ruleDirId: Int32Array; // dict id; -1 when not recorded
  readonly ruleOutcome: Uint8Array; // index into RULE_OUTCOMES
  readonly ruleStaticCount: Int32Array; // leading static edges of the rule's run
  readonly ruleTargetOffset: Int32Array; // ruleCount + 1, into ruleTargetId
  readonly ruleTargetFiles: Int32Array; // leading file targets of the rule's run
  readonly ruleTargetId: Int32Array; // dict ids, files then dirs per rule
  // 1 where the blob wrote `?` for the rule's deps (unknown, as opposed to
  // none). A byte per rule rather than a sentinel in `ruleStaticCount`, which
  // the CSR's static/dynamic split arithmetic reads.
  readonly ruleDepsUnknown: Uint8Array;
  // Rule node id -> the end offset of each dynamic-dep stage, relative to the
  // start of the rule's dynamic edges. A map, not a column: dynamic deps are
  // rare (the monorepo trace has none at all), so this holds an entry only for
  // the rules that have any.
  readonly ruleDynStages: ReadonlyMap<NodeId, Int32Array>;
  // The dep set (a dense index into the factored block below) whose expansion
  // *is* the rule's static edges, or NO_REF when the rule named none - which
  // covers both "no deps" and `ruleDepsUnknown` (see {@link
  // BuildGraph.depSetOf}). Not read by anything on the traversal path: the
  // edges are already expanded into the CSR.
  readonly ruleDepSet: Int32Array;
  // Rule node id -> the dep set of each dynamic-dep stage, NO_REF for a stage
  // that named none. Parallel to `ruleDynStages`, and equally rare.
  readonly ruleDynStageSet: ReadonlyMap<NodeId, Int32Array>;

  // Deps, indexed by node id minus ruleCount.
  readonly depDictId: Int32Array;
  readonly depResolution: Uint8Array; // index into DEP_RESOLUTIONS
  readonly depStatus: Uint8Array; // index into DEP_STATUSES

  // Every node, indexed by node id.
  readonly forcedByKind: Uint8Array; // 0 = not recorded, else FORCED_BY_KINDS + 1
  readonly forcedByPayload: Int32Array; // node id / dangling / dict id, by kind

  // Forward adjacency, CSR over the node-id space. A node's edges are
  // `edgeTarget[edgeOffset[id] .. edgeOffset[id + 1])`, ordered so the edge kind
  // follows from the position (see {@link BuildGraph.outEdges}).
  readonly edgeOffset: Int32Array; // nodeCount + 1
  readonly edgeTarget: Int32Vector;

  // The blob's factored dep sets, kept alongside the flat CSR rather than
  // discarded once expanded (see README.md, "The blob format"): the SQL edge
  // mirror stores *this* form - where the row count falls ~5x - and the only
  // other way back to it would be re-parsing the blob. ~4.2M ints.
  //
  // Both member tables hold node references in `edgeTarget`'s encoding, and are
  // contiguous per owner and in owner order, so a rowid range serves the
  // forward direction. Nothing on the traversal path reads any of this.
  readonly coreBlobId: Int32Array; // the blob's own `core_id`, by core index
  readonly coreMemberOffset: Int32Array; // coreCount + 1, into coreMemberTarget
  readonly coreMemberTarget: Int32Vector;
  readonly depSetBlobId: Int32Array; // the blob's own `set_id`, by set index
  readonly depSetCore: Int32Array; // core index, NO_REF for an uncored set
  readonly depSetAddOffset: Int32Array; // setCount + 1, into depSetAddTarget
  readonly depSetAddTarget: Int32Vector;

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
    ruleDepsUnknown: new Uint8Array(0),
    ruleDynStages: new Map(),
    ruleDepSet: new Int32Array(0),
    ruleDynStageSet: new Map(),
    depDictId: new Int32Array(0),
    depResolution: new Uint8Array(0),
    depStatus: new Uint8Array(0),
    forcedByKind: new Uint8Array(0),
    forcedByPayload: new Int32Array(0),
    edgeOffset: new Int32Array(1),
    edgeTarget: new Int32Vector(),
    coreBlobId: new Int32Array(0),
    coreMemberOffset: new Int32Array(1),
    coreMemberTarget: new Int32Vector(),
    depSetBlobId: new Int32Array(0),
    depSetCore: new Int32Array(0),
    depSetAddOffset: new Int32Array(1),
    depSetAddTarget: new Int32Vector(),
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
  // The factored dep-set tables' sizes (see GraphColumns' factored block).
  readonly coreCount: number;
  readonly depSetCount: number;

  constructor(private readonly cols: GraphColumns) {
    this.ruleCount = cols.ruleId.length;
    this.depCount = cols.depDictId.length;
    this.nodeCount = this.ruleCount + this.depCount;
    this.coreCount = cols.coreBlobId.length;
    this.depSetCount = cols.depSetBlobId.length;
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

  /**
   * The build-output prefixes a displayed path may drop, derived from this
   * graph's rule dirs - see {@link deriveBuildRoots} for what counts as one and
   * `node_display.ts:decorateDepPath` for what it does with them.
   *
   * Derived once and cached, since every path a panel renders asks for it.
   */
  private buildRootsCache?: readonly string[];

  get buildRoots(): readonly string[] {
    return (this.buildRootsCache ??= deriveBuildRoots(this.ruleDirs()));
  }

  // Every distinct rule context dir. Only {@link buildRoots} wants this: a
  // monorepo trace's 6.5k rules share ~350 dirs, so the set is small even
  // though the scan is over every rule.
  private ruleDirs(): ReadonlySet<string> {
    const dirs = new Set<string>();
    for (let id = 0; id < this.ruleCount; id++) {
      const dir = this.dirOf(id);
      if (dir !== undefined) dirs.add(dir);
    }
    return dirs;
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

  // The stored code behind {@link statusOf}: an index into DEP_STATUSES.
  statusCodeOf(id: NodeId): number {
    return this.cols.depStatus[id - this.ruleCount];
  }

  outcomeOf(id: NodeId): RuleOutcome {
    return RULE_OUTCOMES[this.outcomeCodeOf(id)] ?? 'unfinished';
  }

  resolutionOf(id: NodeId): DepResolutionKind {
    return DEP_RESOLUTIONS[this.resolutionCodeOf(id)] ?? 'unfinished';
  }

  // How building the dep itself ended. Independent of `resolutionOf`: a failed
  // dep can still have resolved to a known rule, and one whose resolution is
  // `unknown` is `unknown` *because* of this status. `ok` for a rule, which
  // reports the same thing through its outcome.
  statusOf(id: NodeId): DepStatus {
    if (this.isRule(id)) return 'ok';
    return DEP_STATUSES[this.statusCodeOf(id)] ?? 'ok';
  }

  // How this node ended, in the one vocabulary both kinds share - ask this
  // rather than picking apart `outcomeOf` / `statusOf` / `resolutionOf`.
  //
  // A rule says it all in its outcome. A dep needs two fields: `statusOf`
  // returning `ok` does not on its own mean the dep is fine, since a dep whose
  // span never ended has nothing recorded to fail and reports `ok` while its
  // resolution is `unfinished`. A resolution of `unknown` is not a state of its
  // own - it means dune could not tell *because* of a cause `statusOf` reports.
  healthOf(id: NodeId): NodeHealth {
    if (this.isRule(id)) {
      const outcome = this.outcomeOf(id);
      if (FAILED_OUTCOMES.includes(outcome)) return 'failed';
      if (outcome === 'cancelled') return 'cancelled';
      return outcome === 'unfinished' ? 'unfinished' : 'ok';
    }
    const status = this.statusOf(id);
    if (FAILED_STATUSES.includes(status)) return 'failed';
    if (status === 'cancelled') return 'cancelled';
    return this.resolutionOf(id) === 'unfinished' ? 'unfinished' : 'ok';
  }

  /**
   * Whether the blob reported that it could not determine this rule's deps (a
   * `?` where the dep ids go), as opposed to the rule having none. The node has
   * no dep edges either way, so anything that counts or joins on dependency
   * edges has to consult this before reading "0 deps" as a fact about the
   * build. False for a dep node, which has no such field.
   */
  depsUnknownOf(id: NodeId): boolean {
    return this.isRule(id) && this.cols.ruleDepsUnknown[id] === 1;
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

  // The dep set whose expansion *is* this rule's static edges, as an index into
  // the factored tables. Undefined covers both a rule with no deps and one
  // whose deps the blob could not determine - `depsUnknownOf` tells those
  // apart. For the SQL mirror only; the CSR already has the edges.
  depSetOf(id: NodeId): number | undefined {
    if (!this.isRule(id)) return undefined;
    const set = this.cols.ruleDepSet[id];
    return set === NO_REF ? undefined : set;
  }

  // The dep set of one of a rule's dynamic-dep stages, or undefined when that
  // stage named none (an empty stage still holds its slot - see
  // {@link dynStageCount}).
  dynStageSetOf(id: NodeId, stage: number): number | undefined {
    const sets = this.cols.ruleDynStageSet.get(id);
    if (sets === undefined || stage < 0 || stage >= sets.length) {
      return undefined;
    }
    return sets[stage] === NO_REF ? undefined : sets[stage];
  }

  targetCount(id: NodeId): number {
    return this.cols.ruleTargetOffset[id + 1] - this.cols.ruleTargetOffset[id];
  }

  // A rule's declared outputs: each recorded relative name joined onto the
  // rule's `dir`, files then directories. Target paths share the dep *path*
  // namespace, but the joined path is not itself a dict id, so sql_graph.ts
  // joins them as text rather than by id. Outputs, not dependency edges, so
  // deliberately absent from `edges()`.
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
      case 'RULE_RECOVERY':
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
      case 'RULE_RECOVERY':
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
    // A recovery forcer names a rule that really did force this node into the
    // build (while recovering its own deps), so it marks an edge exactly as a
    // plain rule forcer does - each node still records a single forcer, so
    // forced edges remain a spanning forest.
    const kind = FORCED_BY_KINDS[code - 1];
    if (kind !== 'RULE' && kind !== 'RULE_RECOVERY' && kind !== 'DEP') {
      return -1;
    }
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
          depsUnknown: this.depsUnknownOf(id),
        }
      : {
          ...base,
          kind: 'dep',
          resolution: this.resolutionOf(id),
          status: this.statusOf(id),
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

  // The factored dep sets, read like the CSR above: a half-open range of member
  // slots per owner, a target per slot. A set's membership is its core's
  // members followed by its own adds, and the two are disjoint. For the SQL
  // mirror only - the sets are already expanded into `edgeTarget`.
  coreOfDepSet(set: number): number | undefined {
    const core = this.cols.depSetCore[set];
    return core === NO_REF ? undefined : core;
  }

  // The blob's own `core_id` / `set_id` behind a dense index - per-process join
  // keys within one blob, never stable identities (the same caveat `ruleId`
  // carries), kept so the mirror can be lined up against the raw blob.
  coreIdOf(core: number): number {
    return this.cols.coreBlobId[core];
  }

  depSetIdOf(set: number): number {
    return this.cols.depSetBlobId[set];
  }

  coreMemberStart(core: number): number {
    return this.cols.coreMemberOffset[core];
  }

  coreMemberEnd(core: number): number {
    return this.cols.coreMemberOffset[core + 1];
  }

  coreMemberTarget(i: number): number {
    return this.cols.coreMemberTarget.at(i);
  }

  depSetAddStart(set: number): number {
    return this.cols.depSetAddOffset[set];
  }

  depSetAddEnd(set: number): number {
    return this.cols.depSetAddOffset[set + 1];
  }

  depSetAddTarget(i: number): number {
    return this.cols.depSetAddTarget.at(i);
  }

  // A node's prerequisites, tagged with why each edge exists. The kind follows
  // from the *position* in the node's CSR run rather than a per-edge column: a
  // rule's run is its static deps then its dynamic stages in order, a dep's is
  // either the rule it resolved to or the deps it expanded to. Yields dangling
  // references too (`target < 0`); callers wanting only real edges skip those.
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

  // A node's outgoing edges as display rows, including the references the blob
  // made to nodes it never recorded - which render as unlinked entries rather
  // than silently vanishing.
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

// Whether `dest`'s `forcedBy` names `source`. Each node records a single
// forcer, so forced edges pick out per node the one dependency that caused it
// to be built - a spanning forest. `source` depends on `dest`, so `source` is
// the potential forcer; the other `forcedBy` kinds name non-node forcers (dune
// files, the top-level request) and never mark an edge forced.
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

// The build-output prefixes worth folding away when a path is displayed.
//
// Dune lays its build dir out as `<build>/<context>/<pkg>`, and for the actions
// and install trees `<build>/<role>/<context>/<pkg>`, so the prefix ends at the
// *context* - one segment deeper for the roles. The context is the name
// appearing both directly under the build dir and again one level down under a
// sibling of it (`default`, in both `_build/default/src` and
// `_build/.actions/default/src`), which spots it without hardcoding `_build` or
// `default` - neither of which a `--build-dir` or non-default-context build
// would give us. Only observed prefixes are returned.
function deriveBuildRoots(dirs: Iterable<string>): readonly string[] {
  // Names seen one and two levels under each build root. Kept per root so a
  // rule dir that isn't in a build tree at all can only ever produce a context
  // for its own first segment.
  const depth1 = new Map<string, Set<string>>();
  const depth2 = new Map<string, Set<string>>();
  const add = (into: Map<string, Set<string>>, root: string, name: string) => {
    const names = into.get(root);
    if (names === undefined) into.set(root, new Set([name]));
    else names.add(name);
  };
  // Empty segments dropped, so a dir written `_build/default/` or `.` behaves
  // as `_build/default` / nothing at all (see joinDir's tolerance of both).
  const split = [...dirs].map((dir) => dir.split('/').filter((s) => s !== ''));
  for (const segs of split) {
    if (segs.length < 2) continue;
    add(depth1, segs[0], segs[1]);
    if (segs.length > 2) add(depth2, segs[0], segs[2]);
  }
  const roots = new Set<string>();
  for (const segs of split) {
    if (segs.length < 2) continue;
    const isContext = (name: string) =>
      (depth1.get(segs[0])?.has(name) ?? false) &&
      (depth2.get(segs[0])?.has(name) ?? false);
    // Shortest prefix ending at a context, so a role-less dir stops at the
    // context and never at a package dir that happens to share its name. No
    // two prefixes can nest: a dir whose depth-1 name is a context stops
    // there, so the deeper form is only ever produced under a non-context.
    if (isContext(segs[1])) roots.add(`${segs[0]}/${segs[1]}`);
    else if (segs.length > 2 && isContext(segs[2])) {
      roots.add(`${segs[0]}/${segs[1]}/${segs[2]}`);
    }
  }
  return [...roots];
}

// The whole graph's edge set (source depends on dest), dangling references
// dropped. The SQL edge mirror is the only consumer at full scale - 28.7M edges
// on the monorepo trace, so this is a generator rather than an array, and even
// so the per-edge object is why materialising that mirror is opt-in.
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

// Every edge whose source and dest are both in `nodes`. Walks each node's
// out-edges rather than the whole graph, so it stays cheap for a small set.
//
// With `isHidden`, hidden nodes are never an edge endpoint but are still
// traversed *through*, contracting the run: this is how the graph pane's "hide
// rules" collapses `dep -> rule -> dep` to one `dep -> dep`. Traversal never
// leaves `nodes`, so hiding a kind can only remove nodes from view, never
// surface a connection that was not already reachable within the selection.
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

// Reverse adjacency: the nodes that directly depend on each node. Built once
// per graph, on first use, and dropped with it. Same CSR shape as the forward
// edges, produced by a counting sort over them - as ~28M string-keyed map
// entries this was not buildable at monorepo scale at all.
//
// Duplicate edges stay duplicated; {@link directParents} de-dups the small
// list it hands to a caller.
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

// The chain that transitively forced `id` into the build, excluding `id`. A
// single-parent walk rather than a search, since each node records one forcer:
// it stops when `forcedBy` is absent, names a non-node kind, or names an id the
// blob never recorded. The visited set guards a cyclic `forcedBy`.
//
// Same spanning forest as {@link isForcedEdge}, so the result is a subset of
// `ancestors(id)` wherever the forcer also lists `id` as a dependency; one that
// does not (a trace inconsistency) still yields the node, faithfully.
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
   * Roughly how many rows the SQL edge tier would store. **An estimate**,
   * derived from the payload's size rather than its contents (see
   * `trace_graph_source.ts`): it's what's available before a parse, and it's the
   * number that predicts whether a load fits in memory at all.
   *
   * Rows, not edges. Since dune started factoring dep sets there is no way to
   * estimate the *edge* count from byte sizes at all - that is precisely what
   * the factoring hides - and the stored row count is the one that predicts
   * cost anyway.
   */
  readonly estimatedEdgeRows: number;
}

// One section of the source's raw payload: how much of it there is, and how
// many pieces it arrived in.
export interface GraphSectionStats {
  readonly name: string;
  readonly chunks: number;
  readonly bytes: number;
}
