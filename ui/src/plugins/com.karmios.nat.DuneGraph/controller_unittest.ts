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
 * The load gates: which of them a trace has to clear before the graph, the node
 * tables and the edge tables get built.
 *
 * There is one soft gate - the row estimate against the setting, checked before
 * anything is parsed - and one hard cap on the edge tier, which is a refusal
 * rather than a question. This file pins that there is exactly one of each: a
 * graph that used to need a second yes for its edge tables now gets them from
 * the first one, and the hard cap still stops short of an error state.
 *
 * The controller is driven through a stub engine, the same trick
 * `sql_graph_unittest.ts` uses: there is no trace processor in a unit test, so
 * what can be checked is which steps the controller decides to run, not what a
 * query over their tables returns.
 */

import {describe, expect, test} from 'vitest';
import type {Engine} from '../../trace_processor/engine';
import {
  AUTO_LOAD_ROW_LIMIT_SETTING,
  DEFAULT_AUTO_LOAD_ROW_LIMIT,
  DuneGraphController,
} from './controller';
import type {Trace} from '../../public/trace';
import type {BuildGraph} from './graph';
import {DEPS_SECTION} from './graph_blob';
import {dep, rule, testGraph} from './graph_test_helper';
import {EDGE_HARD_LIMIT} from './sql_graph';

// A graph small enough to mirror in a test but with real edges in it, so the
// two mirror builders have something to walk.
const g = testGraph([
  dep('a/x.cmi', {resolvedRule: 'r1'}),
  rule('r1', {dir: 'a', targetFiles: ['x.cmi'], staticDeps: ['a/y.ml']}),
  dep('a/y.ml', {isSource: true}),
]);

/**
 * The same fixture graph, claiming a different edge count.
 *
 * A hundred million edges can't be built in a unit test, and neither can the
 * ten million the deleted soft cap sat at. Only the controller's gates read
 * `graph.edgeCount` - the mirror builders count the CSR themselves, see
 * `censusEdges` in sql_graph.ts - so shadowing it moves the gate without moving
 * the work. Prototype delegation rather than a spread: `BuildGraph` is a class
 * whose methods read its columnar store off `this`.
 */
function claimingEdges(graph: BuildGraph, edgeCount: number): BuildGraph {
  return Object.create(graph, {edgeCount: {value: edgeCount}}) as BuildGraph;
}

// A controller wired to a stub engine, plus the two knobs the gates read.
interface Harness {
  readonly controller: DuneGraphController;
  // Every statement the engine was handed, in order.
  readonly sql: readonly string[];
  // The setting's value, as the settings page would have it. `undefined` is
  // "never registered" - what a controller sees with no plugin activation.
  limit?: number;
}

/**
 * Builds a controller over a stub engine.
 *
 * `blobBytes` is the size the pre-load probe (`TraceGraphSource.stats`) sees on
 * the one blob section that carries dep ids, which is what the row estimate is
 * divided out of. The tests below read the estimate back off the controller
 * rather than recomputing it, so they don't restate the divisor.
 */
function makeHarness(opts: {readonly blobBytes?: number} = {}): Harness {
  const sql: string[] = [];
  // One blob section, so `stats()` has something to sum. Its `iter` shape is
  // the query-result cursor: valid/next plus the columns as properties.
  const sections = [
    {section: DEPS_SECTION, chunks: 1, bytes: BigInt(opts.blobBytes ?? 0)},
  ];
  const blobResult = {
    iter: () => {
      let i = 0;
      return {
        valid: () => i < sections.length,
        next: () => i++,
        get section() {
          return sections[i].section;
        },
        get chunks() {
          return sections[i].chunks;
        },
        get bytes() {
          return sections[i].bytes;
        },
      };
    },
    firstRow: () => sections[0],
  };
  // Everything else - the lifecycle aggregate and every statement the two
  // mirror builders issue - only has to answer without rows.
  const emptyResult = {
    iter: () => ({valid: () => false, next: () => {}}),
    firstRow: () => ({n: 0, instants: 0}),
  };
  const answer = (q: string) => {
    sql.push(q);
    // The only query whose rows are read is the blob-section aggregate.
    return Promise.resolve(
      q.includes('group by s.name') ? blobResult : emptyResult,
    );
  };
  const harness: Harness = {
    controller: undefined as unknown as DuneGraphController,
    sql,
  };
  const trace = {
    engine: {query: answer, tryQuery: answer} as unknown as Engine,
    settings: {
      get: (id: string) =>
        id === AUTO_LOAD_ROW_LIMIT_SETTING && harness.limit !== undefined
          ? {get: () => harness.limit}
          : undefined,
    },
    raf: {scheduleFullRedraw: () => {}},
  } as unknown as Trace;
  return Object.assign(harness, {controller: new DuneGraphController(trace)});
}

