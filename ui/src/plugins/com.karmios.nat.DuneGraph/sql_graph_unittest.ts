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
 * The SQL mirror's *generated statements*, captured through a stub engine.
 *
 * There is no trace processor in a unit test, so what can be checked here is
 * what the mirror decides to store, not what a query over it returns. That is
 * still the interesting half for the factored edge tier: which rows each
 * factored table gets, which references are dropped on the way, and - for the
 * dynamic-dep stages - a shape no real trace to hand contains at all (every
 * available dune trace has zero dynamic deps, so this file is their only
 * coverage).
 *
 * The end-to-end check that `dune_edge` still reproduces the in-memory edge set
 * exactly is not this: it is done by dumping the generated SQL for a real
 * trace's blob and running it under `tools/trace_processor` (see
 * PERF_SUMMARY.LOCAL.md's *Verification*).
 */

import type {Engine} from '../../trace_processor/engine';
import type {BuildGraph} from './graph';
import {dep, depSet, rule, testGraph} from './graph_test_helper';
import {buildEdgeMirror, buildNodeMirror} from './sql_graph';

// Every statement the two mirror builders issue, in order.
async function capture(graph: BuildGraph): Promise<string[]> {
  const sql: string[] = [];
  const result = {
    firstRow: () => ({n: 0}),
    iter: () => ({valid: () => false, next: () => {}}),
  };
  const engine = {
    query: async (q: string) => {
      sql.push(q);
      return result;
    },
    tryQuery: async (q: string) => {
      sql.push(q);
      return result;
    },
  } as unknown as Engine;
  const nodes = await buildNodeMirror(engine, graph);
  await buildEdgeMirror(engine, graph, nodes);
  return sql;
}

// The tuples INSERTed into `table`, each as a list of its column texts.
function rowsOf(sql: readonly string[], table: string): string[][] {
  const rows: string[][] = [];
  for (const stmt of sql) {
    const match = new RegExp(
      `^INSERT INTO ${table} \\(([^)]*)\\) VALUES `,
    ).exec(stmt);
    if (match === null) continue;
    const values = stmt.slice(match[0].length);
    for (const tuple of values.matchAll(/\(([^)]*)\)/g)) {
      rows.push(tuple[1].split(',').map((v) => v.trim()));
    }
  }
  return rows;
}

// The body of a generated PERFETTO FUNCTION.
function functionBody(sql: readonly string[], name: string): string {
  const stmt = sql.find((q) => q.includes(`PERFETTO FUNCTION ${name}(`));
  expect(stmt).toBeDefined();
  return stmt!;
}

