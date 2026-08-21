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
 * The source payloads (explore_source.ts), checked against the Data Explorer's
 * own loaders rather than against a copy of what they expect. That matters more
 * than usual here: the payload is *data*, so every way of getting it wrong - an
 * unknown node type, a one-sided edge, a root that isn't one - is silently
 * dropped on load rather than caught by the compiler.
 *
 * The appending half is where the risk is. A merge that renumbers, drops or
 * subtly rewires what the user already had would be destructive and invisible:
 * a dashboard item names its data source by *node id*, so an id that moved is a
 * dashboard that renders nothing. Hence the "untouched" assertions below.
 */

import {registerCoreNodes} from '../dev.perfetto.DataExplorer/query_builder/core_nodes';
import {dashboardRegistry} from '../dev.perfetto.DataExplorer/dashboard/dashboard_registry';
import {
  deserializeState,
  validateSerializedGraph,
} from '../dev.perfetto.DataExplorer/json_handler';
import type {SerializedNode} from '../dev.perfetto.DataExplorer/json_handler';
import type {SqlModules} from '../dev.perfetto.SqlModules/sql_modules';
import type {Trace} from '../../public/trace';
import {DIR_TREE_SOURCE} from './dir_tree_graph';
import type {ExploreSource} from './explore_source';
import {
  appendExploreSourceToGraph,
  exploreColumnType,
  exploreSelect,
  exploreSourceGraph,
} from './explore_source';
import {NODE_SOURCE} from './node_source';

// The node registry is populated as a side effect of the Data Explorer's own
// module load; a unit test importing only the loaders has to do it itself.
registerCoreNodes();

// Nothing in these graphs reads the trace or the SQL modules: the sources are
// raw SQL (not stdlib tables) and the other nodes only shuffle columns.
const trace = {} as Trace;
const sqlModules = {} as SqlModules;

// A source of no particular interest, so that the mechanism is tested rather
// than either of the two real ones.
const TOY_SOURCE: ExploreSource = {
  from: 'dune_toy',
  columns: [
    {name: 'a', type: 'int'},
    {name: 'b', type: 'duration', expr: 'b_ns'},
  ],
  exportName: 'Toy',
  label: 'Toy',
  icon: 'science',
  title: 'A source that exists only in this test',
};

interface ParsedGraph {
  nodes: SerializedNode[];
  rootNodeIds: string[];
  selectedNodeId?: string;
  nodeLayouts?: {[key: string]: {x: number; y: number}};
  labels?: unknown[];
}

function parse(json: string): ParsedGraph {
  return JSON.parse(json) as ParsedGraph;
}

describe('exploreSelect', () => {
  it('is one SELECT, aliased where a column is an expression', () => {
    expect(exploreSelect(TOY_SOURCE)).toBe(
      ['SELECT', '  a,', '  b_ns AS b', 'FROM dune_toy'].join('\n'),
    );
    // No leading statements and no trailing semicolon - all SqlSourceNode's
    // statement validation accepts.
    expect(exploreSelect(TOY_SOURCE)).not.toContain(';');
  });
});

describe('exploreColumnType', () => {
  it('wraps a bare kind and passes a full type through', () => {
    expect(exploreColumnType({name: 'a', type: 'duration'})).toEqual({
      kind: 'duration',
    });
    const idType = {
      kind: 'joinid' as const,
      source: {table: 't', column: 'id'},
    };
    expect(exploreColumnType({name: 'a', type: idType})).toBe(idType);
  });
});

describe('exploreSourceGraph', () => {
  it('passes the Data Explorer structural validation', () => {
    expect(
      validateSerializedGraph(exploreSourceGraph(TOY_SOURCE).json).errors,
    ).toEqual([]);
  });

  it('numbers its nodes from zero and reports the ids it used', () => {
    // Zero because this payload *replaces* the graph, so there is nothing to
    // avoid; that it reports them at all is what lets a dashboard item point
    // at the export node without writing a number down twice.
    const {json, ids} = exploreSourceGraph(TOY_SOURCE);
    expect(parse(json).nodes.map((n) => n.nodeId)).toEqual([
      ids.sourceNodeId,
      ids.columnsNodeId,
      ids.exportNodeId,
    ]);
  });

  it("declares its column types as the user's own, so a run cannot erase them", () => {
    // Without typeUserModified, ModifyColumnsNode.onPrevNodesUpdated() rebuilds
    // selectedColumns from the source's finalCols - which a freshly run
    // sql_source reports untyped - and every duration and node chip in the grid
    // silently becomes a bare integer. See explore_source.ts.
    const columns = parse(exploreSourceGraph(TOY_SOURCE).json).nodes[1]
      .state as {
      selectedColumns: Array<{type: unknown; typeUserModified: boolean}>;
    };
    expect(columns.selectedColumns.map((c) => c.typeUserModified)).toEqual([
      true,
      true,
    ]);
    expect(columns.selectedColumns.map((c) => c.type)).toEqual([
      {kind: 'int'},
      {kind: 'duration'},
    ]);
  });
});

