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
 * Graph fixtures for the unit tests. Only used by `*_unittest.ts`.
 *
 * Everything in the real model is an integer - a node is a dense id, a path is a
 * dict id, a rule is its `rule_id` (see graph.ts) - which makes hand-built
 * fixtures unreadable: `staticDeps: [7]` says nothing, and an assertion on node
 * `3` says less. So a fixture is written in *names*:
 *
 *     const g = testGraph([
 *       dep('a', {resolvedRule: 'r1'}),
 *       rule('r1', {staticDeps: ['b']}),
 *       dep('b'),
 *     ]);
 *     expect(g.names(descendants(g.graph, g.id('a')))).toEqual(['b', 'r1']);
 *
 * `id(name)` is the node id a name was given, and `names(ids)` maps node ids back
 * to the names the test wrote (sorted, for order-independent assertions). A name
 * that no fixture defines still interns to an id, which is how a test writes a
 * reference the blob never recorded a node for (see `dangling` in graph.ts).
 *
 * The fixtures go through the real {@link GraphBuilder} and the real record
 * types, so they exercise the ingest and linking path rather than a parallel
 * hand-rolled one.
 */

import type {BuildGraph, NodeId} from './graph';
import {GraphBuilder} from './graph_build';
import type {
  DepRecord,
  ForcedByTag,
  RuleRecord,
  StringTable,
} from './graph_blob';

// Names are interned per graph, in two namespaces: dep names become dict ids
// (a dep's path), rule names become `rule_id`s.
class Names {
  private readonly ids = new Map<string, number>();
  private readonly names = new Map<number, string>();
  // Rule ids and dict ids are independent counters in the blob, so they may
  // collide; starting them at different values makes a mixed-up id obvious in a
  // failing test rather than accidentally valid.
  private next: number;

  constructor(kind: 'dep' | 'rule') {
    this.next = kind === 'rule' ? 100 : 0;
  }

  id(name: string): number {
    const existing = this.ids.get(name);
    if (existing !== undefined) return existing;
    // A digits-only name *is* the id it interns to, so a test that asserts on a
    // rule's label - which is its `rule_id`, not a name the graph knows - can
    // write the id it wants to see.
    const numeric = /^\d+$/.test(name) ? Number(name) : undefined;
    const id =
      numeric !== undefined && !this.names.has(numeric)
        ? numeric
        : this.fresh();
    this.ids.set(name, id);
    this.names.set(id, name);
    return id;
  }

  private fresh(): number {
    while (this.names.has(this.next)) this.next++;
    return this.next++;
  }

  nameOf(id: number): string | undefined {
    return this.names.get(id);
  }

  // The dep names as an intern table, i.e. what the blob's `graph-dict` would
  // hold for this fixture.
  strings(): StringTable {
    return {
      get: (id: number) => this.names.get(id),
      size: this.names.size,
      entries: () => [...this.names].sort((a, b) => a[0] - b[0]),
    };
  }
}

// A fixture's node, as written by a test: a record plus the name it's filed
// under. `build` is deferred so every name in the fixture is interned before any
// record refers to one.
export interface NodeSpec {
  readonly kind: 'dep' | 'rule';
  readonly name: string;
  build(names: FixtureNames): DepRecord | RuleRecord;
}

export interface FixtureNames {
  dep(name: string): number;
  rule(name: string): number;
}

export interface DepOpts {
  // Names of the deps this one expands to.
  readonly expanded?: readonly string[];
  // Name of the rule this dep resolves to.
  readonly resolvedRule?: string;
  readonly isSource?: boolean;
  // Dune couldn't determine the resolution (its build failed/was cancelled).
  readonly unknown?: boolean;
  readonly unfinished?: boolean;
  // How building the dep itself ended; `ok` unless said otherwise.
  readonly status?: DepRecord['status'];
  readonly forcedBy?: ForcedBySpec;
}

export interface RuleOpts {
  readonly staticDeps?: readonly string[];
  readonly dynamicDeps?: readonly (readonly string[])[];
  readonly dir?: string;
  readonly targetFiles?: readonly string[];
  readonly targetDirs?: readonly string[];
  readonly outcome?: RuleRecord['outcome'];
  // Dune couldn't determine this rule's deps at all - distinct from having
  // none, which is what leaving `staticDeps` unset means.
  readonly depsUnknown?: boolean;
  readonly forcedBy?: ForcedBySpec;
}

// A `forced_by` written in names: `{rule}` / `{dep}` for the node-naming kinds,
// `{path}` for the dune-file kinds, or a bare payload-less kind.
export type ForcedBySpec =
  | {readonly rule: string}
  // A rule that forced this node while recovering its own deps after failing.
  | {readonly ruleRecovery: string}
  | {readonly dep: string}
  | {
      readonly kind: 'DYNAMIC_INCLUDES' | 'GEN_RULES' | 'PFORM';
      readonly path: string;
    }
  | {readonly kind: 'CONFIGURATOR' | 'REQUEST' | 'UNKNOWN'};

