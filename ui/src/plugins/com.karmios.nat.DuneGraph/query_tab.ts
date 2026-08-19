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

import m from 'mithril';
import {classNames} from '../../base/classnames';
import {Icons} from '../../base/semantic_icons';
import {shortUuid} from '../../base/uuid';
import type {Tab} from '../../public/tab';
import type {Trace} from '../../public/trace';
import type {Row, SqlValue} from '../../trace_processor/query_result';
import type {QueryResponse} from '../../components/query_table/queries';
import {runQueryForQueryTable} from '../../components/query_table/queries';
import {DataGrid} from '../../components/widgets/datagrid/datagrid';
import type {
  ColumnDef,
  ColumnSchema,
} from '../../components/widgets/datagrid/datagrid_schema';
import {escapePath} from '../../components/widgets/datagrid/datagrid_schema';
import type {Column} from '../../components/widgets/datagrid/model';
import {InMemoryDataSource} from '../../components/widgets/datagrid/in_memory_data_source';
import {DataGridToolbar} from '../../components/widgets/datagrid/datagrid_toolbar';
import {Anchor} from '../../widgets/anchor';
import {Button, ButtonGroup} from '../../widgets/button';
import {MenuItem, PopupMenu} from '../../widgets/menu';
import {Callout} from '../../widgets/callout';
import {EmptyState} from '../../widgets/empty_state';
import {Spinner} from '../../widgets/spinner';
import {StackAuto} from '../../widgets/stack';
import type {DuneGraphController} from './controller';
import type {BuildGraph, NodeId} from './graph';
import {
  decorateNode,
  forcedByText,
  formatDurNs,
  nodePathParts,
} from './node_display';
import {
  groupBulkActions,
  nodesInGroup,
  nodeToggleButton,
} from './node_tree_actions';
import type {PathTreeItem, PathTreeLeaf, PathTreeRow} from './path_tree';
import {buildPathTree, collectGroupKeys} from './path_tree';
import {PathTreeView} from './path_tree_view';

// Columns whose value IS a graph node's id (`dune_node.node_id`), so a row maps
// back to a node without touching the trace: `node_id` itself, from `dune_node`
// and the per-kind detail tables, and the `src`/`dst` endpoints of `dune_edge`
// and of every relation function. All three render as a coloured kind chip +
// label + ＋/－ toggle.
const NODE_COL = 'node_id';
const SRC_COL = 'src';
const DST_COL = 'dst';
const CHIP_COLS = [NODE_COL, SRC_COL, DST_COL];

// A node's primary lifecycle slice (`dune_node.slice_id`), rendered as a plain
// slice link. Node-bearing too, but only indirectly: it's timing data rather
// than an identity (NULL for a node whose timing never resolved, and several
// slices share one node), and mapping it back is a query rather than a range
// check - see `nodesBySliceId`.
const SLICE_ID_COL = 'slice_id';

// The relation functions' per-endpoint detail columns, folded into the `src`/
// `dst` chips (which already show a node's kind and label); hidden by default
// when both chips are present, but still addable from the column menu.
const RELATION_COMPONENT_COLS = ['src_kind', 'src_id', 'dst_kind', 'dst_id'];

// The `dune_node` view columns folded into the `node_id` chip; hidden by default
// (when `node_id` is present) but still addable from the column menu. `slice_id`
// is deliberately not one of them - the chip no longer carries it.
const NODE_DETAIL_COLS = ['kind', 'orig_id', 'label'];

// `dune_node`'s `dune.forced_by` mirror columns (see sql_graph.ts's doc
// comment) - given special formatting as a tree leaf's extras rather than plain
// `col=value` (see `formatExtraParts`).
const FORCED_BY_KIND_COL = 'forced_by_kind';
const FORCED_BY_TARGET_COL = 'forced_by_target';

// Nanosecond-duration columns from `dune_node`/`dune_rule` (see sql_graph.ts):
// rendered as a human duration (e.g. "88ms") rather than a raw integer, in
// both table mode (`buildSchema`) and tree mode (`formatExtraValue`).
const DURATION_COLS = new Set(['dur_ns', 'action_dur_ns']);

// Preferred default "Group by" column in tree mode, most to least specific.
const GROUP_COL_PRIORITY = [NODE_COL, SRC_COL, DST_COL, SLICE_ID_COL];

