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

import type {Engine} from '../../../trace_processor/engine';
import type {BuildGraph} from '../model/graph';
import {dep, depSet, rule, testGraph} from '../model/graph_test_helper';
import {PerfRun} from '../perf';
import {timingKindCode} from './lifecycle_sql';
import type {MirrorPhase} from './sql_graph';
import {
  EDGE_MIRROR_PHASES,
  NODE_MIRROR_PHASES,
  buildEdgeMirror,
  buildNodeMirror,
} from './sql_graph';

// An engine that answers nothing - bar the census's `gen-rules` key query,
// whose keys the caller supplies - and appends every statement issued against
// it to `sql`. Enough for the builders, which read a query's result back only
// for that, for the directory duration rollup (empty here) and for the row
// counts.
function stubEngine(
  sql: string[],
  genRulesKeys: readonly number[] = [],
): Engine {
  const empty = {
    firstRow: () => ({n: 0}),
    iter: () => ({valid: () => false, next: () => {}}),
  };
  const keys = {
    ...empty,
    iter: () => {
      let i = 0;
      return {
        valid: () => i < genRulesKeys.length,
        next: () => i++,
        get str_id() {
          return genRulesKeys[i];
        },
      };
    },
  };
  const record = async (q: string) => {
    sql.push(q);
    return q.includes('DISTINCT key AS str_id') ? keys : empty;
  };
  return {query: record, tryQuery: record} as unknown as Engine;
}

