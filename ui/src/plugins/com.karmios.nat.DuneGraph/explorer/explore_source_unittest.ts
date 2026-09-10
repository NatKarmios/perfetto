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
 * Merging is where the risk is. A merge that renumbers, drops or subtly rewires
 * what the user already had would be destructive and invisible: a dashboard
 * item names its data source by *node id*, so an id that moved is a dashboard
 * that renders nothing. Hence the "untouched" assertions below.
 *
 * What is added is asserted just as closely - a group, and no dashboard export
 * - since nothing else would notice a source that quietly started publishing
 * itself.
 */

import {registerCoreNodes} from '../../dev.perfetto.DataExplorer/query_builder/core_nodes';
import {dashboardRegistry} from '../../dev.perfetto.DataExplorer/dashboard/dashboard_registry';
import {
  deserializeState,
  validateSerializedGraph,
} from '../../dev.perfetto.DataExplorer/json_handler';
import type {SerializedNode} from '../../dev.perfetto.DataExplorer/json_handler';
import type {Trace} from '../../../public/trace';
import {DIR_TREE_SOURCE} from './dir_tree_source';
import type {ExploreSource} from './explore_source';
import {
  appendExploreSourceToGraph,
  exploreColumnType,
  exploreSelect,
} from './explore_source';
import {NODE_SOURCE} from './node_source';

// The node registry is populated as a side effect of the Data Explorer's own
// module load; a unit test importing only the loaders has to do it itself.
registerCoreNodes();

// Nothing in these graphs reads the trace or the SQL modules: the sources are
// raw SQL (not stdlib tables) and the other nodes only shuffle columns.
const trace = {} as Trace;
// `SqlModules` comes from a plugin this one doesn't depend on, so its type is
// taken off `deserializeState` rather than imported across. Nothing here reads
// it - the loaders under test only pass it through - so a bare stub will do.
const sqlModules = {} as Parameters<typeof deserializeState>[2];

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

/**
 * A graph of the kind a source is appended *into*: a chain the user built and
 * published to a dashboard themselves, with ids 0, 1, 2.
 *
 * Written out here rather than generated, because nothing in the plugin builds
 * a `dashboard` node any more - which is the point. What these tests need from
 * it is precisely that it is somebody else's work: its ids, its export and its
 * name have to come back out of a merge exactly as they went in.
 */