// Namespaces the tree view's collapse-state keys (see `path_tree_view.ts`)
// from the selection panel's, in case both share a global key space somehow -
// harmless belt-and-braces since each panel owns its own `collapsed` Set.
const TREE_KEY_PREFIX = 'query';

const EXTRAS_OPTIONS = [
  {key: 'none', label: 'None'},
  {key: 'visible', label: 'Visible columns'},
  {key: 'all', label: 'All columns'},
] as const;
type ExtrasMode = (typeof EXTRAS_OPTIONS)[number]['key'];

// One tree-mode leaf: the node-bearing cell's value, the node it resolves to
// (absent for a dangling id), a representative source row (for the "extra
// columns" suffix), and how many result rows collapsed into this leaf (see
// `merge` in `buildNodeTreeItems`).
export interface TreeLeafEntry {
  readonly value: SqlValue;
  readonly node?: NodeId;
  readonly row: Row;
  readonly count: number;
}

/**
 * Groups `rows` into path-tree items keyed off `col` (a node-bearing column -
 * `node_id`/`src`/`dst`/`slice_id`): each row's cell resolves to a graph node via
 * `resolve` (or stays dangling, filed under its raw value as a top-level leaf
 * - dangling ids aren't paths). Null/missing cells are skipped.
 *
 * When `merge` is set, rows resolving to the same node (or, when dangling,
 * the same raw value) collapse into a single item with an incremented
 * `count`, keeping the first-seen row as the representative.
 */
export function buildNodeTreeItems(
  graph: BuildGraph,
  rows: readonly Row[],
  col: string,
  merge: boolean,
  resolve: (value: SqlValue) => NodeId | undefined,
): PathTreeItem<TreeLeafEntry>[] {
  const items: PathTreeItem<TreeLeafEntry>[] = [];
  const indexByKey = merge ? new Map<string, number>() : undefined;
  for (const row of rows) {
    const value = row[col];
    if (value === null || value === undefined) continue;
    const node = resolve(value);
    const key = node !== undefined ? `n:${node}` : `r:${String(value)}`;
    if (indexByKey !== undefined) {
      const existing = indexByKey.get(key);
      if (existing !== undefined) {
        const prev = items[existing];
        items[existing] = {
          ...prev,
          item: {...prev.item, count: prev.item.count + 1},
        };
        continue;
      }
      indexByKey.set(key, items.length);
    }
    const {dir, leaf} =
      node !== undefined
        ? nodePathParts(
            graph.kindOf(node),
            graph.labelOf(node),
            graph.dirOf(node),
          )
        : {dir: [], leaf: {sep: '', name: String(value)}};
    items.push({dir, leaf, item: {value, node, row, count: 1}});
  }
  return items;
}

/**
 * The tree leaf "extras" suffix for one row, as a list of already-formatted
 * parts (joined with ", " by the caller): a leading `×N` when `count` merged
 * more than one result row, then each of `cols` in order.
 *
 * `forced_by_kind` folds together with `forced_by_target` (wherever either falls
 * in `cols`) into one `forced by <text>` part via `forcedByText`, consuming both
 * columns - unless
 * `forced_by_kind`'s value isn't a kind `forcedByText` recognises, in which
 * case both fall back to plain `col=value` rather than silently dropping the
 * target. Every other column delegates to `formatValue` (which decides
 * per-column whether a numeric value is worth resolving to a node label).
 */
export function formatExtraParts(
  cols: readonly string[],
  row: Row,
  count: number,
  formatValue: (col: string, value: SqlValue) => string,
): string[] {
  const parts: string[] = [];
  if (count > 1) parts.push(`×${count}`);

  // Computed once so `forced_by_target` is skipped wherever it falls relative
  // to `forced_by_kind` in `cols` (a custom query could select them in either
  // order, or `target` alone).
  const foldTarget = cols.includes(FORCED_BY_KIND_COL);

  for (const col of cols) {
    if (col === FORCED_BY_TARGET_COL && foldTarget) continue;
    const value = row[col];
    if (value === null || value === undefined) continue;
    if (col === FORCED_BY_KIND_COL) {
      const target = row[FORCED_BY_TARGET_COL];
      const targetStr =
        target === null || target === undefined ? undefined : String(target);
      const text = forcedByText(String(value), targetStr);
      if (text !== undefined) {
        parts.push(`forced by ${text}`);
      } else {
        // Unrecognised kind: don't guess, show the raw column(s) instead.
        parts.push(`${col}=${formatValue(col, value)}`);
        if (target !== null && target !== undefined) {
          parts.push(
            `${FORCED_BY_TARGET_COL}=${formatValue(FORCED_BY_TARGET_COL, target)}`,
          );
        }
      }
    } else {
      parts.push(`${col}=${formatValue(col, value)}`);
    }
  }
  return parts;
}

