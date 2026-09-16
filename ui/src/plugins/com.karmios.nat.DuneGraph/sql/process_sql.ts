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
 * The build's *process* slices, indexed by the rule that forced them.
 *
 * Dune emits a duration event named `process` per spawned process, on a
 * `job-<n>` track, tagged with a `debug.dune.forced_by` arg naming what pulled
 * it into the build.
 *
 * **ARCHITECTURE.md, "Processes", is the reference**: why they are not graph nodes,
 * why they get a table of their own, why both halves of the filter matter, and
 * why the table is keyed by `rule_id` rather than `node_id`. Nothing in this
 * file knows about the graph, and the two lookups below hold that line: both
 * speak rule ids, and translating either end to a node is sql_graph.ts's job.
 */

import type {Engine} from '../../../trace_processor/engine';
import {
  LONG,
  NUM,
  NUM_NULL,
  STR_NULL,
} from '../../../trace_processor/query_result';
import type {PerfRun} from '../perf';
import {measure} from '../perf';

// The name a spawned process's slice carries, the arg naming what forced it,
// and the prefix that arg's value carries in front of a rule id.
const PROCESS_SLICE_NAME = 'process';
const FORCED_BY_ARG = 'debug.dune.forced_by';
const RULE_PREFIX = 'rule ';

// The args describing what a process slice actually ran. `PROG_ARG` is the
// program's full path; `ARGV_FLAT_KEY` is the *flat* key of the argv array,
// whose per-element keys read `<flat>[N]` and whose elements are argv with the
// program excluded (so `[0]` is the first real argument). See the file comment
// for the rest of the arg set, which the slice's own details panel renders in
// full (row_details_panel.ts).
export const PROG_ARG = 'debug.prog';
const CWD_ARG = 'debug.dir';
const EXIT_ARG = 'debug.exit';
const ARGV_FLAT_KEY = 'debug.dune.process_args';

/**
 * The name {@link buildProcessSlices} measures itself under.
 *
 * Exported for the same reason as lifecycle_sql.ts's LIFECYCLE_TIMING_PHASE:
 * this is a node-tier phase, so it is listed in sql_graph.ts's
 * NODE_MIRROR_PHASES and reported from there, and the two must not drift.
 */
export const PROCESS_INDEX_PHASE = 'process: index by rule';

/**
 * One row per process slice: its slice id and the `rule_id` that forced it.
 *
 * A plain `PERFETTO TABLE` rather than the keyed `WITHOUT ROWID` shape
 * `_dune_timing` needs (see lifecycle_sql.ts): every one of its readers scans it
 * anyway - the track filters on `rule_id IN (...)`, and the two per-selection
 * lookups below (`ruleIdForSliceId` by slice, `processesForRuleId` by rule) run
 * once per click - and it is orders of magnitude smaller than the timing table,
 * so a real primary key would buy nothing. Measured: see
 * {@link SqlProcessSlices.processesForRuleId}.
 */
export const PROCESS_TABLE = '_dune_process';

/**
 * One row per element of a process's argv: `(slice_id, idx, arg)`.
 *
 * A sibling view rather than more columns on `dune_process`, for the reason
 * `dune_gen_rules` hangs off `dune_dir` - see ARCHITECTURE.md, "Processes",
 * which also records why the joined command line is a `group_concat` recipe
 * rather than a column, and why `slice_id` is declared `LONG`.
 */
export const PROCESS_ARG_VIEW = 'dune_process_arg';

/**
 * One row per spawned process: its slice, timing, the rule that forced it and
 * the program it ran. Built by `processView` in sql_graph.ts, which is where
 * the node join lives; the name is here because the helpers below read it.
 */
export const PROCESS_VIEW = 'dune_process';

/**
 * Index on {@link PROCESS_TABLE}'s `arg_set_id`, which is the only reason
 * {@link PROCESS_ARG_VIEW} is usable under a predicate on the arg value.
 *
 * Measured on the perf plan's monorepo trace (43.0M arg rows):
 * `WHERE arg = '-impl'` did not finish in 580 s when the view reached the arg
 * set through `slice`, because the planner drives from the 50.6M-row `args`
 * and re-scans the process table per candidate. Storing `arg_set_id` here and
 * indexing it makes the same query 1.0 s. Do not remove either half.
 */
