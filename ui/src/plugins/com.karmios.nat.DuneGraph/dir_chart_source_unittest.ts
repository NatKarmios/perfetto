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
 * The chart's row-driven source (dir_chart_source.ts), from the two ends that
 * can be checked without a trace processor: the pure derivation of the pane's
 * channels from a query's rows, and the one query the source issues, captured
 * through a stub engine.
 *
 * The failures worth pinning are all silent ones:
 *
 * - a count keyed on the wrong thing, or a `matchingCounts` that returns
 *   undefined, which sends `FilteredTree` to the mirror's stored totals and
 *   draws the whole build instead of the query's rows;
 * - an unbounded input query, which materialises every node in the build in the
 *   browser, or a cap that silently drops rows without saying so;
 * - a member list in the wrong order, which makes "show more" hand back pages
 *   of an unordered result;
 * - a source that answers `rootDirs` plausibly, which would put the pane back on
 *   its lazy descent and show the whole tree.
 */

import {describe, expect, test} from 'vitest';
import type {Engine} from '../../trace_processor/engine';
import type {DuneGraphController} from './controller';
import {
  CHART_ROW_CAP,
  ChartDirExplorerSource,
  type ChartMemberRow,
  indexChartRows,
} from './dir_chart_source';

// A stub engine that records every statement and answers each from `handler`.
// Rows are read through the real `iter` protocol, so the column names the
// readers ask for have to be the ones the queries select. (Same shape as
// dir_explorer_unittest.ts's, plus the dispatch: this source issues two
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

function nodeRow(over: Record<string, unknown>) {
  return {dir_id: 2, node_id: 1, kind: 'dep', label: 'a.ml', ...over};
}

// Which of the two queries a statement is. `allDirs` is the only one reading
// `dune_dir`; everything else this source issues is the input join.
function isDirQuery(sql: string): boolean {
  return sql.includes('FROM dune_dir');
}