/**
 * A details-drawer tab that runs SQL over the Dune graph tables and lets the
 * user push result rows into the graph selection - per-row via a ＋/－ toggle on
 * a node cell, or in bulk via the toolbar. Driven by the `&` omnibox mode /
 * "Dune: query graph" command, which call `runQuery`.
 *
 * Node-aware rendering (coloured chip + slice link + ＋/－ toggle) applies to
 * every column whose value is a `node_id`: `node_id` itself (dune_node and the
 * per-kind detail tables) and the `src`/`dst` endpoints of `dune_edge` and the
 * relation functions. A raw `slice_id` renders as a plain slice link.
 */
export class DuneQueryTab implements Tab {
  private loading = false;
  private error?: string;
  private response?: QueryResponse;
  private dataSource?: InMemoryDataSource;
  // Any `slice_id` cells in the result, resolved to graph nodes once per query.
  // Mapping a lifecycle slice id to its node is a query, not a JS map lookup
  // (see controller.ts), and every renderer below is synchronous - so the whole
  // column is resolved up front, in one batch. Empty unless the result actually
  // selected `slice_id`; a chip column needs no lookup at all.
  private nodesBySliceId = new Map<number, NodeId>();
  // Result rows that resolve to a known graph node, computed once per query.
  private mappable: NodeId[] = [];
  // Bumped per query so the DataGrid remounts, dropping column/sort state tied
  // to the previous result's shape and re-applying `initialColumns`.
  private queryId = 0;

  // Table/tree toggle. Sticky across queries (forced back to 'table' in
  // `render` when a result has no node-bearing column to group by).
  private view: 'table' | 'tree' = 'table';
  // The node-bearing column tree mode groups by. Reset per query only when
  // the previous choice isn't present in the new result (see `groupColFor`).
  private groupCol?: string;
  // Tree-mode display options; sticky across queries like `view`.
  private extras: ExtrasMode = 'visible';
  private mergeDuplicates = false;
  // Collapse state for the tree view's directory groups, keyed by
  // `PathTreeView`'s `groupKey(row.path, TREE_KEY_PREFIX)`. Reset per query
  // (unlike `view`/`extras`/`mergeDuplicates`) since group paths are specific
  // to one result.
  private collapsed = new Set<string>();

  constructor(
    private readonly trace: Trace,
    private readonly controller: DuneGraphController,
  ) {}

  getTitle(): string {
    const n = this.response?.totalRowCount;
    return n === undefined
      ? 'Dune query'
      : `Dune query (${n.toLocaleString()})`;
  }

  async runQuery(query: string): Promise<void> {
    this.loading = true;
    this.error = undefined;
    this.response = undefined;
    this.dataSource = undefined;
    this.mappable = [];
    this.nodesBySliceId = new Map();
    this.collapsed.clear();
    m.redraw();

    // The `dune_*` tables don't exist until the graph has been loaded and
    // mirrored (it no longer loads with the trace - see controller.ts). Say so
    // rather than letting the query come back with a bare "no such table".
    const missing = this.missingTables();
    if (missing !== undefined) {
      this.loading = false;
      this.error = missing;
      m.redraw();
      return;
    }

    const response = await runQueryForQueryTable(query, this.trace.engine);
    this.loading = false;
    if (response.error !== undefined) {
      this.error = response.error;
    } else {
      this.response = response;
      // Resolve the `slice_id` column (if any) before rendering, so the cell
      // renderers - and the CSV formatters, and the bulk actions - can stay
      // synchronous. A no-op query when the column isn't present.
      this.nodesBySliceId = await this.controller.nodesForSliceIds(
        sliceIdsIn(response, [SLICE_ID_COL]),
      );
      this.dataSource = new InMemoryDataSource(response.rows);
      this.mappable = this.mappableNodes(response);
    }
    this.queryId++;
    m.redraw();
  }

