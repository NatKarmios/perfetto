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

import type {GraphEdge, NodeId} from './graph';
import {descendants, edges, forcers, inducedEdges, ReverseIndex} from './graph';
import type {TestGraph} from './graph_test_helper';
import {dep, rule, testGraph} from './graph_test_helper';

// Simplified edge shape for assertions: (source name, dest name, forced).
function simplify(g: TestGraph, edgeList: readonly GraphEdge[]) {
  return edgeList
    .map((e) => [g.name(e.source), g.name(e.dest), e.forced] as const)
    .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
}

describe('inducedEdges', () => {
  // Every node of the fixture, which is what the graph pane passes in.
  const all = (g: TestGraph): NodeId[] =>
    Array.from({length: g.graph.nodeCount}, (_, id) => id);
  const isRule = (g: TestGraph) => (id: NodeId) => g.graph.isRule(id);

  it('reproduces the plain induced subgraph when isHidden is omitted', () => {
    const g = testGraph([
      dep('a', {resolvedRule: 'r1'}),
      rule('r1', {staticDeps: ['b']}),
      dep('b'),
    ]);

    expect(simplify(g, inducedEdges(g.graph, all(g)))).toEqual([
      ['a', 'r1', false],
      ['r1', 'b', false],
    ]);
  });

  it('collapses dep -> rule -> dep into dep -> dep when rules are hidden', () => {
    const g = testGraph([
      dep('a', {resolvedRule: 'r1'}),
      rule('r1', {staticDeps: ['b']}),
      dep('b'),
    ]);

    expect(simplify(g, inducedEdges(g.graph, all(g), isRule(g)))).toEqual([
      ['a', 'b', false],
    ]);
  });

  it('collapses a multi-hop chain through several hidden nodes of mixed kinds', () => {
    // a -> r1 -> mid -> r2 -> c, with r1, mid and r2 all hidden.
    const g = testGraph([
      dep('a', {resolvedRule: 'r1'}),
      rule('r1', {staticDeps: ['mid']}),
      dep('mid', {resolvedRule: 'r2'}),
      rule('r2', {staticDeps: ['c']}),
      dep('c'),
    ]);
    const hidden = (id: NodeId) => g.graph.isRule(id) || g.name(id) === 'mid';

    expect(simplify(g, inducedEdges(g.graph, all(g), hidden))).toEqual([
      ['a', 'c', false],
    ]);
  });

  it('emits exactly one edge for a diamond of hidden paths', () => {
    // a expands to d1/d2; d1 -> r1 -> b and d2 -> r2 -> b, everything but a/b
    // hidden.
    const g = testGraph([
      dep('a', {expanded: ['d1', 'd2']}),
      dep('d1', {resolvedRule: 'r1'}),
      rule('r1', {staticDeps: ['b']}),
      dep('d2', {resolvedRule: 'r2'}),
      rule('r2', {staticDeps: ['b']}),
      dep('b'),
    ]);
    const hidden = (id: NodeId) => g.name(id) !== 'a' && g.name(id) !== 'b';

    expect(simplify(g, inducedEdges(g.graph, all(g), hidden))).toEqual([
      ['a', 'b', false],
    ]);
  });

  it('marks a contracted edge forced only when every hop was forced', () => {
    const g = testGraph([
      // r1 is NOT named as forced by a, so a -> r1 is not forced.
      dep('a', {resolvedRule: 'r1'}),
      rule('r1', {staticDeps: ['b']}),
      dep('b', {forcedBy: {rule: 'r1'}}),
    ]);

    expect(simplify(g, inducedEdges(g.graph, all(g), isRule(g)))).toEqual([
      ['a', 'b', false],
    ]);
  });

  it('prefers a forced path when a diamond has both forced and unforced routes', () => {
    const g = testGraph([
      dep('a', {expanded: ['d1', 'd2']}),
      // Fully-forced path: a -> d1 -> r1 -> b.
      dep('d1', {resolvedRule: 'r1', forcedBy: {dep: 'a'}}),
      rule('r1', {staticDeps: ['b'], forcedBy: {dep: 'd1'}}),
      // Unforced path: a -> d2 -> r2 -> b (d2 not forced by a).
      dep('d2', {resolvedRule: 'r2'}),
      rule('r2', {staticDeps: ['b']}),
      dep('b', {forcedBy: {rule: 'r1'}}),
    ]);
    const hidden = (id: NodeId) => g.name(id) !== 'a' && g.name(id) !== 'b';

    expect(simplify(g, inducedEdges(g.graph, all(g), hidden))).toEqual([
      ['a', 'b', true],
    ]);
  });

  it('emits nothing for a hidden rule with no visible prerequisite', () => {
    const g = testGraph([
      dep('a', {resolvedRule: 'r1'}),
      rule('r1'), // no static or dynamic deps at all.
    ]);

    expect(inducedEdges(g.graph, all(g), isRule(g))).toEqual([]);
  });
});

