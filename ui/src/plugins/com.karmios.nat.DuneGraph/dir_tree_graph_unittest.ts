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
 * The hand-off payload (dir_tree_graph.ts), checked against the Data Explorer's
 * own loaders rather than against a copy of what they expect. That matters more
 * than usual here: the payload is *data*, so every way of getting it wrong -
 * an unknown node type, a one-sided edge, a dashboard item that fails
 * validation - is silently dropped on load rather than caught by the compiler,
 * and shows up as an empty dashboard the user has to configure by hand.
 *
 * The interesting assertion is the last one: that the exported data source
 * carries its columns *before anything has been executed*, which is the whole
 * reason the graph has a modify_columns node in it.
 */

import {registerCoreNodes} from '../dev.perfetto.DataExplorer/query_builder/core_nodes';
import {dashboardRegistry} from '../dev.perfetto.DataExplorer/dashboard/dashboard_registry';
import {deserializeDashboardsFromExport} from '../dev.perfetto.DataExplorer/graph_io';
import {
  deserializeState,
  validateSerializedGraph,
} from '../dev.perfetto.DataExplorer/json_handler';
import type {SqlModules} from '../dev.perfetto.SqlModules/sql_modules';
import type {Trace} from '../../public/trace';
import {
  DIR_TREE_COLUMNS,
  DIR_TREE_GRID_COLUMNS,
  DIR_TREE_GRID_TREE,
  DIR_TREE_SQL,
  dirTreeColumnType,
  dirTreeDashboards,
  dirTreeGraphJson,
} from './dir_tree_graph';
import {DUNE_NODE_JOINID} from './node_cell';

// The node registry is populated as a side effect of the Data Explorer's own
// module load; a unit test importing only the loaders has to do it itself.
registerCoreNodes();

// Nothing in this graph reads the trace or the SQL modules: the source is raw
// SQL (not a stdlib table) and the other two nodes only shuffle columns.
const trace = {} as Trace;
const sqlModules = {} as SqlModules;

const columnNames = DIR_TREE_COLUMNS.map((c) => c.name);

describe('DIR_TREE_SQL', () => {
  it('is one SELECT over dune_dir, as SqlSourceNode requires', () => {
    expect(DIR_TREE_SQL.startsWith('SELECT')).toBe(true);
    expect(DIR_TREE_SQL).toContain('FROM dune_dir');
    // Zero statements before the SELECT and nothing after it.
    expect(DIR_TREE_SQL).not.toContain(';');
  });

  it('selects every declared column, aliased where it is an expression', () => {
    for (const col of DIR_TREE_COLUMNS) {
      const expected =
        col.expr === undefined
          ? `  ${col.name}`
          : `  ${col.expr} AS ${col.name}`;
      expect(DIR_TREE_SQL).toContain(expected);
    }
  });

  it('labels the empty top-level directory instead of rendering it blank', () => {
    // dune_dir keeps the directory dune named, which for the top level is the
    // empty string; the tree column must not be blank.
    expect(DIR_TREE_SQL).toContain("iif(path = '', '(top level)', path)");
    expect(DIR_TREE_SQL).toContain("iif(name = '', '(top level)', name)");
  });
});

describe('dirTreeGraphJson', () => {
  it('passes the Data Explorer structural validation', () => {
    const {errors} = validateSerializedGraph(dirTreeGraphJson());
    expect(errors).toEqual([]);
  });

  it('wires source -> columns -> export, both ends of every edge', () => {
    const graph = JSON.parse(dirTreeGraphJson());
    expect(graph.rootNodeIds).toEqual(['0']);
    expect(graph.nodes.map((n: {type: string}) => n.type)).toEqual([
      'sql_source',
      'modify_columns',
      'dashboard',
    ]);
    const [source, columns, exportNode] = graph.nodes;
    expect(source.nextNodes).toEqual([columns.nodeId]);
    expect(columns.primaryInputId).toBe(source.nodeId);
    expect(columns.nextNodes).toEqual([exportNode.nodeId]);
    expect(exportNode.primaryInputId).toBe(columns.nodeId);
    expect(exportNode.nextNodes).toEqual([]);
  });

  it('checks every column it selects', () => {
    const graph = JSON.parse(dirTreeGraphJson());
    const selected = graph.nodes[1].state.selectedColumns;
    expect(selected.map((c: {name: string}) => c.name)).toEqual(columnNames);
    // An omitted or false `checked` exports nothing at all.
    expect(selected.every((c: {checked: boolean}) => c.checked)).toBe(true);
  });

  it('builds a live graph whose export publishes the columns up front', () => {
    const state = deserializeState(dirTreeGraphJson(), trace, sqlModules);
    expect(state.rootNodes).toHaveLength(1);

    // The dashboard item points at node '2'; this is the source it finds. That
    // it already has columns - with no query having been run - is what makes
    // the grid render (and then ask for execution) instead of reporting "No
    // columns" and waiting for a manual run in the query builder.
    const source = dashboardRegistry.getExportedSource('2');
    expect(source).toBeDefined();
    expect(source!.name).toBe('Dune directories');
    expect(source!.columns.map((c) => c.name)).toEqual(columnNames);
  });
});