  // Why the graph tables aren't queryable right now, or undefined when they
  // are. The node tier alone is enough to run something useful (`dune_node`
  // and the per-kind detail tables), so a missing edge tier isn't a refusal -
  // a query that needs `dune_edge` gets trace processor's own error.
  private missingTables(): string | undefined {
    if (this.controller.nodeMirrorReady) return undefined;
    return this.controller.graphStep.error !== undefined
      ? `The Dune graph failed to load: ${this.controller.graphStep.error}`
      : 'The Dune graph is not loaded yet, so there are no dune_* tables to ' +
          'query. Load it from the Dune side panel (or the “Dune: load build ' +
          'graph” command) and run this again.';
  }

  render(): m.Children {
    if (this.loading) {
      return m('.pf-dune-query__status', m(Spinner), 'Running query…');
    }
    if (this.error !== undefined) {
      return m(Callout, {icon: 'error'}, this.error);
    }
    const {response, dataSource} = this;
    if (response === undefined || dataSource === undefined) {
      return m(
        EmptyState,
        {icon: 'table_view', title: 'Run a SQL query to add graph nodes'},
        "Use the '&' omnibox mode or the “Dune: query graph” command. " +
          'Query dune_node / dune_edge, per-kind detail via dune_rule / ' +
          'dune_dep / dune_rule_target (joined on node_id), every path the ' +
          'build mentions via dune_string, or a relation ' +
          'function - bounded dune_descendants/dune_ancestors(node_id, ' +
          'max_steps, step_kind), unbounded ' +
          'dune_all_descendants/dune_all_ancestors(node_id), one-hop ' +
          'dune_children/dune_parents(node_id), or forced-only ' +
          'dune_forcers/dune_forced(node_id) - any node_id / src / dst / ' +
          'slice_id column becomes addable. To see transitive forcing on a ' +
          'result, LEFT JOIN dune_forced()/dune_forcers() USING (dst).',
      );
    }

    const hasNodes = this.nodeBearingCols(response).length > 0;
    // A result that lost its node-bearing column (a new, differently-shaped
    // query) can't stay in tree mode.
    if (!hasNodes) this.view = 'table';
    return m(
      '.pf-dune-query',
      !hasNodes &&
        m(
          Callout,
          {icon: 'warning'},
          'Return a node_id, src, dst, or slice_id column to add nodes to ' +
            'the graph.',
        ),
      this.view === 'tree'
        ? this.renderTreeBody(response)
        : this.renderTableBody(response, dataSource),
    );
  }

  private renderTableBody(
    response: QueryResponse,
    dataSource: InMemoryDataSource,
  ): m.Children {
    return m(
      '.pf-dune-query__grid',
      m(DataGrid, {
        key: this.queryId,
        schema: this.buildSchema(response),
        initialColumns: this.initialColumns(response),
        data: dataSource,
        fillHeight: true,
        emptyStateMessage: 'Query returned no rows',
        showExportButton: true,
        disablePivotControls: true,
        toolbarItemsLeft: this.renderToolbarLeft(response),
        toolbarItemsRight: this.renderToolbarRight(response),
      }),
    );
  }

  // The tree view: the same toolbar content as table mode (via
  // `DataGridToolbar`, since we're not inside a `DataGrid` here) over a
  // scrollable `PathTreeView` grouping the result by `groupColFor`.
  private renderTreeBody(response: QueryResponse): m.Children {
    const col = this.groupColFor(response);
    const tree = this.buildTree(response, col);
    return [
      m(DataGridToolbar, {
        leftItems: this.renderToolbarLeft(response),
        rightItems: this.renderToolbarRight(response),
      }),
      m(
        '.pf-dune-query__tree',
        tree.length === 0
          ? m(EmptyState, {icon: 'table_view', title: 'Query returned no rows'})
          : m(PathTreeView<TreeLeafEntry>, {
              rows: tree,
              keyPrefix: TREE_KEY_PREFIX,
              collapsed: this.collapsed,
              onToggleGroup: (key) => {
                if (this.collapsed.has(key)) this.collapsed.delete(key);
                else this.collapsed.add(key);
              },
              renderLeaf: (row) => this.renderTreeLeaf(response, col, row),
              groupActions: (row) =>
                groupBulkActions(this.controller, nodesInGroup(row)),
            }),
      ),
    ];
  }

