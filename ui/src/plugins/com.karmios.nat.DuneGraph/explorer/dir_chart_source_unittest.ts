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
 * The chart's row-driven source (dir_chart_source.ts), from the end that can be
 * checked without a trace processor: the queries it generates, captured through
 * a stub engine, and what it makes of the rows they come back with.
 *
 * The failures worth pinning are all silent ones, and the chief of them is an
 * _unbounded_ query: the chart's input can be every node in the build, so a
 * query whose result size follows the input's - rather than the mirror's
 * directory count, or a member page's `LIMIT` - is the bug this file exists to
 * catch.
 */

import {describe, expect, test} from 'vitest';
import type {Engine} from '../../../trace_processor/engine';
import type {DuneGraphController} from '../controller';
import {ChartDirExplorerSource} from './dir_chart_source';
import type {MemberFilter} from '../model/dir_explorer';

// A stub engine that records every statement and answers each from `handler`.
// Rows are read through the real `iter` protocol, so the column names the
// readers ask for have to be the ones the queries select. (Same shape as
// dir_explorer_unittest.ts's, plus the dispatch: this source issues three
// different queries and they want different rows.)
function stubEngine(
  handler: (sql: string) => ReadonlyArray<Record<string, unknown>>,
): {engine: Engine; sql: string[]} {
  const sql: string[] = [];
  const engine = {
    query: async (q: string) => {
      sql.push(q);
      const rows = handler(q);
      let i = 0;
      const it = {
        valid: () => i < rows.length,
        next: () => {
          i++;
        },
      };
      return {
        iter: () =>
          new Proxy(it, {
            get: (target, prop) => {
              if (prop in target) return target[prop as keyof typeof target];
              return rows[i]?.[prop as string];
            },
          }),
      };
    },
  } as unknown as Engine;
  return {engine, sql};
}

// Everything this source reads off the controller: which mirror its ids belong
// to, and somewhere to send the redraw a landed load needs. Both stay writable
// and readable, since a rebuilt mirror and a requested redraw are two of the
// things being checked.
type FakeController = DuneGraphController & {
  mirrorVersion: number;
  redraws: number;
};

function fakeController(mirrorVersion = 0): FakeController {
  const controller = {
    mirrorVersion,
    redraws: 0,
    requestRedraw: () => {
      controller.redraws++;
    },
  };
  return controller as unknown as FakeController;
}

// One `dune_dir` row, with every column `readDirs` wants.
function dirRow(over: Record<string, unknown>) {
  return {
    parent_id: undefined,
    name: '',
    path: '',
    depth: 0,
    n_rules: 0,
    n_deps: 0,
    n_failed: 0,
    t_rules: 0,
    t_deps: 0,
    t_failed: 0,
    total_dur_ns: 0n,
    ...over,
  };
}

// `_build` → `_build/default` → {lib, bin}: enough hierarchy for a subtree walk
// and for a directory that holds none of the query's rows.
const DIRS = [
  dirRow({id: 0, name: '_build', path: '_build', depth: 0}),
  dirRow({id: 1, parent_id: 0, name: 'default', path: '_build/default'}),
  dirRow({id: 2, parent_id: 1, name: 'lib', path: '_build/default/lib'}),
  dirRow({id: 3, parent_id: 1, name: 'bin', path: '_build/default/bin'}),
];

// One row of the counts query: a directory, a kind, and how many of the input's
// nodes of that kind it holds.
function countRow(dirId: number, kind: string, cnt: number) {
  return {dir_id: dirId, kind, cnt};
}

// One row of a member query.
function memberRow(over: Record<string, unknown> = {}) {
  return {node_id: 1, kind: 'dep', label: 'a.ml', ...over};
}

// Which query a statement is. The counts query is the only one that aggregates,
// and it is tested for *first*: under a path filter it embeds a `dune_dir` scan
// of its own (the rule half of a path test - see `countsWhere`), so "reads
// `dune_dir`" does not pick out the hierarchy read on its own.
function isCountsQuery(sql: string): boolean {
  return sql.includes('count(*)');
}

// `allDirs`, or the scan behind `matchingRuleDirs` - both read `dune_dir` and
// both are answered from the same canned rows, since both are read for an `id`.
function isDirQuery(sql: string): boolean {
  return !isCountsQuery(sql) && sql.includes('FROM dune_dir');
}

function isMemberQuery(sql: string): boolean {
  return !isCountsQuery(sql) && !isDirQuery(sql);
}