function existingUserGraph(source: ExploreSource): string {
  return JSON.stringify({
    nodes: [
      {
        nodeId: '0',
        type: 'sql_source',
        state: {sql: exploreSelect(source)},
        nextNodes: ['1'],
      },
      {
        nodeId: '1',
        type: 'modify_columns',
        state: {
          selectedColumns: source.columns.map((c) => ({
            name: c.name,
            checked: true,
            type: exploreColumnType(c),
            typeUserModified: true,
          })),
        },
        primaryInputId: '0',
        nextNodes: ['2'],
      },
      {
        nodeId: '2',
        type: 'dashboard',
        state: {exportName: source.exportName},
        primaryInputId: '1',
        nextNodes: [],
      },
    ],
    rootNodeIds: ['0'],
    selectedNodeId: '0',
  });
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

describe('appendExploreSourceToGraph', () => {
  it('seeds from scratch when there is no graph to append to', () => {
    // getActiveGraphJson() returns undefined for an empty tab, and '' for one
    // that has been emptied. Either way the button does what it always does -
    // the same grouped, unexported chain it appends to a graph in progress.
    const empty = JSON.stringify({nodes: [], rootNodeIds: []});
    const expected = appendExploreSourceToGraph(empty, TOY_SOURCE).json;
    expect(appendExploreSourceToGraph(undefined, TOY_SOURCE).json).toBe(
      expected,
    );
    expect(appendExploreSourceToGraph('', TOY_SOURCE).json).toBe(expected);
    expect(validateSerializedGraph(expected).errors).toEqual([]);
  });

  it('groups the chain and publishes nothing', () => {
    // The panel's button makes the data available; what is done with it is the
    // user's call, so no dashboard export node - and the pair of nodes lands as
    // one named, collapsed group rather than loose on the user's canvas.
    const {json, ids} = appendExploreSourceToGraph(undefined, TOY_SOURCE);
    const {nodes} = parse(json);
    expect(nodes.map((n) => n.type)).toEqual([
      'sql_source',
      'modify_columns',
      'group',
    ]);
    const group = nodes[2];
    expect(group.nodeId).toBe(ids.groupNodeId);
    expect((group.state as {name: string}).name).toBe(TOY_SOURCE.exportName);
    expect(group.innerNodeIds).toEqual([ids.sourceNodeId, ids.columnsNodeId]);
    // The group is the root; its inner nodes are reached by traversing it.
    expect(parse(json).rootNodeIds).toEqual([ids.groupNodeId]);
  });

  it('leaves the group connectable, with the columns node as its output', () => {
    // The end node - the inner node with no successor inside the group - is
    // what the loader turns into the group's output port, and it is what a
    // `dashboard` node would be connected to later. It is also where the
    // declared column types live, so they survive the grouping.
    const {json, ids} = appendExploreSourceToGraph(undefined, TOY_SOURCE);
    const state = deserializeState(json, trace, sqlModules);
    expect(state.rootNodes).toHaveLength(1);
    const group = state.rootNodes[0];
    expect(group.type).toBe('group');
    expect(group.innerNodes?.map((n) => n.nodeId)).toEqual([
      ids.sourceNodeId,
      ids.columnsNodeId,
    ]);
    const end = group.innerNodes?.find((n) => n.nodeId === ids.columnsNodeId);
    expect(end?.finalCols.map((c) => c.name)).toEqual(
      TOY_SOURCE.columns.map((c) => c.name),
    );
  });

  it('allocates ids above everything already in the graph', () => {
    const before = existingUserGraph(DIR_TREE_SOURCE); // ids 0, 1, 2
    const {json, ids} = appendExploreSourceToGraph(before, NODE_SOURCE);
    expect(ids).toEqual({
      sourceNodeId: '3',
      columnsNodeId: '4',
      groupNodeId: '5',
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
    const before = parse(existingUserGraph(DIR_TREE_SOURCE));
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
    // The original root is still a root, and the new group has joined it.
    expect(after.rootNodeIds).toEqual([...before.rootNodeIds, '5']);
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

  it('selects the group it just added', () => {
    // The group, not the SQL node inside it: on the graph tab the inner nodes
    // are not drawn, so selecting one would look like nothing happened.
    const before = existingUserGraph(DIR_TREE_SOURCE);
    const {json, ids} = appendExploreSourceToGraph(before, NODE_SOURCE);
    expect(parse(json).selectedNodeId).toBe(ids.groupNodeId);
  });

  it('numbers a repeated group name instead of adding two alike', () => {
    // Adding the same source twice is legitimate (two views of one table,
    // filtered differently); two identically titled groups are not tellable
    // apart on the canvas.
    const once = appendExploreSourceToGraph(undefined, TOY_SOURCE).json;
    const twice = appendExploreSourceToGraph(once, TOY_SOURCE).json;
    const thrice = appendExploreSourceToGraph(twice, TOY_SOURCE).json;
    const names = parse(thrice)
      .nodes.filter((n) => n.type === 'group')
      .map((n) => (n.state as {name: string}).name);
    expect(names).toEqual(['Toy', 'Toy 2', 'Toy 3']);
  });

  it("declares its column types as the user's own, so a run cannot erase them", () => {
    // Without typeUserModified, ModifyColumnsNode.onPrevNodesUpdated() rebuilds
    // selectedColumns from the source's finalCols - which a freshly run
    // sql_source reports untyped - and every duration and node chip in the grid
    // silently becomes a bare integer. See explore_source.ts.
    const columns = parse(
      appendExploreSourceToGraph(undefined, TOY_SOURCE).json,
    ).nodes[1].state as {
      selectedColumns: Array<{
        type: unknown;
        checked: boolean;
        typeUserModified: boolean;
      }>;
    };
    expect(columns.selectedColumns.map((c) => c.typeUserModified)).toEqual([
      true,
      true,
    ]);
    // An omitted or false `checked` exports nothing at all.
    expect(columns.selectedColumns.every((c) => c.checked)).toBe(true);
    expect(columns.selectedColumns.map((c) => c.type)).toEqual([
      {kind: 'int'},
      {kind: 'duration'},
    ]);
  });

  it('refuses a graph it does not understand rather than replacing it', () => {
    expect(() => appendExploreSourceToGraph('{"nope": 1}', TOY_SOURCE)).toThrow(
      /not in the expected format/,
    );
    expect(() => appendExploreSourceToGraph('not json', TOY_SOURCE)).toThrow();
  });

  it("produces a graph the Data Explorer accepts, next to the user's", () => {
    const before = existingUserGraph(DIR_TREE_SOURCE);
    const {json, ids} = appendExploreSourceToGraph(before, NODE_SOURCE);
    expect(validateSerializedGraph(json).errors).toEqual([]);

    const state = deserializeState(json, trace, sqlModules);
    // The graph that was there and the appended group, so two roots - a merge
    // that lost one would show up here as a chain silently missing.
    expect(state.rootNodes).toHaveLength(2);
    expect(state.selectedNodes).toEqual(new Set([ids.groupNodeId]));

    // The graph that was already there still publishes its source, under its
    // own id and name, with its columns known before anything has been
    // executed - and the appended one publishes nothing.
    const dirs = dashboardRegistry.getExportedSource(
      parse(before).nodes[2].nodeId,
    );
    expect(dirs?.name).toBe(DIR_TREE_SOURCE.exportName);
    expect(dirs?.columns.map((c) => c.name)).toEqual(
      DIR_TREE_SOURCE.columns.map((c) => c.name),
    );
    expect(
      parse(json).nodes.filter((n) => n.type === 'dashboard'),
    ).toHaveLength(1);
  });
});
