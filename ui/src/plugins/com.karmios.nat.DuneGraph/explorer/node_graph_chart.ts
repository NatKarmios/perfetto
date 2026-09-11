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
 * The side panel's node graph offered as a Data Explorer *chart type*: a query's
 * rows, drawn as the build graph between the nodes they named.
 *
 * The same pane the side panel draws (graph_panel.ts), over a different node
 * set: the card's query rather than the graph selection. That is the whole
 * point - a query says "every rule in this directory that failed" far faster
 * than clicking does, and the edges between whatever it names are drawn for
 * free, the graph being in memory already.
 *
 * Nothing else about the pane changes: same induced subgraph, same contraction
 * through hidden rules, same "Hide rules" toggle on the controller, same jump
 * to a node's slice on a click. The only things the card does not offer are the
 * two toolbar actions that act on the *selection* rather than on what is drawn,
 * "Timeline" and "Clear" - see `GraphPanelNodes`. `config.column` is read as
 * the node id column, exactly as the directory chart reads it (see
 * chart_node_column.ts).
 *
 * **Unlike the directory chart, this one has a cap.** That chart's tree is
 * bounded by the mirror however large its query; this one draws a dot per node,
 * so the query's size is the card's size. {@link NODE_GRAPH_MAX_NODES} is the
 * limit, justified in node_graph_source.ts where it lives, and it is all or
 * nothing: a query within it is drawn entire, and one past it is refused by
 * name rather than sampled down to size, for the reason given at the refusal
 * below.
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
import {EmptyState} from '../../../widgets/empty_state';
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
import {renderMirrorNotLoaded} from '../views/dir_explorer_panel';
import {GraphPanel} from '../views/graph_panel';
import {plural} from '../model/graph';
import {ChartNodeGraphSource, NODE_GRAPH_MAX_NODES} from './node_graph_source';

/**
 * The chart type identifier. Dashboards persist this as a bare string and
 * survive being reopened without us (the registry renders a placeholder naming
 * the type), so it is prefixed rather than a bare word like the built-ins:
 * whatever else may come to register a chart type, it will not be this.
 */
const NODE_GRAPH_CHART_TYPE = 'dune-node-graph';

// The card's icon, reused by every state that stands in for it so a
// misconfigured chart still reads as this chart rather than as an error.
const ICON = 'hub';

// What the pane needs that the node tier is the source of: the graph itself is
// parsed by the time `dune_node` exists, so the one readiness check covers both
// the query below and the edges the pane draws from memory.
const NOT_LOADED = {
  icon: ICON,
  title: 'Build graph not loaded',
  note:
    'The nodes a query names, and the dependencies between them, come from ' +
    "the graph's node tables, which have not been built for this trace yet.",
};

/**
 * Registers the node graph chart type for as long as `trace` lives.
 *
 * The chart registry is global and outlives a trace, and the pane it renders
 * closes over a controller belonging to *this* trace, so the registration goes
 * in the trace's trash and the next trace load registers afresh - see
 * dir_explorer_chart.ts, which says the same thing at length.
 *
 * @param trace The trace the registration's lifetime is tied to.
 * @param controller The controller whose graph the nodes are drawn from.
 */
