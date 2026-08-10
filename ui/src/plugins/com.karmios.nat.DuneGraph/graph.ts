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
 * The build graph has two kinds of node:
 *
 * - `dep` nodes come from "build-dep" slices. A dep resolves either to a rule
 *   (`resolvedRuleId`) or to a set of further deps (`expandedDepIds`).
 * - `rule` nodes come from "exec-rule" slices, which carry the rule's static
 *   deps (`dune.deps`) and dynamic deps (`dune.dyn_deps`) in their own args.
 *
 * Ids live in two namespaces (dep ids are Dune dep strings; rule ids are the
 * stringified `dune.rule_id` int). A dep's `resolvedRuleId` keys into `rules`;
 * a rule's dep ids key into `deps`.
 */

export interface DepNode {
  readonly kind: 'dep';
  // The `dune.dep` string identifying this dep.
  readonly id: string;
  // The "build-dep" slice this node was extracted from.
  readonly sliceId: number;
  // Set iff the dep resolved to a rule (`dune.dep_outcome.rule`).
  readonly resolvedRuleId?: string;
  // Set iff the dep resolved to further deps (`dune.dep_outcome.expanded`).
  readonly expandedDepIds?: readonly string[];
}

export interface RuleNode {
  readonly kind: 'rule';
  // The stringified `dune.rule_id` identifying this rule.
  readonly id: string;
  // The "exec-rule" slice this node was extracted from.
  readonly sliceId: number;
  // Static deps from the exec-rule slice's `dune.deps` arg.
  readonly staticDepIds?: readonly string[];
  // Dynamic deps from the exec-rule slice's `dune.dyn_deps` arg, a list of
  // lists.
  readonly dynamicDepIds?: readonly (readonly string[])[];
}

export type GraphNode = DepNode | RuleNode;

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
