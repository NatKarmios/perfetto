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
 * `dune_selected()`: the graph selection, readable from SQL.
 *
 * The selection lives in the controller, which SQL cannot see, so the
 * controller copies it into `_dune_selected` whenever it changes and the
 * function reads that table back. Independent of the mirror tiers: the table
 * holds bare node ids and joins nothing, so it can exist (empty) before a load
 * and survive a reload, which clears the selection and so rewrites it empty.
 */

import type {Engine} from '../../../trace_processor/engine';
import type {NodeId} from '../model/graph';

export const SELECTED_FUNCTION = 'dune_selected';
const SELECTED_TABLE = '_dune_selected';
// Same bound as the mirror's inserts (sql_graph.ts's INSERT_CHUNK).
const INSERT_CHUNK = 5_000;

/**
 * The statements that make `_dune_selected` hold exactly `nodes`, creating it
 * and the function on the way if this is the first write. Idempotent, so every
 * write can run all of them rather than tracking whether setup happened.
 */
export function selectionSql(nodes: readonly NodeId[]): string[] {
  const sql = [
    `CREATE TABLE IF NOT EXISTS ${SELECTED_TABLE} (node_id INTEGER PRIMARY KEY)`,
    `CREATE OR REPLACE PERFETTO FUNCTION ${SELECTED_FUNCTION}()
    RETURNS TABLE(node_id LONG) AS
    SELECT node_id FROM ${SELECTED_TABLE}`,
    `DELETE FROM ${SELECTED_TABLE}`,
  ];
  for (let i = 0; i < nodes.length; i += INSERT_CHUNK) {
    const values = nodes
      .slice(i, i + INSERT_CHUNK)
      .map((id) => `(${id})`)
      .join(', ');
    sql.push(`INSERT INTO ${SELECTED_TABLE} (node_id) VALUES ${values}`);
  }
  return sql;
}

export async function writeSelection(
  engine: Engine,
  nodes: readonly NodeId[],
): Promise<void> {
  for (const q of selectionSql(nodes)) await engine.query(q);
}