function sourceOver(
  rows: {
    counts?: ReadonlyArray<Record<string, unknown>>;
    members?: ReadonlyArray<Record<string, unknown>>;
  } = {},
  opts: {column?: string; controller?: FakeController} = {},
) {
  const {engine, sql} = stubEngine((q) => {
    if (isCountsQuery(q)) return rows.counts ?? [];
    if (isDirQuery(q)) return DIRS;
    return rows.members ?? [];
  });
  const controller = opts.controller ?? fakeController();
  const source = new ChartDirExplorerSource(
    engine,
    controller,
    'SELECT * FROM results_1',
    opts.column ?? 'node_id',
  );
  return {source, sql, controller};
}

// Whitespace-insensitive containment, since the queries are template literals.
function has(sql: string, fragment: string): boolean {
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
  return flat(sql).includes(flat(fragment));
}

describe('ChartDirExplorerSource counts query', () => {
  test('aggregates per directory and kind rather than reading the rows', async () => {
    // The point of the whole file: the result size follows `dune_dir` (two rows
    // per directory at the very worst) rather than the input's, so there is
    // nothing to cap and the tree is complete however big the query is.
    const {source, sql} = sourceOver();
    await source.matchingCounts('rule', {});

    const counts = sql.find(isCountsQuery);
    expect(counts).toBeDefined();
    expect(
      has(
        counts!,
        'SELECT n.dir_id AS dir_id, n.kind AS kind, count(*) AS cnt ' +
          'FROM dune_node n',
      ),
    ).toBe(true);
    expect(has(counts!, 'GROUP BY 1, 2')).toBe(true);
    expect(counts).not.toMatch(/LIMIT/);
  });

  test('counts nodes rather than join rows', async () => {
    // An edge query has a `src` per edge, not per node, so counting the join
    // would count a node once per edge it appears on.
    const {source, sql} = sourceOver();
    await source.matchingCounts('rule', {});

    const counts = sql.find(isCountsQuery)!;
    expect(
      has(
        counts,
        'JOIN ( SELECT DISTINCT "node_id" AS node_id ' +
          'FROM (SELECT * FROM results_1) ) q ON q.node_id = n.node_id',
      ),
    ).toBe(true);
  });

  test('quotes the column name rather than pasting it in', async () => {
    const {source, sql} = sourceOver({}, {column: 'we"ird'});
    await source.matchingCounts('rule', {});
    expect(sql.some((q) => q.includes('"we""ird" AS node_id'))).toBe(true);
  });

  test('splits the rows into one channel per kind', async () => {
    const {source} = sourceOver({
      counts: [
        countRow(2, 'dep', 2),
        countRow(2, 'rule', 1),
        countRow(3, 'rule', 5),
      ],
    });
    expect([...(await source.matchingCounts('rule', {}))]).toEqual([
      [2, 1],
      [3, 5],
    ]);
    expect([...(await source.matchingCounts('dep', {}))]).toEqual([[2, 2]]);
  });

  test('leaves a directory with no rows out of both channels', async () => {
    // This is the hard filter: `FilteredTree` draws no row for a directory
    // nothing counted in, so an entry here would put the whole mirror back.
    const {source} = sourceOver({counts: [countRow(2, 'dep', 1)]});
    expect((await source.matchingCounts('rule', {})).has(1)).toBe(false);
    expect((await source.matchingCounts('dep', {})).has(1)).toBe(false);
  });

  test('reads the hierarchy and the counts once between them', async () => {
    const {source, sql} = sourceOver({counts: [countRow(2, 'dep', 1)]});
    await Promise.all([
      source.allDirs(),
      source.matchingCounts('rule', {}),
      source.matchingCounts('dep', {}),
    ]);
    // Three reads of the same load, still two statements.
    expect(sql).toHaveLength(2);
  });

  test('re-reads when the mirror is rebuilt under it', async () => {
    const controller = fakeController(3);
    const {source, sql} = sourceOver({}, {controller});
    await source.allDirs();
    expect(sql).toHaveLength(2);
    expect(source.version).toBe(3);

    controller.mirrorVersion = 4;
    await source.allDirs();
    expect(sql).toHaveLength(4);
    expect(source.version).toBe(4);
  });
});

