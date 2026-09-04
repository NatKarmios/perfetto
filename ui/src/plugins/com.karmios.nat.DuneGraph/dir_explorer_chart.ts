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
 * The directory Explorer offered as a Data Explorer *chart type*: a query's
 * rows, drawn as the part of the build's directory tree they landed in.
 *
 * ## What the chart is a view of
 *
 * Its input is a **selection**, not a structure. The hierarchy comes from the
 * mirror as it always did; what the query's rows decide is which directories are
 * drawn and what hangs off them - a directory none of the rows are filed in gets
 * no row at all, and a directory row lists only the members the query returned.
 * That makes the card honestly a picture of its query rather than a tree that
 * happens to highlight some of it. See dir_chart_source.ts, which is where all
 * of that lives; this file is the registration and the states around it.
 *
 * ## `config.column` is the node id column
 *
 * Every chart type reads its config's primary column as something; this one
 * reads it as the column holding a `dune_node.node_id`, which is what maps a row
 * to a place in the tree. The chart picker's generic default rarely picks it, so
 * a chart dropped on a Dune query offers to switch to the right column rather
 * than silently joining on a path string and drawing nothing (see
 * {@link resolveNodeColumn}).
 *
 * ## Clicking a directory narrows everything else
 *
 * The row's filter button emits `setBrushSelection('dir_id', [...])` over the
 * directories its subtree actually holds rows in. That lands as repeated `=`
 * filters and is rendered as `dir_id IN (...)` by the dashboard's own
 * `buildWhereClause`, so it needs nothing new from the host - but it does need
 * the query to *have* a `dir_id` column, which is why the button is only offered
 * when one is there. Any query over `dune_node` carries it for free.
 */

import m from 'mithril';
import {assertUnreachable} from '../../base/assert';
import type {Trace} from '../../public/trace';
import type {ColumnInfo} from '../dev.perfetto.DataExplorer/query_builder/column_info';
import type {ChartConfig} from '../dev.perfetto.DataExplorer/query_builder/nodes/visualisation_node';
import type {
  ChartLoaderEntry,
  ChartRenderContext,
} from '../dev.perfetto.DataExplorer/query_builder/charts/chart_renderers';
import {registerChartType} from '../dev.perfetto.DataExplorer/query_builder/charts/chart_type_registry';
import {Button} from '../../widgets/button';
import {Callout} from '../../widgets/callout';
import {EmptyState} from '../../widgets/empty_state';
import {Intent} from '../../widgets/common';
import {Spinner} from '../../widgets/spinner';
import type {DuneGraphController} from './controller';
import {ChartDirExplorerSource} from './dir_chart_source';
import type {DirEntry} from './dir_explorer';
import {DirExplorerPanel, renderMirrorNotLoaded} from './dir_explorer_panel';

/**
 * The chart type identifier. Dashboards persist this as a bare string and
 * survive being reopened without us (the registry renders a placeholder naming
 * the type), so it is prefixed rather than a bare word like the built-ins:
 * whatever else may come to register a chart type, it will not be this.
 *
 * Exported for the seeded dashboard (dir_tree_graph.ts), which names the type
 * in a chart item rather than going through the registry.
 */
export const DIR_TREE_CHART_TYPE = 'dune-dir-tree';

/**
 * The column a directory click filters on, and the one the pane's narrowing
 * button needs the query to carry.
 *
 * `dune_node.dir_id` is a plain id column on the mirror's node view, so any
 * query over `dune_node` has it without asking (see sql_graph.ts). Deliberately
 * not the primary column: what is being narrowed is *where* the rows are, which
 * is a different question from which column named them.
 */
const DIR_ID_COLUMN = 'dir_id';

/**
 * Column names whose value is a `dune_node.node_id`, in the order to prefer
 * them.
 *
 * The same three the query tab treats as node-bearing (`query_results.ts`'s
 * `CHIP_COLS`, and its `GROUP_COL_PRIORITY` order), because a query written for
 * one surface should not need rewriting for the other: `node_id` off `dune_node`
 * and the detail tables, `src` / `dst` off `dune_edge` and the relation
 * functions.
 */
