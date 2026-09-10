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
 * than silently joining on a path string and drawing nothing - which is shared
 * with the node graph chart, and so lives in chart_node_column.ts.
 *
 * ## Clicking a directory narrows everything else
 *
 * The row's filter button emits `setBrushSelection('dir_id', [...])` over the
 * directories its subtree actually holds rows in. That lands as repeated `=`
 * filters and is rendered as `dir_id IN (...)` by the dashboard's own
 * `buildWhereClause`, so it needs nothing new from the host - but it does need
 * the query to *have* a `dir_id` column, which is why the button is only offered
 * when one is there. Any query over `dune_node` carries it for free.
 *
 * The button is a toggle: clicking the directory that is already brushed clears
 * the brush instead of re-applying it. That needs someone to remember which
 * directory that is, and the pane cannot - it hands out a directory and hears
 * nothing back - so the answer lives here, in `brushes`, and goes into the pane
 * as `filteredDirId` for it to draw the button pressed.
 *
 * `brushes` dies with the trace and the brush itself is saved with the tab, so
 * on the far side of a reload the card has to work out again which directory it
 * brushed. It reads that back off the persisted filters, which carry the id of
 * the chart that set them - see `recoverBrushedDir`.
 *
 * The pane's own path box and Filters menu narrow *this* card's tree and
 * nothing else. Deliberately: a brush is persisted with the tab and the pane's
 * filter is not, so a dashboard reopened after a filter brush came back
 * narrowed by a filter nothing on screen was showing.
 */

import m from 'mithril';
import {assertUnreachable} from '../../../base/assert';
import type {Trace} from '../../../public/trace';
import type {ChartConfig} from '../../dev.perfetto.DataExplorer/query_builder/nodes/visualisation_node';
import type {
  ChartLoaderEntry,
  ChartRenderContext,
} from '../../dev.perfetto.DataExplorer/query_builder/charts/chart_renderers';
import {registerChartType} from '../../dev.perfetto.DataExplorer/query_builder/charts/chart_type_registry';
import {Callout} from '../../../widgets/callout';
import {EmptyState} from '../../../widgets/empty_state';
import {Spinner} from '../../../widgets/spinner';
import {
  defaultNodeColumn,
  renderNodeColumnPrompt,
  resolveNodeColumn,
} from './chart_node_column';
import type {DuneGraphController} from '../controller';
import {ChartDirExplorerSource} from './dir_chart_source';
import type {DirEntry} from '../model/dir_explorer';
import {
  DirExplorerPanel,
  renderMirrorNotLoaded,
} from '../views/dir_explorer_panel';

/**
 * The chart type identifier. Dashboards persist this as a bare string and
 * survive being reopened without us (the registry renders a placeholder naming
 * the type), so it is prefixed rather than a bare word like the built-ins:
 * whatever else may come to register a chart type, it will not be this.
 *
 * Module-private: everything that names a chart type goes through the registry
 * this one is registered with, so nothing outside needs the string.
 */
const DIR_TREE_CHART_TYPE = 'dune-dir-tree';

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
 * Which directory this card's `dir_id` brush names, if any.
 *
 * Held per chart rather than per source because it has to outlive one: a
 * consumer card's own query carries the brush filters, so brushing rebuilds the
 * loader and with it the source (see `ensureLoader`), and state kept on the
 * source would be dropped by the very click that set it - the toggle would
 * un-light itself.
 */
