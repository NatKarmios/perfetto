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

import type {BuildGraph, DepNode, GraphNode, RuleNode} from './graph';
import {inducedEdges} from './graph';

function dep(id: string, opts: Partial<DepNode> = {}): DepNode {
  return {kind: 'dep', id, sliceId: 0, ...opts};
}

function rule(id: string, opts: Partial<RuleNode> = {}): RuleNode {
  return {kind: 'rule', id, sliceId: 0, ...opts};
}

function graphOf(nodes: readonly GraphNode[]): BuildGraph {
  const deps = new Map<string, DepNode>();
  const rules = new Map<string, RuleNode>();
  for (const n of nodes) {
    if (n.kind === 'dep') deps.set(n.id, n);
    else rules.set(n.id, n);
  }
  return {deps, rules, bySliceId: new Map()};
}

// Simplified edge shape for assertions: (source id, dest id, forced).
function simplify(
  edges: readonly {source: GraphNode; dest: GraphNode; forced: boolean}[],
) {
  return edges
    .map((e) => [e.source.id, e.dest.id, e.forced] as const)
    .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
}

const isRule = (n: GraphNode) => n.kind === 'rule';

describe('inducedEdges', () => {
  it('reproduces the plain induced subgraph when isHidden is omitted', () => {
    const a = dep('a', {resolvedRuleId: 'r1'});
    const r1 = rule('r1', {staticDepIds: ['b']});
    const b = dep('b');
    const graph = graphOf([a, r1, b]);

    expect(simplify(inducedEdges(graph, [a, r1, b]))).toEqual([
      ['a', 'r1', false],
      ['r1', 'b', false],
    ]);
  });

  it('collapses dep -> rule -> dep into dep -> dep when rules are hidden', () => {
    const a = dep('a', {resolvedRuleId: 'r1'});
    const r1 = rule('r1', {staticDepIds: ['b']});
    const b = dep('b');
    const graph = graphOf([a, r1, b]);

    expect(simplify(inducedEdges(graph, [a, r1, b], isRule))).toEqual([
      ['a', 'b', false],
    ]);
  });

  it('collapses a multi-hop chain through several hidden nodes of mixed kinds', () => {
    // a -> r1 -> mid -> r2 -> c, with r1, mid and r2 all hidden.
    const a = dep('a', {resolvedRuleId: 'r1'});
    const r1 = rule('r1', {staticDepIds: ['mid']});
    const mid = dep('mid', {resolvedRuleId: 'r2'});
    const r2 = rule('r2', {staticDepIds: ['c']});
    const c = dep('c');
    const graph = graphOf([a, r1, mid, r2, c]);
    const isHidden = (n: GraphNode) => n.kind === 'rule' || n.id === 'mid';

    expect(
      simplify(inducedEdges(graph, [a, r1, mid, r2, c], isHidden)),
    ).toEqual([['a', 'c', false]]);
  });

  it('emits exactly one edge for a diamond of hidden paths', () => {
    // a expands to d1/d2; d1 -> r1 -> b and d2 -> r2 -> b, everything but a/b
    // hidden.
    const a = dep('a', {expandedDepIds: ['d1', 'd2']});
    const d1 = dep('d1', {resolvedRuleId: 'r1'});
    const r1 = rule('r1', {staticDepIds: ['b']});
    const d2 = dep('d2', {resolvedRuleId: 'r2'});
    const r2 = rule('r2', {staticDepIds: ['b']});
    const b = dep('b');
    const graph = graphOf([a, d1, r1, d2, r2, b]);
    const isHidden = (n: GraphNode) => n.id !== 'a' && n.id !== 'b';

    const result = inducedEdges(graph, [a, d1, r1, d2, r2, b], isHidden);
    expect(simplify(result)).toEqual([['a', 'b', false]]);
  });

  it('marks a contracted edge forced only when every hop was forced', () => {
    const a = dep('a', {resolvedRuleId: 'r1'});
    // r1 is NOT named as forced by a, so a -> r1 is not forced.
    const r1 = rule('r1', {staticDepIds: ['b']});
    const b = dep('b', {forcedBy: {kind: 'RULE', rule: 'r1'}});
    const graph = graphOf([a, r1, b]);

    expect(simplify(inducedEdges(graph, [a, r1, b], isRule))).toEqual([
      ['a', 'b', false],
    ]);
  });

  it('prefers a forced path when a diamond has both forced and unforced routes', () => {
    const a = dep('a', {expandedDepIds: ['d1', 'd2']});
    // Fully-forced path: a -> d1 -> r1 -> b.
    const d1 = dep('d1', {
      resolvedRuleId: 'r1',
      forcedBy: {kind: 'DEP', dep: 'a'},
    });
    const r1 = rule('r1', {
      staticDepIds: ['b'],
      forcedBy: {kind: 'DEP', dep: 'd1'},
    });
    // Unforced path: a -> d2 -> r2 -> b (d2 not forced by a).
    const d2 = dep('d2', {resolvedRuleId: 'r2'});
    const r2 = rule('r2', {staticDepIds: ['b']});
    const b = dep('b', {forcedBy: {kind: 'RULE', rule: 'r1'}});
    const graph = graphOf([a, d1, r1, d2, r2, b]);
    const isHidden = (n: GraphNode) => n.id !== 'a' && n.id !== 'b';

    expect(
      simplify(inducedEdges(graph, [a, d1, r1, d2, r2, b], isHidden)),
    ).toEqual([['a', 'b', true]]);
  });

  it('emits nothing for a hidden rule with no visible prerequisite', () => {
    const a = dep('a', {resolvedRuleId: 'r1'});
    const r1 = rule('r1'); // no staticDepIds/dynamicDepIds at all.
    const graph = graphOf([a, r1]);

    expect(inducedEdges(graph, [a, r1], isRule)).toEqual([]);
  });
});
