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
import type {Engine} from '../../trace_processor/engine';
import type {Row} from '../../trace_processor/query_result';
import {buildProcessSlices} from './process_sql';

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
        get value() {
          return rows[i]?.value;
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
const ARGV_ROWS: Canned = {
  match: 'a.flat_key',
  rows: [
    {slice_id: 10, value: '-c'},
    {slice_id: 10, value: '-impl'},
    {slice_id: 10, value: 'src/a.ml'},
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
    expect(sql.some((q) => q.includes('a.flat_key'))).toBe(false);
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

  test('parses the argv index out of the element key', async () => {
    // `key` reads `debug.dune.process_args[N]`, so the index starts one past
    // the flat key's length plus the bracket - i.e. character 25.
    const sql: string[] = [];
    const processes = await build([COUNT_ROWS, SCALAR_ROWS, ARGV_ROWS], sql);
    await processes.processesForRuleId(1314);
    const argv = sql.find((q) => q.includes('a.flat_key'))!;
    expect(argv).toContain('substr(a.key, 25)');
    expect(argv).toContain("a.flat_key = 'debug.dune.process_args'");
    expect(argv).toContain('s.id IN (10, 11)');
  });
});