describe('descendants', () => {
  it('walks transitively through dep -> rule -> dep, excluding the start node', () => {
    const g = testGraph([
      dep('a', {resolvedRule: 'r1'}),
      rule('r1', {staticDeps: ['b']}),
      dep('b'),
    ]);

    expect(g.names(descendants(g.graph, g.id('a')))).toEqual(['b', 'r1']);
  });

  it('de-dups a diamond reachable via two paths', () => {
    const g = testGraph([
      dep('a', {expanded: ['d1', 'd2']}),
      dep('d1', {resolvedRule: 'r1'}),
      rule('r1', {staticDeps: ['b']}),
      dep('d2', {resolvedRule: 'r2'}),
      rule('r2', {staticDeps: ['b']}),
      dep('b'),
    ]);

    expect(g.names(descendants(g.graph, g.id('a')))).toEqual([
      'b',
      'd1',
      'd2',
      'r1',
      'r2',
    ]);
  });

  it('skips references the blob recorded no node for', () => {
    const g = testGraph([
      dep('a', {resolvedRule: 'missing'}),
      dep('b', {expanded: ['also-missing']}),
    ]);

    expect(descendants(g.graph, g.id('a'))).toEqual([]);
    expect(descendants(g.graph, g.id('b'))).toEqual([]);
  });

  it('terminates on a cycle', () => {
    const g = testGraph([
      dep('a', {expanded: ['b']}),
      dep('b', {expanded: ['a']}),
    ]);

    expect(g.names(descendants(g.graph, g.id('a')))).toEqual(['b']);
  });
});

describe('ReverseIndex', () => {
  it('reports the nodes that directly depend on a node', () => {
    const g = testGraph([
      dep('a', {resolvedRule: 'r1'}),
      dep('a2', {resolvedRule: 'r1'}),
      rule('r1', {staticDeps: ['b']}),
      dep('b'),
    ]);
    const index = ReverseIndex.build(g.graph);

    expect(g.names(index.parents(g.id('r1')))).toEqual(['a', 'a2']);
    expect(g.names(index.parents(g.id('b')))).toEqual(['r1']);
    expect(index.parents(g.id('a'))).toEqual([]);
  });

  it('de-dups a parent that reaches the same node twice', () => {
    // r1 lists b both statically and dynamically: two edges, one dependant.
    const g = testGraph([
      rule('r1', {staticDeps: ['b'], dynamicDeps: [['b']]}),
      dep('b'),
    ]);
    const index = ReverseIndex.build(g.graph);

    expect(g.names(index.parents(g.id('b')))).toEqual(['r1']);
  });

  it('walks ancestors transitively, excluding the node itself', () => {
    const g = testGraph([
      dep('a', {resolvedRule: 'r1'}),
      rule('r1', {staticDeps: ['b']}),
      dep('b', {resolvedRule: 'r2'}),
      rule('r2'),
    ]);
    const index = ReverseIndex.build(g.graph);

    expect(g.names(index.ancestors(g.id('r2')))).toEqual(['a', 'b', 'r1']);
  });

  it('terminates on a cycle', () => {
    const g = testGraph([
      dep('a', {expanded: ['b']}),
      dep('b', {expanded: ['a']}),
    ]);
    const index = ReverseIndex.build(g.graph);

    expect(g.names(index.ancestors(g.id('a')))).toEqual(['b']);
  });
});