  private buildTree(
    response: QueryResponse,
    col: string,
  ): PathTreeRow<TreeLeafEntry>[] {
    return buildPathTree(
      buildNodeTreeItems(
        this.controller.graph,
        response.rows,
        col,
        this.mergeDuplicates,
        (v) => this.nodeForValue(col, v),
      ),
    );
  }

  // The node-bearing column tree mode currently groups by: the sticky
  // `groupCol` when it's still a candidate for this result, else the highest-
  // priority candidate present (see `GROUP_COL_PRIORITY`). Only called where
  // `nodeBearingCols` is known to be non-empty.
  private groupColFor(response: QueryResponse): string {
    const cols = this.nodeBearingCols(response);
    if (this.groupCol !== undefined && cols.includes(this.groupCol)) {
      return this.groupCol;
    }
    return GROUP_COL_PRIORITY.find((c) => cols.includes(c)) ?? cols[0];
  }

  private renderTreeLeaf(
    response: QueryResponse,
    col: string,
    row: PathTreeLeaf<TreeLeafEntry>,
  ): m.Children {
    const {item: entry, prefix, label} = row;
    const {node, value} = entry;
    return m(
      '.pf-dune-query__tree-row',
      node !== undefined && this.renderKindChip(node),
      m(
        'span.pf-dune-graph__ref-label',
        prefix !== '' && m('span.pf-dune-graph__ref-prefix', prefix),
        node !== undefined ? this.nodeAnchor(node, label) : label,
      ),
      this.renderTreeExtras(response, entry),
      this.renderNodeToggle(col, value),
    );
  }

  // Muted "×N" (when duplicates were merged) plus, when enabled, the row's
  // other columns - `forced_by_*` specially formatted (see `formatExtraParts`),
  // the rest as "col=value" text, a node-bearing sibling column (e.g. `dst` when
  // grouping by `src`) rendering via its own node label rather than a raw id.
  private renderTreeExtras(
    response: QueryResponse,
    entry: TreeLeafEntry,
  ): m.Children {
    const parts = formatExtraParts(
      this.extraCols(response),
      entry.row,
      entry.count,
      (col, value) => this.formatExtraValue(col, value),
    );
    if (parts.length === 0) return undefined;
    const text = parts.join(', ');
    return m('span.pf-dune-query__extras', {title: text}, text);
  }

  // A `dur_ns`/`action_dur_ns` column renders as a human duration; a
  // node-bearing column (e.g. `dst` when grouping by `src`) as its node's label;
  // anything else as the raw value. `nodeLabelFor` resolves nothing for a column
  // that isn't node-bearing, so an arbitrary numeric column (a `distance`, say)
  // can't false-positive its way into a label.
  private formatExtraValue(col: string, value: SqlValue): string {
    if (DURATION_COLS.has(col)) {
      const text = this.durationText(value);
      if (text !== undefined) return text;
    }
    return this.nodeLabelFor(col, value) ?? String(value);
  }

  // `value` (a `dur_ns`-shaped column) as a human duration, or undefined if
  // it isn't a number/bigint (e.g. NULL).
  private durationText(value: SqlValue): string | undefined {
    if (typeof value !== 'number' && typeof value !== 'bigint') {
      return undefined;
    }
    return formatDurNs(Number(value));
  }

  // Columns shown as a tree leaf's "extras" suffix: every result column
  // except the one it's grouped by, minus the table's default-hidden columns
  // when `extras` is 'visible' (i.e. exactly what the table shows by
  // default). 'all' keeps everything else; 'none' shows nothing.
  private extraCols(response: QueryResponse): string[] {
    if (this.extras === 'none') return [];
    const groupCol = this.groupColFor(response);
    const hidden =
      this.extras === 'visible'
        ? this.defaultHiddenCols(response)
        : new Set<string>();
    return response.columns.filter((c) => c !== groupCol && !hidden.has(c));
  }

  // Toolbar controls right of the row-count/SQL echo, shared verbatim between
  // table mode (as `DataGrid`'s `toolbarItemsRight`) and tree mode (in our own
  // `DataGridToolbar`) so switching views doesn't move any other control.
  private renderToolbarRight(response: QueryResponse): m.Children {
    if (this.nodeBearingCols(response).length === 0) return undefined;
    const isTree = this.view === 'tree';
    return [
      this.renderViewToggle(),
      isTree && this.renderExpandCollapseButtons(response),
      isTree && this.renderTreeOptionsMenu(response),
      this.renderGraphMenu(response),
    ];
  }