describe('appendExploreSourceToGraph', () => {
  it('seeds from scratch when there is no graph to append to', () => {
    // getActiveGraphJson() returns undefined for an empty tab.
    expect(appendExploreSourceToGraph(undefined, TOY_SOURCE).json).toBe(
      exploreSourceGraph(TOY_SOURCE).json,
    );
    expect(appendExploreSourceToGraph('', TOY_SOURCE).json).toBe(
      exploreSourceGraph(TOY_SOURCE).json,
    );
  });

  it('allocates ids above everything already in the graph', () => {
    const before = exploreSourceGraph(DIR_TREE_SOURCE).json; // ids 0, 1, 2
    const {json, ids} = appendExploreSourceToGraph(before, NODE_SOURCE);
    expect(ids).toEqual({
      sourceNodeId: '3',
      columnsNodeId: '4',
      exportNodeId: '5',
    });
    expect(parse(json).nodes.map((n) => n.nodeId)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
  });

  it('allocates above the highest id, not the node count', () => {
    // A graph the user has been editing has gaps (deleted nodes) and its ids
    // are in no particular order. Counting nodes, or trusting the last one,
    // would hand out an id that is already taken.
    const gappy = JSON.stringify({
      nodes: [
        {
          nodeId: '41',
          type: 'sql_source',
          state: {sql: 'SELECT 1'},
          nextNodes: [],
        },
        {
          nodeId: '7',
          type: 'sql_source',
          state: {sql: 'SELECT 2'},
          nextNodes: [],
        },
      ],
      rootNodeIds: ['41', '7'],
    });
    expect(appendExploreSourceToGraph(gappy, TOY_SOURCE).ids.sourceNodeId).toBe(
      '42',
    );
  });

  it('ignores ids that are not numbers, which cannot collide anyway', () => {
    const named = JSON.stringify({
      nodes: [
        {
          nodeId: 'source',
          type: 'sql_source',
          state: {sql: 'SELECT 1'},
          nextNodes: [],
        },
      ],
      rootNodeIds: ['source'],
    });
    expect(appendExploreSourceToGraph(named, TOY_SOURCE).ids.sourceNodeId).toBe(
      '0',
    );
  });

  it('leaves everything already in the graph exactly as it was', () => {
    // Node ids especially: a dashboard item names its source by node id, so a
    // renumbered export node is a dashboard that renders nothing.
    const before = parse(exploreSourceGraph(DIR_TREE_SOURCE).json);
    // Plus the things a real graph carries that this builder never writes.
    const withUserState = JSON.stringify({
      ...before,
      nodeLayouts: {'0': {x: 10, y: 20}, '1': {x: 30, y: 40}},
      labels: [{id: 'l', x: 0, y: 0, width: 100, text: 'mine'}],
      sidebarWidth: 321,
    });
    const after = parse(
      appendExploreSourceToGraph(withUserState, NODE_SOURCE).json,
    );

    expect(after.nodes.slice(0, before.nodes.length)).toEqual(before.nodes);
    expect(after.nodes).toHaveLength(before.nodes.length + 3);
    // The original root is still a root, and the new source has joined it.
    expect(after.rootNodeIds).toEqual([...before.rootNodeIds, '3']);
    // Layouts, labels and panel state are the user's business, not ours - and
    // the appended nodes deliberately get no layout, so the graph view places
    // them itself instead of stacking them on someone else.
    expect(after.nodeLayouts).toEqual({
      '0': {x: 10, y: 20},
      '1': {x: 30, y: 40},
    });
    expect(after.labels).toEqual([
      {id: 'l', x: 0, y: 0, width: 100, text: 'mine'},
    ]);
    expect((after as {sidebarWidth?: number}).sidebarWidth).toBe(321);
  });

  it('selects the node it just added', () => {
    const before = exploreSourceGraph(DIR_TREE_SOURCE).json;
    const {json, ids} = appendExploreSourceToGraph(before, NODE_SOURCE);
    expect(parse(json).selectedNodeId).toBe(ids.sourceNodeId);
  });

  it('numbers a repeated export name instead of publishing two alike', () => {
    // Adding the same source twice is legitimate; two identically named
    // entries in the dashboard's source picker are not distinguishable.
    const once = appendExploreSourceToGraph(undefined, TOY_SOURCE).json;
    const twice = appendExploreSourceToGraph(once, TOY_SOURCE).json;
    const thrice = appendExploreSourceToGraph(twice, TOY_SOURCE).json;
    const names = parse(thrice)
      .nodes.filter((n) => n.type === 'dashboard')
      .map((n) => (n.state as {exportName: string}).exportName);
    expect(names).toEqual(['Toy', 'Toy 2', 'Toy 3']);
  });

  it('refuses a graph it does not understand rather than replacing it', () => {
    expect(() => appendExploreSourceToGraph('{"nope": 1}', TOY_SOURCE)).toThrow(
      /not in the expected format/,
    );
    expect(() => appendExploreSourceToGraph('not json', TOY_SOURCE)).toThrow();
  });

  it('produces a graph the Data Explorer accepts and both exports survive', () => {
    const before = exploreSourceGraph(DIR_TREE_SOURCE).json;
    const {json, ids} = appendExploreSourceToGraph(before, NODE_SOURCE);
    expect(validateSerializedGraph(json).errors).toEqual([]);

    const state = deserializeState(json, trace, sqlModules);
    // Two independent chains, so two roots - a merge that lost one would show
    // up here as a chain silently missing from the graph.
    expect(state.rootNodes).toHaveLength(2);
    expect(state.selectedNodes).toEqual(new Set([ids.sourceNodeId]));

    // Both dashboard nodes publish, under their own ids and names, with their
    // columns known before anything has been executed.
    const dirs = dashboardRegistry.getExportedSource(
      parse(before).nodes[2].nodeId,
    );
    const nodes = dashboardRegistry.getExportedSource(ids.exportNodeId);
    expect(dirs?.name).toBe(DIR_TREE_SOURCE.exportName);
    expect(nodes?.name).toBe(NODE_SOURCE.exportName);
    expect(dirs?.columns.map((c) => c.name)).toEqual(
      DIR_TREE_SOURCE.columns.map((c) => c.name),
    );
    expect(nodes?.columns.map((c) => c.name)).toEqual(
      NODE_SOURCE.columns.map((c) => c.name),
    );
  });
});
