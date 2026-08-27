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
 * The `dune_node` source (node_source.ts). One assertion here is the reason the
 * source exists: that `node_id`'s `JOINID(dune_node.node_id)` type survives the
 * whole trip - our column declaration, the serialized graph, the Data
 * Explorer's loader - and comes back out on the *exported* source's columns,
 * which is what a dashboard grid resolves its renderers from. Losing the type
 * anywhere along the way is not an error, just a column of bare integers where
 * the node chips should be.
 *
 * (That such a column renders as a chip is node_cell_unittest.ts's job; this is
 * about the type getting there in the first place.)
 */

import {registerCoreNodes} from '../dev.perfetto.DataExplorer/query_builder/core_nodes';
import {dashboardRegistry} from '../dev.perfetto.DataExplorer/dashboard/dashboard_registry';
import {
  deserializeState,
  validateSerializedGraph,
} from '../dev.perfetto.DataExplorer/json_handler';
import type {SqlModules} from '../dev.perfetto.SqlModules/sql_modules';
import type {Trace} from '../../public/trace';
import {exploreSelect, exploreSourceGraph} from './explore_source';
import {DUNE_NODE_JOINID, DUNE_NODE_TABLE} from './node_cell';
import {DUNE_NODE_COLUMNS, NODE_SOURCE} from './node_source';

// The node registry is populated as a side effect of the Data Explorer's own
// module load; a unit test importing only the loaders has to do it itself.
registerCoreNodes();

const trace = {} as Trace;
const sqlModules = {} as SqlModules;

const columnNames = DUNE_NODE_COLUMNS.map((c) => c.name);

describe('NODE_SOURCE', () => {
  it('selects from the table the renderer registry is keyed on', () => {
    // The chip is keyed on the *table* named in the JOINID, so a source reading
    // anything else would be claiming ids it doesn't have.
    expect(NODE_SOURCE.from).toBe(DUNE_NODE_TABLE);
    const sql = exploreSelect(NODE_SOURCE);
    expect(sql.startsWith('SELECT')).toBe(true);
    expect(sql).toContain(`FROM ${DUNE_NODE_TABLE}`);
    expect(sql).not.toContain(';');
    // The two aliased columns; everything else passes through by name.
    expect(sql).toContain('  dur_ns AS dur');
    expect(sql).toContain('  n_occurrences AS occurrences');
  });

  it('declares node_id, and only node_id, as one of our node ids', () => {
    // `orig_id` is the trace-side id - a rule's dune id, a dep's dict id - and
    // collides with unrelated node_ids by construction, so typing it as a node
    // reference would chip every row as the wrong node.
    const nodeRefs = DUNE_NODE_COLUMNS.filter(
      (c) =>
        typeof c.type !== 'string' &&
        c.type.kind === 'joinid' &&
        c.type.source.table === DUNE_NODE_TABLE,
    );
    expect(nodeRefs.map((c) => c.name)).toEqual(['node_id']);
  });

  it('exports dir_id, and as a directory id rather than a node one', () => {
    // `dune_node.dir_id` indexes `dune_dir`, whose ids are a space of their own
    // (see sql_graph.ts); typing it as a node reference would chip every row as
    // whichever unrelated node shared the number. The mirror-side counterpart
    // of this check is DIR_TREE_COLUMNS' in dir_tree_graph_unittest.ts.
    const byName = new Map(DUNE_NODE_COLUMNS.map((c) => [c.name, c.type]));
    expect(byName.has('dir_id')).toBe(true);
    expect(byName.get('dir_id')).toBe('int');
  });
});

describe('the nodes source as a graph', () => {
  it('passes the Data Explorer structural validation', () => {
    expect(
      validateSerializedGraph(exploreSourceGraph(NODE_SOURCE).json).errors,
    ).toEqual([]);
  });

  it('exports node_id as a node reference, before anything has run', () => {
    const {json, ids} = exploreSourceGraph(NODE_SOURCE);
    deserializeState(json, trace, sqlModules);

    const source = dashboardRegistry.getExportedSource(ids.exportNodeId);
    expect(source).toBeDefined();
    expect(source!.name).toBe('Dune nodes');
    expect(source!.columns.map((c) => c.name)).toEqual(columnNames);

    const byName = new Map(source!.columns.map((c) => [c.name, c.type]));
    // The point of the whole source.
    expect(byName.get('node_id')).toEqual(DUNE_NODE_JOINID);
    // And the ones that are only worth declaring if they survive too: a slice
    // reference (which the DataGrid renders as a timeline link out of the box)
    // and the two time columns.
    expect(byName.get('slice_id')).toEqual({
      kind: 'joinid',
      source: {table: 'slice', column: 'id'},
    });
    expect(byName.get('ts')).toEqual({kind: 'timestamp'});
    expect(byName.get('dur')).toEqual({kind: 'duration'});
  });
});
