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

import type {RuleOutcome} from './graph_blob';

/**
 * The build graph has two kinds of node, both sourced from the trace's graph
 * blob (structure) and lifecycle instants (timing) - see `graph_blob.ts` and
 * `trace_graph_source.ts`:
 *
 * - `dep` nodes come from `graph-deps` blob records / `build-dep` instants. A
 *   dep resolves either to a rule (`resolvedRuleId`) or to a set of further
 *   deps (`expandedDepIds`), or is a source file, or is unfinished.
 * - `rule` nodes come from `graph-rules` blob records / `exec-rule` instants,
 *   which carry the rule's static deps and dynamic deps (a list of stages).
 *
 * Ids live in two namespaces (dep ids are Dune dep path strings, resolved
 * through the blob's `graph-dict`; rule ids are the rule's own `rule_id`,
 * which is per-process and not stable across watch iterations - see
 * `trace_graph_source.ts`). A dep's `resolvedRuleId` keys into `rules`; a
 * rule's dep ids key into `deps`.
 */

/**
 * Why a node was built - the node's `forced_by` blob field. `kind` is the
 * discriminator; the `RULE` / `DEP` variants carry the id of the rule / dep
 * that forced this node (which is the *source* of the build edge into it), the
 * path-bearing variants carry the relevant dune-file / build path, and the rest
 * carry nothing. See {@link isForcedEdge} for how this drives forced edges.
 */
export type ForcedBy =
  | {readonly kind: 'UNKNOWN'}
  | {readonly kind: 'RULE'; readonly rule: string}
  | {readonly kind: 'DEP'; readonly dep: string}
  | {readonly kind: 'DYNAMIC_INCLUDES'; readonly dynamicIncludes: string}
  | {readonly kind: 'GEN_RULES'; readonly genRules: string}
  | {readonly kind: 'PFORM'; readonly pform: string}
  | {readonly kind: 'CONFIGURATOR'}
  | {readonly kind: 'REQUEST'};

// A span's timing, reconstructed by pairing a `-start` instant with its
// matching `-finish` (or reading a single collapsed `-resolved` instant) - see
// `trace_graph_source.ts`. `startSliceId`/`finishSliceId` are the instants to
// navigate to; `durNs` is absent for a span that never got a finish (an
// unfinished span flushed at EOF - see `RuleOutcome`/`DepResolution`).
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

export interface DepNode {
  readonly kind: 'dep';
  // The dep's resolved path, read through `graph-dict` off its `dep_id`.
  readonly id: string;
  // The blob's intern id for `id`, before resolution - the join key against a
  // `build-dep` instant's `dep_id` arg.
  readonly depId: number;
  // Set iff the dep resolved to a rule.
  readonly resolvedRuleId?: string;
  // Set iff the dep resolved to further deps (an expansion, e.g. alias/glob).
  readonly expandedDepIds?: readonly string[];
  // Set iff the dep is a source file (no rule produces it).
  readonly isSource: boolean;
  // Set iff the blob recorded this dep as unfinished (crash/interrupt).
  readonly unfinished: boolean;
  // What forced this dep to be built, if recorded.
  readonly forcedBy?: ForcedBy;
  // Timing off the "build-dep" instants, if any resolved.
  readonly timing?: SpanTiming;
}

export interface RuleNode {
  readonly kind: 'rule';
  // The rule's own `rule_id` (per-process; see the file header).
  readonly id: string;
  // Static deps, resolved through `graph-dict`.
  readonly staticDepIds?: readonly string[];
  // Dynamic deps, a list of stages (each resolved through `graph-dict`).
  readonly dynamicDepIds?: readonly (readonly string[])[];
  // The rule's context directory; `targetFiles` / `targetDirs` are relative to
  // it. Resolved through `graph-dict` off the blob's `dir_id`.
  readonly dir?: string;
  // The rule's output targets relative to `dir`. Use {@link ruleTargetIds} for
  // the joined ids.
  readonly targetFiles?: readonly string[];
  readonly targetDirs?: readonly string[];
  // What forced this rule to run, if recorded.
  readonly forcedBy?: ForcedBy;
  // How the rule resolved: executed, a cache hit, or (crash/interrupt)
  // unfinished.
  readonly outcome: RuleOutcome;
  // Timing off the "exec-rule" instants, if any resolved.
  readonly timing?: SpanTiming;
  // Timing off the "exec-rule-action" instants (executed rules only). Per the
  // dune doc this measures "action in flight", including scheduler queue wait
  // - it is *not* bounded by `-j` and should not be read as worker occupancy.
  readonly actionTiming?: SpanTiming;
}