  private renderViewToggle(): m.Children {
    const isTree = this.view === 'tree';
    return m(
      ButtonGroup,
      m(Button, {
        label: 'Table',
        icon: 'table_view',
        active: !isTree,
        tooltip: 'Show results as a flat table',
        onclick: () => {
          this.view = 'table';
        },
      }),
      m(Button, {
        label: 'Tree',
        icon: 'account_tree',
        active: isTree,
        tooltip: 'Group results by a node column into a directory tree',
        onclick: () => {
          this.view = 'tree';
        },
      }),
    );
  }

  // A "Group by: <current>" submenu nested in Tree options; only shown when
  // the result has more than one node-bearing column (e.g. a
  // `dune_edge`-shaped result offers `src`/`dst`).
  private renderGroupBySubmenu(response: QueryResponse): m.Children {
    const cols = this.nodeBearingCols(response);
    if (cols.length <= 1) return undefined;
    const current = this.groupColFor(response);
    return m(
      MenuItem,
      {label: `Group by: ${current}`, icon: 'view_column'},
      cols.map((col) =>
        m(MenuItem, {
          label: col,
          icon: col === current ? 'check' : undefined,
          onclick: () => {
            this.groupCol = col;
          },
        }),
      ),
    );
  }

  private renderExpandCollapseButtons(response: QueryResponse): m.Children {
    return [
      m(Button, {
        icon: 'unfold_more',
        tooltip: 'Expand all groups',
        onclick: () => this.collapsed.clear(),
      }),
      m(Button, {
        icon: 'unfold_less',
        tooltip: 'Collapse all groups',
        onclick: () => {
          const col = this.groupColFor(response);
          this.collapsed = new Set(
            collectGroupKeys(this.buildTree(response, col), TREE_KEY_PREFIX),
          );
        },
      }),
    ];
  }

  private renderTreeOptionsMenu(response: QueryResponse): m.Children {
    return m(
      PopupMenu,
      {trigger: m(Button, {icon: 'tune', title: 'Tree options'})},
      this.renderGroupBySubmenu(response),
      m(
        MenuItem,
        {label: 'Extra columns', icon: 'view_column'},
        EXTRAS_OPTIONS.map(({key, label}) =>
          m(MenuItem, {
            label,
            icon: this.extras === key ? 'check' : undefined,
            onclick: () => {
              this.extras = key;
            },
          }),
        ),
      ),
      m(MenuItem, {
        label: 'Merge duplicate nodes',
        icon: this.mergeDuplicates ? 'check_box' : 'check_box_outline_blank',
        closePopupOnClick: false,
        onclick: () => {
          this.mergeDuplicates = !this.mergeDuplicates;
        },
      }),
    );
  }

  // Left toolbar group: the row count / time (as the core results table shows),
  // then the query itself in a filler that spans the gap to the right-aligned
  // controls (single line, full text on hover).
  private renderToolbarLeft(response: QueryResponse): m.Children {
    return [
      m(
        'span.pf-dune-query__count',
        `Returned ${response.totalRowCount.toLocaleString()} rows in ` +
          `${response.durationMs.toLocaleString()} ms`,
      ),
      m(
        StackAuto,
        m('code.pf-dune-query__sql', {title: response.query}, response.query),
      ),
    ];
  }

  // The bulk add/remove actions, collapsed under a "Graph" dropdown.
  private renderGraphMenu(response: QueryResponse): m.Children {
    return m(
      PopupMenu,
      {
        trigger: m(Button, {
          label: 'Graph',
          icon: 'account_tree',
          rightIcon: Icons.ContextMenu,
        }),
      },
      this.graphMenuItems(response),
    );
  }

  // A result with both `src` and `dst` chips gets a pair of items per side
  // ("Add all src" / "Add all dst" …); anything else gets a single pair over
  // every mapped node.
  private graphMenuItems(response: QueryResponse): m.Children[] {
    const chip = new Set(this.chipCols(response));
    if (chip.has(SRC_COL) && chip.has(DST_COL)) {
      return [
        ...this.addRemoveItems('src', this.columnNodes(response, SRC_COL)),
        ...this.addRemoveItems('dst', this.columnNodes(response, DST_COL)),
      ];
    }
    return this.addRemoveItems(undefined, this.mappable);
  }

