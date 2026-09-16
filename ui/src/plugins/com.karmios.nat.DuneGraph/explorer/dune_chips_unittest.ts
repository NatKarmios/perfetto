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
 * Whether the Data Explorer nodes' id columns chip.
 *
 * The query page decides that by column *name* (query_results.ts), but every
 * DataGrid - which is what a node's results panel is - decides it by column
 * type*: `resolveColumnRenderers()` looks the referenced table up in
 * `idColumnRenderers` and only chips when something is registered for it. So a
 * node whose `node_id` claims to be a plain integer renders no chips, however
 * well the query page renders the same query.
 *
 * These tests drive that exact function with the columns the nodes actually
 * expose, rather than asserting on the type constants, because the constants
 * being right is not the thing that was broken.
 */

import {afterEach, describe, expect, test} from 'vitest';
import {registerCoreNodes} from '../../dev.perfetto.DataExplorer/query_builder/core_nodes';
import {resolveColumnRenderers} from '../../../components/widgets/datagrid/column_renderers';
import {DisposableStack} from '../../../base/disposable_stack';
import type {Trace} from '../../../public/trace';
import type {DuneGraphController} from '../controller';
import {registerNodeColumnRenderer} from '../views/node_cell';
import {DuneTableSourceNode} from './dune_table_source';
import {DuneMacroNode} from './dune_macro_node';

registerCoreNodes();

let live: DisposableStack | undefined;

afterEach(() => {
  live?.dispose();
  live = undefined;
});

function fakeController(): DuneGraphController {
  return {
    nodeMirrorReady: true,
    edgeMirrorReady: true,
    graph: new Map(),
    dirPath: () => '/some/dir',
    nodeForNodeId: () => undefined,
    isInGraph: () => false,
  } as unknown as DuneGraphController;
}

// The cell renderers are registered per trace, exactly as index.ts does it.
function withRenderers(controller: DuneGraphController): Trace {
  const trash = new DisposableStack();
  const trace = {trash} as unknown as Trace;
  registerNodeColumnRenderer(trace, controller);
  live = new DisposableStack();
  live.defer(() => trash.dispose());
  return trace;
}

// Whether a DataGrid would draw this column as a chip: a cell renderer of its
// own, rather than the default rendering of a number.
function chips(
  trace: Trace,
  node: {finalCols: ReadonlyArray<{name: string; type?: unknown}>},
  column: string,
): boolean {
  const col = node.finalCols.find((c) => c.name === column);
  expect(col, `${column} is a column of this node`).toBeDefined();
  const renderers = resolveColumnRenderers(
    trace,
    col!.type as never,
    col!.name,
  );
  return renderers.cellRenderer !== undefined;
}

describe('the Dune source nodes', () => {
  test.each([
    ['dune_node', 'node_id'],
    ['dune_rule', 'node_id'],
    ['dune_dep', 'node_id'],
    ['dune_process', 'node_id'],
    ['dune_rule_target', 'node_id'],
    ['dune_edge', 'src'],
    ['dune_edge', 'dst'],
  ])('%s chips its %s column as a node', (table, column) => {
    const controller = fakeController();
    const trace = withRenderers(controller);
    const node = new DuneTableSourceNode({table}, {}, controller);

    expect(chips(trace, node, column)).toBe(true);
  });

  test.each([
    ['dune_dir', 'dir_id'],
    ['dune_dir', 'parent_dir_id'],
    ['dune_node', 'dir_id'],
    ['dune_gen_rules', 'dir_id'],
  ])('%s chips its %s column as a directory', (table, column) => {
    const controller = fakeController();
    const trace = withRenderers(controller);
    const node = new DuneTableSourceNode({table}, {}, controller);

    expect(chips(trace, node, column)).toBe(true);
  });
});

describe('the Dune macro nodes', () => {
  // The walk macros return the relation columns, whose `src` and `dst` are
  // mirror node ids like any others.
  test.each(['src', 'dst'])(
    'a walk macro chips its %s column as a node',
    (column) => {
      const controller = fakeController();
      const trace = withRenderers(controller);
      // A macro node derives its columns from the query above it, so it needs
      // one; the walk macros replace those columns with the relation columns.
      const node = new DuneMacroNode({macro: 'dune_children'}, {}, controller);
      node.primaryInput = new DuneTableSourceNode(
        {table: 'dune_node'},
        {},
        controller,
      );

      expect(chips(trace, node, column)).toBe(true);
    },
  );
});