export type GraphNode = DepNode | RuleNode;

// Re-exported so callers of graph.ts don't also need to import graph_blob.ts
// for the node-facing outcome type.
export type {RuleOutcome} from './graph_blob';

// The one slice a node's "Go to slice" action should navigate to - its
// lifecycle start, or its finish if no start instant resolved (shouldn't
// happen in practice, but a finish-only node is still navigable).
export function primarySliceId(node: GraphNode): number | undefined {
  return node.timing?.startSliceId ?? node.timing?.finishSliceId;
}

// The rule id / dep id / dune-file path a `forcedBy` points at - the forcing
// rule id / dep id / dune-file path, or null for the payload-less kinds
// (CONFIGURATOR, REQUEST, UNKNOWN). Backs the `dune_node.forced_by_target` SQL
// column (see sql_graph.ts) and the display phrasing in
// `node_display.ts:forcedByText`, so writer and reader stay in step.
export function forcedByTarget(fb: ForcedBy): string | null {
  switch (fb.kind) {
    case 'RULE':
      return fb.rule;
    case 'DEP':
      return fb.dep;
    case 'DYNAMIC_INCLUDES':
      return fb.dynamicIncludes;
    case 'GEN_RULES':
      return fb.genRules;
    case 'PFORM':
      return fb.pform;
    default:
      return null;
  }
}

// Human-readable label for a node, used in lists and the SQL `label` column. The
// node's kind is conveyed by a chip alongside the label, so a rule shows its bare
// id (not `rule <id>`).
export function nodeLabel(node: GraphNode): string {
  return node.id;
}

// Pluralise a count, e.g. `1 dep` / `2 deps`.
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

// Join a target path (`targetFiles` / `targetDirs` entry) onto a rule's `dir`.
// An absent, empty or `.` dir leaves the relative path unchanged; otherwise a
// single `/` is inserted (tolerating a `dir` that already ends in one).
// Exported for sql_graph.ts's `dune_rule_target` rows, which - unlike
// {@link ruleTargetIds} - need to keep file/dir targets distinguishable.
export function joinDir(dir: string | undefined, rel: string): string {
  if (dir === undefined || dir === '' || dir === '.') return rel;
  return dir.endsWith('/') ? `${dir}${rel}` : `${dir}/${rel}`;
}

// A rule's output target ids: each of `targetFiles` / `targetDirs` joined onto
// `dir`. Target paths share the dep id namespace, so a target links to the
// build-dep node of the same id when one exists. These are outputs, not
// dependency edges, so they are deliberately absent from `edges()`.
export function ruleTargetIds(rule: RuleNode): readonly string[] {
  const rel = [...(rule.targetFiles ?? []), ...(rule.targetDirs ?? [])];
  return rel.map((t) => joinDir(rule.dir, t));
}

// A dep's resolution, as a short discriminator: `rule` | `source` |
// `expanded` | `unfinished`. The single place this is derived from a
// `DepNode`'s flattened fields - `sql_graph.ts`'s `dune_dep.resolution` column
// and the current-selection panel's status chip both read this rather than
// re-deriving it. `unfinished` also serves as the fallback for a dep with none
// of the three outcomes recorded - shouldn't happen given a well-formed blob,
// but a safe default rather than an invented fourth state.
export type DepResolutionKind = 'rule' | 'source' | 'expanded' | 'unfinished';

export function depResolutionKind(dep: DepNode): DepResolutionKind {
  if (dep.unfinished) return 'unfinished';
  if (dep.isSource) return 'source';
  if (dep.resolvedRuleId !== undefined) return 'rule';
  if (dep.expandedDepIds !== undefined) return 'expanded';
  return 'unfinished';
}