const NODE_ID_COLUMNS: readonly string[] = ['node_id', 'src', 'dst'];

/**
 * Registers the directory-tree chart type for as long as `trace` lives.
 *
 * The chart registry is global and outlives a trace, and the pane it renders
 * closes over a controller belonging to *this* trace, so - exactly as with the
 * node column renderer in node_cell.ts - the registration goes in the trace's
 * trash and the next trace load registers afresh. Registering a chart type
 * twice throws by design, so a leaked registration would surface on the next
 * load rather than quietly capturing a dead controller.
 *
 * @param trace The trace the registration's lifetime is tied to.
 * @param controller The controller whose mirror the tree is read from.
 */
export function registerDirExplorerChart(
  trace: Trace,
  controller: DuneGraphController,
): void {
  trace.trash.use(
    registerChartType({
      type: DIR_TREE_CHART_TYPE,
      label: 'Dune Directories',
      icon: 'account_tree',
      description:
        "Browse the query's rows as the build's directory tree, with each " +
        "directory's rules and dependencies",

      // Nothing to configure beyond the primary column: aggregating or binning
      // a directory tree means nothing, and the pane picks every other column
      // it reads out of the mirror itself.
      supportsAggregation: false,
      supportsBinning: false,
      requiresNumericDimension: false,
      // Named for what it is read as, since it is not a dimension or a measure
      // and the popup offers no other hint (see `resolveNodeColumn`).
      primaryColumnLabel: 'Node id column',
      supportsYColumn: false,
      supportsGroupColumn: false,
      supportsSizeColumn: false,

      // The source is created here, once per (table, config) - which is exactly
      // the lifetime the host already manages for a loader, disposing the old
      // one when either changes. Building it in `render` instead would hand the
      // pane a new source every frame, and the pane treats a new source as new
      // data: the tree would collapse on every redraw.
      //
      // The query is *not* run here. The source loads lazily, so a chart whose
      // column is not a node id (below) or whose graph is not loaded costs
      // nothing until it can actually draw something.
      createLoader: (engine, query, config, entry) => {
        entry.custom = new ChartDirExplorerSource(
          engine,
          controller,
          query,
          config.column,
        );
      },

      render: (ctx, config, entry) =>
        m(
          '.pf-dune-dir-chart',
          renderChartBody(controller, ctx, config, entry),
        ),

      // The card is the query's tree, and the query is named by the node it
      // sits on; the column that maps rows to nodes is plumbing rather than a
      // title.
      defaultLabel: () => 'Dune directory tree',

      // No `preview`: the picker falls back to `icon` for types without an SVG
      // thumbnail, and the tree has no schematic worth drawing.
    }),
  );
}

/**
 * Everything inside the card: the tree, or an honest account of why there isn't
 * one.
 *
 * The order of the checks is the order the answers become knowable - no mirror,
 * then no node id column, then no rows to load, then the load itself - so each
 * one only ever reports the first thing that is actually wrong.
 */
function renderChartBody(
  controller: DuneGraphController,
  ctx: ChartRenderContext,
  config: ChartConfig,
  entry: ChartLoaderEntry,
): m.Children {
  // `dune_dir` is built as part of the node tier, so there is nothing to read
  // until that is up - including the hierarchy, which is not the chart's input
  // but is half of what it draws.
  if (!controller.nodeMirrorReady) return renderMirrorNotLoaded(controller);

  const suggestion = resolveNodeColumn(config.column, ctx.node.sourceCols);
  if (suggestion !== undefined) {
    return renderColumnPrompt(ctx, config, suggestion);
  }

  // No loader entry means the host has no results table yet (it creates loaders
  // only once the upstream node has run), so there is nothing to have loaded.
  const source = entry.custom;
  if (!(source instanceof ChartDirExplorerSource)) {
    return m(
      EmptyState,
      {icon: 'account_tree', title: 'Waiting for results'},
      m(
        '.pf-dune-graph__load-note',
        'This query has not produced a results table yet.',
      ),
    );
  }

  // Kicked from the render rather than from the pane, so the states below can
  // be told apart before the tree is mounted: the pane, handed a source that
  // failed or matched nothing, would only be able to say "nothing to show".
  source.ensureLoaded();
  const state = source.state;
  switch (state.phase) {
    case 'idle':
    case 'loading':
      return m(
        '.pf-dune-graph__status',
        m(Spinner),
        m('span', "Reading the query's rows…"),
      );
    case 'error':
      return m(
        Callout,
        {icon: 'error'},
        `Could not map the query's rows to Dune nodes: ${state.message}`,
      );
    case 'ready':
      break;
    default:
      assertUnreachable(state);
  }

  if (state.nodeCount === 0) {
    return m(
      EmptyState,
      {icon: 'search_off', title: 'No Dune nodes in these rows'},
      m(
        '.pf-dune-graph__load-note',
        `Nothing in "${config.column}" matched a node in the graph. That ` +
          'column has to hold a dune_node.node_id for its rows to have a ' +
          'place in the tree.',
      ),
    );
  }

  return m(
    '.pf-dune-dir-chart__pane',
    m(DirExplorerPanel, {
      controller,
      source,
      onFilterToDir: dirFilterHandler(ctx, source),
    }),
  );
}