function sourceOver(
  rows: ReadonlyArray<Record<string, unknown>>,
  opts: {column?: string; controller?: FakeController} = {},
) {
  const {engine, sql} = stubEngine((q) => (isDirQuery(q) ? DIRS : rows));
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

describe('indexChartRows', () => {
  const rows: ChartMemberRow[] = [
    {dirId: 2, nodeId: 5, kind: 'dep', label: 'b.ml'},
    {dirId: 2, nodeId: 6, kind: 'rule', label: 'zzz'},
    {dirId: 2, nodeId: 7, kind: 'dep', label: 'a.ml'},
    {dirId: 3, nodeId: 8, kind: 'rule', label: 'r'},
  ];

  test('counts each kind per directory', () => {
    const {counts} = indexChartRows(rows);
    expect([...counts.rule]).toEqual([
      [2, 1],
      [3, 1],
    ]);
    expect([...counts.dep]).toEqual([[2, 2]]);
  });

  test('leaves a directory with no rows out of both channels', () => {
    // This is the hard filter: `FilteredTree` draws no row for a directory
    // nothing counted in, so an entry here would put the whole mirror back.
    const {counts, members} = indexChartRows(rows);
    expect(counts.rule.has(1)).toBe(false);
    expect(counts.dep.has(1)).toBe(false);
    expect(members.has(1)).toBe(false);
  });

  test('orders members rules-first then by label, as paging needs', () => {
    const {members} = indexChartRows(rows);
    expect(members.get(2)?.map((r) => r.label)).toEqual([
      'zzz',
      'a.ml',
      'b.ml',
    ]);
  });
});

describe('ChartDirExplorerSource queries', () => {
  test('joins the input into dune_node, bounded, on the configured column', async () => {
    const {source, sql} = sourceOver([nodeRow({})]);
    await source.allDirs();

    const join = sql.find((q) => !isDirQuery(q));
    expect(join).toBeDefined();
    expect(has(join!, 'FROM dune_node n')).toBe(true);
    expect(
      has(join!, 'JOIN (SELECT * FROM results_1) q ON q."node_id" = n.node_id'),
    ).toBe(true);
    // One more than the cap: that row is what says the cap bit.
    expect(has(join!, `LIMIT ${CHART_ROW_CAP + 1}`)).toBe(true);
  });

  test('quotes the column name rather than pasting it in', async () => {
    const {source, sql} = sourceOver([], {column: 'we"ird'});
    await source.allDirs();
    expect(sql.some((q) => q.includes('q."we""ird"'))).toBe(true);
  });

  test('reads the hierarchy and the rows in one pass each', async () => {
    const {source, sql} = sourceOver([nodeRow({})]);
    await Promise.all([
      source.allDirs(),
      source.matchingCounts('rule', {}),
      source.dirMembers(2, undefined, 10, 0),
    ]);
    // Three reads of the same load, still two statements.
    expect(sql).toHaveLength(2);
  });

  test('re-reads when the mirror is rebuilt under it', async () => {
    const controller = fakeController(3);
    const {source, sql} = sourceOver([nodeRow({})], {controller});
    await source.allDirs();
    expect(sql).toHaveLength(2);
    expect(source.version).toBe(3);

    controller.mirrorVersion = 4;
    await source.allDirs();
    expect(sql).toHaveLength(4);
    expect(source.version).toBe(4);
  });
});

describe('ChartDirExplorerSource contract', () => {
  test('declares itself row-driven', () => {
    const {source} = sourceOver([]);
    expect(source.rowDriven).toBe(true);
  });

  test('refuses to be descended a level at a time', async () => {
    // Returning [] here would look like an empty build; the pane would draw
    // nothing and no one would know why.
    const {source} = sourceOver([nodeRow({})]);
    await expect(source.rootDirs()).rejects.toThrow(/rows/);
    await expect(source.childDirs()).rejects.toThrow(/rows/);
  });

  test('never says "all of them" for a kind', async () => {
    // Undefined would send FilteredTree to the mirror's stored n_rules/n_deps,
    // i.e. draw every directory in the build.
    const {source} = sourceOver([]);
    expect(await source.matchingCounts('rule', {})).toBeDefined();
    expect(await source.matchingCounts('dep', {})).toBeDefined();
  });

  test('pages members out of the input rows', async () => {
    const {source, sql} = sourceOver([
      nodeRow({node_id: 1, label: 'b.ml'}),
      nodeRow({node_id: 2, label: 'a.ml'}),
      nodeRow({node_id: 3, kind: 'rule', label: 'r'}),
    ]);
    const first = await source.dirMembers(2, undefined, 2, 0);
    expect(first.map((r) => r.label)).toEqual(['r', 'a.ml']);
    const second = await source.dirMembers(2, undefined, 2, 2);
    // A short page ends the list, which is what the pane reads "no more" off.
    expect(second.map((r) => r.label)).toEqual(['b.ml']);
    // Still no query per page: they are slices of the rows already in hand.
    expect(sql).toHaveLength(2);
  });

  test('narrows members and bulk ids by kind', async () => {
    const {source} = sourceOver([
      nodeRow({node_id: 1, label: 'a.ml'}),
      nodeRow({node_id: 2, kind: 'rule', label: 'r'}),
    ]);
    expect(await source.dirMembers(2, 'dep', 10, 0)).toEqual([
      {dirId: 2, nodeId: 1, kind: 'dep', label: 'a.ml'},
    ]);
    expect(await source.dirMemberIds(2, ['rule'])).toEqual([2]);
    expect(await source.dirMemberIds(2, ['rule', 'dep'])).toEqual([2, 1]);
  });

  test('de-duplicates a node the input named twice', async () => {
    // An edge query has a `src` per edge, not per node.
    const {source} = sourceOver([nodeRow({node_id: 9}), nodeRow({node_id: 9})]);
    expect(await source.matchingCounts('dep', {})).toEqual(new Map([[2, 1]]));
  });
});

describe('ChartDirExplorerSource state', () => {
  test('reports the row count and asks for a redraw when the load lands', async () => {
    const {source, controller} = sourceOver([nodeRow({})]);
    expect(source.state.phase).toBe('idle');
    source.ensureLoaded();
    expect(source.state.phase).toBe('loading');
    await source.allDirs();
    expect(source.state).toEqual({
      phase: 'ready',
      rowCount: 1,
      truncated: false,
    });
    expect(controller.redraws).toBeGreaterThan(0);
  });

  test('says so when the cap bites, and holds exactly the cap', async () => {
    const rows = Array.from({length: CHART_ROW_CAP + 1}, (_, i) =>
      nodeRow({node_id: i}),
    );
    const {source} = sourceOver(rows);
    await source.allDirs();
    expect(source.state).toEqual({
      phase: 'ready',
      rowCount: CHART_ROW_CAP,
      truncated: true,
    });
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
    const {source} = sourceOver([
      nodeRow({dir_id: 2, node_id: 1}),
      nodeRow({dir_id: 1, node_id: 2}),
    ]);
    await source.allDirs();
    // From the root: 1 and 2 hold rows, 0 and 3 do not. Sorted for the
    // comparison only - the walk's order is its own business.
    expect([...source.subtreeDirIds(0)].sort()).toEqual([1, 2]);
    expect(source.subtreeDirIds(2)).toEqual([2]);
    expect(source.subtreeDirIds(3)).toEqual([]);
  });

  test('is empty before the load lands', () => {
    const {source} = sourceOver([nodeRow({})]);
    expect(source.subtreeDirIds(0)).toEqual([]);
  });
});