describe('sql_graph edge tier', () => {
  it('stores a shared dep set once, and both rules point at it', async () => {
    const shared = depSet({core: ['c1', 'c2'], adds: ['a1']});
    const g = testGraph([
      rule('r1', {depSet: shared}),
      rule('r2', {depSet: shared}),
      dep('c1'),
      dep('c2'),
      dep('a1'),
    ]);
    const sql = await capture(g.graph);

    // One core (index 0) holding both its members, one set (index 0) naming it.
    expect(rowsOf(sql, '_dune_core')).toEqual([['0', '1', '2']]);
    expect(rowsOf(sql, '_dune_core_member')).toEqual([
      ['0', String(g.id('c1'))],
      ['0', String(g.id('c2'))],
    ]);
    expect(rowsOf(sql, '_dune_depset')).toEqual([['0', '0', '1', '1']]);
    expect(rowsOf(sql, '_dune_depset_add')).toEqual([
      ['0', String(g.id('a1'))],
    ]);
    // ... and both rules name set 0 (last `_dune_rule` column).
    const ruleSets = rowsOf(sql, '_dune_rule').map((r) => r[r.length - 1]);
    expect(ruleSets).toEqual(['0', '0']);
  });

  it('leaves dep_set NULL for a rule with no deps and for unknown deps', async () => {
    const g = testGraph([
      rule('r1', {staticDeps: ['a']}),
      rule('r2'),
      rule('r3', {depsUnknown: true}),
      dep('a'),
    ]);
    const sql = await capture(g.graph);
    const rules = rowsOf(sql, '_dune_rule');
    // (node_id, …, deps_unknown, dep_set)
    expect(rules.map((r) => [r[0], r[r.length - 2], r[r.length - 1]])).toEqual([
      [String(g.id('r1')), '0', '0'],
      [String(g.id('r2')), '0', 'NULL'],
      [String(g.id('r3')), '1', 'NULL'],
    ]);
  });

  it('stores an uncored set with a NULL core and all its members as adds', async () => {
    const g = testGraph([
      rule('r1', {staticDeps: ['a', 'b']}),
      dep('a'),
      dep('b'),
    ]);
    const sql = await capture(g.graph);
    expect(rowsOf(sql, '_dune_core')).toEqual([]);
    expect(rowsOf(sql, '_dune_core_member')).toEqual([]);
    expect(rowsOf(sql, '_dune_depset')).toEqual([['0', 'NULL', '1', '2']]);
  });

  it('skips members the blob never recorded, and narrows the ranges', async () => {
    // `nope` is referenced but never defined, so it is a dangling reference in
    // both the core and the add list and must not reach SQL - the rowid ranges
    // have to count what is stored, not what the set holds.
    const g = testGraph([
      rule('r1', {
        depSet: depSet({core: ['c1', 'nope'], adds: ['nope2', 'a1']}),
      }),
      dep('c1'),
      dep('a1'),
    ]);
    const sql = await capture(g.graph);
    expect(rowsOf(sql, '_dune_core')).toEqual([['0', '1', '1']]);
    expect(rowsOf(sql, '_dune_core_member')).toEqual([
      ['0', String(g.id('c1'))],
    ]);
    expect(rowsOf(sql, '_dune_depset')).toEqual([['0', '0', '1', '1']]);
    expect(rowsOf(sql, '_dune_depset_add')).toEqual([
      ['0', String(g.id('a1'))],
    ]);
  });

  it('keeps an empty dynamic stage as a slot naming no set', async () => {
    // `3||5` in the blob: three stages, the middle one with no deps. Dropping
    // the slot would renumber every later stage.
    const g = testGraph([
      rule('r1', {dynamicDeps: [['d1'], [], ['d2']]}),
      dep('d1'),
      dep('d2'),
    ]);
    const sql = await capture(g.graph);
    expect(rowsOf(sql, '_dune_rule_dyn_stage')).toEqual([
      [String(g.id('r1')), '0', '0'],
      [String(g.id('r1')), '1', 'NULL'],
      [String(g.id('r1')), '2', '1'],
    ]);
    // The two non-empty stages' sets are stored like any other.
    expect(rowsOf(sql, '_dune_depset_add')).toEqual([
      ['0', String(g.id('d1'))],
      ['1', String(g.id('d2'))],
    ]);
  });

  it("stores only a dep node's edges flat", async () => {
    const g = testGraph([
      rule('r1', {staticDeps: ['a']}),
      dep('a', {resolvedRule: 'r2'}),
      dep('b', {expanded: ['a']}),
      rule('r2'),
    ]);
    const sql = await capture(g.graph);
    // A rule's edges live in the factored tables, so `_dune_edge` holds the
    // dep -> rule and dep -> dep ones and nothing else.
    expect(rowsOf(sql, '_dune_edge')).toEqual([
      [String(g.id('a')), String(g.id('r2'))],
      [String(g.id('b')), String(g.id('a'))],
    ]);
    expect(rowsOf(sql, '_dune_node_out').map((r) => r[0])).toEqual([
      String(g.id('a')),
      String(g.id('b')),
    ]);
  });

  it('materializes a forced edge only where the forcer depends on the node', async () => {
    // `x` names r1 as its forcer and r1 really does depend on it: an edge.
    // `y` names r1 too, but r1 never listed it - dune forced it into the build
    // some other way - so there is no edge to mark, and the forced walks must
    // not invent one.
    const g = testGraph([
      rule('r1', {staticDeps: ['x']}),
      dep('x', {forcedBy: {rule: 'r1'}}),
      dep('y', {forcedBy: {rule: 'r1'}}),
    ]);
    const sql = await capture(g.graph);
    // (dst, src)
    expect(rowsOf(sql, '_dune_forced_edge')).toEqual([
      [String(g.id('x')), String(g.id('r1'))],
    ]);
  });

  it('gives each arm of a hop its own recursive term', async () => {
    // The load-bearing perf property of the tier: SQLite will not push a
    // constraint that comes from the recursive table down into a compound
    // subquery, so a hop must not be expressed as one joined union of the arms.
    // Five arms downwards and five upwards (see `edgeArms`), one forced arm.
    const g = testGraph([rule('r1', {staticDeps: ['a']}), dep('a')]);
    const sql = await capture(g.graph);
    const terms = (body: string) => body.split('FROM states s').length - 1;
    expect(terms(functionBody(sql, 'dune_descendants'))).toBe(5);
    expect(terms(functionBody(sql, 'dune_ancestors'))).toBe(5);
    // The unbounded walks read the whole relation through the view instead,
    // which is the one shape a compound view is good at.
    expect(functionBody(sql, 'dune_all_descendants')).toContain(
      '_dune_edge_all',
    );
    expect(functionBody(sql, 'dune_forced')).toContain('_dune_forced_edge');
  });
});