/**
 * The column that should hold node ids but isn't the one configured, or
 * undefined when the configured one will do.
 *
 * The chart picker's default column is chosen generically - the first
 * non-numeric column, which on a Dune query is usually a label or a path - so a
 * chart dropped on a query would otherwise join on a string, match nothing and
 * show an empty tree. This is the offer to fix that, and it is an offer rather
 * than a silent substitution because the column picker is the config's own and
 * quietly ignoring it is what this chart used to do.
 *
 * A configured column that is one of the known node id names is taken as
 * deliberate. So is one that isn't, when the query offers no better - a query
 * may well have aliased its node id to something else, and only its author
 * knows.
 */
function resolveNodeColumn(
  column: string,
  cols: ReadonlyArray<ColumnInfo>,
): string | undefined {
  if (NODE_ID_COLUMNS.includes(column)) return undefined;
  const names = new Set(cols.map((c) => c.name));
  return NODE_ID_COLUMNS.find((c) => names.has(c));
}

// The offer to point the chart at a column that actually holds node ids. The
// click is the config popup's own `updateChart`, so it persists exactly as
// picking the column there would - and rebuilding the loader on the new column
// is then the host's business rather than ours.
function renderColumnPrompt(
  ctx: ChartRenderContext,
  config: ChartConfig,
  suggestion: string,
): m.Children {
  return m(
    EmptyState,
    {icon: 'account_tree', title: 'Pick the node id column'},
    m(
      '.pf-dune-graph__load-note',
      `This chart maps each row to a Dune node, so it needs the column ` +
        `holding a dune_node.node_id. "${config.column}" is not one, but ` +
        `"${suggestion}" is.`,
    ),
    m(Button, {
      label: `Use ${suggestion}`,
      icon: 'check',
      intent: Intent.Primary,
      onclick: () => ctx.node.updateChart(config.id, {column: suggestion}),
    }),
  );
}

/**
 * What a directory row's filter button does, or undefined when the query has no
 * `dir_id` column for the filter to name.
 *
 * Withheld rather than offered-and-broken: a filter on a column the query does
 * not have would either error downstream or quietly match nothing, and neither
 * is something to find out by clicking. The clear-then-set pair is the same one
 * every built-in renderer's brush does (see `handleBarBrush`), and it is what
 * makes clicking a second directory a *move* rather than a union with the
 * first.
 */
function dirFilterHandler(
  ctx: ChartRenderContext,
  source: ChartDirExplorerSource,
): ((dir: DirEntry) => void) | undefined {
  if (!ctx.node.sourceCols.some((c) => c.name === DIR_ID_COLUMN)) {
    return undefined;
  }
  return (dir: DirEntry) => {
    const ids = source.subtreeDirIds(dir.id);
    if (ids.length === 0) return;
    ctx.node.clearChartFiltersForColumn(DIR_ID_COLUMN);
    ctx.node.setBrushSelection(DIR_ID_COLUMN, [...ids]);
    ctx.onFilterChange?.();
  };
}