describe('forcers', () => {
  it('walks a multi-hop RULE/DEP forcedBy chain', () => {
    const g = testGraph([
      rule('r1', {forcedBy: {kind: 'REQUEST'}}),
      dep('d1', {forcedBy: {rule: 'r1'}}),
      rule('r2', {forcedBy: {dep: 'd1'}}),
    ]);

    expect(g.names(forcers(g.graph, g.id('r2')))).toEqual(['d1', 'r1']);
  });

  it('stops at a non-node forcedBy kind', () => {
    const g = testGraph([rule('r1', {forcedBy: {kind: 'REQUEST'}})]);

    expect(forcers(g.graph, g.id('r1'))).toEqual([]);
  });

  it('is empty when forcedBy is absent', () => {
    const g = testGraph([rule('r1')]);

    expect(forcers(g.graph, g.id('r1'))).toEqual([]);
  });

  it('is empty when the named forcer has no node', () => {
    const g = testGraph([rule('r1', {forcedBy: {dep: 'missing'}})]);

    expect(forcers(g.graph, g.id('r1'))).toEqual([]);
  });

  it('terminates on a cyclic forcedBy', () => {
    const g = testGraph([
      rule('r1', {forcedBy: {dep: 'd1'}}),
      dep('d1', {forcedBy: {rule: 'r1'}}),
    ]);

    expect(g.names(forcers(g.graph, g.id('r1')))).toEqual(['d1']);
  });
});

describe('ruleTargets', () => {
  const paths = (g: TestGraph, name: string) =>
    [...g.graph.ruleTargets(g.id(name))].map((t) => t.path);

  it('joins target files then target dirs onto dir', () => {
    const g = testGraph([
      rule('r1', {
        dir: 'src/foo',
        targetFiles: ['a.ml', 'a.mli'],
        targetDirs: ['sub'],
      }),
    ]);

    expect([...g.graph.ruleTargets(g.id('r1'))]).toEqual([
      {path: 'src/foo/a.ml', isDir: false},
      {path: 'src/foo/a.mli', isDir: false},
      {path: 'src/foo/sub', isDir: true},
    ]);
  });

  it('returns relative names verbatim when dir is absent', () => {
    const g = testGraph([rule('r1', {targetFiles: ['a.ml']})]);
    expect(paths(g, 'r1')).toEqual(['a.ml']);
  });

  it('does not double the separator when dir already ends in /', () => {
    const g = testGraph([rule('r1', {dir: 'src/foo/', targetFiles: ['a.ml']})]);
    expect(paths(g, 'r1')).toEqual(['src/foo/a.ml']);
  });

  it('treats a "." dir as no dir', () => {
    const g = testGraph([rule('r1', {dir: '.', targetFiles: ['a.ml']})]);
    expect(paths(g, 'r1')).toEqual(['a.ml']);
  });

  it('returns nothing when there are no target args', () => {
    const g = testGraph([rule('r1', {dir: 'src/foo'})]);
    expect(paths(g, 'r1')).toEqual([]);
  });
});

