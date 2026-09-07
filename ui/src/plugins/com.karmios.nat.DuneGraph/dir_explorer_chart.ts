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
 * ## So does the pane's own filter
 *
 * The pane's path box and Filters menu narrow the tree; the same gesture should
 * narrow the other cards, and does - as a brush over the *node ids* the filter
 * matched, on whichever column the chart was pointed at (see `filterHandler`).
 *
 * A set of ids rather than a predicate, and not for want of trying to be
 * cleverer: the filter matches a dep on its own `label`, and a rule on the path
 * of its *directory*, because a rule's label is a bare dune id carrying no path
 * at all. That is a disjunction over two different columns, and brush filters
 * AND across columns - so no predicate on one column, glob or otherwise, can
 * express it. A set of node ids can, and `node_id` is the column both halves
 * resolve onto.
 *
 * Every id in that set is a runtime brush filter, a term of an `IN (...)`, and a
 * few dozen bytes of the dashboard's persisted state, so the set is capped and a
 * filter over the cap brushes *nothing* rather than a truncated something - see
 * {@link MAX_BRUSH_NODES}.
 *
 * ## The two brushes do not interfere
 *
 * `dir_id` and the node id column are different columns, so the dashboard ANDs
 * them (see `buildWhereClause`), and neither gesture clears the other. That is
 * the honest reading of both: narrowing to `lib/foo` and then filtering to
 * `*.cmi` asks for the .cmi files under lib/foo, and clearing the filter should
 * leave you where you were rather than also un-narrowing the directory. They
 * are tracked separately in {@link CardBrush} for the same reason.
 */

import m from 'mithril';
import {assertUnreachable} from '../../base/assert';
import {getErrorMessage} from '../../base/errors';
import type {Trace} from '../../public/trace';
import type {ChartConfig} from '../dev.perfetto.DataExplorer/query_builder/nodes/visualisation_node';
import type {
  ChartLoaderEntry,
  ChartRenderContext,
} from '../dev.perfetto.DataExplorer/query_builder/charts/chart_renderers';
import {registerChartType} from '../dev.perfetto.DataExplorer/query_builder/charts/chart_type_registry';
import {Callout} from '../../widgets/callout';
import {EmptyState} from '../../widgets/empty_state';
import {Icon} from '../../widgets/icon';
import {Spinner} from '../../widgets/spinner';
import {
  defaultNodeColumn,
  renderNodeColumnPrompt,
  resolveNodeColumn,
} from './chart_node_column';
import type {DuneGraphController} from './controller';
import {ChartDirExplorerSource} from './dir_chart_source';
import type {DirEntry, MemberFilter} from './dir_explorer';
import {filterActive} from './dir_explorer';
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
 * The most node ids a filter may brush the dashboard with.
 *
 * Every id is paid for three times over, and none of the three is the query
 * that produced it:
 *
 * - as a `DashboardBrushFilter` object in a runtime array that is copied on
 *   every flush and again for every data source sharing the column;
 * - as one term of a `node_id IN (...)` in every consumer card's statement,
 *   ~8 bytes of SQL each;
 * - as ~45 bytes of the tab's *persisted* state, since brush filters are
 *   serialised with the dashboard (see tab_io.ts).
 *
 * At 2,000 that is ~90kB of saved state and a ~16kB statement per card - the
 * order of a hand-written query, and something a dashboard can carry. The
 * numbers this has to refuse are not close to it: a path filter of `_build`
 * matches most of the build, and the monorepo trace has 818k nodes, i.e. ~36MB
 * of persisted state and a statement no one should generate. Nothing about the
 * SQL itself breaks at either size (an `IN` list of literals is an expression
 * list, not a compound SELECT - see the 500-term limit noted in sql_graph.ts);
 * what breaks is everything the ids are carried around in.
 *
 * A filter over the cap brushes nothing at all rather than its first 2,000
 * matches: a truncated brush is a lie about what matched, and a silent one at
 * that - the other cards would show a subset with nothing on screen saying so.
 * See `filterHandler` for what is shown instead.
 */
export const MAX_BRUSH_NODES = 2000;

/**
 * What one card has put on the dashboard's brush filters, and what to say about
 * it.
 *
 * Held per chart rather than per source because it has to outlive one: a
 * consumer card's own query carries the brush filters, so brushing rebuilds the
 * loader and with it the source (see `ensureLoader`), and state kept on the
 * source would be dropped by the very click that set it - the toggle would
 * un-light itself.
 *
 * The two brushes are separate fields because they are separate gestures on
 * separate columns and neither undoes the other (see the file header).
 */
