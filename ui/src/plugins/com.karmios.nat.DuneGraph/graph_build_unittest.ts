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
 * Tests for the ingest/link path itself: the id layout, the CSR, and what the
 * builder does with a record the blob shouldn't have written but might.
 *
 * The higher-level fixtures in `graph_test_helper.ts` (used by
 * `graph_unittest.ts`) go through this same builder, so the walks are covered
 * there; here the records are written out by hand, since the point is the shapes
 * a fixture builder wouldn't produce.
 */

import type {DepRecord, RuleRecord, StringTable} from './graph_blob';
import {GraphBuilder} from './graph_build';
import type {BuildGraph} from './graph';
import {danglingId, edges, isDangling} from './graph';

// A dict holding `id -> "s<id>"` for every id a test uses, so a dep's label is
// recognisable without the test having to spell out an intern table.
const DICT: StringTable = {
  get: (id: number) => (id >= 0 && id < 1000 ? `s${id}` : undefined),
  size: 1000,
  *entries() {
    for (let id = 0; id < 1000; id++) yield [id, `s${id}`] as const;
  },
};

function ruleRecord(
  ruleId: number,
  opts: Partial<RuleRecord> = {},
): RuleRecord {
  return {
    ruleId,
    targetFileIds: [],
    targetDirIds: [],
    outcome: 'executed',
    depIds: [],
    dynDepStages: [],
    ...opts,
  };
}

function depRecord(depId: number, opts: Partial<DepRecord> = {}): DepRecord {
  return {depId, resolution: {kind: 'source'}, ...opts};
}

function build(
  rules: readonly RuleRecord[],
  deps: readonly DepRecord[],
): BuildGraph {
  const builder = new GraphBuilder();
  builder.strings(DICT);
  for (const rule of rules) builder.rule(rule);
  for (const dep of deps) builder.dep(dep);
  return builder.finish();
}

// A node's raw CSR run, dangling references and all.
function targets(graph: BuildGraph, id: number): number[] {
  const out: number[] = [];
  for (let i = graph.outStart(id); i < graph.outEnd(id); i++) {
    out.push(graph.outTarget(i));
  }
  return out;
}

describe('GraphBuilder id layout', () => {
  it('numbers rules from zero and deps after them', () => {
    const graph = build(
      [ruleRecord(10), ruleRecord(11)],
      [depRecord(1), depRecord(2), depRecord(3)],
    );

    expect(graph.ruleCount).toBe(2);
    expect(graph.depCount).toBe(3);
    expect(graph.nodeCount).toBe(5);
    expect(graph.nodeForRuleId(10)).toBe(0);
    expect(graph.nodeForRuleId(11)).toBe(1);
    expect(graph.nodeForDepId(1)).toBe(2);
    expect(graph.nodeForDepId(3)).toBe(4);
    expect(graph.kindOf(1)).toBe('rule');
    expect(graph.kindOf(2)).toBe('dep');
  });

  it('has no node for an id the blob never recorded', () => {
    const graph = build([ruleRecord(10)], [depRecord(1)]);

    expect(graph.nodeForRuleId(99)).toBeUndefined();
    expect(graph.nodeForDepId(99)).toBeUndefined();
    expect(graph.has(2)).toBe(false);
    expect(graph.has(-1)).toBe(false);
    expect(graph.has(1.5)).toBe(false);
  });

  it('keeps the first record when an id repeats', () => {
    const graph = build(
      [ruleRecord(10, {dirId: 5}), ruleRecord(10, {dirId: 6})],
      [
        depRecord(1, {resolution: {kind: 'source'}}),
        depRecord(1, {resolution: {kind: 'unfinished'}}),
      ],
    );

    expect(graph.ruleCount).toBe(1);
    expect(graph.depCount).toBe(1);
    expect(graph.dirOf(0)).toBe('s5');
    expect(graph.resolutionOf(1)).toBe('source');
  });

  it('drops a record whose own id is unusable', () => {
    const graph = build([ruleRecord(NaN)], [depRecord(NaN), depRecord(-3)]);

    expect(graph.nodeCount).toBe(0);
  });
});