/**
 * The extracted build graph. Nodes are indexed by id within their kind's
 * namespace so edges (dep -> rule, dep -> deps, rule -> deps) can be resolved,
 * and by originating slice id so a timeline selection can be mapped back to its
 * node.
 */
export interface BuildGraph {
  readonly deps: ReadonlyMap<string, DepNode>;
  readonly rules: ReadonlyMap<string, RuleNode>;
  // Reverse index: the "build-dep" / "exec-rule" slice id -> its node.
  readonly bySliceId: ReadonlyMap<number, GraphNode>;
}

export const EMPTY_GRAPH: BuildGraph = {
  deps: new Map(),
  rules: new Map(),
  bySliceId: new Map(),
};

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
  load(): Promise<BuildGraph>;
}

// A stable per-node key spanning both id namespaces (dep ids are Dune strings,
// rule ids are stringified ints, so they could collide numerically).
export function nodeKey(kind: GraphNode['kind'], id: string): string {
  return `${kind}:${id}`;
}

// Why a forward edge exists, straight off the node that carries it: a rule's
// static/dynamic deps, or a dep's resolution (to a rule, or an expansion).
// Drives `dune_edge.edge_kind`/`dyn_deps_stage` in the SQL mirror.
export type EdgeKind = 'static' | 'dynamic' | 'resolved' | 'expanded';

// A directed build edge: `source` depends on `dest` (dest is the prerequisite).
export interface GraphEdge {
  readonly source: GraphNode;
  readonly dest: GraphNode;
  // Whether this is a *forced* edge (see {@link isForcedEdge}).
  readonly forced: boolean;
  // Set for a direct (one-hop) edge - i.e. every edge `edges()` yields.
  // Undefined for a contracted, multi-hop edge from `inducedEdges()`'s
  // hide-rules traversal, which has no single meaningful kind.
  readonly edgeKind?: EdgeKind;
  // The dynamic-dep stage index, set iff `edgeKind === 'dynamic'`.
  readonly dynDepsStage?: number;
}

/**
 * Whether the build edge `source -> dest` is *forced*: i.e. `dest` was forced
 * into the build by `source`, meaning `dest`'s `forcedBy` names `source`. Since
 * each node records a single forcer, forced edges pick out - per node - the one
 * dependency that caused it to be built (a spanning forest of the graph).
 *
 * `source` depends on `dest`, so `source` is the potential forcer: a rule
 * forces the deps it lists (`forcedBy.kind === 'RULE'`), a dep forces the rule
 * it resolves to and the deps it expands to (`forcedBy.kind === 'DEP'`). The
 * other `forcedBy` kinds name non-node forcers (dune files, the top-level
 * request, ...) and so never mark an edge forced.
 */
export function isForcedEdge(source: GraphNode, dest: GraphNode): boolean {
  const fb = dest.forcedBy;
  if (fb === undefined) return false;
  return source.kind === 'rule'
    ? fb.kind === 'RULE' && fb.rule === source.id
    : fb.kind === 'DEP' && fb.dep === source.id;
}

// One of a node's outgoing edges, tagged with why it exists (see
// {@link EdgeKind}). Yielded by {@link outEdges}; {@link edges} promotes each
// to a full {@link GraphEdge}.
export interface OutEdge {
  readonly dest: GraphNode;
  readonly edgeKind: EdgeKind;
  readonly dynDepsStage?: number;
}

/**
 * A node's outgoing edges: the prerequisite nodes it depends on (rule -> deps
 * for static/dynamic deps, dep -> rule for a resolved rule, dep -> deps for
 * expanded deps). Id references are resolved against the graph and dangling
 * ones skipped. This is the single place the forward edge shape is defined;
 * {@link edges} and {@link inducedEdges} both build on it.
 *
 * @yields each prerequisite {@link OutEdge} this node depends on.
 */