// Every statement the two mirror builders issue, in order.
async function capture(
  graph: BuildGraph,
  genRulesKeys: readonly number[] = [],
): Promise<string[]> {
  const sql: string[] = [];
  const engine = stubEngine(sql, genRulesKeys);
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

// `_dune_dir`'s rows, each as `path@depth ^parent n=direct t=subtree d=durations`
// with the direct/subtree quadruples being rules/deps/failed/gen-rules. Paths
// keep their SQL quotes, so what is asserted below is the literal text
// inserted.
function dirRows(sql: readonly string[]): string[] {
  const rows = rowsOf(sql, '_dune_dir');
  const pathOf = new Map(rows.map((r) => [r[0], r[3]]));
  return rows.map(
    (r) =>
      `${r[3]}@${r[4]} ^${r[1] === 'NULL' ? '-' : pathOf.get(r[1])} ` +
      `n=${r[5]}/${r[6]}/${r[7]}/${r[8]} ` +
      `t=${r[9]}/${r[10]}/${r[11]}/${r[12]} d=${r[13]}/${r[14]}`,
  );
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

describe('sql_graph dir tier', () => {
  // A rule per directory spelling dune produces, and deps both inside and
  // outside `_build` - the case a rule-dir-only tree would drop.
  const fixture = () =>
    testGraph([
      rule('1', {dir: '_build/default/lib', outcome: 'failed-action'}),
      rule('2', {dir: '_build/default/lib'}),
      rule('3', {dir: '_build/default/bin'}),
      // `.` is dune's other spelling of the top level, and must not become a
      // second row alongside a rule that reported no dir at all.
      rule('4', {dir: '.'}),
      rule('5'),
      dep('_build/default/lib/x.cmi'),
      dep('/usr/bin/ocamlopt'),
      dep('dune-project'),
    ]);

  it('interns every prefix, counting rules and deps separately', async () => {
    const sql = await capture(fixture().graph);
    expect(dirRows(sql)).toEqual([
      // Interior directories hold no rules of their own, only subtree totals.
      "'_build'@0 ^- n=0/0/0/0 t=3/1/1/0 d=0/0",
      "'_build/default'@1 ^'_build' n=0/0/0/0 t=3/1/1/0 d=0/0",
      "'_build/default/lib'@2 ^'_build/default' n=2/1/1/0 t=2/1/1/0 d=0/0",
      "'_build/default/bin'@2 ^'_build/default' n=1/0/0/0 t=1/0/0/0 d=0/0",
      // The top level: both `.` and an absent dir land here, as does a dep with
      // no directory in its path.
      "''@0 ^- n=2/1/0/0 t=2/1/0/0 d=0/0",
      // An absolute path's leading `/` stays with its first segment, so `/usr`
      // is a root rather than an empty root holding `usr`.
      "'/usr'@0 ^- n=0/0/0/0 t=0/1/0/0 d=0/0",
      "'/usr/bin'@1 ^'/usr' n=0/1/0/0 t=0/1/0/0 d=0/0",
    ]);
  });

  it('interns a directory dune generated rules for, members or not', async () => {
    // A `gen-rules` span is keyed by the dict id of its directory, and dune
    // generates rules for output directories that hold no rule and no dep at
    // all - half of them on the monorepo trace. Here the dep's own path stands
    // in for one: nothing in the graph is filed under it, so it is a row only
    // because `gen-rules` ran there.
    const g = fixture();
    const key = g.graph.traceIdOf(g.id('_build/default/lib/x.cmi'));
    const rows = dirRows(await capture(g.graph, [key]));

    // The whole table, because what matters is as much what did *not* move:
    // the new row is the only one with members of its own it did not have
    // before, and `t_gen_rules` reaches its ancestors and nothing else.
    expect(rows).toEqual([
      "'_build'@0 ^- n=0/0/0/0 t=3/1/1/1 d=0/0",
      "'_build/default'@1 ^'_build' n=0/0/0/0 t=3/1/1/1 d=0/0",
      "'_build/default/lib'@2 ^'_build/default' n=2/1/1/0 t=2/1/1/1 d=0/0",
      // The row that exists only because dune generated rules there.
      "'_build/default/lib/x.cmi'@3 ^'_build/default/lib' " +
        'n=0/0/0/1 t=0/0/0/1 d=0/0',
      "'_build/default/bin'@2 ^'_build/default' n=1/0/0/0 t=1/0/0/0 d=0/0",
      "''@0 ^- n=2/1/0/0 t=2/1/0/0 d=0/0",
      "'/usr'@0 ^- n=0/0/0/0 t=0/1/0/0 d=0/0",
      "'/usr/bin'@1 ^'/usr' n=0/1/0/0 t=0/1/0/0 d=0/0",
    ]);
  });

  it('files every node under a directory, deps included', async () => {
    const g = fixture();
    const sql = await capture(g.graph);
    // `_dune_dir`'s ids in insert order, so a row's directory can be named.
    const dirPath = new Map(rowsOf(sql, '_dune_dir').map((r) => [r[0], r[3]]));
    // `_dune_node` is (node_id, orig_id, forced_by_kind, forced_by_target_id,
    // dir_id): the directory is the last column.
    const filed = new Map(
      rowsOf(sql, '_dune_node').map((r) => [r[0], dirPath.get(r[4])]),
    );
    const of = (name: string) => filed.get(String(g.id(name)));

    // A rule is filed under its context `dir` - including both spellings of
    // the top level, which must land on the same row.
    expect(of('1')).toBe("'_build/default/lib'");
    expect(of('3')).toBe("'_build/default/bin'");
    expect(of('4')).toBe("''");
    expect(of('5')).toBe("''");
    // A dep under the directory its path lives in, which is the whole point:
    // `/usr/bin` is under no rule's dir at all.
    expect(of('_build/default/lib/x.cmi')).toBe("'_build/default/lib'");
    expect(of('/usr/bin/ocamlopt')).toBe("'/usr/bin'");
    expect(of('dune-project')).toBe("''");
    // Never NULL: every node contributed a directory to the tree.
    expect([...filed.values()].filter((d) => d === undefined)).toEqual([]);
  });

  it('agrees with the n_rules / n_deps counts it is interned from', async () => {
    const sql = await capture(fixture().graph);
    const dirs = rowsOf(sql, '_dune_dir');
    // The SQL aggregate the census's doc says is now expressible, done here in
    // JS: group `_dune_node.dir_id` by which side of the rule/dep boundary the
    // node falls on, and it must reproduce the stored direct counts.
    const ruleCount = dirs.reduce((n, r) => n + Number(r[5]), 0);
    const nRules = new Map<string, number>();
    const nDeps = new Map<string, number>();
    for (const r of rowsOf(sql, '_dune_node')) {
      const counts = Number(r[0]) < ruleCount ? nRules : nDeps;
      counts.set(r[4], (counts.get(r[4]) ?? 0) + 1);
    }
    for (const r of dirs) {
      expect([r[3], nRules.get(r[0]) ?? 0, nDeps.get(r[0]) ?? 0]).toEqual([
        r[3],
        Number(r[5]),
        Number(r[6]),
      ]);
    }
  });

  it('indexes the two columns the directory explorer descends by', async () => {
    // Both are descent keys rather than identities, so neither is a rowid and
    // neither is free. `_dune_node(dir_id)` is the one that matters: listing one
    // directory's members is `WHERE dir_id = ?`, and unindexed that is a scan of
    // every node in the build once per directory expanded (818k rows on the
    // monorepo trace). See dir_explorer.ts for the queries that probe them.
    const sql = await capture(fixture().graph);
    const indexes = sql.filter((q) => q.startsWith('CREATE INDEX'));
    expect(indexes).toContain(
      'CREATE INDEX _dune_node_dir_id ON _dune_node(dir_id)',
    );
    expect(indexes).toContain(
      'CREATE INDEX _dune_dir_parent_id ON _dune_dir(parent_id)',
    );
  });

  it('maps trace-side rule ids to directories, then drops the map', async () => {
    const sql = await capture(fixture().graph);
    // Keyed by `rule_id`, not `node_id`: it exists to be probed from
    // `_dune_timing`, whose key is the trace-side id.
    expect(rowsOf(sql, '_dune_rule_dir')).toEqual([
      ['1', '2'],
      ['2', '2'],
      ['3', '3'],
      ['4', '4'],
      ['5', '4'],
    ]);
    // Scan the timing table, probe the map - never the other way round (see
    // PERF_SUMMARY.LOCAL.md) - and don't leave 386k rows of pages behind.
    const agg = sql.find((q) => q.includes('FROM _dune_timing t'));
    expect(agg).toContain('JOIN _dune_rule_dir m ON m.rule_id = t.key');
    const drops = sql.filter(
      (q) => q === 'DROP TABLE IF EXISTS _dune_rule_dir',
    );
    expect(drops).toHaveLength(2);
  });
});

describe('sql_graph gen-rules views', () => {
  const fixture = () =>
    testGraph([
      rule('1', {dir: '_build/default/lib'}),
      dep('_build/default/lib/x.cmi'),
    ]);

  // The generated `CREATE PERFETTO VIEW` for a public view, by SQL name.
  const view = async (name: string, keys: readonly number[] = []) => {
    const sql = await capture(fixture().graph, keys);
    const stmt = sql.find((q) => q.includes(`CREATE PERFETTO VIEW ${name}(`));
    expect(stmt, `no CREATE for ${name}`).toBeDefined();
    return stmt!;
  };

  it('maps each gen-rules key to the directory the census interned it as', async () => {
    const g = fixture();
    const key = g.graph.traceIdOf(g.id('_build/default/lib/x.cmi'));
    const sql = await capture(g.graph, [key]);
    const dirId = new Map(rowsOf(sql, '_dune_dir').map((r) => [r[3], r[0]]));
    // Ints only, one row per key: `(dir_id, dir_str_id)`, the dict id the
    // timing row is keyed by against the `dune_dir` row for the same path.
    expect(rowsOf(sql, '_dune_gen_rules')).toEqual([
      [dirId.get("'_build/default/lib/x.cmi'"), String(key)],
    ]);
  });

  it('joins the timing table on the gen-rules kind, never on the key alone', async () => {
    // A `genrules` key and a dep's `orig_id` are both dict ids in one space,
    // so dropping the `kind` term would match unrelated deps.
    const stmt = await view('dune_gen_rules');
    expect(stmt).toContain(
      `ON t.kind = ${timingKindCode('genrules')} AND t.key = g.dir_str_id`,
    );
  });

  it('keeps a gen-rules span whose finish never arrived', async () => {
    // LEFT, not JOIN, on both slices: an interrupted build flushes an
    // unmatched `-start`, whose row must survive with a NULL finish and a NULL
    // `dune_file`. No trace to hand exercises it, which is why it is asserted
    // here.
    const stmt = await view('dune_gen_rules');
    expect(stmt).toContain('LEFT JOIN slice ss ON ss.id = t.start_slice_id');
    expect(stmt).toContain('LEFT JOIN slice fs ON fs.id = t.finish_slice_id');
    // And the slice ids come off those joins, so they are real JOINIDs rather
    // than the timing table's plain integers.
    expect(stmt).toContain('ss.id AS start_slice_id');
    expect(stmt).toContain('fs.id AS finish_slice_id');
  });

  it('reads dynamic-includes straight off the timing table', async () => {
    // No map table: the key is the `dune` file's dict id, which is already
    // what a query wants.
    const stmt = await view('dune_dyn_includes');
    expect(stmt).toContain('t.key AS dune_file_str_id');
    expect(stmt).toContain(`WHERE t.kind = ${timingKindCode('dyninc')}`);
    expect(stmt).not.toContain('_dune_gen_rules');
  });

  it('drops both views before the tables they read', async () => {
    const sql: string[] = [];
    const engine = stubEngine(sql);
    const mirror = await buildNodeMirror(engine, fixture().graph);
    sql.length = 0;
    await mirror[Symbol.asyncDispose]();
    const at = (q: string) => sql.indexOf(q);
    for (const v of ['dune_gen_rules', 'dune_dyn_includes']) {
      expect(at(`DROP VIEW IF EXISTS ${v}`)).toBeGreaterThanOrEqual(0);
      expect(at(`DROP VIEW IF EXISTS ${v}`)).toBeLessThan(
        at('DROP TABLE IF EXISTS dune_string'),
      );
      expect(at(`DROP VIEW IF EXISTS ${v}`)).toBeLessThan(
        at('DROP TABLE IF EXISTS _dune_timing'),
      );
    }
  });
});

describe('sql_graph process view', () => {
  // Five rules, so the rule/dep boundary the generated SQL inlines is 5.
  const graph = () =>
    testGraph([rule('1'), rule('2'), rule('3'), rule('4'), rule('5'), dep('a')])
      .graph;

  const processView = async () => {
    const sql = await capture(graph());
    const stmt = sql.find((q) =>
      q.includes('CREATE PERFETTO VIEW dune_process'),
    );
    expect(stmt).toBeDefined();
    return stmt!;
  };

  it('reaches a node from a trace-side rule id through an index', async () => {
    // Without an index on `orig_id` this join is a scan of every node in the
    // build per process slice (818k rows on the monorepo trace) - the reason
    // `_dune_process` is keyed by `rule_id` in the first place (process_sql.ts).
    // Partial, because only the rule half is ever probed: a dep's `orig_id` is
    // a dict id in an unrelated numbering.
    const sql = await capture(graph());
    expect(sql.filter((q) => q.startsWith('CREATE INDEX'))).toContain(
      'CREATE INDEX _dune_node_orig_id ON _dune_node(orig_id) ' +
        'WHERE node_id < 5',
    );
  });

  it('bounds the node join to rules, with the term the index needs', async () => {
    const stmt = await processView();
    // Same predicate as the partial index, so SQLite can use it - and required
    // for correctness regardless, since a dep's `orig_id` would otherwise match
    // whatever rule id happened to share its number.
    expect(stmt).toContain('LEFT JOIN _dune_node n');
    expect(stmt).toContain('ON n.node_id < 5 AND n.orig_id = p.rule_id');
  });

  it('keeps a process whose rule the blob never recorded', async () => {
    // LEFT, not JOIN: such a row reports a NULL node rather than vanishing.
    expect(await processView()).toContain('LEFT JOIN _dune_node');
  });

  it('sources slice_id from the join so it carries the id type', async () => {
    // A stored INTEGER would not be a SliceTable::Id, and the column would stop
    // rendering as a slice link - the same reason `dune_node.slice_id` is
    // sourced this way.
    const stmt = await processView();
    expect(stmt).toContain('slice_id JOINID(slice.id)');
    expect(stmt).toContain('SELECT s.id AS slice_id');
    expect(stmt).toContain('JOIN slice s ON s.id = p.slice_id');
  });

  it('names the duration dur_ns, so the query tab prints it as one', async () => {
    // `slice.dur` is already nanoseconds; the name is what query_results.ts's
    // DURATION_COLS matches on.
    expect(await processView()).toContain('AS dur_ns');
  });

  it('publishes an unfinished slice as a NULL duration, not -1', async () => {
    // Perfetto's sentinel for a slice that never finished. Left verbatim it
    // would sort the running processes of a Ctrl-C'd build first under
    // `ORDER BY dur_ns`, and - since the column is in DURATION_COLS - be
    // rendered as a negative duration. NULL is what the rest of the mirror
    // says, `_dune_timing.dur_ns` included.
    const stmt = await processView();
    expect(stmt).toContain('nullif(s.dur, -1) AS dur_ns');
    expect(stmt).not.toContain('s.dur AS dur_ns');
  });

  it('drops the view with the tier', async () => {
    const sql = await capture(graph());
    expect(sql).toContain('DROP VIEW IF EXISTS dune_process');
  });
});

describe('sql_graph blocked time', () => {
  // Five rules again, so the inlined rule/dep boundary is 5.
  const graph = () =>
    testGraph([rule('1'), rule('2'), rule('3'), rule('4'), rule('5'), dep('a')])
      .graph;

  // The one statement containing `needle`.
  const statement = async (needle: string) => {
    const sql = await capture(graph());
    const stmt = sql.find((q) => q.includes(needle));
    expect(stmt).toBeDefined();
    return stmt!;
  };

  const spanView = () => statement('CREATE PERFETTO VIEW _dune_span');
  const macro = () => statement('PERFETTO MACRO dune_blocked');
  const blockedView = () => statement('CREATE PERFETTO VIEW dune_edge_blocked');

  it('takes a span from the start instant plus the lifecycle duration', async () => {
    // Not `finish.ts - start.ts`: a span collapsed to one `-resolved` instant
    // has no distinct finish timestamp, and this is the interval the timeline
    // track draws.
    const stmt = await spanView();
    expect(stmt).toContain('s.ts AS ts');
    expect(stmt).toContain('coalesce(s.ts + t.dur_ns, trace_end()) AS end_ts');
  });

  it('runs an unfinished span to the end of the trace', async () => {
    // A NULL `dur_ns` is a span the trace was truncated in the middle of, so
    // the node really was still live at `trace_end()` - same as the track's
    // `dur = -1`.
    expect(await spanView()).toContain('trace_end()');
  });

  it('keys the span on the same (kind, orig_id) the timing table stores', async () => {
    const stmt = await spanView();
    expect(stmt).toContain('t.kind = iif(n.node_id < 5,');
    expect(stmt).toContain('t.key = n.orig_id');
  });

  it('drops a node with no timing rather than giving it a NULL span', async () => {
    // INNER, unlike `dune_node`'s LEFT joins: the macro's own LEFT JOIN onto
    // this view is what turns "no timing" into a NULL `blocked_ns`.
    const stmt = await spanView();
    expect(stmt).toContain('JOIN _dune_timing t');
    expect(stmt).not.toContain('LEFT JOIN _dune_timing');
    expect(stmt).not.toContain('LEFT JOIN slice');
  });

  it('resolves the span without touching the string table', async () => {
    // The whole reason this is not a slice of `dune_node`: SQLite does not
    // eliminate a join nothing selects from, and the macro probes a node twice
    // per edge row.
    expect(await spanView()).not.toContain('dune_string');
  });

  it('intersects the two endpoints spans', async () => {
    // blocked = max(0, min(ends) - max(starts)), i.e. the stretch where the
    // waiting `src` was live and the prerequisite `dst` was still building.
    expect(await macro()).toContain(
      'max(0, min(es.end_ts, ds.end_ts) - max(es.ts, ds.ts)) AS blocked_ns',
    );
  });

  it('joins a span per endpoint, LEFT so an untimed edge stays', async () => {
    const stmt = await macro();
    expect(stmt).toContain('LEFT JOIN _dune_span es ON es.node_id = e.src');
    expect(stmt).toContain('LEFT JOIN _dune_span ds ON ds.node_id = e.dst');
  });

  it('passes the input table through, so it composes', async () => {
    // `e.*` over a `TableOrSubquery` is what lets it wrap a filtered edge set
    // or a relation function's result, not just `dune_edge`.
    const stmt = await macro();
    expect(stmt).toContain('edges TableOrSubquery');
    expect(stmt).toContain('SELECT e.*,');
    expect(stmt).toContain('FROM ($edges) e');
  });

  it('replaces the macro rather than dropping it', async () => {
    // There is no DROP PERFETTO MACRO, so a stale one would survive a rebuild.
    expect(await macro()).toContain('CREATE OR REPLACE PERFETTO MACRO');
  });

  it('exposes dune_edge_blocked as the macro over dune_edge', async () => {
    const stmt = await blockedView();
    expect(stmt).toContain('SELECT * FROM dune_blocked!(dune_edge)');
    expect(stmt).toContain('blocked_ns LONG');
  });

  it('drops both with their tiers, before what they read', async () => {
    const sql = await capture(graph());
    expect(sql).toContain('DROP VIEW IF EXISTS _dune_span');
    // Ahead of `dune_edge`, which it selects from.
    const drops = sql.filter((q) => q.startsWith('DROP VIEW IF EXISTS dune_'));
    expect(drops.indexOf('DROP VIEW IF EXISTS dune_edge_blocked')).toBeLessThan(
      drops.indexOf('DROP VIEW IF EXISTS dune_edge'),
    );
  });
});

describe('sql_graph phase manifests', () => {
  // NODE_MIRROR_PHASES / EDGE_MIRROR_PHASES are hand-written (see their doc for
  // why they are not a descriptor array the builders are driven from), so this
  // is what stops them drifting: the load view lists them up front, and a
  // `measure()` added, removed or reordered without an entry would silently
  // produce a progress list that skips - or mis-orders - a step.
  //
  // Every phase in both tiers is unconditional except the edge tier's reverse
  // index, which is gated on the hard edge cap and so always runs at this size.

  // Which positions the recorded phase names and the manifest disagree at, one
  // human-readable line each. An empty list is the pass, and a failure names
  // the entry that moved rather than dumping two thirty-element arrays.
  function drift(
    ran: readonly string[],
    manifest: readonly MirrorPhase[],
  ): string[] {
    const declared = manifest.map((p) => p.id);
    const lines: string[] = [];
    for (let i = 0; i < Math.max(ran.length, declared.length); i++) {
      if (ran[i] === declared[i]) continue;
      lines.push(
        `#${i}: the build ran ${ran[i] ?? '(nothing)'}, ` +
          `the manifest declares ${declared[i] ?? '(nothing)'}`,
      );
    }
    return lines;
  }

  // A graph touching every optional shape a phase might otherwise skip: a
  // shared dep set (cores and adds), a dynamic stage, a rule with targets, and
  // a forced dep.
  function graph(): BuildGraph {
    return testGraph([
      rule('r1', {
        depSet: depSet({core: ['c1'], adds: ['a1']}),
        dynamicDeps: [['d1']],
        targetFiles: ['lib/a.ml'],
      }),
      rule('r2', {depSet: depSet({core: ['c1'], adds: ['a1']})}),
      dep('c1'),
      dep('a1'),
      dep('d1'),
      dep('lib/a.ml', {forcedBy: {rule: 'r1'}}),
    ]).graph;
  }

  it('NODE_MIRROR_PHASES is what buildNodeMirror measures, in order', async () => {
    const perf = new PerfRun('node tier');
    await buildNodeMirror(stubEngine([]), graph(), {perf});
    expect(drift(perf.phaseNames, NODE_MIRROR_PHASES)).toEqual([]);
  });

  it('EDGE_MIRROR_PHASES is what buildEdgeMirror measures, in order', async () => {
    const g = graph();
    const engine = stubEngine([]);
    const nodes = await buildNodeMirror(engine, g);
    const perf = new PerfRun('edge tier');
    await buildEdgeMirror(engine, g, nodes, {perf});
    expect(drift(perf.phaseNames, EDGE_MIRROR_PHASES)).toEqual([]);
  });
});
