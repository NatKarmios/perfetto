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
 * This file is the registration and the states around it; dir_chart_source.ts
 * is the data. **ARCHITECTURE.md, "The Explorer pane", covers both** - what the card
 * is a picture of, and how the narrow-to-this-directory brush works.
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
import {
  defaultNodeColumn,
  renderChartError,
  renderChartLoading,
  renderChartNoNodes,
  renderChartWaiting,
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

// The card's icon, reused by every state that stands in for it so a
// misconfigured chart still reads as this chart rather than as an error.
const ICON = 'account_tree';

// The column a directory click filters on. Any query over `dune_node` has it
// without asking.
const DIR_ID_COLUMN = 'dir_id';

// Which directory this card's `dir_id` brush names, if any.
interface CardBrush {
  dirId?: number;
  // Whether the persisted filters have already been asked what `dirId` was.
  // Taken once and kept, including when it comes back undefined: a set that
  // could not be explained this frame will not be explicable the next one.
  recovered?: boolean;
}

// Registered for as long as `trace` lives: the chart registry is global and
// outlives a trace, while the pane closes over *this* trace's controller.
// Registering a type twice throws by design, so a leaked registration surfaces
// on the next load rather than capturing a dead controller.
export function registerDirExplorerChart(
  trace: Trace,
  controller: DuneGraphController,
): void {
  // Scoped to the registration, so it dies with the trace; within one trace it
  // holds one number per chart ever configured.
  const brushes = new Map<string, CardBrush>();
  trace.trash.use(
    registerChartType({
      type: DIR_TREE_CHART_TYPE,
      label: 'Dune Directories',
      icon: ICON,
      description:
        "Browse the query's rows as the build's directory tree, with each " +
        "directory's rules and dependencies",

      // Aggregating or binning a directory tree means nothing, and the pane
      // picks every other column it reads out of the mirror itself.
      supportsAggregation: false,
      supportsBinning: false,
      requiresNumericDimension: false,
      // Named for what it is read as: not a dimension or a measure.
      primaryColumnLabel: 'Node id column',
      // So a chart dropped on a query that has one just draws.
      defaultColumn: defaultNodeColumn,
      supportsYColumn: false,
      supportsGroupColumn: false,
      supportsSizeColumn: false,

      // Once per (table, config), the lifetime the host already manages.
      // The query is *not* run here: the source loads lazily, so a chart that
      // cannot draw yet costs nothing.
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

      // The query is named by the node the card sits on.
      defaultLabel: () => 'Dune directory tree',

      // No `preview`: the picker falls back to `icon` for types without an SVG
      // thumbnail, and the tree has no schematic worth drawing.
    }),
  );
}

// The checks run in the order their answers become knowable - no mirror, no
// node id column, no results table, then the load - so each reports only the
// first thing actually wrong.
function renderChartBody(
  controller: DuneGraphController,
  brushes: Map<string, CardBrush>,
  ctx: ChartRenderContext,
  config: ChartConfig,
  entry: ChartLoaderEntry,
): m.Children {
  // `dune_dir` is built as part of the node tier, and the hierarchy is half of
  // what this draws.
  if (!controller.nodeMirrorReady) return renderMirrorNotLoaded(controller);

  const suggestion = resolveNodeColumn(config.column, ctx.node.sourceCols);
  if (suggestion !== undefined) {
    return renderNodeColumnPrompt(ctx, config, suggestion, ICON);
  }

  const source = entry.custom;
  if (!(source instanceof ChartDirExplorerSource)) {
    return renderChartWaiting(ICON);
  }

  // Kicked from the render rather than from the pane, so the states below can
  // be told apart before the tree is mounted: the pane, handed a source that
  // failed or matched nothing, would only be able to say "nothing to show".
  source.ensureLoaded();
  const state = source.state;
  switch (state.phase) {
    case 'idle':
    case 'loading':
      return renderChartLoading();
    case 'error':
      return renderChartError(state.message);
    case 'ready':
      break;
    default:
      assertUnreachable(state);
  }

  if (state.nodeCount === 0) return renderChartNoNodes(config, 'the tree');

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

// Fills in `brush.dirId` from the filters the brush was persisted as, for a
// card whose brush predates a reload. `chartId` is what makes them readable: a
// `dir_id` selection stamped with this chart's id is this card's brush and no
// one else's. Silent about failure by design - see the README.
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

// Undefined when the query has no `dir_id` column: withheld rather than
// offered-and-broken, since such a filter would error downstream or quietly
// match nothing. The clear-then-set pair is every built-in renderer's brush
// (see `handleBarBrush`), and is what makes a second click a *move* rather
// than a union. The pane reports every click the same way; this side decides,
// because it is the side that knows what is brushed.
function dirFilterHandler(
  ctx: ChartRenderContext,
  source: ChartDirExplorerSource,
  brush: CardBrush,
): ((dir: DirEntry) => void) | undefined {
  if (!ctx.node.sourceCols.some((c) => c.name === DIR_ID_COLUMN)) {
    return undefined;
  }
  return (dir: DirEntry) => {
    // This card now knows what it brushed first-hand, and the persisted
    // filters still describe a cleared brush for one frame.
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