describe('ChartDirExplorerSource member queries', () => {
  test('pages one directory rather than slicing the input', async () => {
    const {source, sql} = sourceOver({members: [memberRow()]});
    await source.dirMembers(2, 'dep', 500, 1000);

    const members = sql.find(isMemberQuery);
    expect(members).toBeDefined();
    expect(
      has(
        members!,
        'SELECT n.node_id AS node_id, n.kind AS kind, n.label AS label ' +
          'FROM dune_node n',
      ),
    ).toBe(true);
    // `dir_id` first: it is the index probe that selects rows, and it is what
    // bounds this query by the directory instead of by the input.
    expect(
      has(
        members!,
        "WHERE n.dir_id = 2 AND n.kind = 'dep' " +
          'AND n.node_id IN (SELECT "node_id" FROM (SELECT * FROM results_1))',
      ),
    ).toBe(true);
    // Rules before deps then by label - the order paging rests on.
    expect(has(members!, 'ORDER BY n.kind DESC, n.label')).toBe(true);
    expect(has(members!, 'LIMIT 500 OFFSET 1000')).toBe(true);
  });

  test('asks for both kinds by leaving the kind clause out', async () => {
    // A node has no third kind, so `kind IN ('rule','dep')` would narrow
    // nothing while costing a comparison on a computed column.
    const {source, sql} = sourceOver({members: []});
    await source.dirMembers(7, undefined, 10, 0);

    const members = sql.find(isMemberQuery)!;
    expect(members).not.toMatch(/n\.kind =/);
    expect(has(members, 'WHERE n.dir_id = 7 AND n.node_id IN')).toBe(true);
  });

  test('does not need the counts load to page a directory', async () => {
    // One query per page, and nothing held between them.
    const {source, sql} = sourceOver({members: [memberRow()]});
    await source.dirMembers(2, undefined, 10, 0);
    expect(sql).toHaveLength(1);
  });

  test('maps a member row onto what the pane renders', async () => {
    const {source} = sourceOver({
      members: [memberRow({node_id: 4, kind: 'rule', label: 'lib:foo'})],
    });
    expect(await source.dirMembers(2, undefined, 10, 0)).toEqual([
      {nodeId: 4, kind: 'rule', label: 'lib:foo'},
    ]);
  });

  test('reads bulk ids unbounded but still from one directory', async () => {
    const {source, sql} = sourceOver({
      members: [memberRow({node_id: 4}), memberRow({node_id: 9})],
    });
    expect(await source.dirMemberIds(2, ['rule'])).toEqual([4, 9]);

    const ids = sql.find(isMemberQuery)!;
    expect(has(ids, 'SELECT n.node_id AS node_id FROM dune_node n')).toBe(true);
    expect(
      has(
        ids,
        "WHERE n.dir_id = 2 AND n.kind = 'rule' " +
          'AND n.node_id IN (SELECT "node_id" FROM (SELECT * FROM results_1))',
      ),
    ).toBe(true);
    // Unbounded by design: the count is on screen before the click and the
    // caller is about to put them all in a Set.
    expect(ids).not.toMatch(/LIMIT/);
  });

  test('asks nothing at all for no kinds', async () => {
    const {source, sql} = sourceOver();
    expect(await source.dirMemberIds(2, [])).toEqual([]);
    expect(sql).toHaveLength(0);
  });
});

/**
 * A filter reaching into every part of one: a path (which is per kind - a dep's
 * own label, a rule's directory), a rule-only attribute, and a node column that
 * applies to both kinds. The three halves are what the queries below have to
 * keep apart.
 */
const FILTER: MemberFilter = {
  path: {text: 'lib', pattern: '*lib*'},
  outcomes: new Set(['failed-action' as const]),
  minDurNs: 10_000_000n,
};