describe('labelOf / path / forcedByOf', () => {
  it('resolves a dep to its interned path, and a rule to its bare id', () => {
    const g = testGraph([dep('a/b.ml'), rule('r1')]);

    expect(g.graph.labelOf(g.id('a/b.ml'))).toEqual('a/b.ml');
    expect(g.graph.labelOf(g.id('r1'))).toEqual(
      String(g.graph.traceIdOf(g.id('r1'))),
    );
  });

  it('shows an unknown dict id as #<id> rather than blank', () => {
    const g = testGraph([]);
    // 1e9 is never interned by the fixtures, so it stands in for a dep id the
    // blob referenced but the dict didn't hold.
    expect(g.graph.path(1e9)).toEqual('#1000000000');
  });

  it('resolves a forcedBy target per kind, and nothing for the payload-less ones', () => {
    const g = testGraph([
      dep('forcer.ml'),
      rule('r1'),
      dep('by-rule', {forcedBy: {rule: 'r1'}}),
      dep('by-dep', {forcedBy: {dep: 'forcer.ml'}}),
      dep('by-file', {forcedBy: {kind: 'GEN_RULES', path: 'dir/dune'}}),
      dep('by-request', {forcedBy: {kind: 'REQUEST'}}),
    ]);

    expect(g.graph.forcedByOf(g.id('by-rule'))).toEqual({
      kind: 'RULE',
      node: g.id('r1'),
      target: String(g.graph.traceIdOf(g.id('r1'))),
    });
    expect(g.graph.forcedByOf(g.id('by-dep'))).toEqual({
      kind: 'DEP',
      node: g.id('forcer.ml'),
      target: 'forcer.ml',
    });
    expect(g.graph.forcedByOf(g.id('by-file'))).toEqual({
      kind: 'GEN_RULES',
      target: 'dir/dune',
    });
    expect(g.graph.forcedByOf(g.id('by-request'))).toEqual({kind: 'REQUEST'});
    expect(g.graph.forcedByOf(g.id('forcer.ml'))).toBeUndefined();
  });

  it('keeps the id of a forcer the blob never recorded', () => {
    const g = testGraph([dep('a', {forcedBy: {dep: 'missing.ml'}})]);
    const forcedBy = g.graph.forcedByOf(g.id('a'));

    expect(forcedBy?.kind).toEqual('DEP');
    expect(forcedBy?.node).toBeUndefined();
    // The dict holds the name (the fixture interned it), there just is no node.
    expect(forcedBy?.target).toEqual('missing.ml');
  });
});

describe('edges', () => {
  it('tags every edge with its edgeKind, and a dynamic edge with its stage', () => {
    const g = testGraph([
      dep('a', {resolvedRule: 'r1'}),
      rule('r1', {staticDeps: ['b'], dynamicDeps: [['c'], ['d']]}),
      dep('b'),
      dep('c'),
      dep('d', {expanded: ['e']}),
      dep('e'),
    ]);

    const byPair = new Map(
      [...edges(g.graph)].map((edge) => [
        `${g.name(edge.source)}->${g.name(edge.dest)}`,
        edge,
      ]),
    );
    expect(byPair.get('a->r1')).toMatchObject({edgeKind: 'resolved'});
    expect(byPair.get('r1->b')).toMatchObject({edgeKind: 'static'});
    expect(byPair.get('r1->c')).toMatchObject({
      edgeKind: 'dynamic',
      dynDepsStage: 0,
    });
    expect(byPair.get('r1->d')).toMatchObject({
      edgeKind: 'dynamic',
      dynDepsStage: 1,
    });
    expect(byPair.get('d->e')).toMatchObject({edgeKind: 'expanded'});
  });

  it('drops references the blob recorded no node for, keeping the rest', () => {
    const g = testGraph([
      rule('r1', {staticDeps: ['b', 'missing', 'c']}),
      dep('b'),
      dep('c'),
    ]);

    expect(simplify(g, [...edges(g.graph)])).toEqual([
      ['r1', 'b', false],
      ['r1', 'c', false],
    ]);
    // The dropped reference is still one of the rule's declared static deps.
    expect(g.graph.staticDepCount(g.id('r1'))).toEqual(3);
  });
});
