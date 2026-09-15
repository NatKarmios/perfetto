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
 * One query, `sql()` below. Unlike the directory chart's source it has no
 * aggregate to hide behind - every node it draws crosses into the browser as a
 * row - so the transfer is bounded explicitly by {@link NODE_GRAPH_MAX_NODES},
 * and `count(*) OVER ()` computes the true total alongside it. The window
 * function makes the engine walk the whole join before emitting anything and
 * the `LIMIT` applies last, so `total` is exact whatever the cap did: when it
 * is within the cap, the rows in hand are the whole answer rather than a page
 * of it. `SELECT DISTINCT` is not optional - an edge query has a `src` per
 * edge, not per node - and `ORDER BY n.node_id` is what makes a re-run redraw
 * the same picture: graph_layout.ts orders each rank structurally now, so the
 * row order no longer decides the picture, but it is still the tie-break the
 * ordering heuristic walks from.
 */

import {getErrorMessage} from '../../../base/errors';
import {quoteIdentifier} from '../../../components/widgets/datagrid/sql_utils';
import type {Engine} from '../../../trace_processor/engine';
import {NUM} from '../../../trace_processor/query_result';
import type {DuneGraphController} from '../controller';
import type {NodeId} from '../model/graph';

// How many nodes the chart draws at once - and so, since it draws all or none,
// the most a query may name before the card refuses it. The three limits that
// agree on a few hundred are in ARCHITECTURE.md, "Performance"; 400 rather than 200
// because the pathological case, every node on one rank, is not the usual one.
// node_graph_chart.ts argues the all-or-nothing where it acts on it.
export const NODE_GRAPH_MAX_NODES = 400;

// Monotonic across every source in the process, which is why it is a module
// variable. It is the panel's relayout key, and the panel outlives the source:
// a per-source counter would hand the panel a different source's "1" after its
// own "1" and the graph would never be laid out again.
let nextVersion = 1;

// Where the load has got to. The cap is *not* a phase - the chart reads it off
// `total`.
type NodeSetState =
  | {readonly phase: 'idle'}
  | {readonly phase: 'loading'}
  | {
      readonly phase: 'ready';
      // At most NODE_GRAPH_MAX_NODES, and every node the query named whenever
      // `total` is within that.
      readonly nodes: readonly NodeId[];
      // How many the query named in all. Exact whatever the `LIMIT` did.
      readonly total: number;
      readonly version: number;
    }
  | {readonly phase: 'error'; readonly message: string};

// Built once per (table, config) by the chart's loader and thrown away with it
// (see `ChartLoaderEntry.custom`): building it in `render` would hand the panel
// a new node set every frame, and a new version means a relayout, so the card
// would recentre itself continuously.
//
// The load is lazy and happens at most once per mirror version - a graph reload
// renumbers every node, so the ids held here stop meaning anything.
export class ChartNodeGraphSource {
  private stateValue: NodeSetState = {phase: 'idle'};
  private loadPromise?: Promise<void>;
  private loadedVersion?: number;
  private disposed = false;

  // `query` is the chart's input as the host hands it over: embedded as a
  // subquery, never executed on its own. `nodeColumn` is its column holding a
  // `dune_node.node_id`.
  constructor(
    private readonly engine: Engine,
    private readonly controller: DuneGraphController,
    private readonly query: string,
    private readonly nodeColumn: string,
  ) {}

  // Cheap; read every render.
  get state(): NodeSetState {
    return this.stateValue;
  }

  // Safe to call every frame: the promise is cached, a rejected one stays
  // cached, and the message lands on `state` rather than at the caller.
  ensureLoaded(): void {
    const version = this.controller.mirrorVersion;
    if (this.loadPromise === undefined || this.loadedVersion !== version) {
      this.loadedVersion = version;
      this.stateValue = {phase: 'loading'};
      this.loadPromise = this.fetch();
    }
  }

  // Called through `ChartLoaderEntry.custom`.
  dispose(): void {
    this.disposed = true;
    this.loadPromise = undefined;
    this.stateValue = {phase: 'idle'};
  }

  // Nothing is thrown at the caller: a failed load is something the card shows,
  // so the message lands on `state`.
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

  // Split out so a test can assert on the SQL without an engine. See the file
  // header for why the query is shaped this way.
  //
  // `quoteIdentifier` because the column name comes from a chart's config -
  // persisted, user-typed - so it is not something to interpolate raw. This is
  // *identifier* quoting, not `sqlValue`'s string-literal quoting; conflating
  // them is a bug both ways.
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