  private addRemoveItems(
    which: 'src' | 'dst' | undefined,
    nodes: readonly NodeId[],
  ): m.Children[] {
    const suffix = which === undefined ? '' : ` ${which}`;
    return [
      m(MenuItem, {
        label: `Add all${suffix}`,
        icon: 'add',
        onclick: () => this.controller.addToGraph(nodes),
      }),
      m(MenuItem, {
        label: `Remove all${suffix}`,
        icon: 'remove',
        onclick: () => this.controller.removeFromGraph(nodes),
      }),
    ];
  }

  private buildSchema(response: QueryResponse): ColumnSchema {
    const chipCols = new Set(this.chipCols(response));
    const schema: ColumnSchema = {};
    for (const col of response.columns) {
      schema[escapePath(col)] =
        col === SLICE_ID_COL
          ? this.sliceLinkDef(col)
          : chipCols.has(col)
            ? this.chipDef(col)
            : DURATION_COLS.has(col)
              ? this.durationDef(col)
              : {title: col};
    }
    return schema;
  }

  // A raw `slice_id`: the value as a slice link (+ toggle). The core query table
  // only links a column literally named `id` on slice-ish results (it ignores
  // the JOINID type), so we render the link ourselves.
  private sliceLinkDef(col: string): ColumnDef {
    return {
      title: col,
      cellRenderer: (value) => this.renderSliceCell(value),
      actions: (value) => this.renderNodeToggle(col, value),
    };
  }

  // A `node_id` / `src` / `dst` column: the node as a coloured kind chip + label,
  // linking to its slice (+ toggle). The value is the node id (exported as the
  // node's label).
  private chipDef(col: string): ColumnDef {
    return {
      title: col,
      cellRenderer: (value) => this.renderNodeChip(col, value),
      cellFormatter: (value) => this.nodeLabelFor(col, value) ?? String(value),
      actions: (value) => this.renderNodeToggle(col, value),
    };
  }

  // A `dur_ns`/`action_dur_ns` column: rendered (and exported) as a human
  // duration rather than a raw nanosecond integer.
  private durationDef(col: string): ColumnDef {
    return {
      title: col,
      cellRenderer: (value) => this.durationText(value) ?? '',
      cellFormatter: (value) => this.durationText(value) ?? String(value),
    };
  }

  // Default visible columns: every result column that isn't folded into a chip
  // (see `defaultHiddenCols`). Returns undefined - "show all, in order" - when
  // nothing is hidden.
  private initialColumns(response: QueryResponse): Column[] | undefined {
    const hidden = this.defaultHiddenCols(response);
    if (hidden.size === 0) return undefined;
    return response.columns
      .filter((c) => !hidden.has(c))
      .map((field) => ({id: shortUuid(), field: escapePath(field)}));
  }

  // Columns hidden by default because a chip column supersedes them: the
  // `node_id` chip folds in `dune_node`'s kind/orig_id/label, and the `src`/`dst`
  // chips fold in the relation functions' per-endpoint kind/id. Only applied when
  // the superseding chip is present, so an explicit `SELECT kind, label ...`
  // (no `node_id`) still shows them.
  private defaultHiddenCols(response: QueryResponse): Set<string> {
    const present = new Set(response.columns);
    const chip = new Set(this.chipCols(response));
    const hidden = new Set<string>();
    if (chip.has(NODE_COL)) {
      for (const c of NODE_DETAIL_COLS) if (present.has(c)) hidden.add(c);
    }
    if (chip.has(SRC_COL) && chip.has(DST_COL)) {
      for (const c of RELATION_COMPONENT_COLS) {
        if (present.has(c)) hidden.add(c);
      }
    }
    return hidden;
  }

  // The slice_id value as a link that jumps to the slice on the timeline (when
  // it resolves to a graph node), else the plain value.
  private renderSliceCell(value: SqlValue): m.Children {
    const node = this.nodeForValue(SLICE_ID_COL, value);
    const text = value === null ? '' : String(value);
    if (node === undefined) return text;
    return this.nodeAnchor(node, text);
  }

