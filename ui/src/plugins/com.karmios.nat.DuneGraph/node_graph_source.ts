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
 * The node set behind the Dune node graph chart (see node_graph_chart.ts): the
 * nodes a query's rows named, capped, plus how many there were.
 *
 * ## One query, and what makes it bounded
 *
 * The chart draws nodes rather than counting them, so unlike the directory
 * chart's source (dir_chart_source.ts) there is no aggregate to hide behind:
 * every node it draws has to cross into the browser as a row. A query's rows
 * are unbounded - a bare `SELECT ... FROM dune_node` names all 818k nodes of
 * the monorepo trace - so the transfer is bounded explicitly, by
 * {@link NODE_GRAPH_MAX_NODES}, and the count that says whether the cap bit is
 * computed alongside it with `count(*) OVER ()`:
 *
 * ```sql
 * SELECT n.node_id AS node_id, count(*) OVER () AS total
 * FROM dune_node n
 * JOIN (SELECT DISTINCT "src" AS node_id FROM (<the chart's query>)) q
 *   ON q.node_id = n.node_id
 * ORDER BY n.node_id
 * LIMIT 400
 * ```
 *
 * The window function makes the engine walk the whole join before it emits
 * anything, which is exactly what a `SELECT count(*)` would have cost and is
 * what the trace processor is for; the `LIMIT` then applies last, so what
 * crosses the boundary is at most the cap however large the input was. A second
 * counting query would be the alternative, and would run the join twice.
 *
 * The join is driven **from** the input into `dune_node`'s primary key - the
 * same direction and the same reasoning as the directory chart's counts query -
 * so it is one index probe per distinct input node rather than a scan of the
 * mirror. `SELECT DISTINCT` is not optional: an input naming the same node more
 * than once is normal rather than exotic (an edge query has a `src` per edge,
 * not per node), and without it the cap would be spent on repeats and `total`
 * would count edges while calling them nodes.
 *
 * `total` is therefore exact whatever the `LIMIT` did, and that is what makes
 * the cap an all-or-nothing one: when `total` is within it, the rows that came
 * back are not a page of the answer but the whole of it - every node the query
 * named, and so every edge between them. Past it the chart draws nothing and
 * says the number instead; the reasoning for that is at the refusal itself, in
 * node_graph_chart.ts.
 *
 * `ORDER BY n.node_id` is what makes a re-run redraw the same picture. Rows
 * reach graph_layout.ts in the order they arrive and a rank keeps that order
 * (there is no crossing reduction to impose one), so an unordered join would
 * lay the same nodes out differently from one load to the next. It costs
 * nothing - it is the order the mirror's primary key is already in.
 *
 * ## Why there is a cap here when the directory chart has none
 *
 * The directory chart deliberately has no cap: its `GROUP BY` collapses any
 * input to at most two rows per directory before anything leaves the engine, so
 * its tree is bounded by `dune_dir` (~19k rows) rather than by the query. This
 * one is bounded by nothing at all, and what it feeds - graph_layout.ts - is a
 * hand-rolled layered layout with no crossing reduction. So the number is about
 * what that layout and the SVG it becomes can actually carry; see below.
 */

import {getErrorMessage} from '../../base/errors';
import {quoteIdentifier} from '../../components/widgets/datagrid/sql_utils';
import type {Engine} from '../../trace_processor/engine';
import {NUM} from '../../trace_processor/query_result';
import type {DuneGraphController} from './controller';
import type {NodeId} from './graph';

/**
 * How many nodes the chart will draw at once - and so, since it draws all of
 * them or none, the most a query may name before the card refuses it.
 *
 * One number rather than a soft cap and a hard one, because a graph drawn from
 * part of what was asked for is not a thinner answer, it is a wrong one: which
 * part survives is not arbitrary, and the drawn edges are only those with both
 * ends inside it. node_graph_chart.ts makes that argument where it acts on it.
 *
 * This is the cost ceiling, and it is what stops a query naming most of the
 * build from freezing the tab. Three things set it, and they agree on a few
 * hundred:
 *
 * - **The geometry.** A rank in graph_layout.ts is a row of dots `NODE_WIDTH +
 *   GAP` apart, so `k` nodes on one rank is `36k - 20` layout units wide. The
 *   panel's `MAX_ZOOM` is 20 layout units per CSS pixel, so the widest row that
 *   can ever be got fully into a pane `W` pixels across is `k = (20W + 20)/36`
 *   - about 440 nodes in an 800px card, about 220 in a 400px one. Past a few
 *   hundred nodes on a rank, "Fit" stops being able to show the graph at all.
 * - **The redraw.** Every node is a `<circle>` and every edge a `<line>` with
 *   an arrowhead marker, and the whole lot is rebuilt as mithril vnodes and
 *   diffed on *every* frame of a pan or a zoom (the viewBox changes, so the
 *   subtree is revisited). A build graph's induced subgraph runs to a few edges
 *   per node, so 400 nodes is already a couple of thousand SVG elements per
 *   frame - about what fits in a frame budget.
 * - **Legibility.** graph_layout.ts has no crossing reduction: rows keep input
 *   order, so a rank of `k` nodes draws its edges through up to `k(k-1)/2`
 *   crossings. Well before the two limits above, the picture stops being one.
 *
 * 400 rather than 200 because the pathological case - every node on one rank -
 * is not the usual one: a layered build subgraph spreads over many ranks, and a
 * cap set for the worst case would turn away graphs that lay out perfectly
 * well.
 */
export const NODE_GRAPH_MAX_NODES = 400;