export function* outEdges(
  graph: BuildGraph,
  node: GraphNode,
): Iterable<OutEdge> {
  if (node.kind === 'dep') {
    if (node.resolvedRuleId !== undefined) {
      const rule = graph.rules.get(node.resolvedRuleId);
      if (rule !== undefined) yield {dest: rule, edgeKind: 'resolved'};
    }
    for (const id of node.expandedDepIds ?? []) {
      const dep = graph.deps.get(id);
      if (dep !== undefined) yield {dest: dep, edgeKind: 'expanded'};
    }
  } else {
    for (const id of node.staticDepIds ?? []) {
      const dep = graph.deps.get(id);
      if (dep !== undefined) yield {dest: dep, edgeKind: 'static'};
    }
    for (const [stage, group] of (node.dynamicDepIds ?? []).entries()) {
      for (const id of group) {
        const dep = graph.deps.get(id);
        if (dep !== undefined) {
          yield {dest: dep, edgeKind: 'dynamic', dynDepsStage: stage};
        }
      }
    }
  }
}

/**
 * The whole graph's edge set (source depends on dest). Both the SQL mirror
 * (sql_graph.ts) and the reverse index below build from this.
 *
 * @yields each build edge as a {@link GraphEdge}.
 */
export function* edges(graph: BuildGraph): Iterable<GraphEdge> {
  for (const source of graph.deps.values()) {
    for (const {dest, edgeKind, dynDepsStage} of outEdges(graph, source)) {
      yield {source, dest, forced: isForcedEdge(source, dest), edgeKind, dynDepsStage};
    }
  }
  for (const source of graph.rules.values()) {
    for (const {dest, edgeKind, dynDepsStage} of outEdges(graph, source)) {
      yield {source, dest, forced: isForcedEdge(source, dest), edgeKind, dynDepsStage};
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
  nodes: readonly GraphNode[],
  isHidden?: (node: GraphNode) => boolean,
): readonly GraphEdge[] {
  const inSet = new Map(nodes.map((n) => [nodeKey(n.kind, n.id), n] as const));
  const hidden = (n: GraphNode) => isHidden?.(n) ?? false;

  const result: GraphEdge[] = [];
  for (const source of nodes) {
    if (hidden(source)) continue;
    // dest key -> best edge found to it, so a diamond of hidden paths (or a
    // rule listing the same dep both statically and dynamically) yields one
    // edge, preferring a forced one if any path to that dest is forced.
    const bestByDest = new Map<string, GraphEdge>();
    // DFS over the induced subgraph, only stepping into nodes that are in the
    // selection; `forced` tracks whether every hop of the current path so far
    // was a forced edge. Visited is keyed by node+forced-so-far, since a path
    // that's still forced can reach further than one that already lost it.
    const seen = new Set<string>();
    const stack: Array<{node: GraphNode; forced: boolean}> = [
      {node: source, forced: true},
    ];
    seen.add(`${nodeKey(source.kind, source.id)}|1`);
    while (stack.length > 0) {
      const {node: current, forced} = stack.pop()!;
      for (const {dest: next} of outEdges(graph, current)) {
        const nextInSet = inSet.get(nodeKey(next.kind, next.id));
        if (nextInSet === undefined) continue; // outside the selection
        const nextForced = forced && isForcedEdge(current, next);
        if (hidden(nextInSet)) {
          const key = `${nodeKey(next.kind, next.id)}|${nextForced ? 1 : 0}`;
          if (seen.has(key)) continue;
          seen.add(key);
          stack.push({node: nextInSet, forced: nextForced});
          continue;
        }
        if (nextInSet === source) continue; // drop self-edges from contraction
        const destKey = nodeKey(next.kind, next.id);
        const existing = bestByDest.get(destKey);
        if (existing === undefined || (nextForced && !existing.forced)) {
          bestByDest.set(destKey, {
            source,
            dest: nextInSet,
            forced: nextForced,
          });
        }
      }
    }
    result.push(...bestByDest.values());
  }
  return result;
}

/**
 * Reverse adjacency of the build graph: maps a node's key to the nodes that
 * directly depend on it (i.e. that have a build edge pointing at it). Built
 * once per graph from {@link edges}; used to walk a node's parents/ancestors,
 * which the forward-only node model can't do.
 */
export type ReverseIndex = ReadonlyMap<string, readonly GraphNode[]>;

export function buildReverseIndex(graph: BuildGraph): ReverseIndex {
  // dest key -> (source key -> source node); the inner map de-dups sources that
  // reach the same dest via more than one edge (e.g. static + dynamic dep).
  const byDest = new Map<string, Map<string, GraphNode>>();
  for (const {source, dest} of edges(graph)) {
    const destKey = nodeKey(dest.kind, dest.id);
    let sources = byDest.get(destKey);
    if (sources === undefined) {
      sources = new Map();
      byDest.set(destKey, sources);
    }
    sources.set(nodeKey(source.kind, source.id), source);
  }

  const index = new Map<string, readonly GraphNode[]>();
  for (const [destKey, sources] of byDest) {
    index.set(destKey, [...sources.values()]);
  }
  return index;
}

// Nodes that directly depend on `node` (its immediate parents).
export function directParents(
  index: ReverseIndex,
  node: GraphNode,
): readonly GraphNode[] {
  return index.get(nodeKey(node.kind, node.id)) ?? [];
}

// All nodes that transitively depend on `node` (its ancestors), excluding
// `node` itself. Depth-first over reverse edges with a visited set - build
// graphs are DAGs, but the guard keeps us safe against accidental cycles.
export function ancestors(
  index: ReverseIndex,
  node: GraphNode,
): readonly GraphNode[] {
  const seen = new Set<string>([nodeKey(node.kind, node.id)]);
  const result: GraphNode[] = [];
  const stack: GraphNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const parent of directParents(index, current)) {
      const key = nodeKey(parent.kind, parent.id);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(parent);
      stack.push(parent);
    }
  }
  return result;
}