describe('DIR_TREE_COLUMNS types', () => {
  it('declares no column as a reference to a graph node', () => {
    // `dune_dir` numbers *directories*, so its `id` / `parent_id` are directory
    // ids. Typing either as JOINID(dune_node.node_id) would render it as
    // whichever unrelated graph node happened to share the number, which is
    // worse than the plain integer it is. A directory is not a node.
    for (const col of DIR_TREE_COLUMNS) {
      const type = dirTreeColumnType(col);
      expect(type.kind).not.toBe('id');
      expect(type.kind).not.toBe('joinid');
    }
  });

  it('carries a full id type through to the serialized column', () => {
    // Step 3 of the design: a builder can declare a node reference, and the
    // Data Explorer's loader has to hand it back intact for the grid to render
    // a chip from it (see node_cell.ts). Checked on a graph built here rather
    // than on the dir tree's, which deliberately has no such column.
    const json = JSON.stringify({
      nodes: [
        {
          nodeId: '10',
          type: 'sql_source',
          state: {sql: 'SELECT node_id FROM dune_node'},
          nextNodes: ['11'],
        },
        {
          nodeId: '11',
          type: 'modify_columns',
          state: {
            selectedColumns: [
              {
                name: 'node_id',
                checked: true,
                type: dirTreeColumnType({
                  name: 'node_id',
                  type: DUNE_NODE_JOINID,
                }),
              },
            ],
          },
          primaryInputId: '10',
          nextNodes: ['12'],
        },
        {
          nodeId: '12',
          type: 'dashboard',
          state: {exportName: 'Dune nodes'},
          primaryInputId: '11',
          nextNodes: [],
        },
      ],
      rootNodeIds: ['10'],
    });

    expect(validateSerializedGraph(json).errors).toEqual([]);
    deserializeState(json, trace, sqlModules);
    const source = dashboardRegistry.getExportedSource('12');
    expect(source?.columns).toHaveLength(1);
    expect(source?.columns[0].type).toEqual(DUNE_NODE_JOINID);
  });
});

describe('dirTreeDashboards', () => {
  it('survives the hydration setActiveGraphJson puts it through', () => {
    const hydrated = deserializeDashboardsFromExport(dirTreeDashboards());
    expect(hydrated).toBeDefined();
    expect(hydrated).toHaveLength(1);
    // Items that fail validation are dropped silently, so the count is the
    // assertion that matters.
    expect(hydrated![0].items).toHaveLength(1);
    const item = hydrated![0].items[0];
    expect(item.kind).toBe('grid');
    if (item.kind !== 'grid') return;
    expect(item.sourceNodeId).toBe('2');
    expect(item.tree).toEqual(DIR_TREE_GRID_TREE);
    expect(item.columns).toEqual(DIR_TREE_GRID_COLUMNS);
  });

  it('only shows and trees columns the source actually exports', () => {
    // A grid column the source lost is dropped by the dashboard, and a tree
    // field it lost turns the tree off entirely - both silently.
    for (const name of DIR_TREE_GRID_COLUMNS) {
      expect(columnNames).toContain(name);
    }
    expect(columnNames).toContain(DIR_TREE_GRID_TREE.idField);
    expect(columnNames).toContain(DIR_TREE_GRID_TREE.parentIdField);
    expect(columnNames).toContain(DIR_TREE_GRID_TREE.treeColumn);
  });
});