  // A node as a coloured kind chip plus its label, linking to its slice. A dep's
  // path additionally gets a leading build/code icon (its `_build/<dir>/` prefix
  // folded into the icon tooltip); a rule shows its bare id. Falls back to the
  // raw value when it isn't a node of the current graph.
  private renderNodeChip(col: string, value: SqlValue): m.Children {
    const node = this.nodeForValue(col, value);
    if (node === undefined) return value === null ? '' : String(value);
    const {icon, text} = decorateNode(this.controller.graph, node);
    return m(
      'span.pf-dune-query__node',
      this.renderKindChip(node),
      icon,
      this.nodeAnchor(node, text),
    );
  }

  // The node's kind as a coloured chip, reusing the graph panel's styling (a
  // global class).
  private renderKindChip(node: NodeId): m.Children {
    const kind = this.controller.graph.kindOf(node);
    return m(
      'span',
      {
        class: classNames(
          'pf-dune-graph__chip',
          `pf-dune-graph__chip--${kind}`,
        ),
      },
      kind,
    );
  }

  private nodeAnchor(node: NodeId, label: string): m.Children {
    return m(
      Anchor,
      {
        icon: Icons.UpdateSelection,
        title: 'Go to slice on the timeline',
        onclick: () => void this.controller.goToNode(node),
      },
      label,
    );
  }

  // ＋/－ toggle for a node cell: adds or removes that node, reflecting current
  // membership. Absent when the cell doesn't name a node of the current graph.
  private renderNodeToggle(col: string, value: SqlValue): m.Children {
    const node = this.nodeForValue(col, value);
    if (node === undefined) return undefined;
    return nodeToggleButton(this.controller, node);
  }

  // Every distinct graph node reachable from the result's node-bearing columns
  // (deduped across node_id/src/dst/slice_id), for the "Add all" bulk action.
  private mappableNodes(response: QueryResponse): NodeId[] {
    return this.columnNodes(response, ...this.nodeBearingCols(response));
  }

  // Distinct graph nodes drawn from the given node-bearing columns, deduped by
  // node. Used for both the whole-result and per-src/dst bulk actions.
  private columnNodes(response: QueryResponse, ...cols: string[]): NodeId[] {
    const seen = new Set<NodeId>();
    for (const row of response.rows) {
      for (const col of cols) {
        const node = this.nodeForValue(col, row[col]);
        if (node !== undefined) seen.add(node);
      }
    }
    return [...seen];
  }

  // Chip columns present in this result: `dune_node`'s `node_id` (also on the
  // per-kind detail tables) and the `src`/`dst` endpoints of `dune_edge` and the
  // relation functions.
  private chipCols(response: QueryResponse): string[] {
    return CHIP_COLS.filter((c) => response.columns.includes(c));
  }

  // All node-bearing columns: the chip columns plus a raw `slice_id`. Drives the
  // "N nodes in result" bulk actions.
  private nodeBearingCols(response: QueryResponse): string[] {
    const cols = this.chipCols(response);
    if (response.columns.includes(SLICE_ID_COL)) cols.push(SLICE_ID_COL);
    return cols;
  }

  private nodeLabelFor(col: string, value: SqlValue): string | undefined {
    const node = this.nodeForValue(col, value);
    return node === undefined ? undefined : this.controller.graph.labelOf(node);
  }

  // The graph node a cell in `col` names. A chip column's value *is* the node id,
  // so resolving it is a range check against the current graph (see
  // `controller.nodeForNodeId`); a `slice_id` comes out of the batch resolved in
  // `runQuery`. Any other column resolves to nothing - a bare integer elsewhere
  // in the result (a `distance`, a `dur_ns`) is not an id.
  private nodeForValue(col: string, value: SqlValue): NodeId | undefined {
    if (typeof value !== 'number' && typeof value !== 'bigint') {
      return undefined;
    }
    const id = Number(value);
    if (col === SLICE_ID_COL) return this.nodesBySliceId.get(id);
    return CHIP_COLS.includes(col)
      ? this.controller.nodeForNodeId(id)
      : undefined;
  }
}

// Every distinct slice id in `cols` of the result - the batch handed to the
// controller to resolve into nodes once per query.
function sliceIdsIn(
  response: QueryResponse,
  cols: readonly string[],
): number[] {
  const ids = new Set<number>();
  for (const row of response.rows) {
    for (const col of cols) {
      const value = row[col];
      if (typeof value === 'number' || typeof value === 'bigint') {
        ids.add(Number(value));
      }
    }
  }
  return [...ids];
}
