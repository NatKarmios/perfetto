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
import type {GraphNode} from './graph';
import {nodeKey, nodeLabel} from './graph';
import {
  decorateDepPath,
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

// Columns whose value is a build-dep/exec-rule slice id, so a row maps back to
// a graph node. A raw `slice_id` renders as a plain slice link; the "chip"
// columns render as a coloured kind chip + label + slice link. `node` comes
// from the dune_node view, `src`/`dst` from the dune_edge view, and `src`/`dst`
// are also synthesized from the relation functions' `*_slice_id` (see runQuery).
const SLICE_ID_COL = 'slice_id';
const NODE_COL = 'node';
const SRC_COL = 'src';
const DST_COL = 'dst';
const CHIP_COLS = [NODE_COL, SRC_COL, DST_COL];

// The relation functions expose the src/dst node as separate `*_slice_id` /
// `*_kind` / `*_id` columns rather than a single `src`/`dst`; we fold them into
// chips (the cell resolves its node from the slice id alone - the DataGrid
// projects rows to opaque aliases, so a cell renderer can't read siblings).
const SRC_SLICE_COL = 'src_slice_id';
const DST_SLICE_COL = 'dst_slice_id';

// The raw relation component columns folded into the `src`/`dst` chips; hidden
// by default (when both chips are present) but still addable from the column
// menu. Also covers the `dune_edge` view's `src_node_id`/`dst_node_id`.
const RELATION_COMPONENT_COLS = [
  'src_node_id',
  SRC_SLICE_COL,
  'src_kind',
  'src_id',
  'dst_node_id',
  DST_SLICE_COL,
  'dst_kind',
  'dst_id',
];

// The `dune_node` view columns folded into the `node` chip; hidden by default
// (when `node` is present) but still addable from the column menu.
const NODE_DETAIL_COLS = ['kind', 'orig_id', SLICE_ID_COL, 'label'];

// `dune_node`'s synthetic dense id and its `dune.forced_by` mirror columns
// (see sql_graph.ts's doc comment) - given special formatting as a tree
// leaf's extras rather than plain `col=value` (see `formatExtraParts`).
const NODE_ID_COL = 'node_id';
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
  readonly node?: GraphNode;
  readonly row: Row;
  readonly count: number;
}

/**
 * Groups `rows` into path-tree items keyed off `col` (a node-bearing column -
 * `node`/`src`/`dst`/`slice_id`): each row's cell resolves to a graph node via
 * `resolve` (or stays dangling, filed under its raw value as a top-level leaf
 * - dangling ids aren't paths). Null/missing cells are skipped.
 *
 * When `merge` is set, rows resolving to the same node (or, when dangling,
 * the same raw value) collapse into a single item with an incremented
 * `count`, keeping the first-seen row as the representative.
 */
