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
 * Two assertions carry more than their weight. That the exported data source
 * carries its columns *before anything has been executed* is the whole reason
 * the graph has a modify_columns node in it. And that the seeded chart names a
 * node id column is what makes it draw a tree at all: the directory chart maps
 * rows to directories through `dune_node`, so a chart pointed anywhere else
 * renders its "pick the node id column" prompt instead.
 */

import {registerCoreNodes} from '../dev.perfetto.DataExplorer/query_builder/core_nodes';
import {dashboardRegistry} from '../dev.perfetto.DataExplorer/dashboard/dashboard_registry';
import {deserializeDashboardsFromExport} from '../dev.perfetto.DataExplorer/graph_io';
import {
  deserializeState,
  validateSerializedGraph,
} from '../dev.perfetto.DataExplorer/json_handler';
import type {Trace} from '../../public/trace';
import {DIR_TREE_CHART_TYPE} from './dir_explorer_chart';
import {
  DIR_TREE_COLUMNS,
  DIR_TREE_SQL,
  dirTreeDashboards,
  dirTreeGraphJson,
} from './dir_tree_graph';
import {exploreColumnType} from './explore_source';
import {DUNE_NODE_COLUMNS, NODE_SOURCE} from './node_source';

// The node registry is populated as a side effect of the Data Explorer's own
// module load; a unit test importing only the loaders has to do it itself.
registerCoreNodes();

// Nothing in this graph reads the trace or the SQL modules: the source is raw
// SQL (not a stdlib table) and the other two nodes only shuffle columns.
const trace = {} as Trace;
// `SqlModules` comes from a plugin this one doesn't depend on, so its type is
// taken off `deserializeState` rather than imported across. Nothing here reads
// it - the loaders under test only pass it through - so a bare stub will do.
const sqlModules = {} as Parameters<typeof deserializeState>[2];

// The seeded graph selects nodes, not directories: the chart it feeds places
// rows by their node id (see dir_tree_graph.ts).
const columnNames = DUNE_NODE_COLUMNS.map((c) => c.name);

// The generated graph, parsed. Node ids are allocated rather than written out
// (see explore_source.ts), so every assertion below reads them off the payload
// instead of naming them - the numbers are not the contract, the wiring is.
function parsedGraph() {
  return JSON.parse(dirTreeGraphJson()) as {
    nodes: Array<{
      nodeId: string;
      type: string;
      state: {selectedColumns?: Array<{name: string; checked: boolean}>};
      primaryInputId?: string;
      nextNodes: string[];
    }>;
    rootNodeIds: string[];
    selectedNodeId?: string;
  };
}

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
    const graph = parsedGraph();
    expect(graph.nodes.map((n) => n.type)).toEqual([
      'sql_source',
      'modify_columns',
      'dashboard',
    ]);
    const [source, columns, exportNode] = graph.nodes;
    // Exactly the input-less nodes are roots, and the source is the only one:
    // anything else is unreachable on load, or a root that isn't one.
    expect(graph.rootNodeIds).toEqual([source.nodeId]);
    expect(source.primaryInputId).toBeUndefined();
    expect(source.nextNodes).toEqual([columns.nodeId]);
    expect(columns.primaryInputId).toBe(source.nodeId);
    expect(columns.nextNodes).toEqual([exportNode.nodeId]);
    expect(exportNode.primaryInputId).toBe(columns.nodeId);
    expect(exportNode.nextNodes).toEqual([]);
    // The SQL is the node worth landing on in the graph tab.
    expect(graph.selectedNodeId).toBe(source.nodeId);
  });

  it('checks every column it selects', () => {
    const selected = parsedGraph().nodes[1].state.selectedColumns!;
    expect(selected.map((c) => c.name)).toEqual(columnNames);
    // An omitted or false `checked` exports nothing at all.
    expect(selected.every((c) => c.checked)).toBe(true);
  });

  it('builds a live graph whose export publishes the columns up front', () => {
    const state = deserializeState(dirTreeGraphJson(), trace, sqlModules);
    expect(state.rootNodes).toHaveLength(1);

    // The dashboard item points at the export node; this is the source it
    // finds. That it already has columns - with no query having been run - is
    // what makes the card render (and then ask for execution) instead of
    // reporting "No columns" and waiting for a manual run in the query
    // builder.
    const exportNodeId = parsedGraph().nodes[2].nodeId;
    const source = dashboardRegistry.getExportedSource(exportNodeId);
    expect(source).toBeDefined();
    expect(source!.name).toBe(NODE_SOURCE.exportName);
    expect(source!.columns.map((c) => c.name)).toEqual(columnNames);
  });
});

describe('DIR_TREE_COLUMNS types', () => {
  it('declares no column as a reference to a graph node', () => {
    // `dune_dir` numbers *directories*, so its `id` / `parent_id` are directory
    // ids. Typing either as JOINID(dune_node.node_id) would render it as
    // whichever unrelated graph node happened to share the number, which is
    // worse than the plain integer it is. A directory is not a node.
    // (node_source_unittest.ts is where a column that *is* one is checked.)
    for (const col of DIR_TREE_COLUMNS) {
      const type = exploreColumnType(col);
      expect(type.kind).not.toBe('id');
      expect(type.kind).not.toBe('joinid');
    }
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
    expect(item.kind).toBe('chart');
    if (item.kind !== 'chart') return;
    // The item has to name the graph's export node: a dashboard pointing at a
    // node that isn't there renders nothing and says nothing.
    expect(item.sourceNodeId).toBe(
      parsedGraph().nodes.find((n) => n.type === 'dashboard')!.nodeId,
    );
    // The registered type, taken from the registration rather than spelt out,
    // since an unregistered one renders a placeholder naming it.
    expect(item.config.chartType).toBe(DIR_TREE_CHART_TYPE);
  });

  it('points the chart at a node id column the source exports', () => {
    // Two ways for the card to draw no tree, both silent: a column the source
    // does not export (the dashboard reports "Invalid column" instead), and one
    // the chart does not read as node ids (it offers to switch instead of
    // drawing). `node_id` is the first of the three names the chart takes as
    // node-bearing - see dir_explorer_chart.ts's NODE_ID_COLUMNS.
    const hydrated = deserializeDashboardsFromExport(dirTreeDashboards());
    const item = hydrated![0].items[0];
    if (item.kind !== 'chart') throw new Error('not a chart');
    expect(item.config.column).toBe('node_id');
    expect(columnNames).toContain(item.config.column);
  });
});