const PROCESS_ARG_SET_INDEX = '_dune_process_args';

/**
 * What one process slice ran, for the panel that explains a rule (see
 * `renderProcesses` in selection_info_panel.ts).
 *
 * A deliberately small slice of the arg set: the rest of it - pid, queue wait,
 * target files, rusage - is what the process slice's *own* details panel is
 * for (row_details_panel.ts), and `sliceId` is the link that gets there.
 *
 * Every field but `sliceId` and `args` is optional because every one of them is
 * an arg that a future dune, or an interrupted process, need not have written.
 * `durNs` is additionally absent for an *unfinished* slice, which perfetto
 * stores as `dur = -1` - a negative duration is not a duration, and formatting
 * one would read as a process that finished before it started.
 */
export interface ProcessDetails {
  readonly sliceId: number;
  // The program's full path, e.g. `/nix/store/.../bin/ocamlc.opt`.
  readonly prog?: string;
  // argv with the program excluded, in order.
  readonly args: readonly string[];
  // The directory the process ran in, relative to the workspace root.
  readonly dir?: string;
  readonly exitCode?: number;
  readonly durNs?: number;
}

/**
 * Handle on the built process table: the derived track reads it directly by
 * name, and a selection on one of its rows resolves back through
 * `ruleIdForSliceId`.
 */
export interface SqlProcessSlices extends AsyncDisposable {
  // How many process slices the trace holds. Zero on a trace from a dune that
  // doesn't emit the arg at all, which is the common case today.
  readonly rowCount: number;

  /**
   * The `rule_id` that forced `sliceId`, or undefined if it isn't a process
   * slice of this trace.
   */
  ruleIdForSliceId(sliceId: number): Promise<number | undefined>;

  /**
   * Every process `ruleId` forced, in start order, with what it ran.
   *
   * The inverse of `ruleIdForSliceId` above, and the same shape of query: a
   * scan of {@link PROCESS_TABLE} filtered to one rule. That scan is why this
   * is not free - but it is very nearly: on the perf plan's monorepo trace,
   * 266,615 process rows, the filter is lost in the noise of the table build
   * (~285 ms for build-plus-filter against ~300 ms for the build alone). So no
   * index is added for it, which keeps {@link PROCESS_TABLE}'s "every reader
   * scans anyway" shape true.
   */
  processesForRuleId(ruleId: number): Promise<readonly ProcessDetails[]>;
}

/**
 * Builds {@link PROCESS_TABLE} and returns a handle that drops it when
 * disposed. Rebuilding is idempotent: an existing table of the same name is
 * dropped first.
 */
/**
 * Name shared by the scalar function and the `!` macro, as the relation
 * functions in sql_graph.ts do it: `dune_process_cmd(id)` answers for one
 * process, `dune_process_cmd!(rows)` for a set.
 */
export const PROCESS_CMD_MACRO = 'dune_process_cmd';

/**
 * `dune_process_cmd(slice_id)`: the command line one process ran, as a single
 * string - the program, then its argv joined by spaces.
 *
 * This is the {@link PROCESS_ARG_VIEW} recipe as a function, because writing it
 * out by hand gets two things wrong. The `ORDER BY` inside `group_concat` is
 * not optional: argv order is `idx`, not row order, and without it the
 * arguments come back shuffled. And the program is *not* argv[0] here - it is a
 * column on `dune_process`, so a hand-written join over the arg view alone
 * silently drops it.
 *
 * Returns NULL for a slice that is not a process, rather than an empty string:
 * no row in, no answer out. A process with no arguments gives just the program.
 */
export function processCmdFunction(): string {
  return `
    CREATE OR REPLACE PERFETTO FUNCTION ${PROCESS_CMD_MACRO}(slice_id LONG)
    RETURNS STRING AS
    SELECT trim(
      coalesce(p.prog, '') || ' ' ||
      coalesce(
        (SELECT group_concat(a.arg, ' ' ORDER BY a.idx)
         FROM ${PROCESS_ARG_VIEW} a WHERE a.slice_id = p.slice_id),
        ''))
    FROM ${PROCESS_VIEW} p
    WHERE p.slice_id = $slice_id`;
}