// All nodes `node` transitively depends on (its descendants), excluding `node`
// itself. Mirror of {@link ancestors}, but forward over {@link outEdges} - no
// index needed, since forward edges are already directly resolvable off the
// graph.
export function descendants(
  graph: BuildGraph,
  node: GraphNode,
): readonly GraphNode[] {
  const seen = new Set<string>([nodeKey(node.kind, node.id)]);
  const result: GraphNode[] = [];
  const stack: GraphNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const {dest: child} of outEdges(graph, current)) {
      const key = nodeKey(child.kind, child.id);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(child);
      stack.push(child);
    }
  }
  return result;
}

// The chain of nodes that transitively forced `node` into the build, walking
// `forcedBy` up to its root (excluding `node` itself). Since each node records
// a single forcer, this is a single-parent walk, not a search: it resolves a
// `RULE` forcer via `graph.rules` and a `DEP` forcer via `graph.deps`, and
// stops as soon as `forcedBy` is absent, names a non-node kind (the dune-file
// / request / configurator forcers - see {@link ForcedBy}), or names a
// dangling id. A visited set guards against a cyclic `forcedBy` even though
// that shouldn't happen in practice.
//
// This walks the same spanning forest as {@link isForcedEdge}, so its result
// is a subset of `ancestors(node)` wherever the forcer also lists `node` as a
// dependency; a `forcedBy` that doesn't (a trace inconsistency) still yields
// the node here, faithfully reflecting what the trace recorded.
export function forcers(
  graph: BuildGraph,
  node: GraphNode,
): readonly GraphNode[] {
  const seen = new Set<string>([nodeKey(node.kind, node.id)]);
  const result: GraphNode[] = [];
  let current: GraphNode | undefined = node;
  while (current !== undefined) {
    const fb: ForcedBy | undefined = current.forcedBy;
    if (fb === undefined) break;
    const forcer: GraphNode | undefined =
      fb.kind === 'RULE'
        ? graph.rules.get(fb.rule)
        : fb.kind === 'DEP'
          ? graph.deps.get(fb.dep)
          : undefined;
    if (forcer === undefined) break;
    const key = nodeKey(forcer.kind, forcer.id);
    if (seen.has(key)) break;
    seen.add(key);
    result.push(forcer);
    current = forcer;
  }
  return result;
}
