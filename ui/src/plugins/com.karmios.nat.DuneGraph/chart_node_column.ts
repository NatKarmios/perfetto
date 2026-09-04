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
 * The one piece of chart plumbing both Dune chart types need: which column of a
 * chart's query holds a `dune_node.node_id`.
 *
 * Every Data Explorer chart type reads its config's primary column as some one
 * thing - a dimension, a measure, an axis. Both of ours read it as a node
 * id, because that is the only thing that maps a query's rows onto the build
 * graph: the directory tree needs it to know where a row is filed
 * (dir_explorer_chart.ts), and the node graph needs it to know which nodes to
 * draw (node_graph_chart.ts).
 *
 * Both then have the same problem. The chart picker's default primary column is
 * chosen generically - the first non-numeric column, which on a Dune query is
 * usually a label or a path - so a chart dropped on a query would otherwise join
 * on a string, match nothing, and draw an empty picture of it. The offer to fix
 * that is what lives here: it was written for the directory tree, and the node
 * graph wants it verbatim, which is the second data point that says it belongs
 * to neither of them.
 *
 * It stops at *offering*. The column picker is the chart config's own, and
 * quietly substituting a different column behind the user's back is what the
 * directory chart used to do.
 */

import m from 'mithril';
import {Button} from '../../widgets/button';
import {EmptyState} from '../../widgets/empty_state';
import {Intent} from '../../widgets/common';
import type {ColumnInfo} from '../dev.perfetto.DataExplorer/query_builder/column_info';
import type {ChartConfig} from '../dev.perfetto.DataExplorer/query_builder/nodes/visualisation_node';
import type {ChartRenderContext} from '../dev.perfetto.DataExplorer/query_builder/charts/chart_renderers';

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
export const NODE_ID_COLUMNS: readonly string[] = ['node_id', 'src', 'dst'];

/**
 * The column that should hold node ids but isn't the one configured, or
 * undefined when the configured one will do.
 *
 * A configured column that is one of the known node id names is taken as
 * deliberate. So is one that isn't, when the query offers no better - a query
 * may well have aliased its node id to something else, and only its author
 * knows.
 *
 * @param column The chart config's primary column.
 * @param cols The columns the chart's query actually returns.
 */
export function resolveNodeColumn(
  column: string,
  cols: ReadonlyArray<ColumnInfo>,
): string | undefined {
  if (NODE_ID_COLUMNS.includes(column)) return undefined;
  const names = new Set(cols.map((c) => c.name));
  return NODE_ID_COLUMNS.find((c) => names.has(c));
}

/**
 * The offer to point a chart at a column that actually holds node ids.
 *
 * The click is the config popup's own `updateChart`, so it persists exactly as
 * picking the column there would - and rebuilding the loader on the new column
 * is then the host's business rather than the chart's.
 *
 * @param ctx The render context, for the config update the button applies.
 * @param config The chart's config, whose `column` is the one being questioned.
 * @param suggestion The column to offer instead (from {@link resolveNodeColumn}).
 * @param icon The chart's own icon, so the prompt still looks like the card it
 *   replaced rather than like a generic error.
 */
export function renderNodeColumnPrompt(
  ctx: ChartRenderContext,
  config: ChartConfig,
  suggestion: string,
  icon: string,
): m.Children {
  return m(
    EmptyState,
    {icon, title: 'Pick the node id column'},
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