// A loaded graph without a load: `doLoadGraph` is a no-op once its step is
// ready, which is what lets a test hand the controller a graph it could never
// have parsed out of the stub engine.
function withGraph(h: Harness, graph: BuildGraph): void {
  h.controller.graph = graph;
  h.controller.graphStep.status = 'ready';
}

describe('autoLoadEdgeRowLimit', () => {
  test('falls back to the default when the setting is unregistered', () => {
    // What a controller built without the plugin having been activated sees.
    expect(makeHarness().controller.autoLoadEdgeRowLimit).toBe(
      DEFAULT_AUTO_LOAD_ROW_LIMIT,
    );
  });

  test('is read afresh on every access', () => {
    // Nothing re-runs when the setting changes, so the panel only reflects an
    // edit because the value isn't cached.
    const h = makeHarness();
    h.limit = 10;
    expect(h.controller.autoLoadEdgeRowLimit).toBe(10);
    h.limit = 20;
    expect(h.controller.autoLoadEdgeRowLimit).toBe(20);
  });
});

describe('autoLoads', () => {
  test('is false until the stats are in', () => {
    const h = makeHarness({blobBytes: 7});
    h.limit = 1_000_000;
    expect(h.controller.autoLoads).toBe(false);
  });

  test('turns over on the setting', async () => {
    const h = makeHarness({blobBytes: 7_000});
    await h.controller.loadStats();
    const rows = h.controller.stats?.estimatedEdgeRows ?? 0;
    expect(rows).toBeGreaterThan(0);

    // The limit is the last size that still loads unprompted.
    h.limit = rows;
    expect(h.controller.autoLoads).toBe(true);
    h.limit = rows - 1;
    expect(h.controller.autoLoads).toBe(false);
    // 0 is how "always ask" is written, and the schema's floor.
    h.limit = 0;
    expect(h.controller.autoLoads).toBe(false);
  });
});

describe('load', () => {
  test('builds the edge tier the old soft cap would have skipped', async () => {
    // 20M edges: past the 10M the deleted EDGE_SOFT_LIMIT sat at, so this used
    // to end with the edge step idle and a "Build edge tables" offer in the
    // panel. The one question is asked before the parse now, and this graph
    // has already got past it.
    const h = makeHarness();
    withGraph(h, claimingEdges(g.graph, 20_000_000));
    await h.controller.load();
    expect(h.controller.nodeMirrorStep.status).toBe('ready');
    expect(h.controller.edgeMirrorStep.status).toBe('ready');
    expect(h.sql.some((q) => q.includes('_dune_depset'))).toBe(true);
  });

  test('skips the edge tier past the hard cap, without failing', async () => {
    // The hard cap is a memory ceiling, so it is pre-checked rather than left
    // to throw out of buildEdgeMirror: the panel explains a refusal, where it
    // would only be able to print an error string.
    const h = makeHarness();
    withGraph(h, claimingEdges(g.graph, EDGE_HARD_LIMIT + 1));
    await h.controller.load();
    expect(h.controller.edgeTierRefused).toBe(true);
    expect(h.controller.nodeMirrorStep.status).toBe('ready');
    expect(h.controller.edgeMirrorStep.status).toBe('idle');
    expect(h.controller.edgeMirrorStep.error).toBeUndefined();
    expect(h.sql.some((q) => q.includes('_dune_depset'))).toBe(false);
  });
});
