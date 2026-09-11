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
 *
 * Alongside it, the stand-in views both charts draw before they have a picture:
 * {@link renderChartWaiting}, {@link renderChartLoading},
 * {@link renderChartError} and {@link renderChartNoNodes}. They live here
 * because the two cards say the *same* thing in those states and should go on
 * saying it - a query that maps to no nodes is the same answer whether the card
 * would have drawn a tree or a graph.
 */

import m from 'mithril';
import {Button} from '../../../widgets/button';
import {Callout} from '../../../widgets/callout';
import {EmptyState} from '../../../widgets/empty_state';
import {Intent} from '../../../widgets/common';
import {Spinner} from '../../../widgets/spinner';
import type {ColumnInfo} from '../../dev.perfetto.DataExplorer/query_builder/column_info';
import type {ChartConfig} from '../../dev.perfetto.DataExplorer/query_builder/nodes/visualisation_node';
import type {ChartRenderContext} from '../../dev.perfetto.DataExplorer/query_builder/charts/chart_renderers';
import {DUNE_NODE_ID_COLUMNS} from '../views/node_cell';

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
  return DUNE_NODE_ID_COLUMNS.find((c) => names.has(c));
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
  if (DUNE_NODE_ID_COLUMNS.includes(column)) return undefined;
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

/**
 * What a card shows before its query has produced a results table at all.
 *
 * The host creates a chart's loader only once the upstream node has run, so an
 * absent loader entry is not an error - there is simply nothing to have loaded
 * yet.
 *
 * @param icon The chart's own icon, so the card still reads as itself.
 */
export function renderChartWaiting(icon: string): m.Children {
  return m(
    EmptyState,
    {icon, title: 'Waiting for results'},
    m(
      '.pf-dune-graph__load-note',
      'This query has not produced a results table yet.',
    ),
  );
}

/** What a card shows while its source is reading the query's rows. */
export function renderChartLoading(): m.Children {
  return m(
    '.pf-dune-graph__status',
    m(Spinner),
    m('span', "Reading the query's rows…"),
  );
}

/**
 * What a card shows when mapping its rows onto nodes failed.
 *
 * @param message The source's own error text.
 */
export function renderChartError(message: string): m.Children {
  return m(
    Callout,
    {icon: 'error'},
    `Could not map the query's rows to Dune nodes: ${message}`,
  );
}

/**
 * What a card shows when the query ran but named no node this graph knows.
 *
 * Says which column was read and what it has to hold, because that is the one
 * thing the reader can act on - the usual cause is a column of ids from
 * somewhere other than `dune_node`.
 *
 * @param config The chart's config, for the column name it read.
 * @param place Where the rows would have been drawn ('the tree', 'the build
 *   graph'), so the sentence names the picture that is missing.
 */
export function renderChartNoNodes(
  config: ChartConfig,
  place: string,
): m.Children {
  return m(
    EmptyState,
    {icon: 'search_off', title: 'No Dune nodes in these rows'},
    m(
      '.pf-dune-graph__load-note',
      `Nothing in "${config.column}" matched a node in the graph. That ` +
        'column has to hold a dune_node.node_id for its rows to have a ' +
        `place in ${place}.`,
    ),
  );
}
