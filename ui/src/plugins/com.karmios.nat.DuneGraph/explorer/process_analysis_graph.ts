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
 * The "Process Analysis" recipe's graph. Data only - what offers it is
 * dune_recipes.ts.
 *
 * This one was built in the Data Explorer and exported rather than written
 * here, which is why it is a whole-tab export (`{version, title, graph,
 * dashboards}`) and not a bare graph. Three of its nodes export to a
 * dashboard, and the dashboard those three feed - three charts and a grid -
 * is half of what the recipe is. Only that envelope carries it.
 *
 * It is a TypeScript object literal rather than the exported file's text for
 * two reasons. Several of the column descriptions the export carries contain
 * backticks, so the text cannot sit in a template literal without escaping the
 * middle of the data. And as a literal the envelope is type-checked, which is
 * the one part of a recipe a type can check at all - the per-node `state` is
 * `object` either way, and only the test that deserializes this can speak for
 * it.
 *
 * Not under `ui/src/assets/`, where the Data Explorer's own examples live:
 * that directory belongs to that plugin, and this one ships no assets. Carrying
 * the JSON inline is the case `ExampleGraph.json` exists for.
 *
 * Three things were changed in the export by hand, and they are the only
 * three.
 *
 * The `dur_ns > 1s` filter that sat between the source and the sort is gone,
 * and the sort takes the source directly. Sorting by duration and taking
 * thirty already yields the thirty longest, so the filter only hid short
 * builds - on a build where nothing ran for a second it emptied that branch
 * entirely. The rewiring is what deleting the node in the UI does: the child
 * reconnects to the deleted node's primary parent, inherits its layout because
 * it had none of its own, and the deleted node leaves `rootNodeIds`.
 *
 * `title` was changed from the tab's working name, for the reason given where
 * it is set below.
 *
 * `selectedNodeId` was set to the terminal join, so that the recipe opens
 * showing a result rather than an empty panel. Nothing was selected when the
 * tab was exported.
 */

import type {SerializedTabExport} from '../../dev.perfetto.DataExplorer/graph_io';
import type {SerializedGraph} from '../../dev.perfetto.DataExplorer/json_handler';