/**
 * `dune_process_cmd!(processes)`: the same thing for a set of processes, with
 * the program and the argv kept as separate columns.
 *
 * Takes any table or subquery with a `slice_id`, the way `dune_blocked!` takes
 * an edge set. Prefer it to calling the scalar per row: this is one grouped
 * pass over the arg view, where the function is a correlated subquery per
 * process, and over the whole table that difference is 15 s against several
 * minutes.
 *
 * The `LEFT JOIN` matters - 122 of the monorepo trace's 266,614 processes have
 * no arguments at all, and an inner join drops them rather than returning the
 * program alone.
 */
export function processCmdMacro(): string {
  return `
    CREATE OR REPLACE PERFETTO MACRO ${PROCESS_CMD_MACRO}(
      processes TableOrSubquery
    )
    RETURNS TableOrSubquery AS
    (
      SELECT p.slice_id AS slice_id, p.prog AS prog,
        group_concat(a.arg, ' ' ORDER BY a.idx) AS args
      FROM ($processes) s
      JOIN ${PROCESS_VIEW} p ON p.slice_id = s.slice_id
      LEFT JOIN ${PROCESS_ARG_VIEW} a ON a.slice_id = p.slice_id
      GROUP BY p.slice_id
    )`;
}

export async function buildProcessSlices(
  engine: Engine,
  perf?: PerfRun,
): Promise<SqlProcessSlices> {
  const rowCount = await measure(perf, PROCESS_INDEX_PHASE, async (p) => {
    // The view first: it depends on the table.
    await engine.tryQuery(`DROP VIEW IF EXISTS ${PROCESS_ARG_VIEW}`);
    await engine.tryQuery(`DROP TABLE IF EXISTS ${PROCESS_TABLE}`);
    // The name filter goes in the inner query so `extract_arg` - the expensive
    // half - runs only for slices that can possibly qualify. The GLOB is what
    // validates the value: `substr`/`cast` would silently read a `dep <path>`
    // forcer (or a non-numeric one) as rule 0, which is a real rule.
    //
    // `arg_set_id` is stored rather than re-reached through `slice` for
    // {@link PROCESS_ARG_SET_INDEX}'s sake; see there for the measurement.
    await engine.query(`
      CREATE PERFETTO TABLE ${PROCESS_TABLE} AS
      SELECT slice_id,
        cast(substr(forced_by, ${RULE_PREFIX.length + 1}) AS INTEGER) AS rule_id,
        arg_set_id
      FROM (
        SELECT s.id AS slice_id, s.arg_set_id AS arg_set_id,
          extract_arg(s.arg_set_id, '${FORCED_BY_ARG}') AS forced_by
        FROM slice s
        WHERE s.name = '${PROCESS_SLICE_NAME}'
      )
      WHERE forced_by GLOB '${RULE_PREFIX}[0-9]*'
    `);
    await engine.query(`
      CREATE PERFETTO INDEX ${PROCESS_ARG_SET_INDEX}
        ON ${PROCESS_TABLE}(arg_set_id)
    `);
    // The array arg's elements all share one `flat_key` and carry their index
    // in `key` as `<flat>[N]`, so the index is parsed back out of `key`:
    // `args.id` happens to come out in index order, but nothing promises that.
    // This is the mirror's single place that knows the encoding.
    await engine.query(`
      CREATE PERFETTO VIEW ${PROCESS_ARG_VIEW}(
        slice_id LONG,
        idx LONG,
        arg STRING
      ) AS
      SELECT p.slice_id AS slice_id,
        cast(substr(a.key, ${ARGV_FLAT_KEY.length + 2}) AS INTEGER) AS idx,
        a.string_value AS arg
      FROM ${PROCESS_TABLE} p
      JOIN args a ON a.arg_set_id = p.arg_set_id
      WHERE a.flat_key = '${ARGV_FLAT_KEY}'
    `);
    const count = await engine.query(
      `SELECT count(*) AS n FROM ${PROCESS_TABLE}`,
    );
    const rows = count.firstRow({n: NUM}).n;
    p.rows(rows);
    return rows;
  });

  return {
    rowCount,

    async ruleIdForSliceId(sliceId: number): Promise<number | undefined> {
      if (rowCount === 0 || !Number.isFinite(sliceId)) return undefined;
      const result = await engine.query(`
        SELECT rule_id FROM ${PROCESS_TABLE}
        WHERE slice_id = ${Math.trunc(sliceId)}
        LIMIT 1
      `);
      if (result.numRows() === 0) return undefined;
      return result.firstRow({rule_id: NUM_NULL}).rule_id ?? undefined;
    },

    async processesForRuleId(
      ruleId: number,
    ): Promise<readonly ProcessDetails[]> {
      if (rowCount === 0 || !Number.isFinite(ruleId)) return [];
      const rows = await scalarsForRule(engine, Math.trunc(ruleId));
      if (rows.length === 0) return [];
      // A second query rather than an aggregate over the same join: argv is an
      // array arg, so folding it in would multiply the scalar columns by up to
      // ~90 rows per process, and `group_concat` cannot be un-escaped safely -
      // an argv element may contain any separator we could pick. Two round
      // trips is the cheaper honest answer, and a rule forces at most a handful
      // of processes (4 is the observed maximum, across 266k rules).
      const argv = await argvForSlices(
        engine,
        rows.map((r) => r.sliceId),
      );
      return rows.map((row) => ({...row, args: argv.get(row.sliceId) ?? []}));
    },

    async [Symbol.asyncDispose](): Promise<void> {
      // The view depends on the table, so it goes first.
      await engine.tryQuery(`DROP VIEW IF EXISTS ${PROCESS_ARG_VIEW}`);
      await engine.tryQuery(`DROP TABLE IF EXISTS ${PROCESS_TABLE}`);
    },
  };
}

