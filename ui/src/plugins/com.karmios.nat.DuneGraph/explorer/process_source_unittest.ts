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
 * The `dune_process` source (process_source.ts). Its one interesting column is
 * `node_id`, so the assertions mirror node_source_unittest.ts's: that the
 * `JOINID(dune_node.node_id)` type survives our declaration, the serialized
 * graph and the Data Explorer's loader, and comes back out on the columns the
 * appended chain reports. Losing it anywhere along the way is not an error,
 * just a column of bare integers where the node chips should be.
 *
 * The other half is what must *not* be typed that way: `rule_id` is dune's own
 * rule id and collides with unrelated `node_id`s by construction.
 */

import {registerCoreNodes} from '../../dev.perfetto.DataExplorer/query_builder/core_nodes';
import {
  deserializeState,
  validateSerializedGraph,
} from '../../dev.perfetto.DataExplorer/json_handler';
import type {Trace} from '../../../public/trace';
import {appendExploreSourceToGraph, exploreSelect} from './explore_source';
import {DUNE_NODE_JOINID, DUNE_NODE_TABLE} from '../sql/dune_tables';
import {SLICE_JOINID} from './node_source';
import {PROCESS_COLUMNS, PROCESS_SOURCE} from './process_source';

// The node registry is populated as a side effect of the Data Explorer's own
// module load; a unit test importing only the loaders has to do it itself.
registerCoreNodes();

const trace = {} as Trace;
// `SqlModules` comes from a plugin this one doesn't depend on, so its type is
// taken off `deserializeState` rather than imported across. Nothing here reads
// it - the loaders under test only pass it through - so a bare stub will do.
const sqlModules = {} as Parameters<typeof deserializeState>[2];

const columnNames = PROCESS_COLUMNS.map((c) => c.name);

describe('PROCESS_SOURCE', () => {
  it('is one SELECT over dune_process, as SqlSourceNode requires', () => {
    const sql = exploreSelect(PROCESS_SOURCE);
    expect(sql.startsWith('SELECT')).toBe(true);
    expect(sql).toContain('FROM dune_process');
    // Zero statements before the SELECT and nothing after it.
    expect(sql).not.toContain(';');
    // The one aliased column; everything else passes through by name.
    expect(sql).toContain('  dur_ns AS dur');
  });

  it('declares node_id, and only node_id, as one of our node ids', () => {
    // `rule_id` is dune's rule id, which collides with unrelated node_ids by
    // construction, so typing it as a node reference would chip every row as
    // the wrong node.
    const nodeRefs = PROCESS_COLUMNS.filter(
      (c) =>
        typeof c.type !== 'string' &&
        c.type.kind === 'joinid' &&
        c.type.source.table === DUNE_NODE_TABLE,
    );
    expect(nodeRefs.map((c) => c.name)).toEqual(['node_id']);

    const byName = new Map(PROCESS_COLUMNS.map((c) => [c.name, c.type]));
    expect(byName.get('rule_id')).toBe('int');
  });
});

describe('the processes source as a graph', () => {
  it('passes the Data Explorer structural validation', () => {
    expect(
      validateSerializedGraph(
        appendExploreSourceToGraph(undefined, PROCESS_SOURCE).json,
      ).errors,
    ).toEqual([]);
  });

  it('carries node_id as a node reference, before anything has run', () => {
    // Read off the chain's end node, which is the group's output port and the
    // node a `dashboard` would publish: what it reports as `finalCols` is
    // exactly what an exported source's columns are (see explore_source.ts).
    // That they are known here, with no query having been run, is the whole
    // reason for the modify_columns node.
    const {json, ids} = appendExploreSourceToGraph(undefined, PROCESS_SOURCE);
    const state = deserializeState(json, trace, sqlModules);
    const end = state.rootNodes[0].innerNodes?.find(
      (n) => n.nodeId === ids.columnsNodeId,
    );
    expect(end).toBeDefined();
    expect(end!.finalCols.map((c) => c.name)).toEqual(columnNames);

    const byName = new Map(end!.finalCols.map((c) => [c.name, c.type]));
    // The point of the whole source.
    expect(byName.get('node_id')).toEqual(DUNE_NODE_JOINID);
    // And the slice reference, which the DataGrid renders as a timeline link
    // out of the box - free, but only if the type gets there.
    expect(byName.get('slice_id')).toEqual(SLICE_JOINID);
  });
});
