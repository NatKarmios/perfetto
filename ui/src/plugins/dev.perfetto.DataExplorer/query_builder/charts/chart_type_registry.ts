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

import type m from 'mithril';
import type {ChartConfig, ChartType} from '../nodes/visualisation_node';
import type {ChartLoaderEntry, ChartRenderContext} from './chart_renderers';
import {
  renderBarChart,
  renderBoxplot,
  renderCdf,
  renderHeatmap,
  renderHistogram,
  renderLineChart,
  renderPieChart,
  renderScatterChart,
  renderScorecard,
  renderTreemap,
  renderUnknownChartType,
} from './chart_renderers';
import {SQLBarChartLoader} from '../../../../components/widgets/charts/bar_chart_loader';
import {SQLHistogramLoader} from '../../../../components/widgets/charts/histogram_loader';
import {SQLLineChartLoader} from '../../../../components/widgets/charts/line_chart_loader';
import {SQLScatterChartLoader} from '../../../../components/widgets/charts/scatterplot_loader';
import {SQLPieChartLoader} from '../../../../components/widgets/charts/pie_chart_loader';
import {SQLTreemapLoader} from '../../../../components/widgets/charts/treemap_loader';
import {SQLBoxplotLoader} from '../../../../components/widgets/charts/boxplot_loader';
import {SQLHeatmapLoader} from '../../../../components/widgets/charts/heatmap_loader';
import {SQLCdfLoader} from '../../../../components/widgets/charts/cdf_loader';
import {SQLSingleValueLoader} from '../../../../components/widgets/charts/single_value_loader';
import type {Engine} from '../../../../trace_processor/engine';
import type {ColumnInfo} from '../column_info';
import {isQuantitativeType} from '../../../../trace_processor/perfetto_sql_type';
import {CHART_PREVIEWS} from './chart_previews';

/**
 * Definition of a chart type: its metadata, its capabilities and its
 * behaviour (how to load its data and how to render it).
 *
 * This registry pattern allows for extensible chart types. To add a built-in
 * chart type:
 * 1. Implement its render function in chart_renderers.ts
 * 2. Add a new entry to BUILT_IN_CHART_TYPES below, wiring up `createLoader`
 *    and `render`
 *
 * Other plugins add their own types by calling `registerChartType`, which hands
 * back a disposable so that a registration made for one trace goes away with
 * it.
 */
export interface ChartTypeDefinition {
  /** The chart type identifier — unique across the registry. */
  readonly type: ChartType;

  /** Human-readable label for the chart type */
  readonly label: string;

  /** Material icon name for the chart type */
  readonly icon: string;

  /**
   * Whether this chart type supports aggregation functions (COUNT, SUM, etc.)
   * When true, the chart can show aggregated values per category.
   * Example: Bar chart showing SUM(duration) by thread_name
   */
  readonly supportsAggregation: boolean;

  /**
   * Whether this chart type supports binning of continuous values.
   * When true, the chart groups values into bins/buckets.
   * Example: Histogram showing distribution of durations in 10 bins
   */
  readonly supportsBinning: boolean;

  /**
   * Whether the primary column must be numeric.
   * When true, the column picker is filtered to quantitative types.
   * Example: Histogram, line chart, scatter plot all require numeric X.
   */
  readonly requiresNumericDimension: boolean;

  /** Label shown for the primary column picker in the config popup. */
  readonly primaryColumnLabel: string;

  /**
   * Whether the chart requires a second numeric column (Y axis).
   * When true, a Y column picker is shown in the config popup.
   * Example: Line chart (Y values), scatter plot (Y values).
   */
  readonly supportsYColumn: boolean;

  /** Label shown for the Y column picker (defaults to "Y Column"). */
  readonly yColumnLabel?: string;

  /**
   * Whether the chart supports an optional grouping/series column (any type).
   * When true, a group column picker is shown in the config popup.
   * Example: Line chart series grouping, treemap parent grouping.
   */
  readonly supportsGroupColumn: boolean;

  /**
   * Whether the chart supports an optional numeric size column.
   * When true, a size column picker is shown in the config popup.
   * Example: Scatter plot bubble size.
   */
  readonly supportsSizeColumn: boolean;

  /** Short description shown on hover in the chart type picker. */
  readonly description: string;

  /**
   * The column a freshly added chart of this type should start on, given the
   * columns its query returns, or undefined to let the host choose generically.
   *
   * The generic choice is "the first column that isn't a number", which suits a
   * chart whose primary column is a category to aggregate by. A chart type
   * whose primary column means something more specific - an id joining the rows
   * to somewhere else, say - will otherwise land on a column it cannot use and
   * have to ask the user to correct it before it can draw anything.
   *
   * Only a starting point: it is written into the chart's config, so it appears
   * in the column picker as an ordinary choice the user can change.
   */
  readonly defaultColumn?: (
    columns: ReadonlyArray<{readonly name: string}>,
  ) => string | undefined;

