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
import type {SqlValue} from '../../trace_processor/query_result';
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
import {Anchor} from '../../widgets/anchor';
import {Button} from '../../widgets/button';
import {MenuItem, PopupMenu} from '../../widgets/menu';
import {Callout} from '../../widgets/callout';
import {EmptyState} from '../../widgets/empty_state';
import {Spinner} from '../../widgets/spinner';
import {StackAuto} from '../../widgets/stack';
import type {DuneGraphController} from './controller';
import type {GraphNode} from './graph';
import {nodeKey, nodeLabel} from './graph';
import {decorateDepPath} from './node_display';

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
          'Query dune_node / dune_edge / dune_descendants / dune_ancestors - ' +
          'any node / src / dst / slice_id column becomes addable.',
      );
    }

    const hasNodes = this.nodeBearingCols(response).length > 0;
    return m(
      '.pf-dune-query',
      !hasNodes &&
        m(
          Callout,
          {icon: 'warning'},
          'Return a node, src, dst, or slice_id column to add nodes to the ' +
            'graph.',
        ),
      m(
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
          toolbarItemsRight: hasNodes
            ? this.renderGraphMenu(response)
            : undefined,
        }),
      ),
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
    const inGraph = this.controller.isInGraph(node);
    return m(Button, {
      icon: inGraph ? 'remove' : 'add',
      title: inGraph ? 'Remove from graph' : 'Add to graph',
      onclick: () =>
        inGraph
          ? this.controller.removeFromGraph([node])
          : this.controller.addToGraph([node]),
    });
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