const GRAPH: SerializedGraph = {
  nodes: [
    {
      nodeId: '12241',
      type: 'overlap_count',
      state: {},
      nextNodes: ['12252'],
      primaryInputId: '12244',
    },
    {
      nodeId: '12243',
      type: 'dune_source_dune_process',
      state: {
        table: 'dune_process',
      },
      nextNodes: ['12244', '12253', '12261'],
    },
    {
      nodeId: '12249',
      type: 'dune_macro_dune_parents',
      state: {
        macro: 'dune_parents',
      },
      nextNodes: ['12263'],
      primaryInputId: '12262',
    },
    {
      nodeId: '12251',
      type: 'dashboard',
      state: {
        exportName: '30 longest processes',
      },
      nextNodes: [],
      primaryInputId: '12265',
    },
    {
      nodeId: '12263',
      type: 'join',
      state: {
        leftQueryAlias: 'left',
        rightQueryAlias: 'right',
        conditionType: 'equality',
        joinType: 'INNER',
        leftColumn: 'node_id',
        rightColumn: 'dst',
        sqlExpression: '',
        leftColumns: [
          {
            name: 'slice_id',
            type: {
              kind: 'joinid',
              source: {
                table: 'slice',
                column: 'id',
              },
            },
            description: "The process's slice on the timeline.",
            checked: true,
          },
          {
            name: 'ts',
            type: {
              kind: 'timestamp',
            },
            description: 'When the process started.',
            checked: false,
          },
          {
            name: 'dur_ns',
            type: {
              kind: 'duration',
            },
            description:
              'How long it ran, in nanoseconds. NULL for a process that had not finished when the trace ended.',
            checked: true,
          },
          {
            name: 'rule_id',
            type: {
              kind: 'int',
            },
            description: "Dune's rule id for the rule that spawned it.",
            checked: false,
          },
          {
            name: 'node_id',
            type: {
              kind: 'joinid',
              source: {
                table: 'dune_node',
                column: 'node_id',
              },
            },
            description:
              'That rule as a dune_node, or NULL if the graph has no such rule.',
            checked: false,
          },
          {
            name: 'prog',
            type: {
              kind: 'string',
            },
            description:
              'The program that ran, as a full path. Join dune_process_arg for its arguments.',
            checked: false,
          },
        ],
        rightColumns: [
          {
            name: 'src',
            type: {
              kind: 'joinid',
              source: {
                table: 'dune_node',
                column: 'node_id',
              },
            },
            description: 'The walk’s near end.',
            checked: true,
          },
          {
            name: 'src_kind',
            type: {
              kind: 'string',
            },
            description: "'rule' or 'dep'.",
            checked: false,
          },
          {
            name: 'src_id',
            type: {
              kind: 'string',
            },
            description: "`src`'s label: a rule id, or a dep's path.",
            checked: false,
          },
          {
            name: 'dst',
            type: {
              kind: 'joinid',
              source: {
                table: 'dune_node',
                column: 'node_id',
              },
            },
            description: 'The reached node.',
            checked: false,
          },
          {
            name: 'dst_kind',
            type: {
              kind: 'string',
            },
            description: "'rule' or 'dep'.",
            checked: false,
          },
          {
            name: 'dst_id',
            type: {
              kind: 'string',
            },
            description: "`dst`'s label: a rule id, or a dep's path.",
            checked: false,
          },
          {
            name: 'distance',
            type: {
              kind: 'int',
            },
            description:
              'Path nodes traversed away from the anchor, excluding the anchor itself; equals `rule_distance + dep_distance`.',
            checked: false,
          },
          {
            name: 'rule_distance',
            type: {
              kind: 'int',
            },
            description:
              'How much of `distance` was spent stepping through rules.',
            checked: false,
          },
          {
            name: 'dep_distance',
            type: {
              kind: 'int',
            },
            description:
              'How much of `distance` was spent stepping through deps.',
            checked: false,
          },
        ],
      },
      nextNodes: ['12265', '12264'],
      secondaryInputIds: {
        '0': '12262',
        '1': '12249',
      },
    },
    {
      nodeId: '12265',
      type: 'join',
      state: {
        leftQueryAlias: 'left',
        rightQueryAlias: 'right',
        conditionType: 'equality',
        joinType: 'INNER',
        leftColumn: 'slice_id',
        rightColumn: 'slice_id',
        sqlExpression: '',
        leftColumns: [
          {
            name: 'slice_id',
            type: {
              kind: 'joinid',
              source: {
                table: 'slice',
                column: 'id',
              },
            },
            description: "The process's slice on the timeline.",
            checked: true,
          },
          {
            name: 'dur_ns',
            type: {
              kind: 'duration',
            },
            description:
              'How long it ran, in nanoseconds. NULL for a process that had not finished when the trace ended.',
            checked: true,
          },
          {
            name: 'src',
            type: {
              kind: 'joinid',
              source: {
                table: 'dune_node',
                column: 'node_id',
              },
            },
            description: 'The walk’s near end.',
            checked: true,
          },
        ],
        rightColumns: [
          {
            name: 'slice_id',
            type: {
              kind: 'joinid',
              source: {
                table: 'slice',
                column: 'id',
              },
            },
            description: 'The process slice, as passed in.',
            checked: false,
          },
          {
            name: 'prog',
            type: {
              kind: 'string',
            },
            description: 'The program, from `dune_process.prog`.',
            checked: false,
          },
          {
            name: 'args',
            type: {
              kind: 'string',
            },
            description:
              'The argv, space-joined in `idx` order, NOT including the program. NULL when the process took no arguments.',
            checked: false,
          },
        ],
      },
      nextNodes: ['12251'],
      secondaryInputIds: {
        '0': '12263',
        '1': '12264',
      },
    },
    {
      nodeId: '12264',
      type: 'dune_macro_dune_process_cmd',
      state: {
        macro: 'dune_process_cmd',
      },
      nextNodes: ['12265'],
      primaryInputId: '12263',
    },
    {
      nodeId: '12252',
      type: 'dashboard',
      state: {
        exportName: 'Parallelism over time',
      },
      nextNodes: [],
      primaryInputId: '12241',
    },
    {
      nodeId: '12244',
      type: 'modify_columns',
      state: {
        selectedColumns: [
          {
            name: 'slice_id',
            type: {
              kind: 'joinid',
              source: {
                table: 'slice',
                column: 'id',
              },
            },
            checked: false,
          },
          {
            name: 'ts',
            type: {
              kind: 'timestamp',
            },
            checked: true,
          },
          {
            name: 'dur_ns',
            type: {
              kind: 'duration',
            },
            checked: true,
            alias: 'dur',
          },
          {
            name: 'rule_id',
            type: {
              kind: 'int',
            },
            checked: false,
          },
          {
            name: 'node_id',
            type: {
              kind: 'joinid',
              source: {
                table: 'dune_node',
                column: 'node_id',
              },
            },
            checked: false,
          },
          {
            name: 'prog',
            type: {
              kind: 'string',
            },
            checked: false,
          },
        ],
      },
      nextNodes: ['12241'],
      primaryInputId: '12243',
    },
    {
      nodeId: '12253',
      type: 'dashboard',
      state: {
        exportName: 'All processes',
      },
      nextNodes: [],
      primaryInputId: '12243',
    },
    {
      nodeId: '12262',
      type: 'limit_and_offset',
      state: {
        limit: 30,
        offset: 0,
      },
      nextNodes: ['12249', '12263'],
      primaryInputId: '12261',
    },
    {
      nodeId: '12261',
      type: 'sort',
      state: {
        sortCriteria: [
          {
            colName: 'dur_ns',
            direction: 'DESC',
          },
        ],
      },
      nextNodes: ['12262'],
      primaryInputId: '12243',
    },
  ],
  rootNodeIds: ['12241', '12243', '12249', '12251', '12263', '12265', '12264'],
  // Hand-set to the join that feeds the "30 longest processes" dashboard; the
  // export had nothing selected.
  selectedNodeId: '12265',
  nodeLayouts: {
    '1039': {
      x: 426.28450017884524,
      y: 839.2565188655174,
    },
    '12243': {
      x: 231.81665653196052,
      y: 0,
    },
    '12244': {
      x: 267.29049657125256,
      y: 197.41316480898806,
    },
    '12249': {
      x: 0,
      y: 455.77076445702846,
    },
    '12251': {
      x: 508.143889766846,
      y: 732.179139420773,
    },
    '12253': {
      x: 440.5648017695184,
      y: 104.14089399828003,
    },
    '12263': {
      x: 287.986193007868,
      y: 386.7488545707945,
    },
    '12264': {
      x: 217.57495147932931,
      y: 615.2961601614863,
    },
    '12265': {
      x: 470.52476269874654,
      y: 558.8315931142802,
    },
    '12261': {
      x: 32.036206683220826,
      y: 215.55623326165232,
    },
  },
  labels: [],
  isExplorerCollapsed: false,
  sidebarWidth: 380.4000244140625,
};