  /**
   * Create the SQL loader(s) this chart needs and stash them on `entry`, from
   * where the render function picks them up. Charts whose config is not yet
   * complete (e.g. a line chart with no Y column) create nothing.
   */
  readonly createLoader: (
    engine: Engine,
    query: string,
    config: ChartConfig,
    entry: ChartLoaderEntry,
  ) => void;

  /** Render the chart widget for a config + its loader entry. */
  readonly render: (
    ctx: ChartRenderContext,
    config: ChartConfig,
    entry: ChartLoaderEntry,
  ) => m.Child;

  /**
   * Display label for a chart of this type when the user hasn't named it.
   * `config.column` is guaranteed non-empty.
   */
  readonly defaultLabel: (config: ChartConfig) => string;

  /**
   * Schematic SVG thumbnail shown in the chart type picker. Optional: types
   * without one fall back to `icon`.
   */
  readonly preview?: () => m.Children;
}

/**
 * Default label shared by the chart types that aggregate a measure over a
 * dimension column.
 */
function aggregatedByLabel(config: ChartConfig): string {
  const agg = config.aggregation ?? 'COUNT';
  if (agg === 'COUNT') return `Count by ${config.column}`;
  return `${agg}(${config.measureColumn ?? config.column}) by ${config.column}`;
}

/**
 * The chart types that ship with this plugin.
 *
 * The order here determines the order in UI dropdowns and in the chart type
 * picker; registered types are appended after these.
 */
