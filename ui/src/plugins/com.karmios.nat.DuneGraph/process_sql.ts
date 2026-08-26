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
 * `job-<n>` track (one per build job slot), tagged with a `debug.dune.forced_by`
 * arg naming what pulled it into the build. These are not graph nodes and never
 * become any: they carry no `rule_id`/`dep_id` join key, they have no blob
 * record, and the derived "Dune graph" track projects them verbatim (see
 * graph_track.ts) rather than as a node's span.
 *
 * **Both halves of the filter matter.** `process` is the name that carries the
 * semantics - it is what makes the slice a spawned process rather than some
 * other thing dune happens to tag - and `forced_by` is not exclusively a rule:
 * on merlin's trace 182 of the 1,151 process slices read `dep <path>` instead
 * of `rule <rule_id>`, and a dep forcer names no rule to hang the slice off.
 * So the name is matched *and* the value is required to be the `rule` form.
 *
 * They get a table of their own because finding them costs an `extract_arg`
 * over *every* slice in the trace, and the track's SQL is regenerated every
 * time the graph selection changes - which on a monorepo-scale trace would be a
 * multi-second full scan per click, run several times over (SliceTrack builds
 * two mipmaps and a row count from the same source). So the arg is extracted
 * once, here, and the track filters this table instead.
 *
 * Keyed by `rule_id`, not by `node_id`, deliberately. Nothing in here knows
 * about the graph, and the one consumer already has the rule ids of the nodes
 * it wants (graph.ts's `timingKeyOf`). Keying on `node_id` would mean joining
 * `_dune_node`, which SQLite has no index to serve and would run as a scan of
 * all 818k node rows per process slice.
 */

import type {Engine} from '../../trace_processor/engine';
import {NUM, NUM_NULL} from '../../trace_processor/query_result';
import type {PerfRun} from './perf';
import {measure} from './perf';

// The name a spawned process's slice carries, the arg naming what forced it,
// and the prefix that arg's value carries in front of a rule id.
const PROCESS_SLICE_NAME = 'process';
const FORCED_BY_ARG = 'debug.dune.forced_by';
const RULE_PREFIX = 'rule ';

/**
 * One row per process slice: its slice id and the `rule_id` that forced it.
 *
 * A plain `PERFETTO TABLE` rather than the keyed `WITHOUT ROWID` shape
 * `_dune_timing` needs (see lifecycle_sql.ts): both of its readers scan it
 * anyway - the track filters on `rule_id IN (...)`, and the single-slice lookup
 * below runs once per selection - and it is orders of magnitude smaller than
 * the timing table, so a real primary key would buy nothing.
 */
export const PROCESS_TABLE = '_dune_process';

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
}

/**
 * Builds {@link PROCESS_TABLE} and returns a handle that drops it when
 * disposed. Rebuilding is idempotent: an existing table of the same name is
 * dropped first.
 */
export async function buildProcessSlices(
  engine: Engine,
  perf?: PerfRun,
): Promise<SqlProcessSlices> {
  const rowCount = await measure(perf, 'process: index by rule', async (p) => {
    await engine.tryQuery(`DROP TABLE IF EXISTS ${PROCESS_TABLE}`);
    // The name filter goes in the inner query so `extract_arg` - the expensive
    // half - runs only for slices that can possibly qualify. The GLOB is what
    // validates the value: `substr`/`cast` would silently read a `dep <path>`
    // forcer (or a non-numeric one) as rule 0, which is a real rule.
    await engine.query(`
      CREATE PERFETTO TABLE ${PROCESS_TABLE} AS
      SELECT slice_id,
        cast(substr(forced_by, ${RULE_PREFIX.length + 1}) AS INTEGER) AS rule_id
      FROM (
        SELECT s.id AS slice_id,
          extract_arg(s.arg_set_id, '${FORCED_BY_ARG}') AS forced_by
        FROM slice s
        WHERE s.name = '${PROCESS_SLICE_NAME}'
      )
      WHERE forced_by GLOB '${RULE_PREFIX}[0-9]*'
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

    async [Symbol.asyncDispose](): Promise<void> {
      await engine.tryQuery(`DROP TABLE IF EXISTS ${PROCESS_TABLE}`);
    },
  };
}