// One rule's processes minus their argv, in start order. The scalar args are
// read with `extract_arg` rather than off a join against `args`, because there
// is one of each per process and `extract_arg` is a keyed probe of the arg set
// the join has already located.
async function scalarsForRule(
  engine: Engine,
  ruleId: number,
): Promise<Omit<ProcessDetails, 'args'>[]> {
  const result = await engine.query(`
    SELECT p.slice_id AS slice_id, s.dur AS dur,
      extract_arg(s.arg_set_id, '${PROG_ARG}') AS prog,
      extract_arg(s.arg_set_id, '${CWD_ARG}') AS dir,
      extract_arg(s.arg_set_id, '${EXIT_ARG}') AS exit_code
    FROM ${PROCESS_TABLE} p
    JOIN slice s ON s.id = p.slice_id
    WHERE p.rule_id = ${ruleId}
    ORDER BY s.ts, p.slice_id
  `);
  const rows: Omit<ProcessDetails, 'args'>[] = [];
  const it = result.iter({
    slice_id: NUM,
    dur: LONG,
    prog: STR_NULL,
    dir: STR_NULL,
    exit_code: NUM_NULL,
  });
  for (; it.valid(); it.next()) {
    rows.push({
      sliceId: it.slice_id,
      prog: it.prog ?? undefined,
      dir: it.dir ?? undefined,
      exitCode: it.exit_code ?? undefined,
      // Perfetto's -1 for a slice that never finished; see ProcessDetails.
      durNs: it.dur >= 0n ? Number(it.dur) : undefined,
    });
  }
  return rows;
}

// The argv of each of `sliceIds`, by slice id, read off
// {@link PROCESS_ARG_VIEW} - which is where the array-arg encoding lives, so
// this does not repeat it. A slice with no argv at all (a program invoked bare)
// simply has no entry.
async function argvForSlices(
  engine: Engine,
  sliceIds: readonly number[],
): Promise<Map<number, string[]>> {
  const byId = new Map<number, string[]>();
  if (sliceIds.length === 0) return byId;
  const result = await engine.query(`
    SELECT slice_id, idx, arg FROM ${PROCESS_ARG_VIEW}
    WHERE slice_id IN (${sliceIds.join(', ')})
    ORDER BY slice_id, idx
  `);
  const it = result.iter({slice_id: NUM, arg: STR_NULL});
  for (; it.valid(); it.next()) {
    if (it.arg === null) continue;
    const args = byId.get(it.slice_id);
    if (args === undefined) byId.set(it.slice_id, [it.arg]);
    else args.push(it.arg);
  }
  return byId;
}