const BUILT_IN_CHART_TYPES: readonly ChartTypeDefinition[] = [
  {
    type: 'bar',
    label: 'Bar Chart',
    icon: 'bar_chart',
    supportsAggregation: true,
    supportsBinning: false,
    requiresNumericDimension: false,
    primaryColumnLabel: 'Dimension',
    supportsYColumn: false,
    supportsGroupColumn: true,
    supportsSizeColumn: false,
    description: 'Compare categories using vertical or horizontal bars',
    createLoader: (engine, query, config, entry) => {
      entry.barLoader = new SQLBarChartLoader({
        engine,
        query,
        dimensionColumn: config.column,
        measureColumn: config.measureColumn ?? config.column,
        seriesColumn: config.groupColumn,
      });
    },
    render: renderBarChart,
    defaultLabel: aggregatedByLabel,
    preview: CHART_PREVIEWS.bar,
  },
  {
    type: 'histogram',
    label: 'Histogram',
    icon: 'ssid_chart',
    supportsAggregation: false,
    supportsBinning: true,
    requiresNumericDimension: true,
    primaryColumnLabel: 'Column',
    supportsYColumn: false,
    supportsGroupColumn: false,
    supportsSizeColumn: false,
    description: 'Show distribution of numeric values across bins',
    createLoader: (engine, query, config, entry) => {
      entry.histogramLoader = new SQLHistogramLoader({
        engine,
        query: `SELECT ${config.column} FROM (${query})`,
        valueColumn: config.column,
      });
    },
    render: renderHistogram,
    defaultLabel: (config) => `Histogram: ${config.column}`,
    preview: CHART_PREVIEWS.histogram,
  },
  {
    type: 'line',
    label: 'Line Chart',
    icon: 'show_chart',
    supportsAggregation: false,
    supportsBinning: false,
    requiresNumericDimension: true,
    primaryColumnLabel: 'X Column',
    supportsYColumn: true,
    supportsGroupColumn: true,
    supportsSizeColumn: false,
    description: 'Plot trends with connected data points over a numeric axis',
    createLoader: (engine, query, config, entry) => {
      if (config.yColumn) {
        entry.lineLoader = new SQLLineChartLoader({
          engine,
          query,
          xColumn: config.column,
          yColumn: config.yColumn,
          seriesColumn: config.groupColumn,
        });
      }
    },
    render: renderLineChart,
    defaultLabel: (config) =>
      config.yColumn
        ? `${config.yColumn} vs ${config.column}`
        : `Line: ${config.column}`,
    preview: CHART_PREVIEWS.line,
  },
  {
    type: 'scatter',
    label: 'Scatter Plot',
    icon: 'scatter_plot',
    supportsAggregation: false,
    supportsBinning: false,
    requiresNumericDimension: true,
    primaryColumnLabel: 'X Column',
    supportsYColumn: true,
    supportsGroupColumn: true,
    supportsSizeColumn: true,
    description: 'Reveal correlations between two numeric variables',
    createLoader: (engine, query, config, entry) => {
      if (config.yColumn) {
        entry.scatterLoader = new SQLScatterChartLoader({
          engine,
          query,
          xColumn: config.column,
          yColumn: config.yColumn,
          sizeColumn: config.sizeColumn,
          seriesColumn: config.groupColumn,
        });
      }
    },
    render: renderScatterChart,
    defaultLabel: (config) =>
      config.yColumn
        ? `${config.yColumn} vs ${config.column}`
        : `Scatter: ${config.column}`,
    preview: CHART_PREVIEWS.scatter,
  },
  {
    type: 'pie',
    label: 'Pie Chart',
    icon: 'pie_chart',
    supportsAggregation: true,
    supportsBinning: false,
    requiresNumericDimension: false,
    primaryColumnLabel: 'Dimension',
    supportsYColumn: false,
    supportsGroupColumn: false,
    supportsSizeColumn: false,
    description: 'Show proportions of a whole as slices',
    createLoader: (engine, query, config, entry) => {
      entry.pieLoader = new SQLPieChartLoader({
        engine,
        query,
        dimensionColumn: config.column,
        measureColumn: config.measureColumn ?? config.column,
      });
    },
    render: renderPieChart,
    defaultLabel: aggregatedByLabel,
    preview: CHART_PREVIEWS.pie,
  },
  {
    type: 'treemap',
    label: 'Treemap',
    icon: 'grid_view',
    supportsAggregation: true,
    supportsBinning: false,
    requiresNumericDimension: false,
    primaryColumnLabel: 'Label Column',
    supportsYColumn: false,
    supportsGroupColumn: true,
    supportsSizeColumn: false,
    description: 'Display hierarchical data as nested rectangles by size',
    createLoader: (engine, query, config, entry) => {
      entry.treemapLoader = new SQLTreemapLoader({
        engine,
        query,
        labelColumn: config.column,
        sizeColumn: config.measureColumn ?? config.column,
        groupColumn: config.groupColumn,
      });
    },
    render: renderTreemap,
    defaultLabel: aggregatedByLabel,
    preview: CHART_PREVIEWS.treemap,
  },
  {
    type: 'boxplot',
    label: 'Box Plot',
    icon: 'candlestick_chart',
    supportsAggregation: false,
    supportsBinning: false,
    requiresNumericDimension: false,
    primaryColumnLabel: 'Category',
    supportsYColumn: true,
    supportsGroupColumn: false,
    supportsSizeColumn: false,
    description: 'Summarize data spread with quartiles and outliers',
    createLoader: (engine, query, config, entry) => {
      if (config.yColumn) {
        entry.boxplotLoader = new SQLBoxplotLoader({
          engine,
          query,
          categoryColumn: config.column,
          valueColumn: config.yColumn,
        });
      }
    },
    render: renderBoxplot,
    defaultLabel: (config) =>
      config.measureColumn
        ? `${config.measureColumn} by ${config.column}`
        : `Boxplot: ${config.column}`,
    preview: CHART_PREVIEWS.boxplot,
  },
  {
    type: 'heatmap',
    label: 'Heatmap',
    icon: 'grid_on',
    supportsAggregation: true,
    supportsBinning: false,
    requiresNumericDimension: false,
    primaryColumnLabel: 'X Dimension',
    supportsYColumn: true,
    yColumnLabel: 'Y Dimension',
    supportsGroupColumn: false,
    supportsSizeColumn: false,
    description: 'Visualize magnitude across two dimensions using color',
    createLoader: (engine, query, config, entry) => {
      if (config.yColumn) {
        entry.heatmapLoader = new SQLHeatmapLoader({
          engine,
          query,
          xColumn: config.column,
          yColumn: config.yColumn,
          valueColumn: config.measureColumn ?? config.column,
        });
      }
    },
    render: renderHeatmap,
    defaultLabel: (config) =>
      config.yColumn
        ? `${config.column} vs ${config.yColumn}`
        : `Heatmap: ${config.column}`,
    preview: CHART_PREVIEWS.heatmap,
  },
  {
    type: 'cdf',
    label: 'CDF',
    icon: 'trending_up',
    supportsAggregation: false,
    supportsBinning: false,
    requiresNumericDimension: true,
    primaryColumnLabel: 'Value Column',
    supportsYColumn: false,
    supportsGroupColumn: true,
    supportsSizeColumn: false,
    description:
      'Cumulative distribution — proportion of values below a threshold',
    createLoader: (engine, query, config, entry) => {
      entry.cdfLoader = new SQLCdfLoader({
        engine,
        query,
        valueColumn: config.column,
        seriesColumn: config.groupColumn,
      });
    },
    render: renderCdf,
    defaultLabel: (config) => `CDF: ${config.column}`,
    preview: CHART_PREVIEWS.cdf,
  },
  {
    type: 'scorecard',
    label: 'Scorecard',
    icon: 'numbers',
    supportsAggregation: true,
    supportsBinning: false,
    requiresNumericDimension: false,
    primaryColumnLabel: 'Column',
    supportsYColumn: false,
    supportsGroupColumn: false,
    supportsSizeColumn: false,
    description: 'Display a single aggregated number prominently',
    createLoader: (engine, query, config, entry) => {
      entry.singleValueLoader = new SQLSingleValueLoader({
        engine,
        query,
        measureColumn: config.measureColumn ?? config.column,
      });
    },
    render: (ctx, config, entry) =>
      renderScorecard(ctx, config, entry, getDefaultChartLabel(config)),
    defaultLabel: (config) =>
      `${config.aggregation ?? 'COUNT_DISTINCT'}(${config.measureColumn ?? config.column})`,
    preview: CHART_PREVIEWS.scorecard,
  },
] as const;