const EXPORT: SerializedTabExport = {
  version: 1,
  // Hand-set. The tab this opens in is named from here, and only falls back
  // to the registry entry's name when there is none, so the two have to agree
  // - see `loadExampleGraph` in the Data Explorer's graph_io.ts.
  title: 'Dune: Process Analysis',
  graph: JSON.stringify(GRAPH),
  dashboards: [
    {
      id: 'ckjWmREd_',
      items: [
        {
          kind: 'chart',
          sourceNodeId: '12253',
          config: {
            id: 'chart-b46b0367-f479-43a4-bc2d-db351decdb36',
            column: 'dur_ns',
            chartType: 'histogram',
          },
          col: 0,
          row: 10,
          rowSpan: 9,
          colSpan: 12,
        },
        {
          kind: 'chart',
          sourceNodeId: '12252',
          config: {
            id: 'chart-854b970a-dbba-4796-ad82-dc03500822dd',
            column: 'ts',
            chartType: 'line',
            yColumn: 'value',
          },
          col: 0,
          row: 0,
          rowSpan: 9,
          colSpan: 24,
        },
        {
          kind: 'chart',
          sourceNodeId: '12251',
          config: {
            id: 'chart-13824b17-263e-4cbf-87b8-1ef9df1936b7',
            column: 'src',
            chartType: 'dune-dir-tree',
          },
          col: 13,
          row: 10,
          rowSpan: 9,
          colSpan: 11,
        },
        {
          kind: 'grid',
          id: 'cmXDHS9eA',
          sourceNodeId: '12251',
          col: 0,
          row: 20,
          rowSpan: 8,
          colSpan: 24,
        },
      ],
    },
  ],
};

export const PROCESS_ANALYSIS_GRAPH = JSON.stringify(EXPORT);
