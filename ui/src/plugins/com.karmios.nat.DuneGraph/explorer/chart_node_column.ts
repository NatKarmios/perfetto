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
 * chart's query holds a `dune_node.node_id`. Both read their config's primary
 * column as one, because that is the only thing that maps a row onto the build
 * graph, and the chart picker's generic default - the first non-numeric column,
 * usually a label or a path - would otherwise have them join on a string and
 * draw an empty picture.
 *
 * Two halves, and the order matters. {@link defaultNodeColumn} stops the
 * problem happening: it is the descriptor's `defaultColumn` hook, so a chart
 * added to a query that has a node id column *starts* on it. {@link
 * renderNodeColumnPrompt} is the fallback for when it did not - the user picked
 * something else, or the query aliased its node id to a name we cannot guess -
 * and that one stops at *offering*, because the column picker is the chart
 * config's own and substituting behind the user's back once they have chosen is
 * a different thing from choosing for them up front.
 */

import m from 'mithril';
import {Button} from '../../../widgets/button';
import {EmptyState} from '../../../widgets/empty_state';
import {Intent} from '../../../widgets/common';
import type {ColumnInfo} from '../../dev.perfetto.DataExplorer/query_builder/column_info';
import type {ChartConfig} from '../../dev.perfetto.DataExplorer/query_builder/nodes/visualisation_node';
import type {ChartRenderContext} from '../../dev.perfetto.DataExplorer/query_builder/charts/chart_renderers';

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
 * The column a Dune chart should start on, given the columns a query returns.
 *
 * The `defaultColumn` hook of both descriptors. Without it the host picks the
 * first non-numeric column - on a Dune query usually a label or a path - so a
 * chart dropped on `dune_node` would join a string against node ids, match
 * nothing, and need correcting before it drew anything.
 *
 * Undefined when the query has none of the known names, which hands the choice
 * back to the host's generic rule and leaves {@link renderNodeColumnPrompt} to
 * say so if that turns out badly.
 *
 * @param cols The columns the chart's query returns.
 */
export function defaultNodeColumn(
  cols: ReadonlyArray<{readonly name: string}>,
): string | undefined {
  const names = new Set(cols.map((c) => c.name));
  return NODE_ID_COLUMNS.find((c) => names.has(c));
}

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
  return defaultNodeColumn(cols);
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