export function buildNodeTreeItems(
  rows: readonly Row[],
  col: string,
  merge: boolean,
  resolve: (value: SqlValue) => GraphNode | undefined,
): PathTreeItem<TreeLeafEntry>[] {
  const items: PathTreeItem<TreeLeafEntry>[] = [];
  const indexByKey = merge ? new Map<string, number>() : undefined;
  for (const row of rows) {
    const value = row[col];
    if (value === null || value === undefined) continue;
    const node = resolve(value);
    const key =
      node !== undefined
        ? `n:${nodeKey(node.kind, node.id)}`
        : `r:${String(value)}`;
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
            node.kind,
            node.id,
            node.kind === 'rule' ? node.dir : undefined,
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
 * `node_id` renders bare (`#1`, not `node_id=1`); `forced_by_kind` folds
 * together with `forced_by_target` (wherever either falls in `cols`) into one
 * `forced by <text>` part via `forcedByText`, consuming both columns - unless
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
    if (col === NODE_ID_COL) {
      parts.push(`#${String(value)}`);
    } else if (col === FORCED_BY_KIND_COL) {
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
 * Node-aware rendering (coloured chip + slice link + ＋/－ toggle) applies to the
 * `node` column (dune_node view), the `src`/`dst` columns (dune_edge view), and
 * the `src`/`dst` pair synthesized from the relation functions
 * (`dune_descendants` / `dune_ancestors`). A raw `slice_id` renders as a plain
 * slice link.
 */
export class DuneQueryTab implements Tab {
  private loading = false;
  private error?: string;
  private response?: QueryResponse;
  private dataSource?: InMemoryDataSource;
  // Whether the result carries `src_slice_id`/`dst_slice_id` (relation shape).
  private isRelation = false;
  // Result rows that resolve to a known graph node, computed once per query.
  private mappable: GraphNode[] = [];
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
    this.isRelation = false;
    this.collapsed.clear();
    m.redraw();

    const response = await runQueryForQueryTable(query, this.trace.engine);
    this.loading = false;
    if (response.error !== undefined) {
      this.error = response.error;
    } else {
      this.response = response;
      this.isRelation =
        response.columns.includes(SRC_SLICE_COL) &&
        response.columns.includes(DST_SLICE_COL);
      // Back the synthetic chip columns with their slice ids so each cell can
      // resolve its node from its own value.
      if (this.isRelation) {
        for (const row of response.rows) {
          row[SRC_COL] = row[SRC_SLICE_COL];
          row[DST_COL] = row[DST_SLICE_COL];
        }
      }
      this.dataSource = new InMemoryDataSource(response.rows);
      this.mappable = this.mappableNodes(response);
    }
    this.queryId++;
    m.redraw();
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
          'dune_dep / dune_rule_target (joined on node_id), or a relation ' +
          'function - bounded dune_descendants/dune_ancestors(node_id, ' +
          'max_steps, step_kind), unbounded ' +
          'dune_all_descendants/dune_all_ancestors(node_id), one-hop ' +
          'dune_children/dune_parents(node_id), or forced-only ' +
          'dune_forcers/dune_forced(node_id) - any node / src / dst / slice_id ' +
          'column becomes addable. To see transitive forcing on a result, ' +
          'LEFT JOIN dune_forced()/dune_forcers() USING (dst_node_id).',
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
          'Return a node, src, dst, or slice_id column to add nodes to the ' +
            'graph.',
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
              renderLeaf: (row) => this.renderTreeLeaf(response, row),
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
      buildNodeTreeItems(response.rows, col, this.mergeDuplicates, (v) =>
        this.nodeForSliceValue(v),
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
    row: PathTreeLeaf<TreeLeafEntry>,
  ): m.Children {
    const {item: entry, prefix, label} = row;
    const {node, value} = entry;
    return m(
      '.pf-dune-query__tree-row',
      node !== undefined &&
        m(
          'span',
          {
            class: classNames(
              'pf-dune-graph__chip',
              `pf-dune-graph__chip--${node.kind}`,
            ),
          },
          node.kind,
        ),
      m(
        'span.pf-dune-graph__ref-label',
        prefix !== '' && m('span.pf-dune-graph__ref-prefix', prefix),
        node !== undefined ? this.nodeAnchor(node, label) : label,
      ),
      this.renderTreeExtras(response, entry),
      this.renderNodeToggle(value),
    );
  }

  // Muted "×N" (when duplicates were merged) plus, when enabled, the row's
  // other columns - `node_id`/`forced_by_*` specially formatted (see
  // `formatExtraParts`), the rest as "col=value" text, a node-bearing sibling
  // column (e.g. `dst` when grouping by `src`) rendering via its own node
  // label rather than a raw slice id.
  private renderTreeExtras(
    response: QueryResponse,
    entry: TreeLeafEntry,
  ): m.Children {
    const nodeBearing = new Set(this.nodeBearingCols(response));
    const parts = formatExtraParts(
      this.extraCols(response),
      entry.row,
      entry.count,
      (col, value) => this.formatExtraValue(col, value, nodeBearing.has(col)),
    );
    if (parts.length === 0) return undefined;
    const text = parts.join(', ');
    return m('span.pf-dune-query__extras', {title: text}, text);
  }

  // A `dur_ns`/`action_dur_ns` column renders as a human duration; otherwise,
  // only resolves `value` through a node label when `col` is itself a
  // node-bearing column (e.g. `dst` when grouping by `src`) - `nodeLabelFor`
  // treats any number/bigint as a slice id, so calling it on an arbitrary
  // numeric column (a `distance`, say) risks a false-positive match against an
  // unrelated slice id.
  private formatExtraValue(
    col: string,
    value: SqlValue,
    nodeBearing: boolean,
  ): string {
    if (DURATION_COLS.has(col)) {
      const text = this.durationText(value);
      if (text !== undefined) return text;
    }
    const label = nodeBearing ? this.nodeLabelFor(value) : undefined;
    return label ?? String(value);
  }

  // `value` (a `dur_ns`-shaped column) as a human duration, or undefined if
  // it isn't a number/bigint (e.g. NULL).
  private durationText(value: SqlValue): string | undefined {
    if (typeof value !== 'number' && typeof value !== 'bigint') return undefined;
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
    return [
      ...this.chipCols(response).filter(
        (c) => c !== groupCol && !response.columns.includes(c),
      ),
      ...response.columns.filter((c) => c !== groupCol && !hidden.has(c)),
    ];
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
    nodes: readonly GraphNode[],
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
    // Synthesized chip columns (relation src/dst) aren't in response.columns.
    for (const col of chipCols) {
      if (!response.columns.includes(col)) {
        schema[escapePath(col)] = this.chipDef(col);
      }
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
      actions: (value) => this.renderNodeToggle(value),
    };
  }

  // A `node` / `src` / `dst` column: the node as a coloured kind chip + label,
  // linking to its slice (+ toggle). The value is a slice id (exported as the
  // node's label).
  private chipDef(col: string): ColumnDef {
    return {
      title: col,
      cellRenderer: (value) => this.renderNodeChip(value),
      cellFormatter: (value) => this.nodeLabelFor(value) ?? String(value),
      actions: (value) => this.renderNodeToggle(value),
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

  // Default visible columns: lead with any synthesized chip columns (the
  // relation `src`/`dst`, which aren't in `response.columns`), then every result
  // column that isn't folded into a chip (see `defaultHiddenCols`). Returns
  // undefined - "show all, in order" - when nothing is synthesized or hidden.
  private initialColumns(response: QueryResponse): Column[] | undefined {
    const hidden = this.defaultHiddenCols(response);
    const synthesized = this.chipCols(response).filter(
      (c) => !response.columns.includes(c),
    );
    if (hidden.size === 0 && synthesized.length === 0) return undefined;
    const fields = [
      ...synthesized,
      ...response.columns.filter((c) => !hidden.has(c)),
    ];
    return fields.map((field) => ({id: shortUuid(), field: escapePath(field)}));
  }

  // Columns hidden by default because a chip column supersedes them: the
  // `node` chip folds in `dune_node`'s kind/orig_id/slice_id/label; the
  // `src`/`dst` chips fold in the relation components + the `dune_edge` view's
  // raw node_id endpoints. Only applied when the superseding chip is present, so
  // an explicit `SELECT slice_id ...` (no `node`) still shows it.
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
    const node = this.nodeForSliceValue(value);
    const text = value === null ? '' : String(value);
    if (node === undefined) return text;
    return this.nodeAnchor(node, text);
  }

  // A src/dst node as a coloured kind chip plus its label, linking to the slice.
  // A dep's path additionally gets a leading build/code icon (its `_build/<dir>/`
  // prefix folded into the icon tooltip); a rule shows its bare id. Falls back to
  // the raw slice id when the node isn't known.
  private renderNodeChip(value: SqlValue): m.Children {
    const node = this.nodeForSliceValue(value);
    if (node === undefined) return value === null ? '' : String(value);
    const {icon, text} =
      node.kind === 'dep'
        ? decorateDepPath(node.id)
        : {icon: undefined, text: nodeLabel(node)};
    return m(
      'span.pf-dune-query__node',
      m(
        'span',
        {
          // Reuses the graph panel's chip styling (a global class).
          class: classNames(
            'pf-dune-graph__chip',
            `pf-dune-graph__chip--${node.kind}`,
          ),
        },
        node.kind,
      ),
      icon,
      this.nodeAnchor(node, text),
    );
  }

  private nodeAnchor(node: GraphNode, label: string): m.Children {
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
  // membership. Absent when the cell's slice id isn't a graph node.
  private renderNodeToggle(value: SqlValue): m.Children {
    const node = this.nodeForSliceValue(value);
    if (node === undefined) return undefined;
    return nodeToggleButton(this.controller, node);
  }

  // Every distinct graph node reachable from the result's node-bearing columns
  // (deduped across node/src/dst/slice_id), for the "Add all" bulk action.
  private mappableNodes(response: QueryResponse): GraphNode[] {
    return this.columnNodes(response, ...this.nodeBearingCols(response));
  }

  // Distinct graph nodes drawn from the given (slice-id-valued) columns, deduped
  // by node key. Used for both the whole-result and per-src/dst bulk actions.
  private columnNodes(response: QueryResponse, ...cols: string[]): GraphNode[] {
    const seen = new Set<string>();
    const nodes: GraphNode[] = [];
    for (const row of response.rows) {
      for (const col of cols) {
        const node = this.nodeForSliceValue(row[col]);
        if (node === undefined) continue;
        const key = nodeKey(node.kind, node.id);
        if (seen.has(key)) continue;
        seen.add(key);
        nodes.push(node);
      }
    }
    return nodes;
  }

  // Chip columns present in this result: the dune_node view's `node`, the
  // dune_edge view's `src`/`dst`, and the `src`/`dst` synthesized from the
  // relation functions' `*_slice_id` (see runQuery).
  private chipCols(response: QueryResponse): string[] {
    const cols = CHIP_COLS.filter((c) => response.columns.includes(c));
    if (this.isRelation) {
      for (const c of [SRC_COL, DST_COL]) {
        if (!cols.includes(c)) cols.push(c);
      }
    }
    return cols;
  }

  // All node-bearing (slice-id valued) columns: the chip columns plus a raw
  // `slice_id`. Drives the "N nodes in result" bulk actions.
  private nodeBearingCols(response: QueryResponse): string[] {
    const cols = this.chipCols(response);
    if (response.columns.includes(SLICE_ID_COL)) cols.push(SLICE_ID_COL);
    return cols;
  }

  private nodeLabelFor(value: SqlValue): string | undefined {
    const node = this.nodeForSliceValue(value);
    return node === undefined ? undefined : nodeLabel(node);
  }

  private nodeForSliceValue(value: SqlValue): GraphNode | undefined {
    if (typeof value !== 'number' && typeof value !== 'bigint') {
      return undefined;
    }
    return this.controller.nodeForSliceId(Number(value));
  }
}
