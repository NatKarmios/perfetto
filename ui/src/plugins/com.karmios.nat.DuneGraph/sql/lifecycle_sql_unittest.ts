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
 * The timing pipeline's *generated statements*, captured through a stub engine,
 * and the kind encoding they carry.
 *
 * There is no trace processor in a unit test, so what is checked here is which
 * tracks the pipeline reads, which args it will pair on, and - the one thing a
 * later edit can silently break - that a kind's stored code never moves.
 */

import type {Engine} from '../../../trace_processor/engine';
import {buildLifecycleTiming, timingKindCode} from './lifecycle_sql';

// Every statement the timing build issues, in order. Same stub as
// sql_graph_unittest.ts's: it answers nothing, and the builder only reads back
// the final row count.
async function capture(): Promise<string[]> {
  const sql: string[] = [];
  const result = {
    firstRow: () => ({n: 0}),
    iter: () => ({valid: () => false, next: () => {}}),
  };
  const record = async (q: string) => {
    sql.push(q);
    return result;
  };
  await buildLifecycleTiming({
    query: record,
    tryQuery: record,
  } as unknown as Engine);
  return sql;
}

// The statement that reads `slice` - the only one mentioning the tracks.
async function instantStmt(): Promise<string> {
  const stmt = (await capture()).find((q) => q.includes('FROM slice s'));
  expect(stmt).toBeDefined();
  return stmt!;
}

describe('lifecycle timing kinds', () => {
  // `_dune_timing.kind` is a stored code, and sql_graph.ts writes the same
  // codes into the node mirror's joins. Reordering TRACK_BY_KIND would
  // reclassify every stored row without any test noticing, so pin the three
  // the mirror names.
  it('keeps the node-facing kinds on their original codes', () => {
    expect(timingKindCode('rule')).toBe(0);
    expect(timingKindCode('dep')).toBe(1);
    expect(timingKindCode('action')).toBe(2);
  });

  it('reads all five lifecycle tracks and codes each one', async () => {
    const stmt = await instantStmt();
    expect(stmt).toContain(
      "WHERE t.name IN ('exec-rule', 'build-dep', 'exec-rule-action', " +
        "'gen-rules', 'dynamic-includes')",
    );
    expect(stmt).toContain(
      "CASE t.name WHEN 'exec-rule' THEN 0 WHEN 'build-dep' THEN 1 " +
        "WHEN 'exec-rule-action' THEN 2 WHEN 'gen-rules' THEN 3 " +
        "WHEN 'dynamic-includes' THEN 4 END AS kind",
    );
  });

  // One coalesce over all four join keys: a given instant carries exactly one
  // of them, so the pipeline needs no per-kind branch.
  it('pairs on whichever of the four key args the instant carries', async () => {
    const stmt = await instantStmt();
    for (const arg of [
      'rule_id',
      'dep_id',
      'dir_path_id',
      'dune_file_path_id',
    ]) {
      expect(stmt).toContain(`extract_arg(s.arg_set_id, 'debug.dune.${arg}')`);
    }
  });
});