function forcedByTag(
  names: FixtureNames,
  spec: ForcedBySpec | undefined,
): ForcedByTag | undefined {
  if (spec === undefined) return undefined;
  if ('rule' in spec) return {kind: 'RULE', ruleId: names.rule(spec.rule)};
  if ('ruleRecovery' in spec) {
    return {kind: 'RULE_RECOVERY', ruleId: names.rule(spec.ruleRecovery)};
  }
  if ('dep' in spec) return {kind: 'DEP', depId: names.dep(spec.dep)};
  if ('path' in spec) return {kind: spec.kind, pathId: names.dep(spec.path)};
  return {kind: spec.kind};
}

export function dep(name: string, opts: DepOpts = {}): NodeSpec {
  return {
    kind: 'dep',
    name,
    build: (names) => ({
      depId: names.dep(name),
      resolution: depResolution(names, opts),
      forcedBy: forcedByTag(names, opts.forcedBy),
      status: opts.status ?? 'ok',
    }),
  };
}

function depResolution(
  names: FixtureNames,
  opts: DepOpts,
): DepRecord['resolution'] {
  if (opts.resolvedRule !== undefined) {
    return {kind: 'rule', ruleId: names.rule(opts.resolvedRule)};
  }
  if (opts.expanded !== undefined) {
    return {kind: 'expanded', depIds: opts.expanded.map((n) => names.dep(n))};
  }
  if (opts.isSource === true) return {kind: 'source'};
  if (opts.unknown === true) return {kind: 'unknown'};
  if (opts.unfinished === true) return {kind: 'unfinished'};
  // A dep with nothing said about it: an expansion to nothing, so it has no
  // out-edges and no resolution of its own.
  return {kind: 'unfinished'};
}

export function rule(name: string, opts: RuleOpts = {}): NodeSpec {
  return {
    kind: 'rule',
    name,
    build: (names) => ({
      ruleId: names.rule(name),
      dirId: opts.dir === undefined ? undefined : names.dep(opts.dir),
      targetFileIds: (opts.targetFiles ?? []).map((n) => names.dep(n)),
      targetDirIds: (opts.targetDirs ?? []).map((n) => names.dep(n)),
      outcome: opts.outcome ?? 'executed',
      forcedBy: forcedByTag(names, opts.forcedBy),
      depIds: (opts.staticDeps ?? []).map((n) => names.dep(n)),
      depsUnknown: opts.depsUnknown ?? false,
      dynDepStages: (opts.dynamicDeps ?? []).map((stage) =>
        stage.map((n) => names.dep(n)),
      ),
    }),
  };
}

/**
 * A built graph plus the name <-> node id mapping the fixture was written in.
 */
export class TestGraph {
  constructor(
    readonly graph: BuildGraph,
    private readonly deps: Names,
    private readonly rules: Names,
    private readonly byName: ReadonlyMap<string, NodeId>,
  ) {}

  // The node id the fixture's `name` was built as. Throws rather than returning
  // undefined: a test asking for a name it didn't define is a bug in the test.
  id(name: string): NodeId {
    const node = this.byName.get(name);
    if (node === undefined) throw new Error(`no fixture node named ${name}`);
    return node;
  }

  // The fixture name of a node id - a dep's path or a rule's name, i.e. exactly
  // what the test wrote.
  name(id: NodeId): string {
    const traceId = this.graph.traceIdOf(id);
    const name = this.graph.isRule(id)
      ? this.rules.nameOf(traceId)
      : this.deps.nameOf(traceId);
    return name ?? `#${traceId}`;
  }

  // Fixture names of a node list, sorted - for order-independent assertions.
  names(ids: readonly NodeId[]): string[] {
    return ids.map((id) => this.name(id)).sort();
  }
}

// Builds a graph from `specs`, feeding them through the real builder in the same
// order the blob would (rules, then deps).
export function testGraph(specs: readonly NodeSpec[]): TestGraph {
  const deps = new Names('dep');
  const rules = new Names('rule');
  const names: FixtureNames = {
    dep: (name) => deps.id(name),
    rule: (name) => rules.id(name),
  };
  // Intern every fixture's own name first, so ids don't depend on the order
  // references happen to be resolved in.
  for (const spec of specs) names[spec.kind](spec.name);

  const builder = new GraphBuilder();
  const built = specs.map((spec) => ({
    kind: spec.kind,
    record: spec.build(names),
  }));
  builder.strings(deps.strings());
  for (const {kind, record} of built) {
    if (kind === 'rule') builder.rule(record as RuleRecord);
  }
  for (const {kind, record} of built) {
    if (kind === 'dep') builder.dep(record as DepRecord);
  }

  const graph = builder.finish();
  const byName = new Map<string, NodeId>();
  for (const spec of specs) {
    const node =
      spec.kind === 'rule'
        ? graph.nodeForRuleId(rules.id(spec.name))
        : graph.nodeForDepId(deps.id(spec.name));
    if (node !== undefined) byName.set(spec.name, node);
  }
  return new TestGraph(graph, deps, rules, byName);
}