describe('ChartDirExplorerSource under a member filter', () => {
  test('narrows the counts by the filter as well as by the input', async () => {
    // Both narrowings, ANDed: the semi-join is what makes this the query's
    // tree, and the arms are what make it the filter's.
    const {source, sql} = sourceOver();
    await source.matchingCounts('rule', FILTER);

    const counts = sql.find(isCountsQuery)!;
    // Still an aggregate over the mirror's directories, still uncapped.
    expect(has(counts, 'GROUP BY 1, 2')).toBe(true);
    expect(counts).not.toMatch(/LIMIT/);
    expect(
      has(
        counts,
        'JOIN ( SELECT DISTINCT "node_id" AS node_id ' +
          'FROM (SELECT * FROM results_1) ) q ON q.node_id = n.node_id',
      ),
    ).toBe(true);
    // The detail tables, which the filter's `r.` / `d.` predicates need. Both
    // joins are on the primary key, so they probe rather than scan.
    expect(has(counts, 'LEFT JOIN dune_rule r USING (node_id)')).toBe(true);
    expect(has(counts, 'LEFT JOIN dune_dep d USING (node_id)')).toBe(true);
    // One arm per kind, each narrowed on its own columns.
    expect(
      has(
        counts,
        "WHERE (n.kind = 'rule' AND (n.dir_id IN (SELECT id FROM dune_dir " +
          "WHERE path GLOB '*lib*') AND r.outcome IN ('failed-action') " +
          'AND n.dur_ns >= 10000000))',
      ),
    ).toBe(true);
    expect(
      has(
        counts,
        "OR (n.kind = 'dep' AND (n.label GLOB '*lib*' " +
          'AND n.dur_ns >= 10000000))',
      ),
    ).toBe(true);
  });

  test("spells a rule's path test as a scan rather than an id list", async () => {
    // This query spans directories, so the rule path test is a column test -
    // and it cannot be the id set the pane holds, since one query answers both
    // kinds and only the rule call is handed that set.
    const {source, sql} = sourceOver();
    await source.matchingCounts('dep', FILTER);
    const counts = sql.find(isCountsQuery)!;
    expect(has(counts, 'n.dir_id IN (SELECT id FROM dune_dir')).toBe(true);
  });

  test('leaves the unfiltered counts query exactly as it was', async () => {
    // The hot path: every chart runs this one, filter or no filter, so an empty
    // filter must not add a tautology on `kind` or two joins to skip.
    const {source, sql} = sourceOver();
    await source.matchingCounts('rule', {});
    const counts = sql.find(isCountsQuery)!;
    expect(counts).not.toMatch(/WHERE/);
    expect(counts).not.toMatch(/LEFT JOIN/);
    expect(counts).not.toMatch(/n\.kind =/);
  });

  test('reads one counts query per filter, and none for the empty one', async () => {
    const {source, sql} = sourceOver();
    // The load's two statements, and nothing more for either kind.
    await Promise.all([
      source.matchingCounts('rule', {}),
      source.matchingCounts('dep', {}),
    ]);
    expect(sql).toHaveLength(2);

    // One more for the filter, shared by both kinds.
    await Promise.all([
      source.matchingCounts('rule', FILTER),
      source.matchingCounts('dep', FILTER),
    ]);
    expect(sql.filter(isCountsQuery)).toHaveLength(2);

    // A different filter is a different query; the same one is not.
    await source.matchingCounts('rule', {...FILTER, minDurNs: 1n});
    await source.matchingCounts('rule', FILTER);
    expect(sql.filter(isCountsQuery)).toHaveLength(3);
  });

  test('keeps the filter out of the node count the chart reports', async () => {
    // `nodeCount` answers "did this column name any Dune nodes at all", which
    // is about the chart's config rather than about the pane's filter: a filter
    // matching nothing must not turn into "no Dune nodes in these rows", which
    // would replace the tree - filter box and all - with a prompt to pick
    // another column.
    const {engine} = stubEngine((q) => {
      if (!isCountsQuery(q)) return DIRS;
      // The filtered channel is the one with a WHERE, and it matches nothing.
      return q.includes('WHERE') ? [] : [countRow(2, 'dep', 2)];
    });
    const source = new ChartDirExplorerSource(
      engine,
      fakeController(),
      'SELECT * FROM results_1',
      'node_id',
    );
    source.ensureLoaded();
    expect(await source.matchingCounts('dep', FILTER)).toEqual(new Map());
    expect(source.state).toEqual({phase: 'ready', nodeCount: 2});
  });

  test('narrows a member page by the filter, still starting from the directory', async () => {
    const {source, sql} = sourceOver({members: [memberRow()]});
    await source.dirMembers(2, 'dep', 500, 1000, FILTER, true);

    const members = sql.find(isMemberQuery)!;
    expect(has(members, 'LEFT JOIN dune_dep d USING (node_id)')).toBe(true);
    expect(
      has(
        members,
        "WHERE n.dir_id = 2 AND ((n.kind = 'dep' AND " +
          "(n.label GLOB '*lib*' AND n.dur_ns >= 10000000))) " +
          'AND n.node_id IN (SELECT "node_id" FROM (SELECT * FROM results_1))',
      ),
    ).toBe(true);
    // `dir_id` still first, and still the only term that selects rows.
    const flat = members.replace(/\s+/g, ' ');
    expect(flat.indexOf('n.dir_id = 2')).toBeLessThan(
      flat.indexOf('n.label GLOB'),
    );
    expect(has(members, 'ORDER BY n.kind DESC, n.label')).toBe(true);
    expect(has(members, 'LIMIT 500 OFFSET 1000')).toBe(true);
  });

  test('excludes rules whose directory did not match, without testing a path', async () => {
    // The pane has already answered the rule path test for this directory, so
    // the arm is a literal - the same trade the side panel's queries make.
    const {source, sql} = sourceOver({members: []});
    await source.dirMembers(2, undefined, 10, 0, FILTER, false);

    const members = sql.find(isMemberQuery)!;
    expect(has(members, "(n.kind = 'rule' AND (0 AND")).toBe(true);
    expect(members).not.toContain('path GLOB');
  });

  test('narrows bulk ids by the filter too', async () => {
    // Otherwise ＋all adds the rows the filter just hid.
    const {source, sql} = sourceOver({members: [memberRow({node_id: 4})]});
    expect(await source.dirMemberIds(2, ['rule'], FILTER, true)).toEqual([4]);

    const ids = sql.find(isMemberQuery)!;
    expect(
      has(
        ids,
        "WHERE n.dir_id = 2 AND ((n.kind = 'rule' AND " +
          "(r.outcome IN ('failed-action') AND n.dur_ns >= 10000000))) " +
          'AND n.node_id IN (SELECT "node_id" FROM (SELECT * FROM results_1))',
      ),
    ).toBe(true);
    // No path test in the arm at all: the pane answered it for this directory
    // (`dirPathMatches`), so a matching directory leaves the rules alone.
    expect(ids).not.toContain('GLOB');
    expect(ids).not.toMatch(/LIMIT/);
  });

  test('finds the matching directories with the real scan', async () => {
    // Not "all of them": a rule is matched on its directory, and which
    // directories those are has nothing to do with the chart's input - the
    // semi-join settles what the *query* named, separately.
    const {source, sql} = sourceOver();
    expect([...(await source.matchingRuleDirs(FILTER.path!))]).toEqual([
      0, 1, 2, 3,
    ]);
    expect(
      sql.some((q) =>
        has(q, "SELECT id FROM dune_dir WHERE path GLOB '*lib*'"),
      ),
    ).toBe(true);
  });
});