describe('GraphBuilder edges', () => {
  it('lays a rule out as static deps then each dynamic stage in order', () => {
    const graph = build(
      [
        ruleRecord(10, {
          depIds: [1, 2],
          dynDepStages: [[3], [], [4, 5]],
        }),
      ],
      [1, 2, 3, 4, 5].map((id) => depRecord(id)),
    );

    expect(graph.staticDepCount(0)).toBe(2);
    expect(graph.dynStageCount(0)).toBe(3);
    expect([...graph.outEdges(0)]).toEqual([
      {target: graph.nodeForDepId(1), edgeKind: 'static'},
      {target: graph.nodeForDepId(2), edgeKind: 'static'},
      {target: graph.nodeForDepId(3), edgeKind: 'dynamic', dynStage: 0},
      // Stage 1 is empty, so the next dep belongs to stage 2.
      {target: graph.nodeForDepId(4), edgeKind: 'dynamic', dynStage: 2},
      {target: graph.nodeForDepId(5), edgeKind: 'dynamic', dynStage: 2},
    ]);
  });

  it('gives a resolved dep one edge to its rule, and an expanded dep one per dep', () => {
    const graph = build(
      [ruleRecord(10)],
      [
        depRecord(1, {resolution: {kind: 'rule', ruleId: 10}}),
        depRecord(2, {resolution: {kind: 'expanded', depIds: [1, 3]}}),
        depRecord(3),
      ],
    );

    expect([...graph.outEdges(graph.nodeForDepId(1)!)]).toEqual([
      {target: 0, edgeKind: 'resolved'},
    ]);
    expect(graph.resolvedRuleOf(graph.nodeForDepId(1)!)).toBe(0);
    expect([...graph.outEdges(graph.nodeForDepId(2)!)]).toEqual([
      {target: graph.nodeForDepId(1), edgeKind: 'expanded'},
      {target: graph.nodeForDepId(3), edgeKind: 'expanded'},
    ]);
  });

  it('gives a source or unfinished dep no edges at all', () => {
    const graph = build(
      [],
      [depRecord(1), depRecord(2, {resolution: {kind: 'unfinished'}})],
    );

    expect(targets(graph, 0)).toEqual([]);
    expect(targets(graph, 1)).toEqual([]);
    expect(graph.edgeCount).toBe(0);
  });

  it('keeps a reference to an unrecorded node as a dangling target', () => {
    const graph = build([ruleRecord(10, {depIds: [1, 7]})], [depRecord(1)]);

    const [known, missing] = targets(graph, 0);
    expect(known).toBe(graph.nodeForDepId(1));
    expect(isDangling(missing)).toBe(true);
    expect(danglingId(missing)).toBe(7);
    // It is still one of the rule's declared deps, but not an edge.
    expect(graph.staticDepCount(0)).toBe(2);
    expect([...edges(graph)]).toHaveLength(1);
    // And it renders as an unlinked row naming the path the blob asked for.
    expect([...graph.outRefs(0)].map((r) => [r.node, r.label])).toEqual([
      [graph.nodeForDepId(1), 's1'],
      [undefined, 's7'],
    ]);
  });

  it('drops an unusable dep id rather than storing a reference to it', () => {
    const graph = build([ruleRecord(10, {depIds: [NaN, 1]})], [depRecord(1)]);

    expect(graph.staticDepCount(0)).toBe(1);
    expect(targets(graph, 0)).toEqual([graph.nodeForDepId(1)]);
  });

  it('resolves references made before the record they name was ingested', () => {
    // A rule's dep and a dep's rule are both forward references at ingest time:
    // the rules section is parsed first, and a dep can name a later dep.
    const graph = build(
      [ruleRecord(10, {depIds: [2]})],
      [
        depRecord(1, {resolution: {kind: 'expanded', depIds: [2]}}),
        depRecord(2, {resolution: {kind: 'rule', ruleId: 10}}),
      ],
    );

    expect(targets(graph, 0)).toEqual([graph.nodeForDepId(2)]);
    expect(targets(graph, graph.nodeForDepId(1)!)).toEqual([
      graph.nodeForDepId(2),
    ]);
    expect(targets(graph, graph.nodeForDepId(2)!)).toEqual([0]);
  });

  it('builds one contiguous CSR over both kinds', () => {
    const graph = build(
      [ruleRecord(10, {depIds: [1, 2]}), ruleRecord(11, {depIds: [2]})],
      [depRecord(1, {resolution: {kind: 'rule', ruleId: 11}}), depRecord(2)],
    );

    // Every node's run is [outStart, outEnd), the runs are in node-id order, and
    // together they cover the whole vector with no gaps.
    let expectedStart = 0;
    for (let id = 0; id < graph.nodeCount; id++) {
      expect(graph.outStart(id)).toBe(expectedStart);
      expectedStart = graph.outEnd(id);
    }
    expect(expectedStart).toBe(graph.edgeCount);
    expect(graph.edgeCount).toBe(4);
  });
});

describe('GraphBuilder scalars', () => {
  it('resolves a forcer to the node it names', () => {
    const graph = build(
      [ruleRecord(10, {forcedBy: {kind: 'DEP', depId: 1}})],
      [depRecord(1, {forcedBy: {kind: 'RULE', ruleId: 10}})],
    );

    expect(graph.forcerOf(0)).toBe(graph.nodeForDepId(1));
    expect(graph.forcerOf(1)).toBe(0);
  });

  it('keeps a forcer kind whose payload names nothing usable', () => {
    const graph = build(
      [
        ruleRecord(10, {forcedBy: {kind: 'RULE', ruleId: NaN}}),
        ruleRecord(11, {forcedBy: {kind: 'REQUEST'}}),
      ],
      [],
    );

    expect(graph.forcedByOf(0)).toEqual({kind: 'RULE'});
    expect(graph.forcerOf(0)).toBeLessThan(0);
    expect(graph.forcedByOf(1)).toEqual({kind: 'REQUEST'});
  });

  it('keeps a dir and targets as dict ids, resolved on read', () => {
    const graph = build(
      [
        ruleRecord(10, {
          dirId: 4,
          targetFileIds: [5, 6],
          targetDirIds: [7],
        }),
      ],
      [],
    );

    expect(graph.dirOf(0)).toBe('s4');
    expect(graph.targetCount(0)).toBe(3);
    expect([...graph.ruleTargets(0)]).toEqual([
      {path: 's4/s5', isDir: false},
      {path: 's4/s6', isDir: false},
      {path: 's4/s7', isDir: true},
    ]);
  });

  it('treats an unusable dir id as no dir', () => {
    const graph = build([ruleRecord(10, {dirId: NaN})], []);
    expect(graph.dirOf(0)).toBeUndefined();
  });

  it('reports an unrecognised outcome as unfinished rather than guessing', () => {
    const graph = build(
      [ruleRecord(10, {outcome: 'bogus' as RuleRecord['outcome']})],
      [],
    );
    expect(graph.outcomeOf(0)).toBe('unfinished');
  });

  it('is empty - and safe - with no records at all', () => {
    const graph = build([], []);

    expect(graph.nodeCount).toBe(0);
    expect(graph.edgeCount).toBe(0);
    expect([...edges(graph)]).toEqual([]);
  });
});
