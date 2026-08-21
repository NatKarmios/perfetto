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
 * How a graph node renders as a *cell*: a coloured kind chip, the node's label
 * linking to its slice, and the ＋/－ graph-membership toggle. Two layers:
 *
 * - Node-based (`nodeAnchor`, `renderNodeChip`): what the query tab's table and
 *   tree modes both draw, given a node they have already resolved. Only the
 *   anchor is shared out; the chip is reached through the value-based layer.
 * - Value-based (`renderNodeCell` / `nodeCellLabel` / `renderNodeCellActions`):
 *   the same thing for a DataGrid cell whose value *is* a `dune_node.node_id`,
 *   plus `registerNodeColumnRenderer`, which teaches every DataGrid in the UI
 *   to draw a `JOINID(dune_node.node_id)` column that way - the query tab's
 *   results, a Data Explorer results panel, a dashboard grid.
 *
 * Note what a value-based renderer is allowed to read: its own cell value and
 * the controller, nothing else. In particular not a sibling column of the same
 * row - `SQLDataSource` only SELECTs the columns the grid's model shows (so a
 * hidden sibling is simply absent from `row`) and the grid's own added columns
 * are keyed by uuid rather than by name. A node id is self-sufficient, which is
 * what makes this work at all: resolving one is a range check against the
 * current graph (see `controller.nodeForNodeId`), not a query.
 */

import m from 'mithril';
import {Icons} from '../../base/semantic_icons';
import type {ColumnRenderers} from '../../components/widgets/datagrid/column_renderers';
import {idColumnRenderers} from '../../components/widgets/datagrid/column_renderers';
import type {Trace} from '../../public/trace';
import type {PerfettoSqlType} from '../../trace_processor/perfetto_sql_type';
import type {SqlValue} from '../../trace_processor/query_result';
import {Anchor} from '../../widgets/anchor';
import type {DuneGraphController} from './controller';
import type {NodeId} from './graph';
import {decorateNode, kindChip} from './node_display';
import {nodeToggleButton} from './node_tree_actions';

/**
 * The SQL mirror's node table and its id column (see sql_graph.ts). The table
 * name is the key the id-column renderer registry is keyed on, so it is also
 * what a `JOINID(...)` in someone else's query has to name to get a chip.
 */
export const DUNE_NODE_TABLE = 'dune_node';
export const DUNE_NODE_ID_COLUMN = 'node_id';

/**
 * The type a column of graph-node ids should declare to render as a node chip.
 * Exported so a builder emitting serialized Data Explorer JSON (see
 * dir_tree_graph.ts for the shape) can stamp it on a column rather than
 * spelling the type out.
 */
export const DUNE_NODE_JOINID: PerfettoSqlType = {
  kind: 'joinid',
  source: {table: DUNE_NODE_TABLE, column: DUNE_NODE_ID_COLUMN},
};

/**
 * A node's label as a link that jumps to its slice on the timeline. The icon
 * marks it as a selection-changing link, as everywhere else in the UI.
 */
export function nodeAnchor(
  controller: DuneGraphController,
  node: NodeId,
  label: string,
): m.Children {
  return m(
    Anchor,
    {
      icon: Icons.UpdateSelection,
      title: 'Go to slice on the timeline',
      onclick: () => void controller.goToNode(node),
    },
    label,
  );
}

/**
 * A node as a coloured kind chip plus its label, linking to its slice. A dep's
 * path additionally gets a leading build/code icon (its `_build/<dir>/` prefix
 * folded into the icon tooltip); a rule shows its bare id.
 */
function renderNodeChip(
  controller: DuneGraphController,
  node: NodeId,
): m.Children {
  const {graph} = controller;
  const {icon, text} = decorateNode(graph, node);
  return m(
    'span.pf-dune-graph__node-cell',
    kindChip(graph.kindOf(node)),
    icon,
    nodeAnchor(controller, node, text),
  );
}

/**
 * The graph node a cell value names, or undefined when it names none - a
 * non-numeric (or NULL) cell, an id from a graph that has since been reloaded,
 * or any id at all before the graph is loaded (the empty graph has no nodes, so
 * every cell falls back to its raw value).
 */
export function nodeForCellValue(
  controller: DuneGraphController,
  value: SqlValue,
): NodeId | undefined {
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    return undefined;
  }
  return controller.nodeForNodeId(Number(value));
}

/** A node-id cell as a chip, falling back to the raw value. */
export function renderNodeCell(
  controller: DuneGraphController,
  value: SqlValue,
): m.Children {
  const node = nodeForCellValue(controller, value);
  if (node === undefined) return value === null ? '' : String(value);
  return renderNodeChip(controller, node);
}

/**
 * A node-id cell as plain text - the node's label, so an export says what the
 * grid showed rather than repeating a dense internal id. Falls back to the raw
 * value, NULL included, since this is a formatter rather than a renderer.
 */
export function nodeCellLabel(
  controller: DuneGraphController,
  value: SqlValue,
): string {
  const node = nodeForCellValue(controller, value);
  return node === undefined ? String(value) : controller.graph.labelOf(node);
}

/**
 * The ＋/－ toggle for a node-id cell: adds or removes that node, reflecting
 * current membership. Absent when the cell doesn't name a node of the current
 * graph.
 */
export function renderNodeCellActions(
  controller: DuneGraphController,
  value: SqlValue,
): m.Children {
  const node = nodeForCellValue(controller, value);
  if (node === undefined) return undefined;
  return nodeToggleButton(controller, node);
}

/**
 * The DataGrid renderers for a column of graph-node ids. Neither of them looks
 * at anything but the cell's own value (see this file's header).
 */
function nodeColumnRenderers(controller: DuneGraphController): ColumnRenderers {
  return {
    cellRenderer: (value) => renderNodeCell(controller, value),
    actions: (value) => renderNodeCellActions(controller, value),
  };
}

/**
 * Teaches every DataGrid host how to render a reference to one of our nodes, so
 * that a column typed `JOINID(dune_node.node_id)` shows a node chip wherever it
 * appears - the query tab, a Data Explorer results panel, a dashboard grid.
 *
 * Registrations are global and outlive a trace, so this one is put in the
 * trace's trash: it is dropped when the trace is unloaded, and the next trace
 * load registers afresh. Registering a table twice throws by design, so a
 * leaked registration would surface on the next load rather than quietly
 * capturing a dead controller.
 *
 * @param trace The trace the registration's lifetime is tied to.
 * @param controller The controller whose graph node ids are resolved against.
 */
export function registerNodeColumnRenderer(
  trace: Trace,
  controller: DuneGraphController,
): void {
  trace.trash.use(
    idColumnRenderers.register(DUNE_NODE_TABLE, ({column}) =>
      // Keyed by table, so any `JOINID(dune_node.<anything>)` lands here. Only
      // the id column holds node ids; a reference to some other column of
      // dune_node (a `slice_id`, say) is not one, and rendering it as a node
      // would be a lie - so bail out and let it render plainly.
      column === DUNE_NODE_ID_COLUMN
        ? nodeColumnRenderers(controller)
        : undefined,
    ),
  );
}