interface CardBrush {
  dirId?: number;
  /**
   * Whether the persisted filters have already been asked what `dirId` was.
   *
   * The brush outlives this map - it is saved with the tab and the map is built
   * per trace load - so a card coming back from a reload has filters and no
   * `dirId`, and gets it back from `rootOfDirIds` (see `recoverBrushedDir`).
   * That answer is a scan of the mirror's directories, so it is taken once and
   * kept, including when it comes back undefined: a set that could not be
   * explained this frame will not be explicable the next one either.
   */
  recovered?: boolean;
}

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
  // Which directory each card of this type has brushed, by chart config id -
  // which is stable across the loader rebuilds a brush itself causes, unlike
  // the source. Scoped to the registration, so it dies with the trace rather
  // than being a module-level cache of cards from traces ago; within one trace
  // it holds one number per chart ever configured.
  const brushes = new Map<string, CardBrush>();
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
      // So a chart dropped on a query that has one just draws, instead of
      // landing on the host's generic first-non-numeric guess and having to
      // ask (see chart_node_column.ts).
      defaultColumn: defaultNodeColumn,
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
          renderChartBody(controller, brushes, ctx, config, entry),
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
  brushes: Map<string, CardBrush>,
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
    return renderNodeColumnPrompt(ctx, config, suggestion, 'account_tree');
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

  const brush = cardBrush(brushes, config.id);
  recoverBrushedDir(ctx, source, config.id, brush);
  return m(
    '.pf-dune-dir-chart__pane',
    m(DirExplorerPanel, {
      controller,
      source,
      onFilterToDir: dirFilterHandler(ctx, source, brush),
      filteredDirId: brush.dirId,
    }),
  );
}

// This card's brush record, created empty on first sight of the card.
function cardBrush(
  brushes: Map<string, CardBrush>,
  chartId: string,
): CardBrush {
  let brush = brushes.get(chartId);
  if (brush === undefined) {
    brush = {};
    brushes.set(chartId, brush);
  }
  return brush;
}

/**
 * Fills in `brush.dirId` from the filters the card's own brush was persisted
 * as, for a card whose brush was set before a reload.
 *
 * `brushes` lives for one trace load and the brush it mirrors lives with the
 * tab, so reopening a dashboard leaves every other card narrowed by a filter
 * this one no longer knows it set: nothing draws pressed, and the row that
 * would clear the brush re-applies it instead. The filters are the only record
 * left, and `chartId` is what makes them readable - a `dir_id` selection
 * stamped with this chart's id is this card's own brush and no one else's.
 *
 * Silent about failure by design. Every step of the way back is optional - the
 * host may publish no filters at all (the visualisation-node path does not),
 * the set may not resolve to a directory - and where it stops the card is
 * exactly the card it was before, brush-blind but working.
 */
function recoverBrushedDir(
  ctx: ChartRenderContext,
  source: ChartDirExplorerSource,
  chartId: string,
  brush: CardBrush,
): void {
  if (brush.dirId !== undefined || brush.recovered === true) return;
  const ids: number[] = [];
  for (const filter of ctx.brushFilters ?? []) {
    if (filter.column !== DIR_ID_COLUMN) continue;
    if (filter.op !== '=' || filter.chartId !== chartId) continue;
    if (typeof filter.value !== 'number' && typeof filter.value !== 'bigint') {
      continue;
    }
    ids.push(Number(filter.value));
  }
  if (ids.length === 0) return;
  brush.recovered = true;
  brush.dirId = source.rootOfDirIds(ids);
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
 *
 * A toggle, because the pane's button is one: a click on the directory already
 * brushed clears the brush instead. The pane reports every click the same way
 * and this decides, since this is the side that knows what is brushed - the
 * `dirId` it records is also what goes back in as `filteredDirId` to draw the
 * button pressed.
 */
function dirFilterHandler(
  ctx: ChartRenderContext,
  source: ChartDirExplorerSource,
  brush: CardBrush,
): ((dir: DirEntry) => void) | undefined {
  if (!ctx.node.sourceCols.some((c) => c.name === DIR_ID_COLUMN)) {
    return undefined;
  }
  return (dir: DirEntry) => {
    // Whatever the click does, this card now knows what it brushed first-hand
    // and has no more use for the persisted filters - which for one frame
    // after a clear still describe the brush being cleared.
    brush.recovered = true;
    if (brush.dirId === dir.id) {
      brush.dirId = undefined;
      ctx.node.clearChartFiltersForColumn(DIR_ID_COLUMN);
      ctx.onFilterChange?.();
      return;
    }
    const ids = source.subtreeDirIds(dir.id);
    if (ids.length === 0) return;
    brush.dirId = dir.id;
    ctx.node.clearChartFiltersForColumn(DIR_ID_COLUMN);
    ctx.node.setBrushSelection(DIR_ID_COLUMN, [...ids]);
    ctx.onFilterChange?.();
  };
}
