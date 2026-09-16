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
 * How a process slice's args come back out of SQL as a `ProcessDetails`.
 *
 * There is no trace processor in a unit test, so the engine is stubbed: each
 * statement is matched against the canned result the test wants for it. What
 * that pins is the *mapping* - which is where the interesting decisions are,
 * since a process's argv arrives as one row per element and has to be
 * reassembled per slice, and two of the columns have "absent" encodings that
 * are not NULL (perfetto's `dur = -1` for a slice that never finished).
 *
 * The scan-shaped SQL itself is checked against real traces rather than here;
 * see the file comment in process_sql.ts.
 */

import {describe, expect, test} from 'vitest';
import type {Engine} from '../../../trace_processor/engine';
import type {Row} from '../../../trace_processor/query_result';
import {
  buildProcessSlices,
  processCmdFunction,
  processCmdMacro,
} from './process_sql';

// One canned answer: the substring identifying the statement, and the rows it
// returns.
interface Canned {
  readonly match: string;
  readonly rows: readonly Row[];
}

/**
 * An engine that answers each statement with the first canned result whose
 * `match` it contains, and records every statement it was handed.
 *
 * `firstRow`/`iter` are hand-rolled rather than borrowed from the real
 * `QueryResult`: the production types are driven by a wasm protobuf reader, and
 * a plain array of rows is all the code under test reads.
 */
function stubEngine(canned: readonly Canned[], sql: string[]): Engine {
  const answer = async (q: string) => {
    sql.push(q);
    const rows = canned.find((c) => q.includes(c.match))?.rows ?? [];
    let i = 0;
    return {
      numRows: () => rows.length,
      firstRow: () => rows[0] ?? {},
      iter: () => ({
        valid: () => i < rows.length,
        next: () => i++,
        // The iterator hands out the current row's columns by property access,
        // which is what `it.slice_id` etc. compile to.
        get slice_id() {
          return rows[i]?.slice_id;
        },
        get dur() {
          return rows[i]?.dur;
        },
        get prog() {
          return rows[i]?.prog;
        },
        get dir() {
          return rows[i]?.dir;
        },
        get exit_code() {
          return rows[i]?.exit_code;
        },
        get arg() {
          return rows[i]?.arg;
        },
      }),
    };
  };
  return {query: answer, tryQuery: answer} as unknown as Engine;
}

// The table's row count comes back from the `count(*)` the build issues, so a
// non-zero one has to be canned for the lookups to run at all.
const COUNT_ROWS: Canned = {match: 'count(*)', rows: [{n: 3}]};

// The same, for a trace whose dune emitted no `forced_by` arg at all.
const NO_ROWS: Canned = {match: 'count(*)', rows: [{n: 0}]};

// Two processes of the same rule, the second unfinished and missing every
// optional arg - the shape an interrupted build leaves behind.
const SCALAR_ROWS: Canned = {
  match: 'p.rule_id =',
  rows: [
    {
      slice_id: 10,
      dur: 5_000n,
      prog: '/nix/store/x/bin/ocamlc.opt',
      dir: '_build/default',
      exit_code: 0,
    },
    {slice_id: 11, dur: -1n, prog: null, dir: null, exit_code: null},
  ],
};

// Slice 10's argv, and none for slice 11. Ordered by the query, so the rows
// arrive in index order; slice 11 simply has no rows.
//
// Matched on the lookup's own `WHERE`, not on the flat key: the flat key now
// appears in the view the build creates, which is a different statement.
const ARGV_LOOKUP = 'WHERE slice_id IN';
const ARGV_ROWS: Canned = {
  match: ARGV_LOOKUP,
  rows: [
    {slice_id: 10, arg: '-c'},
    {slice_id: 10, arg: '-impl'},
    {slice_id: 10, arg: 'src/a.ml'},
  ],
};

async function build(canned: readonly Canned[], sql: string[] = []) {
  return buildProcessSlices(stubEngine(canned, sql));
}

describe('processesForRuleId', () => {
  test('reassembles argv per slice, in order', async () => {
    const processes = await (
      await build([COUNT_ROWS, SCALAR_ROWS, ARGV_ROWS])
    ).processesForRuleId(1314);
    expect(processes[0]).toEqual({
      sliceId: 10,
      prog: '/nix/store/x/bin/ocamlc.opt',
      dir: '_build/default',
      exitCode: 0,
      durNs: 5_000,
      args: ['-c', '-impl', 'src/a.ml'],
    });
  });

  test('an unfinished process reports no duration, and absent args stay absent', async () => {
    const processes = await (
      await build([COUNT_ROWS, SCALAR_ROWS, ARGV_ROWS])
    ).processesForRuleId(1314);
    // Perfetto stores "never finished" as dur = -1; a negative duration is not
    // a duration, so it must not be formatted as one.
    expect(processes[1]).toEqual({
      sliceId: 11,
      prog: undefined,
      dir: undefined,
      exitCode: undefined,
      durNs: undefined,
      args: [],
    });
  });

  test('exit code 0 is kept, not dropped as falsy', async () => {
    const processes = await (
      await build([COUNT_ROWS, SCALAR_ROWS, ARGV_ROWS])
    ).processesForRuleId(1314);
    expect(processes[0].exitCode).toBe(0);
  });

  test('a trace with no process slices issues no lookup at all', async () => {
    // The overwhelmingly common case today: a dune that doesn't emit the
    // `forced_by` arg. Nothing should reach the engine after the build.
    const sql: string[] = [];
    const processes = await build([NO_ROWS], sql);
    const before = sql.length;
    expect(await processes.processesForRuleId(1314)).toEqual([]);
    expect(sql.length).toBe(before);
  });

  test('a rule with no processes skips the argv query', async () => {
    // The scalar query came back empty, so there are no slice ids to ask about
    // - and `IN ()` is not valid SQLite.
    const sql: string[] = [];
    const processes = await build([COUNT_ROWS], sql);
    expect(await processes.processesForRuleId(1314)).toEqual([]);
    expect(sql.some((q) => q.includes(ARGV_LOOKUP))).toBe(false);
  });

  test('a non-finite rule id is refused rather than interpolated', async () => {
    const sql: string[] = [];
    const processes = await build([COUNT_ROWS, SCALAR_ROWS, ARGV_ROWS], sql);
    const before = sql.length;
    expect(await processes.processesForRuleId(NaN)).toEqual([]);
    expect(sql.length).toBe(before);
  });
});

describe('the SQL it issues', () => {
  test('filters by rule id and orders by start', async () => {
    const sql: string[] = [];
    const processes = await build([COUNT_ROWS, SCALAR_ROWS, ARGV_ROWS], sql);
    await processes.processesForRuleId(1314);
    const scalars = sql.find((q) => q.includes('p.rule_id ='))!;
    expect(scalars).toContain('p.rule_id = 1314');
    expect(scalars).toContain('ORDER BY s.ts');
  });

  test('stores the arg set on the table and indexes it', async () => {
    // The 580 s-vs-1.0 s guard. With the arg set reached through `slice`
    // instead, `SELECT * FROM dune_process_arg WHERE arg = '-impl'` did not
    // finish in 580 s on the monorepo trace (native tools/trace_processor):
    // the planner drives from the 50.6M-row `args` and re-scans the process
    // table per candidate row. Stored and indexed, the same query is 1.0 s.
    const sql: string[] = [];
    await build([COUNT_ROWS], sql);
    const create = sql.find((q) => q.includes('CREATE PERFETTO TABLE'))!;
    expect(create).toContain('s.arg_set_id AS arg_set_id');
    const index = sql.find((q) => q.includes('CREATE PERFETTO INDEX'))!;
    expect(index).toContain('CREATE PERFETTO INDEX _dune_process_args');
    expect(index).toContain('ON _dune_process(arg_set_id)');
  });

  test('the arg view parses the index out of the element key', async () => {
    // `key` reads `debug.dune.process_args[N]`, so the index starts one past
    // the flat key's length plus the bracket - i.e. character 25.
    const sql: string[] = [];
    await build([COUNT_ROWS], sql);
    const view = sql.find((q) =>
      q.includes('CREATE PERFETTO VIEW dune_process_arg'),
    )!;
    expect(view).toContain('substr(a.key, 25)');
    expect(view).toContain("a.flat_key = 'debug.dune.process_args'");
  });

  test('the arg view reaches args off the stored arg set, not off slice', async () => {
    // What pins the shape above: a `JOIN slice` here would put the planner
    // back where the 580 s came from.
    const sql: string[] = [];
    await build([COUNT_ROWS], sql);
    const view = sql.find((q) =>
      q.includes('CREATE PERFETTO VIEW dune_process_arg'),
    )!;
    expect(view).toContain('JOIN args a ON a.arg_set_id = p.arg_set_id');
    expect(view).not.toContain('JOIN slice');
    expect(view).not.toContain('FROM slice');
  });

  test('drops the arg view before the table it depends on', async () => {
    const sql: string[] = [];
    const processes = await build([COUNT_ROWS], sql);
    await processes[Symbol.asyncDispose]();
    const drops = sql.filter((q) => q.startsWith('DROP '));
    expect(drops.slice(-2)).toEqual([
      'DROP VIEW IF EXISTS dune_process_arg',
      'DROP TABLE IF EXISTS _dune_process',
    ]);
  });

  test('reads argv off the view rather than repeating its join', async () => {
    const sql: string[] = [];
    const processes = await build([COUNT_ROWS, SCALAR_ROWS, ARGV_ROWS], sql);
    await processes.processesForRuleId(1314);
    const argv = sql.find((q) => q.includes(ARGV_LOOKUP))!;
    expect(argv).toContain('FROM dune_process_arg');
    expect(argv).toContain('slice_id IN (10, 11)');
    expect(argv).toContain('ORDER BY slice_id, idx');
    expect(argv).not.toContain('flat_key');
  });
});

/**
 * `dune_process_cmd` and `dune_process_cmd!`.
 *
 * Every assertion here is something a hand-written version of this query gets
 * wrong, and each was confirmed against a real trace before being pinned:
 * argv order is `idx` and not row order, the program is a column rather than
 * argv[0], and 122 of the monorepo trace's 266,614 processes have no arguments
 * at all and vanish under an inner join.
 */
describe('the command-line helpers', () => {
  test('orders the argv by idx, not by row order', () => {
    // Without the ORDER BY, group_concat takes whatever order the scan
    // produces - which looks right on small inputs and shuffles on real ones.
    for (const sql of [processCmdFunction(), processCmdMacro()]) {
      expect(sql).toContain("group_concat(a.arg, ' ' ORDER BY a.idx)");
    }
  });

  test('takes the program from the process, not from the argv', () => {
    // `idx = 0` is the first real argument: the program is a column on
    // dune_process, so reading the arg view alone silently drops it.
    expect(processCmdFunction()).toContain('p.prog');
    expect(processCmdFunction()).toContain('FROM dune_process p');
    expect(processCmdMacro()).toContain('p.prog AS prog');
  });

  test('keeps a process that took no arguments', () => {
    // The LEFT is the whole point; an inner join drops the argless ones.
    expect(processCmdMacro()).toContain('LEFT JOIN dune_process_arg a');
  });

  test('is replaceable, because neither can be dropped', () => {
    // There is no DROP PERFETTO MACRO, and a rebuild has to be idempotent.
    expect(processCmdFunction()).toContain(
      'CREATE OR REPLACE PERFETTO FUNCTION',
    );
    expect(processCmdMacro()).toContain('CREATE OR REPLACE PERFETTO MACRO');
  });

  test('answers for one slice and for a set', () => {
    // The function is scalar and keyed by slice; the macro takes a table.
    expect(processCmdFunction()).toContain('dune_process_cmd(slice_id LONG)');
    expect(processCmdFunction()).toContain('RETURNS STRING');
    expect(processCmdFunction()).toContain('WHERE p.slice_id = $slice_id');
    expect(processCmdMacro()).toContain('processes TableOrSubquery');
    expect(processCmdMacro()).toContain('RETURNS TableOrSubquery');
    expect(processCmdMacro()).toContain('GROUP BY p.slice_id');
  });
});
