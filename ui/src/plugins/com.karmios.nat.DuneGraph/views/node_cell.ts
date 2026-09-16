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
 * linking to its slice, and the ＋/－ graph-membership toggle. Two layers -
 * node-based (`nodeAnchor`, `renderNodeChip`) for a caller that has resolved
 * the node already, and value-based (`renderNodeCell` and friends) for a
 * DataGrid cell whose value *is* a `dune_node.node_id`.
 *
 * **A value-based renderer may read its own cell value and the controller, and
 * nothing else** - in particular not a sibling column of the same row (see
 * ARCHITECTURE.md, "Gotchas"). A node id is self-sufficient, which is what makes this
 * work: resolving one is a range check against the current graph, not a query.
 *
 * A `dune_dir.dir_id` cell (`renderDirCell`) is the same shape and the same
 * rule: a
 * directory chip whose path links to that directory's `gen-rules` span. Its
 * path comes off the mirror, which keeps them in memory precisely so this stays
 * synchronous (see sql_graph.ts's `dirPath`).
 */

import m from 'mithril';
import {Icons} from '../../../base/semantic_icons';
import type {ColumnRenderers} from '../../../components/widgets/datagrid/column_renderers';
import {idColumnRenderers} from '../../../components/widgets/datagrid/column_renderers';
import type {Trace} from '../../../public/trace';
import type {SqlValue} from '../../../trace_processor/query_result';
import {Anchor} from '../../../widgets/anchor';
import type {DuneGraphController} from '../controller';
import {dirPathLabel} from '../model/dir_tree';
import type {NodeId} from '../model/graph';
import {
  DUNE_DIR_ID_COLUMN,
  DUNE_DIR_TABLE,
  DUNE_NODE_ID_COLUMN,
  DUNE_NODE_TABLE,
} from '../sql/dune_tables';
import {decorateNode, kindChip} from './node_display';
import {nodeToggleButton} from './node_tree_actions';

/**
 * Every column name whose value IS a `dune_node.node_id`, in the order to
 * prefer them - `node_id` itself, off `dune_node` and the per-kind detail
 * tables, then the `src` / `dst` endpoints of `dune_edge` and of every relation
 * function.
 *
 * One list, because a query written for one surface should not need rewriting
 * for the other: the query page reads it to decide which cells become chips
 * (`query_results.ts`), and both Data Explorer charts read it to pick the
 * column they map rows through (`chart_node_column.ts`).
 */
export const DUNE_NODE_ID_COLUMNS: readonly string[] = [
  DUNE_NODE_ID_COLUMN,
  'src',
  'dst',
];

/**
 * Every column name whose value IS a `dune_dir.dir_id`.
 *
 * `dune_dir`'s own key is spelled `dir_id`, and its parent link
 * `parent_dir_id`, precisely so that `SELECT * FROM dune_dir` chips: a bare
 * `id` / `parent_id` would be far too generic to chip on sight (any
 * `SELECT * FROM slice` has one). `parent_dir_id` is the directory analogue of
 * `src` / `dst` on the node side. A list rather than the bare name because the
 * query page's chip plumbing takes it exactly as it takes
 * {@link DUNE_NODE_ID_COLUMNS} (see query_results.ts).
 *
 * Not offered to the Data Explorer's charts (`explorer/chart_node_column.ts`):
 * both of those map each row onto a *graph node*, and a directory is not one,
 * so a chart pointed at `dir_id` would draw nothing.
 */
export const DUNE_DIR_ID_COLUMNS: readonly string[] = [
  DUNE_DIR_ID_COLUMN,
  'parent_dir_id',
];

/**
 * A node's label as a link that jumps to its slice on the timeline. The icon
 * marks it as a selection-changing link, as everywhere else in the UI.
 *
 * `title` overrides the default tooltip, for a caller showing an abbreviated
 * label that wants the hover to say what was abbreviated away - more use than
 * restating what the icon already conveys (see the directory explorer's member
 * rows).
 */
export function nodeAnchor(
  controller: DuneGraphController,
  node: NodeId,
  label: string,
  title: string = 'Go to slice on the timeline',
): m.Children {
  return m(
    Anchor,
    {
      icon: Icons.UpdateSelection,
      title,
      onclick: () => void controller.goToNode(node),
    },
    label,
  );
}

/**
 * A bare slice id as the same link, for a slice that is *not* one of our
 * nodes' - a `slice_id` cell whose id maps to no node, or any id at all while
 * the graph isn't loaded. No chip and no toggle, since there is no node to
 * colour or to add; just the jump.
 *
 * The controller does the jumping rather than `trace.selection` directly: while
 * the Dune workspace is showing, the slice's real track isn't in it, so the
 * scroll would silently no-op (see `controller.goToSlice`).
 */
export function sliceAnchor(
  controller: DuneGraphController,
  sliceId: number,
  label: string,
): m.Children {
  return m(
    Anchor,
    {
      icon: Icons.UpdateSelection,
      title: 'Go to slice on the timeline',
      onclick: () => void controller.goToSlice(sliceId),
    },
    label,
  );
}

/**
 * Overrides for how a node's chip is labelled.
 *
 * Only for a caller that already knows a shorter, unambiguous label *because of
 * where it is drawing the row* - a directory tree, whose rows sit under a
 * heading that supplies the part it drops. Everywhere else a node has one label
 * and this is left empty, so the chip stays identical across the query tab, the
 * selection panel and every DataGrid.
 */
interface NodeChipOptions {
  // Shown instead of the node's own display text. The kind chip and the
  // build/code icon are unaffected: they say what *kind* of thing this is and
  // where its path lives, which an abbreviation doesn't change.
  readonly label?: string;
  // The link's tooltip. Pass the unabbreviated label whenever `label` is set -
  // an abbreviated row that can't be expanded on hover has lost information.
  readonly title?: string;
}

/**
 * A node as a coloured kind chip plus its label, linking to its slice. A dep's
 * path additionally gets a leading build/code icon (its `_build/<dir>/` prefix
 * folded into the icon tooltip); a rule shows its bare id.
 */
function renderNodeChip(
  controller: DuneGraphController,
  node: NodeId,
  opts: NodeChipOptions = {},
): m.Children {
  const {graph} = controller;
  const {icon, text} = decorateNode(graph, node);
  return m(
    'span.pf-dune-graph__node-cell',
    kindChip(graph.kindOf(node), graph.healthOf(node)),
    icon,
    nodeAnchor(controller, node, opts.label ?? text, opts.title),
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
  opts: NodeChipOptions = {},
): m.Children {
  const node = nodeForCellValue(controller, value);
  if (node === undefined) return value === null ? '' : String(value);
  return renderNodeChip(controller, node, opts);
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
 * A directory's path as a link that selects its `gen-rules` span - the
 * directory counterpart of {@link nodeAnchor}, over the second selection
 * channel (see controller.ts's goToDir).
 *
 * The tooltip says what the link *tries* to do, because a directory dune
 * generated no rules for has no span to select and the click is then a no-op.
 * Every directory reached from a `dir_id` cell has a row in `dune_dir`; only
 * some of them have a span.
 */
export function dirAnchor(
  controller: DuneGraphController,
  dirId: number,
  label: string,
  title: string = "Go to this directory's gen-rules span on the timeline",
): m.Children {
  return m(
    Anchor,
    {
      icon: Icons.UpdateSelection,
      title,
      onclick: () => void controller.goToDir(dirId),
    },
    label,
  );
}

/**
 * The directory a cell value names, as its path, or undefined when it names
 * none - a non-numeric (or NULL) cell, an id no directory has, or any id at all
 * before the SQL mirror is built (which is what holds the paths - see
 * `controller.dirPath`).
 */
export function dirPathForCellValue(
  controller: DuneGraphController,
  value: SqlValue,
): string | undefined {
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    return undefined;
  }
  return controller.dirPath(Number(value));
}

/**
 * A directory-id cell as a chip, falling back to the raw value exactly as
 * {@link renderNodeCell} does.
 *
 * No ＋/－ action beside it, unlike the node cell: a directory is not a graph
 * node, so there is nothing to add to the graph.
 */
export function renderDirCell(
  controller: DuneGraphController,
  value: SqlValue,
): m.Children {
  const path = dirPathForCellValue(controller, value);
  if (path === undefined) return value === null ? '' : String(value);
  return m(
    'span.pf-dune-graph__node-cell',
    m('span.pf-dune-graph__chip.pf-dune-graph__chip--dir', 'dir'),
    dirAnchor(controller, Number(value), dirPathLabel(path)),
  );
}

/**
 * A directory-id cell as plain text - its path, so an export says what the grid
 * showed. Falls back to the raw value, NULL included, as
 * {@link nodeCellLabel} does.
 */
export function dirCellLabel(
  controller: DuneGraphController,
  value: SqlValue,
): string {
  const path = dirPathForCellValue(controller, value);
  return path === undefined ? String(value) : dirPathLabel(path);
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
 * The DataGrid renderers for a column of directory ids. No `actions`, unlike
 * the node column: a directory is not a graph node, so there is no ＋/－.
 */
function dirColumnRenderers(controller: DuneGraphController): ColumnRenderers {
  return {
    cellRenderer: (value) => renderDirCell(controller, value),
  };
}

// Teaches every DataGrid host to render a `JOINID(dune_node.node_id)` column
// as a node chip and a `JOINID(dune_dir.dir_id)` column as a directory chip,
// wherever either appears. Registrations are global and outlive a trace, so
// they go in the trace's trash; registering a table twice throws by design, so
// a leak surfaces on the next load rather than quietly capturing a dead
// controller.
export function registerIdColumnRenderers(
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
  trace.trash.use(
    idColumnRenderers.register(DUNE_DIR_TABLE, ({column}) =>
      // The same guard: `dune_dir.n_rules` is a count, not a directory.
      column === DUNE_DIR_ID_COLUMN
        ? dirColumnRenderers(controller)
        : undefined,
    ),
  );
}