/**
 * The live set of chart types: the built-ins, followed by whatever has been
 * registered. Only registered entries are ever removed again, so the built-ins
 * stay at the front and cannot be lost by a plugin's clean-up.
 */
const chartTypes: ChartTypeDefinition[] = [...BUILT_IN_CHART_TYPES];

/**
 * Add a chart type to the registry.
 *
 * Registered types appear after the built-ins everywhere the registry drives
 * the UI (the chart type dropdown and the picker grid).
 *
 * The registry is global and outlives a trace, so a plugin registering from
 * onTraceLoad must dispose of its registration when the trace goes away:
 *
 *   trace.trash.use(registerChartType(def));
 *
 * Registering a type that is already registered throws, which is what makes a
 * leaked registration visible on the next trace load rather than silently
 * winning or losing.
 *
 * @param def The chart type definition to add
 * @returns A disposable that removes this registration again.
 */
export function registerChartType(def: ChartTypeDefinition): Disposable {
  if (chartTypes.some((d) => d.type === def.type)) {
    throw new Error(`Chart type '${def.type}' is already registered`);
  }
  chartTypes.push(def);
  return {
    [Symbol.dispose]: () => {
      // Found by identity, not by type name: disposing a stale registration
      // must not clobber whatever has replaced it in the meantime.
      const index = chartTypes.indexOf(def);
      if (index !== -1) {
        chartTypes.splice(index, 1);
      }
    },
  };
}

/**
 * All currently known chart types, in UI order.
 *
 * Call this rather than caching the result at module scope: registrations come
 * and go with the traces that made them, long after this module is first
 * imported.
 */
export function getChartTypes(): readonly ChartTypeDefinition[] {
  return chartTypes;
}

/**
 * Get the definition for a specific chart type.
 *
 * @param type The chart type to look up
 * @returns The chart type definition, or undefined if not registered
 */
export function getChartTypeDefinition(
  type: ChartType,
): ChartTypeDefinition | undefined {
  return chartTypes.find((d) => d.type === type);
}

/**
 * Check if a given string names a registered chart type.
 *
 * @param type String to validate
 * @returns True if a chart type with this identifier is registered
 */
export function isValidChartType(type: string): boolean {
  return chartTypes.some((d) => d.type === type);
}

/**
 * Default display label for a chart the user hasn't named.
 * Used by the node card, the chart view header and the dashboard.
 */
export function getDefaultChartLabel(config: ChartConfig): string {
  if (!config.column) return 'Not configured';
  const def = getChartTypeDefinition(config.chartType);
  return def?.defaultLabel(config) ?? `${config.chartType}: ${config.column}`;
}

/**
 * Filter a column list down to those usable as a chart's primary column.
 * Chart types that require a numeric dimension only accept quantitative
 * columns; every other type accepts anything.
 */
export function getChartableColumns(
  chartType: ChartType,
  columns: ReadonlyArray<ColumnInfo>,
): ReadonlyArray<ColumnInfo> {
  if (getChartTypeDefinition(chartType)?.requiresNumericDimension !== true) {
    return columns;
  }
  return columns.filter(
    (col) => col.type !== undefined && isQuantitativeType(col.type),
  );
}

/** Create the appropriate SQL loader(s) for a chart config. */
export function createChartLoaders(
  engine: Engine,
  query: string,
  config: ChartConfig,
  entry: ChartLoaderEntry,
): void {
  getChartTypeDefinition(config.chartType)?.createLoader(
    engine,
    query,
    config,
    entry,
  );
}

/**
 * Render the appropriate chart widget for a config + loader entry.
 *
 * A config can name a chart type that isn't registered — dashboards persist
 * the type as a bare string, so a dashboard saved while another plugin was
 * loaded survives a reload without it. Render a placeholder saying so rather
 * than nothing at all.
 */
export function renderChartByType(
  ctx: ChartRenderContext,
  config: ChartConfig,
  entry: ChartLoaderEntry,
): m.Child {
  const def = getChartTypeDefinition(config.chartType);
  if (def === undefined) {
    return renderUnknownChartType(config.chartType);
  }
  return def.render(ctx, config, entry);
}