interface CardBrush {
  /** The directory this card's `dir_id` brush names, if any. */
  dirId?: number;
  /**
   * Whether a brush over the pane's filter is currently out.
   *
   * A boolean rather than the ids: nothing re-reads them, and all this has to
   * answer is whether there is something to clear - so that a card mounting
   * over an unfiltered pane does not flush a clear of a column it never
   * brushed.
   */
  brushed: boolean;
  /** What could not be brushed, and why, for the note above the tree. */
  note?: string;
  /**
   * Which filter change the fields above belong to, so a superseded one cannot
   * land after it.
   *
   * The ids are fetched asynchronously and the pane can report a further change
   * meanwhile - clearing the filter from the Filters menu is not gated on the
   * apply that is still in flight - so the answer to an older question has to be
   * recognisable and dropped.
   */
  seq: number;
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
  // What each card of this type has brushed, by chart config id - which is
  // stable across the loader rebuilds a brush itself causes, unlike the source.
  // Scoped to the registration, so it dies with the trace rather than being a
  // module-level cache of cards from traces ago; within one trace it holds a
  // handful of fields per chart ever configured.
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
  return [
    brush.note === undefined
      ? undefined
      : m(
          '.pf-dune-dir-chart__note',
          m(Icon, {icon: 'filter_alt_off'}),
          m('span', brush.note),
        ),
    m(
      '.pf-dune-dir-chart__pane',
      m(DirExplorerPanel, {
        controller,
        source,
        onFilterToDir: dirFilterHandler(ctx, source, brush),
        filteredDirId: brush.dirId,
        onFilterChange: filterHandler(controller, ctx, config, source, brush),
      }),
    ),
  ];
}

// This card's brush record, created empty on first sight of the card.
function cardBrush(
  brushes: Map<string, CardBrush>,
  chartId: string,
): CardBrush {
  let brush = brushes.get(chartId);
  if (brush === undefined) {
    brush = {brushed: false, seq: 0};
    brushes.set(chartId, brush);
  }
  return brush;
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
 *
 * Only `dir_id` is touched either way. The pane's own filter brushes a
 * different column and the two are read together (see the file header).
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

/**
 * What the pane's own filter does to the rest of the dashboard: a brush over
 * the node ids it matched, on the column the chart reads as the node id.
 *
 * `config.column` rather than a literal `node_id`, for the same reason every
 * built-in renderer brushes `config.column`: the ids are values *of that
 * column*, and a query may have aliased it (`src` off an edge query, say).
 * With the usual column that is the `node_id IN (...)` it reads like.
 *
 * Three outcomes, and the count decides between them before anything is
 * fetched:
 *
 * - **No filter.** Whatever this card brushed is cleared, so no brush outlives
 *   the filter that made it. Only when it brushed something: a card mounting
 *   over an unfiltered pane must not flush a clear of a column it never
 *   touched.
 * - **More matches than {@link MAX_BRUSH_NODES}.** Nothing is brushed, and any
 *   previous brush is cleared - not left standing, which would leave the other
 *   cards narrowed to a filter that is no longer the one on screen, with
 *   nothing saying so. What is said instead is a note above the tree, where the
 *   filter that caused it is.
 * - **Otherwise**, the ids are read and brushed.
 *
 * Re-emitted on every reported change rather than deduplicated against the last
 * one: the *input* can change under the same filter (an edited upstream query,
 * or this card's own query narrowed by the brush when it sits below a divider),
 * and then the same filter names different nodes. Re-brushing an unchanged set
 * is cheap and settles - it generates the same filters, so the host reuses the
 * loader and nothing rebuilds.
 */
function filterHandler(
  controller: DuneGraphController,
  ctx: ChartRenderContext,
  config: ChartConfig,
  source: ChartDirExplorerSource,
  brush: CardBrush,
): (filter: MemberFilter, matchCount: number) => void {
  const column = config.column;
  const clear = () => {
    brush.brushed = false;
    ctx.node.clearChartFiltersForColumn(column);
    ctx.onFilterChange?.();
  };
  return (filter: MemberFilter, matchCount: number) => {
    const seq = ++brush.seq;
    if (!filterActive(filter)) {
      const had = brush.brushed || brush.note !== undefined;
      brush.note = undefined;
      if (had) clear();
      return;
    }
    if (matchCount > MAX_BRUSH_NODES) {
      brush.note =
        `${matchCount.toLocaleString()} matches is too many to narrow the ` +
        `other cards by (the limit is ${MAX_BRUSH_NODES.toLocaleString()}). ` +
        'They are not narrowed by it at all; narrow the filter, or use a ' +
        "directory's filter button instead.";
      if (brush.brushed) clear();
      else controller.requestRedraw();
      return;
    }
    void source
      .matchingNodeIds(filter)
      .then((ids) => {
        // A later change has already been reported, so this answer is about a
        // filter that is no longer on screen.
        if (seq !== brush.seq) return;
        brush.note = undefined;
        brush.brushed = true;
        ctx.node.clearChartFiltersForColumn(column);
        ctx.node.setBrushSelection(column, [...ids]);
        ctx.onFilterChange?.();
      })
      .catch((e) => {
        if (seq !== brush.seq) return;
        brush.note =
          'Could not work out which rows the filter matched, so the other ' +
          `cards are unchanged: ${getErrorMessage(e)}`;
        controller.requestRedraw();
      });
  };
}
