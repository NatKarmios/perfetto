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

import type {
  CoreRecord,
  DepRecord,
  DepSetRecord,
  RuleRecord,
  StringTable,
} from './graph_blob';
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
    depsUnknown: false,
    dynDepStages: [],
    ...opts,
  };
}

function depRecord(depId: number, opts: Partial<DepRecord> = {}): DepRecord {
  return {depId, resolution: {kind: 'source'}, status: 'ok', ...opts};
}

// A dep set: its adds, and its core when it has one. Both id spaces start at 0
// in the blob, and so do the tests', since that is exactly where a lenient
// parse or a `0`-as-absent sentinel would go wrong.
function setRecord(
  setId: number,
  addIds: readonly number[],
  coreId?: number,
): DepSetRecord {
  return {setId, coreId, addIds};
}

function coreRecord(coreId: number, depIds: readonly number[]): CoreRecord {
  return {coreId, depIds};
}

function build(
  rules: readonly RuleRecord[],
  deps: readonly DepRecord[],
  sets: readonly DepSetRecord[] = [],
  cores: readonly CoreRecord[] = [],
): BuildGraph {
  const builder = new GraphBuilder();
  builder.strings(DICT);
  // The blob's order, which the builder relies on: cores, sets, then the rules
  // that name them.
  for (const core of cores) builder.core(core);
  for (const set of sets) builder.depSet(set);
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

// The retained factored tables, read the same way: a core's members, a set's
// adds. What the SQL mirror will store instead of the expanded edges.
function coreMembers(graph: BuildGraph, core: number): number[] {
  const out: number[] = [];
  for (
    let i = graph.coreMemberStart(core);
    i < graph.coreMemberEnd(core);
    i++
  ) {
    out.push(graph.coreMemberTarget(i));
  }
  return out;
}

function setAdds(graph: BuildGraph, set: number): number[] {
  const out: number[] = [];
  for (let i = graph.depSetAddStart(set); i < graph.depSetAddEnd(set); i++) {
    out.push(graph.depSetAddTarget(i));
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
          depSet: 0,
          // Stage 1 names no set at all, which is the blob's empty stage.
          dynDepStages: [1, undefined, 2],
        }),
      ],
      [1, 2, 3, 4, 5].map((id) => depRecord(id)),
      [setRecord(0, [1, 2]), setRecord(1, [3]), setRecord(2, [4, 5])],
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
    const graph = build(
      [ruleRecord(10, {depSet: 0})],
      [depRecord(1)],
      [setRecord(0, [1, 7])],
    );

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
    const graph = build(
      [ruleRecord(10, {depSet: 0})],
      [depRecord(1)],
      [setRecord(0, [NaN, 1])],
    );

    expect(graph.staticDepCount(0)).toBe(1);
    expect(targets(graph, 0)).toEqual([graph.nodeForDepId(1)]);
  });

  it('resolves references made before the record they name was ingested', () => {
    // A rule's dep and a dep's rule are both forward references at ingest time:
    // the rules section is parsed first, and a dep can name a later dep.
    const graph = build(
      [ruleRecord(10, {depSet: 0})],
      [
        depRecord(1, {resolution: {kind: 'expanded', depIds: [2]}}),
        depRecord(2, {resolution: {kind: 'rule', ruleId: 10}}),
      ],
      [setRecord(0, [2])],
    );

    expect(targets(graph, 0)).toEqual([graph.nodeForDepId(2)]);
    expect(targets(graph, graph.nodeForDepId(1)!)).toEqual([
      graph.nodeForDepId(2),
    ]);
    expect(targets(graph, graph.nodeForDepId(2)!)).toEqual([0]);
  });

  it('builds one contiguous CSR over both kinds', () => {
    const graph = build(
      [ruleRecord(10, {depSet: 0}), ruleRecord(11, {depSet: 1})],
      [depRecord(1, {resolution: {kind: 'rule', ruleId: 11}}), depRecord(2)],
      [setRecord(0, [1, 2]), setRecord(1, [2])],
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

describe('GraphBuilder dep sets', () => {
  it('expands a set as its core members, then its own adds', () => {
    const graph = build(
      [ruleRecord(10, {depSet: 0})],
      [1, 2, 3, 4].map((id) => depRecord(id)),
      [setRecord(0, [3, 4], 0)],
      [coreRecord(0, [1, 2])],
    );

    // The rule's static run is the whole set, flat - the store is expanded
    // exactly as it was before the blob factored the sets out.
    expect(graph.staticDepCount(0)).toBe(4);
    expect(targets(graph, 0)).toEqual(
      [1, 2, 3, 4].map((id) => graph.nodeForDepId(id)),
    );
  });

  it('expands a set with no core to its adds alone', () => {
    const graph = build(
      [ruleRecord(10, {depSet: 0})],
      [depRecord(1), depRecord(2)],
      [setRecord(0, [1, 2])],
    );

    expect(graph.coreOfDepSet(0)).toBeUndefined();
    expect(targets(graph, 0)).toEqual([
      graph.nodeForDepId(1),
      graph.nodeForDepId(2),
    ]);
  });

  it('expands one shared set into each rule that names it', () => {
    const graph = build(
      [ruleRecord(10, {depSet: 0}), ruleRecord(11, {depSet: 0})],
      [1, 2, 3].map((id) => depRecord(id)),
      [setRecord(0, [3], 0)],
      [coreRecord(0, [1, 2])],
    );

    expect(targets(graph, 0)).toEqual(targets(graph, 1));
    expect(graph.edgeCount).toBe(6);
    // Shared in the retained tables, not copied per rule.
    expect(graph.coreCount).toBe(1);
    expect(graph.depSetCount).toBe(1);
    expect(graph.depSetOf(0)).toBe(graph.depSetOf(1));
  });

  // Core ids are allocated from 0, so a set whose core is 0 must expand through
  // it rather than being read as having none.
  it('treats core 0 as a real core, not as "no core"', () => {
    const graph = build(
      [ruleRecord(10, {depSet: 0})],
      [depRecord(1), depRecord(2)],
      [setRecord(0, [2], 0)],
      [coreRecord(0, [1])],
    );

    expect(graph.coreOfDepSet(0)).toBe(0);
    expect(targets(graph, 0)).toEqual([
      graph.nodeForDepId(1),
      graph.nodeForDepId(2),
    ]);
  });

  // The other half of the same trap: set ids are allocated from 0 too, so a
  // rule that named no set must not pick up set 0's deps.
  it('gives a rule that named no set no deps, even though set 0 exists', () => {
    const graph = build(
      [ruleRecord(10, {depSet: 0}), ruleRecord(11)],
      [depRecord(1)],
      [setRecord(0, [1])],
    );

    expect(graph.depSetOf(0)).toBe(0);
    expect(graph.staticDepCount(0)).toBe(1);
    expect(graph.depSetOf(1)).toBeUndefined();
    expect(graph.staticDepCount(1)).toBe(0);
    expect(targets(graph, 1)).toEqual([]);
  });

  it('keeps the retained tables as node references, alongside the flat CSR', () => {
    const graph = build(
      [ruleRecord(10, {depSet: 0, dynDepStages: [1, undefined]})],
      [1, 2, 3].map((id) => depRecord(id)),
      [setRecord(0, [2], 0), setRecord(1, [3])],
      [coreRecord(0, [1])],
    );

    const set = graph.depSetOf(0)!;
    const core = graph.coreOfDepSet(set)!;
    // Members are node ids, not the dict ids the blob wrote - the mirror reads
    // these instead of the expanded edges.
    expect(coreMembers(graph, core)).toEqual([graph.nodeForDepId(1)]);
    expect(setAdds(graph, set)).toEqual([graph.nodeForDepId(2)]);
    // And the blob's own ids are still recoverable.
    expect(graph.coreIdOf(core)).toBe(0);
    expect(graph.depSetIdOf(set)).toBe(0);
    // Stage 0 named set 1; stage 1 named none but still holds its slot.
    expect(graph.dynStageCount(0)).toBe(2);
    expect(graph.dynStageSetOf(0, 0)).toBe(1);
    expect(graph.dynStageSetOf(0, 1)).toBeUndefined();
  });

  it('keeps a set member the blob never recorded as a dangling reference', () => {
    const graph = build(
      [ruleRecord(10, {depSet: 0})],
      [depRecord(1)],
      [setRecord(0, [2], 0)],
      [coreRecord(0, [1])],
    );

    const [member, add] = targets(graph, 0);
    expect(member).toBe(graph.nodeForDepId(1));
    expect(isDangling(add)).toBe(true);
    expect(danglingId(add)).toBe(2);
    // Same encoding in the retained table it was expanded from.
    expect(setAdds(graph, 0)).toEqual([add]);
  });

  it('gives a rule naming an unknown set no deps, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const graph = build(
      [ruleRecord(10, {depSet: 7})],
      [depRecord(1)],
      [setRecord(0, [1])],
    );

    // Not the same as having no deps: the deps have gone missing, so it's
    // counted rather than quietly conflated.
    expect(graph.staticDepCount(0)).toBe(0);
    expect(graph.depSetOf(0)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('1 rule dep-set references'),
    );
    warn.mockRestore();
  });

  it('keeps the adds of a set naming an unknown core, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const graph = build(
      [ruleRecord(10, {depSet: 0})],
      [depRecord(1)],
      [setRecord(0, [1], 4)],
    );

    expect(graph.coreOfDepSet(0)).toBeUndefined();
    expect(targets(graph, 0)).toEqual([graph.nodeForDepId(1)]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('1 dep sets named a core'),
    );
    warn.mockRestore();
  });

  // Expansion is a plain concatenation, on purpose: `adds` is the set
  // difference `S \ core`, so nothing pays for a dedup pass. If an encoder ever
  // breaks that, the duplicate edge is real and has to be reported rather than
  // left as an unexplained double.
  it('counts an add that repeats a core member', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const graph = build(
      [ruleRecord(10, {depSet: 0})],
      [depRecord(1), depRecord(2)],
      [setRecord(0, [1, 2], 0)],
      [coreRecord(0, [1])],
    );

    expect(targets(graph, 0)).toEqual([
      graph.nodeForDepId(1),
      graph.nodeForDepId(1),
      graph.nodeForDepId(2),
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('1 dep-set additions'),
    );
    warn.mockRestore();
  });

  it('says nothing at all about a well-formed blob', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    build(
      [ruleRecord(10, {depSet: 0})],
      [depRecord(1), depRecord(2)],
      [setRecord(0, [2], 0)],
      [coreRecord(0, [1])],
    );

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
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

  it('reports an unrecognised resolution as unfinished, not as the last code', () => {
    const graph = build(
      [],
      [
        depRecord(1, {
          resolution: {kind: 'bogus'} as unknown as DepRecord['resolution'],
        }),
      ],
    );
    expect(graph.resolutionOf(0)).toBe('unfinished');
  });

  // `?` deps and no deps both come through as an empty edge run, so the flag
  // is the only thing that distinguishes them once the record is gone.
  it('keeps "deps unknown" apart from "no deps"', () => {
    const graph = build(
      [ruleRecord(10, {depsUnknown: true}), ruleRecord(11)],
      [],
    );

    expect(graph.depsUnknownOf(0)).toBe(true);
    expect(graph.staticDepCount(0)).toBe(0);
    expect(graph.depsUnknownOf(1)).toBe(false);
    expect(graph.staticDepCount(1)).toBe(0);
  });

  it('stores a dep status alongside - not instead of - its resolution', () => {
    const graph = build(
      [ruleRecord(10)],
      [
        depRecord(1, {
          resolution: {kind: 'rule', ruleId: 10},
          status: 'failed',
        }),
        depRecord(2, {resolution: {kind: 'unknown'}, status: 'cancelled'}),
        depRecord(3),
      ],
    );

    expect(graph.resolutionOf(1)).toBe('rule');
    expect(graph.statusOf(1)).toBe('failed');
    expect(graph.resolvedRuleOf(1)).toBe(0);
    expect(graph.resolutionOf(2)).toBe('unknown');
    expect(graph.statusOf(2)).toBe('cancelled');
    expect(graph.statusOf(3)).toBe('ok');
    // A rule has no status field of its own; it reports through its outcome.
    expect(graph.statusOf(0)).toBe('ok');
  });

  it('gives an unknown-resolution dep no edges at all', () => {
    const graph = build([], [depRecord(1, {resolution: {kind: 'unknown'}})]);
    expect([...graph.outEdges(0)]).toEqual([]);
  });

  // A recovery forcer names a rule exactly as a plain RULE forcer does, so it
  // resolves to the same node and marks the same edge forced.
  it('resolves a recovery forcer to the rule it names', () => {
    const graph = build(
      [
        ruleRecord(10),
        ruleRecord(11, {forcedBy: {kind: 'RULE_RECOVERY', ruleId: 10}}),
      ],
      [],
    );

    expect(graph.forcedByOf(1)).toEqual({
      kind: 'RULE_RECOVERY',
      node: 0,
      target: '10',
    });
    expect(graph.forcerOf(1)).toBe(0);
  });

  it('is empty - and safe - with no records at all', () => {
    const graph = build([], []);

    expect(graph.nodeCount).toBe(0);
    expect(graph.edgeCount).toBe(0);
    expect([...edges(graph)]).toEqual([]);
  });
});
