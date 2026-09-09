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
 * The node graph chart's source (node_graph_source.ts), from the end that can be
 * checked without a trace processor: the one query it generates, and what it
 * makes of the rows that come back.
 *
 * Everything pinned here is a silent failure. The chart draws a dot per row, so
 * an *unbounded* query is the bug this file exists to catch - a missing `LIMIT`
 * costs nothing on a fixture and freezes the tab on a real build. Next to it:
 *
 * - a missing `SELECT DISTINCT`, which spends the cap on repeats and reports an
 *   edge count as a node count (an edge query has a `src` per edge, not per
 *   node);
 * - a missing `ORDER BY`, which lets the rows arrive in a different order each
 *   time the query re-runs, and a rank in the layout keeps the order it was
 *   given, so the card redraws the same nodes as a different picture;
 * - an un-quoted column name, which comes from a dashboard-persisted config and
 *   so is user data;
 * - a version that doesn't move between loads, which is the panel's relayout
 *   key: the card would keep the previous graph's layout for the new nodes.
 */

import {describe, expect, test} from 'vitest';
import type {Engine} from '../../trace_processor/engine';
import type {DuneGraphController} from './controller';
import {ChartNodeGraphSource, NODE_GRAPH_MAX_NODES} from './node_graph_source';

// A stub engine that records every statement and answers each from `handler`.
// Rows are read through the real `iter` protocol, so the column names the
// reader asks for have to be the ones the query selects. (Same shape as
// dir_chart_source_unittest.ts's.)
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

// `count(*) OVER ()` puts the same total on every row, which is what the reader
// takes it off - so the fixture has to as well.
function rows(ids: readonly number[], total = ids.length) {
  return ids.map((id) => ({node_id: id, total}));
}

const QUERY = 'SELECT * FROM results_1';

function makeSource(
  opts: {
    readonly column?: string;
    readonly rows?: ReadonlyArray<Record<string, unknown>>;
    readonly controller?: FakeController;
  } = {},
) {
  const {engine, sql} = stubEngine(() => opts.rows ?? []);
  const controller = opts.controller ?? fakeController();
  const source = new ChartNodeGraphSource(
    engine,
    controller,
    QUERY,
    opts.column ?? 'node_id',
  );
  return {source, sql, controller};
}

// One turn of the microtask queue, which is all the stub engine needs.
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the node graph chart query', () => {
  test('is bounded by the cap, whatever the input names', () => {
    const {source} = makeSource();
    expect(source.sql()).toContain(`LIMIT ${NODE_GRAPH_MAX_NODES}`);
  });

  test('counts the whole input, not the rows it kept', () => {
    // The window function is what makes this one query rather than two: it is
    // computed over the full join, and the LIMIT applies after it. `total` is
    // therefore exact, which is what lets the chart tell "these rows are the
    // whole answer" from "there is more than can be drawn".
    const {source} = makeSource();
    expect(source.sql()).toContain('count(*) OVER () AS total');
  });

  test('counts nodes rather than join rows', () => {
    const {source} = makeSource({column: 'src'});
    expect(source.sql()).toContain('SELECT DISTINCT "src" AS node_id');
  });

  test('drives the join from the input into the mirror primary key', () => {
    const {source} = makeSource();
    const sql = source.sql();
    expect(sql).toContain('FROM dune_node n');
    expect(sql).toContain('ON q.node_id = n.node_id');
    expect(sql).toContain(`FROM (${QUERY})`);
  });

  test('orders the rows, so a re-run draws the same picture', () => {
    const {source} = makeSource();
    expect(source.sql()).toContain('ORDER BY n.node_id');
  });

  test('quotes the configured column, which is user data', () => {
    const {source} = makeSource({column: 'weird "col"'});
    expect(source.sql()).toContain(
      'SELECT DISTINCT "weird ""col""" AS node_id',
    );
  });
});

describe('ChartNodeGraphSource', () => {
  test('is idle until asked, so a chart that cannot draw costs nothing', () => {
    const {source, sql} = makeSource();
    expect(source.state.phase).toBe('idle');
    expect(sql).toEqual([]);
  });

  test('reports the nodes it read and the total behind them', async () => {
    const {source, controller} = makeSource({
      rows: rows([3, 1, 2], 9_000),
    });
    source.ensureLoaded();
    expect(source.state.phase).toBe('loading');
    await settle();

    const state = source.state;
    expect(state.phase).toBe('ready');
    if (state.phase !== 'ready') return;
    expect(state.nodes).toEqual([3, 1, 2]);
    expect(state.total).toBe(9_000);
    // The load landed between frames, so it has to ask for one.
    expect(controller.redraws).toBe(1);
  });

  test('reports a total of zero when the rows named no nodes', async () => {
    const {source} = makeSource({rows: []});
    source.ensureLoaded();
    await settle();

    const state = source.state;
    expect(state.phase).toBe('ready');
    if (state.phase !== 'ready') return;
    expect(state.nodes).toEqual([]);
    expect(state.total).toBe(0);
  });

  test('issues the query once however many frames ask', async () => {
    const {source, sql} = makeSource({rows: rows([1])});
    source.ensureLoaded();
    source.ensureLoaded();
    await settle();
    source.ensureLoaded();

    expect(sql.length).toBe(1);
  });

  test('re-reads when the mirror is rebuilt under it', async () => {
    // A reload renumbers every node, so the ids held here stop meaning
    // anything - and the version they are handed on has to move with them.
    const controller = fakeController(1);
    const {source, sql} = makeSource({controller, rows: rows([1])});
    source.ensureLoaded();
    await settle();
    const first = source.state;

    controller.mirrorVersion = 2;
    source.ensureLoaded();
    await settle();
    const second = source.state;

    expect(sql.length).toBe(2);
    expect(first.phase === 'ready' && second.phase === 'ready').toBe(true);
    if (first.phase !== 'ready' || second.phase !== 'ready') return;
    expect(second.version).toBeGreaterThan(first.version);
  });

  test('gives two sources distinct versions', async () => {
    // The panel outlives the source: the host rebuilds the loader when the
    // chart's query changes, and hands the same component the new source's
    // first result. Two "1"s there would skip the relayout.
    const a = makeSource({rows: rows([1])});
    const b = makeSource({rows: rows([2])});
    a.source.ensureLoaded();
    b.source.ensureLoaded();
    await settle();

    const first = a.source.state;
    const second = b.source.state;
    if (first.phase !== 'ready' || second.phase !== 'ready') {
      throw new Error('both loads should have landed');
    }
    expect(first.version).not.toBe(second.version);
  });

  test('puts a failed query on the state rather than throwing it', async () => {
    const engine = {
      query: async () => {
        throw new Error('no such column: node_id');
      },
    } as unknown as Engine;
    const source = new ChartNodeGraphSource(
      engine,
      fakeController(),
      QUERY,
      'node_id',
    );
    source.ensureLoaded();
    await settle();

    const state = source.state;
    expect(state.phase).toBe('error');
    if (state.phase !== 'error') return;
    expect(state.message).toContain('no such column');
  });

  test('does not touch its state once disposed', async () => {
    const {source} = makeSource({rows: rows([1])});
    source.ensureLoaded();
    source.dispose();
    await settle();

    expect(source.state.phase).toBe('idle');
  });
});