export function registerNodeGraphChart(
  trace: Trace,
  controller: DuneGraphController,
): void {
  trace.trash.use(
    registerChartType({
      type: NODE_GRAPH_CHART_TYPE,
      label: 'Dune Node Graph',
      icon: ICON,
      description:
        "Draw the query's nodes as a layered graph of the build " +
        'dependencies between them',

      // Nothing to configure beyond the primary column: there is no measure to
      // aggregate and no axis to bin - a node is drawn or it isn't - and every
      // other property of a dot comes out of the graph itself.
      supportsAggregation: false,
      supportsBinning: false,
      requiresNumericDimension: false,
      // Named for what it is read as, since it is not a dimension or a measure
      // and the popup offers no other hint.
      primaryColumnLabel: 'Node id column',
      // So a chart dropped on a query that has one just draws, instead of
      // landing on the host's generic first-non-numeric guess and having to
      // ask (see chart_node_column.ts).
      defaultColumn: defaultNodeColumn,
      supportsYColumn: false,
      supportsGroupColumn: false,
      supportsSizeColumn: false,

      // Created here, once per (table, config), which is the lifetime the host
      // already manages for a loader. Building it in `render` instead would
      // hand the pane a new node set every frame, and a new node set means a
      // relayout: the card would recentre itself continuously.
      //
      // The query is *not* run here; the source loads lazily, so a chart that
      // cannot draw anything yet costs nothing.
      createLoader: (engine, query, config, entry) => {
        entry.custom = new ChartNodeGraphSource(
          engine,
          controller,
          query,
          config.column,
        );
      },

      render: (ctx, config, entry) =>
        m(
          '.pf-dune-node-chart',
          renderChartBody(controller, ctx, config, entry),
        ),

      // The card is the query's graph, and the query is named by the node it
      // sits on; the column that maps rows to nodes is plumbing rather than a
      // title.
      defaultLabel: () => 'Dune node graph',

      // No `preview`: the picker falls back to `icon` for types without an SVG
      // thumbnail.
    }),
  );
}

/**
 * Everything inside the card: the graph, or an honest account of why there
 * isn't one.
 *
 * The order of the checks is the order the answers become knowable - no graph,
 * then no node id column, then no rows to load, then the load itself, then what
 * it found - so each one only ever reports the first thing that is actually
 * wrong.
 */
function renderChartBody(
  controller: DuneGraphController,
  ctx: ChartRenderContext,
  config: ChartConfig,
  entry: ChartLoaderEntry,
): m.Children {
  if (!controller.nodeMirrorReady) {
    return renderMirrorNotLoaded(controller, NOT_LOADED);
  }

  const suggestion = resolveNodeColumn(config.column, ctx.node.sourceCols);
  if (suggestion !== undefined) {
    return renderNodeColumnPrompt(ctx, config, suggestion, ICON);
  }

  const source = entry.custom;
  if (!(source instanceof ChartNodeGraphSource)) {
    return renderChartWaiting(ICON);
  }

  // Kicked from the render rather than from the pane, so the states below can
  // be told apart before the pane is mounted: the pane, handed an empty node
  // set, would only be able to say "no nodes selected".
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

  if (state.total === 0) return renderChartNoNodes(config, 'the build graph');

  // The refusal, and the whole reason the cap is all-or-nothing rather than a
  // sample with a warning over it: a partial picture of a build graph is not a
  // thinner answer, it is a misleading one, and here systematically so. The
  // node set is capped by `ORDER BY node_id LIMIT`, node ids *are* the kind
  // partition (rules are `[0, ruleCount)`, see sql_graph.ts), and no edge in
  // this graph joins two rules - so the nodes that would survive are the
  // rules, and the picture would be several hundred dots with not one line
  // between them. That does not read as a corner of a dense graph; it reads as
  // a build with no dependencies in it. Naming the number and asking for a
  // narrower query is the more useful answer, and the only honest one.
  if (state.total > NODE_GRAPH_MAX_NODES) {
    return m(
      EmptyState,
      {icon: 'filter_alt', title: 'Too many nodes to draw'},
      m(
        '.pf-dune-graph__load-note',
        `This query names ${plural(state.total, 'Dune node')}, and the graph ` +
          `is laid out by hand up to ${NODE_GRAPH_MAX_NODES}. Drawing part of ` +
          'them would not be a smaller version of the answer: the nodes that ' +
          'fit are the ones with no dependencies between them, so the card ' +
          'would show a scatter of unconnected dots. Narrow the query - by ' +
          'directory, by rule, or by whatever made you ask - and the graph of ' +
          'what is left will be readable too.',
      ),
    );
  }

  return m(GraphPanel, {
    controller,
    nodes: {
      nodes: state.nodes,
      total: state.total,
      version: state.version,
    },
  });
}