/**
 * Monotonic across every source in the process, and the reason this is a module
 * variable rather than a field.
 *
 * The number is the panel's relayout key (see `GraphPanelNodes.version`), and
 * the panel outlives the source feeding it: the host rebuilds the loader
 * whenever the chart's query or column changes, while the mithril component
 * instance in the card stays put. A per-source counter would hand the panel a
 * different source's "1" after its own "1" and the graph would not be laid out
 * again.
 */
let nextVersion = 1;

/**
 * Where the load has got to, for the chart to render around the panel.
 *
 * A discriminated union rather than a bag of optional fields because the chart
 * switches on it exhaustively: each phase is a different thing to show, and
 * "the query named no nodes" has to be distinguishable from "not asked yet".
 * The cap is *not* a phase - the chart reads it off `total`, which is what says
 * whether the rows in hand are the whole answer or a fragment of a larger one.
 */
type NodeSetState =
  | {readonly phase: 'idle'}
  | {readonly phase: 'loading'}
  | {
      readonly phase: 'ready';
      /**
       * The nodes to draw: at most {@link NODE_GRAPH_MAX_NODES} of them, and
       * every node the query named whenever `total` is within that.
       */
      readonly nodes: readonly NodeId[];
      /** How many the query named in all. Exact whatever the `LIMIT` did. */
      readonly total: number;
      /** See {@link nextVersion}. */
      readonly version: number;
    }
  | {readonly phase: 'error'; readonly message: string};

/**
 * The node graph chart's node set, loaded once per mirror version.
 *
 * Built once per (table, config) by the chart's loader and thrown away with it
 * (see `ChartLoaderEntry.custom`), which is the lifetime the host already
 * manages: building it in `render` instead would hand the panel a new node set
 * every frame, and a new version means a relayout, so the card would recentre
 * itself continuously.
 *
 * The load is lazy - a chart whose column is not a node id, or whose graph is
 * not loaded, costs nothing - and happens at most once per mirror version. A
 * graph reload renumbers every node and rebuilds `dune_node`, so the ids held
 * here stop meaning anything; `mirrorVersion` is what notices, exactly as in
 * dir_chart_source.ts.
 */
export class ChartNodeGraphSource {
  private stateValue: NodeSetState = {phase: 'idle'};
  private loadPromise?: Promise<void>;
  private loadedVersion?: number;
  private disposed = false;

  /**
   * @param engine The engine the mirror and the chart's query are read from.
   * @param controller The controller whose mirror version this tracks.
   * @param query The chart's input query, as the chart host hands it over -
   *   embedded as a subquery, never executed on its own.
   * @param nodeColumn The column of `query` holding a `dune_node.node_id`.
   */
  constructor(
    private readonly engine: Engine,
    private readonly controller: DuneGraphController,
    private readonly query: string,
    private readonly nodeColumn: string,
  ) {}

  /** Where the load has got to. Cheap; read every render. */
  get state(): NodeSetState {
    return this.stateValue;
  }

  /**
   * Starts the load if it has not started, so the chart can render the state of
   * it rather than an empty graph.
   *
   * Idempotent and safe to call every frame: the promise is cached, a rejected
   * one stays cached (a failing query is not retried once a frame), and the
   * message is on `state` rather than thrown at the caller.
   */
  ensureLoaded(): void {
    const version = this.controller.mirrorVersion;
    if (this.loadPromise === undefined || this.loadedVersion !== version) {
      this.loadedVersion = version;
      this.stateValue = {phase: 'loading'};
      this.loadPromise = this.fetch();
    }
  }

  /** Frees the node set. Called through `ChartLoaderEntry.custom`. */
  dispose(): void {
    this.disposed = true;
    this.loadPromise = undefined;
    this.stateValue = {phase: 'idle'};
  }

  /**
   * The one query, and the only place the cap enters SQL. See the file header
   * for the shape and for why each part of it is there.
   *
   * Nothing is thrown at the caller: a failed load is a thing the card shows,
   * not an unhandled rejection once a frame, so the message lands on `state`.
   */
  private async fetch(): Promise<void> {
    try {
      const result = await this.engine.query(this.sql());
      const nodes: NodeId[] = [];
      let total = 0;
      const it = result.iter({node_id: NUM, total: NUM});
      for (; it.valid(); it.next()) {
        nodes.push(it.node_id);
        total = it.total;
      }
      if (this.disposed) return;
      this.stateValue = {
        phase: 'ready',
        nodes,
        // No rows means no window function ran, so `total` never moved off 0 -
        // which is the right answer, and is the chart's "named no nodes at all"
        // state.
        total,
        version: nextVersion++,
      };
      this.controller.requestRedraw();
    } catch (e) {
      if (this.disposed) return;
      this.stateValue = {phase: 'error', message: getErrorMessage(e)};
      this.controller.requestRedraw();
    }
  }

  // Split out so a test can assert on the SQL without an engine: it is the
  // whole of what this class does to the query it was handed.
  //
  // `quoteIdentifier`, because the column name comes from a chart's config -
  // persisted in dashboards, typed by a user - and so is not something to
  // interpolate raw. Identifier quoting, note, not `sqlValue`'s string-literal
  // quoting; conflating the two is a bug in both directions.
  sql(): string {
    return `
      SELECT n.node_id AS node_id, count(*) OVER () AS total
      FROM dune_node n
      JOIN (
        SELECT DISTINCT ${quoteIdentifier(this.nodeColumn)} AS node_id
        FROM (${this.query})
      ) q ON q.node_id = n.node_id
      ORDER BY n.node_id
      LIMIT ${NODE_GRAPH_MAX_NODES}
    `;
  }
}