describe('ChartDirExplorerSource contract', () => {
  test('declares itself row-driven', () => {
    const {source} = sourceOver();
    expect(source.rowDriven).toBe(true);
  });

  test('refuses to be descended a level at a time', async () => {
    // Returning [] here would look like an empty build; the pane would draw
    // nothing and no one would know why.
    const {source} = sourceOver();
    await expect(source.rootDirs()).rejects.toThrow(/rows/);
    await expect(source.childDirs()).rejects.toThrow(/rows/);
  });

  test('never says "all of them" for a kind', async () => {
    // Undefined would send FilteredTree to the mirror's stored n_rules/n_deps,
    // i.e. draw every directory in the build.
    const {source} = sourceOver();
    expect(await source.matchingCounts('rule', {})).toBeDefined();
    expect(await source.matchingCounts('dep', {})).toBeDefined();
  });
});

describe('ChartDirExplorerSource state', () => {
  test('reports the node count and asks for a redraw when the load lands', async () => {
    const {source, controller} = sourceOver({
      counts: [countRow(2, 'dep', 2), countRow(3, 'rule', 1)],
    });
    expect(source.state.phase).toBe('idle');
    source.ensureLoaded();
    expect(source.state.phase).toBe('loading');
    await source.allDirs();
    expect(source.state).toEqual({phase: 'ready', nodeCount: 3});
    expect(controller.redraws).toBeGreaterThan(0);
  });

  test('reports nothing counted as a zero rather than as a failure', async () => {
    const {source} = sourceOver({counts: []});
    await source.allDirs();
    expect(source.state).toEqual({phase: 'ready', nodeCount: 0});
  });

  test('keeps a failed query as a message rather than a retry loop', async () => {
    const engine = {
      query: async () => {
        throw new Error('no such column: q.path');
      },
    } as unknown as Engine;
    const source = new ChartDirExplorerSource(
      engine,
      fakeController(),
      'SELECT * FROM results_1',
      'path',
    );
    source.ensureLoaded();
    await expect(source.allDirs()).rejects.toThrow('no such column');
    expect(source.state).toEqual({
      phase: 'error',
      message: 'no such column: q.path',
    });
  });
});

describe('ChartDirExplorerSource.subtreeDirIds', () => {
  test('returns the subtree directories that hold rows, and only those', async () => {
    const {source} = sourceOver({
      counts: [countRow(2, 'dep', 1), countRow(1, 'rule', 1)],
    });
    await source.allDirs();
    // From the root: 1 and 2 hold rows, 0 and 3 do not. Sorted for the
    // comparison only - the walk's order is its own business.
    expect([...source.subtreeDirIds(0)].sort()).toEqual([1, 2]);
    expect(source.subtreeDirIds(2)).toEqual([2]);
    expect(source.subtreeDirIds(3)).toEqual([]);
  });

  test('is empty before the load lands', () => {
    const {source} = sourceOver({counts: [countRow(0, 'dep', 1)]});
    expect(source.subtreeDirIds(0)).toEqual([]);
  });
});
