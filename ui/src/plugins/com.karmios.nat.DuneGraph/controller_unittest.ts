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
 * rather than a question. This file pins that there is exactly one of each:
 * a yes to the gate buys all three load steps including the edge tier, and the
 * hard cap stops short of an error state.
 *
 * The controller is driven through a stub engine, the same trick
 * `sql_graph_unittest.ts` uses: there is no trace processor in a unit test, so
 * what can be checked is which steps the controller decides to run, not what a
 * query over their tables returns.
 */

import {describe, expect, test} from 'vitest';
import type {Engine} from '../../trace_processor/engine';
import type {Row} from '../../trace_processor/query_result';
import type {LoadStep} from './controller';
import {
  AUTO_LOAD_ROW_LIMIT_SETTING,
  DEFAULT_AUTO_LOAD_ROW_LIMIT,
  DuneGraphController,
} from './controller';
import type {Trace} from '../../public/trace';
import type {BuildGraph, GraphSource} from './model/graph';
import {DEPS_SECTION} from './model/graph_blob';
import {dep, rule, testGraph} from './model/graph_test_helper';
import {graphTrackUri} from './model/graph_tracks';
import {timingKindCode} from './sql/lifecycle_sql';
import type {MirrorProgress} from './sql/sql_graph';
import {
  EDGE_HARD_LIMIT,
  EDGE_MIRROR_PHASES,
  NODE_MIRROR_PHASES,
} from './sql/sql_graph';

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
  // The current timeline selection, as `trace.selection.selection`. Assignable
  // so a test can move the selection the way a click would.
  selection: unknown;
  // Every `selectTrackEvent` the controller made, in order - what a navigation
  // actually landed on.
  readonly selected: {readonly trackUri: string; readonly eventId: number}[];
  // Extra canned answers, consulted before the defaults: the first entry whose
  // `match` the statement contains supplies its rows. Lets a test say what a
  // lookup found without standing up a trace processor.
  canned: {readonly match: string; readonly rows: readonly Row[]}[];
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
    // The single-row lookups (process_sql.ts) check this before reading a row.
    numRows: () => 0,
  };
  const answer = (q: string) => {
    sql.push(q);
    const canned = harness.canned.find((c) => q.includes(c.match));
    if (canned !== undefined) return Promise.resolve(cannedResult(canned.rows));
    // The only other query whose rows are read is the blob-section aggregate.
    return Promise.resolve(
      q.includes('group by s.name') ? blobResult : emptyResult,
    );
  };
  const harness: Harness = {
    controller: undefined as unknown as DuneGraphController,
    sql,
    selection: {kind: 'empty'},
    selected: [],
    canned: [],
  };
  const trace = {
    engine: {query: answer, tryQuery: answer} as unknown as Engine,
    settings: {
      get: (id: string) =>
        id === AUTO_LOAD_ROW_LIMIT_SETTING && harness.limit !== undefined
          ? {get: () => harness.limit}
          : undefined,
    },
    selection: {
      get selection() {
        return harness.selection;
      },
      // Every slice is on one made-up track, keyed by its own id: enough for a
      // navigation to be observable without a trace processor behind it.
      resolveSqlEvents: (_table: string, ids: readonly number[]) =>
        Promise.resolve(
          ids.map((id) => ({trackUri: 'some.other.plugin#Track', eventId: id})),
        ),
      selectTrackEvent: (trackUri: string, eventId: number) => {
        harness.selected.push({trackUri, eventId});
      },
    },
    currentWorkspace: {getTrackByUri: () => undefined},
    raf: {scheduleFullRedraw: () => {}},
  } as unknown as Trace;
  return Object.assign(harness, {controller: new DuneGraphController(trace)});
}

/**
 * A query result over plain rows, for the harness's `canned` answers.
 *
 * The cursor's columns are served through a Proxy rather than spelled out,
 * because the two lookups these tests drive read different column names and the
 * real `QueryResult` iterator is a wasm-protobuf reader with no plain-object
 * constructor.
 */
function cannedResult(rows: readonly Row[]) {
  return {
    numRows: () => rows.length,
    firstRow: () => rows[0] ?? {},
    iter: () => {
      let i = 0;
      return new Proxy(
        {},
        {
          get: (_t, prop) => {
            if (prop === 'valid') return () => i < rows.length;
            if (prop === 'next') {
              return () => {
                i++;
              };
            }
            return rows[i]?.[prop as string];
          },
        },
      );
    },
  };
}

// A loaded graph without a load: `doLoadGraph` is a no-op once its step is
// ready, which is what lets a test hand the controller a graph it could never
// have parsed out of the stub engine.
function withGraph(h: Harness, graph: BuildGraph): void {
  h.controller.graph = graph;
  h.controller.graphStep.status = 'ready';
}

/**
 * A graph the controller will *load*, rather than one it is handed already
 * loaded.
 *
 * `withGraph` skips the graph step instead of running it, which is all most
 * tests need - but a test about what one `load()` settles has to start from
 * cold, and the stub engine carries no blob for the real source to parse. So
 * the source is swapped, which is what that seam exists for (see
 * `makeSource` in controller.ts); the cast is only because nothing outside the
 * controller is meant to hold it.
 */
function withSource(h: Harness, graph: BuildGraph): void {
  (h.controller as unknown as {source: GraphSource}).source = {
    description: 'test graph',
    load: () => Promise.resolve(graph),
    stats: () => Promise.reject(new Error('stats() is not part of a load')),
  };
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
  test('builds the edge tier for a graph far past any prompt', async () => {
    // 20M edges - large enough that a second, post-parse question about the
    // edge tables would be tempting. There isn't one: the only question is
    // asked before the parse, and this graph has already got past it.
    // Everything short of the hard cap therefore loads all three steps.
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

  test('from cold, never leaves the edge tier merely idle', async () => {
    // What makes `load()` the thing to call when something else needs the
    // mirror - the Data Explorer hand-off, say (see data_explorer_handoff.ts).
    // One load settles every tier: the edge tables are either built or
    // explicitly refused, never just absent. `buildNodeMirror()` leaves exactly
    // that third state, and nothing in the panel offers to finish it - the
    // edge-tier prompt speaks for a refusal and the Retry button for an error,
    // but neither for a tier that was never started.
    for (const edgeCount of [g.graph.edgeCount, EDGE_HARD_LIMIT + 1]) {
      const h = makeHarness();
      withSource(h, claimingEdges(g.graph, edgeCount));
      await h.controller.load();
      expect(h.controller.graphStep.status).toBe('ready');
      expect(h.controller.nodeMirrorStep.status).toBe('ready');
      expect(
        h.controller.edgeMirrorStep.ready || h.controller.edgeTierRefused,
      ).toBe(true);
    }
  });
});

/**
 * A step's progress sink, which is private for the good reason that nothing
 * outside a running build should be writing a step's phase state.
 *
 * Reached through a cast anyway, because the state machine it implements is
 * exactly what the panel's phase list renders and it can't be exercised report
 * by report any other way: a build against the stub engine runs to completion
 * inside one `await`, so the only thing observable afterwards is the end state.
 * The interesting cases are the ones in between.
 */
function sinkFor(
  controller: DuneGraphController,
  step: LoadStep,
): (p: MirrorProgress) => void {
  const c = controller as unknown as {
    progressFor(s: LoadStep): (p: MirrorProgress) => void;
  };
  return c.progressFor(step);
}

describe('load progress', () => {
  test('a start report alone makes a phase active', () => {
    // The case the start report exists for: a table small enough to finish
    // inside one flush reports no rows at all, and inferring "active" from a
    // row count would leave every such phase looking untouched.
    const h = makeHarness();
    const step = h.controller.nodeMirrorStep;
    sinkFor(h.controller, step)({phase: 'sql: create node views'});
    expect(step.activePhase).toBe('sql: create node views');
    expect(step.phaseDetail).toBeUndefined();
    expect(step.done.size).toBe(0);
  });

  test('row reports fill the detail in, and the next phase clears it', () => {
    const h = makeHarness();
    const step = h.controller.nodeMirrorStep;
    const report = sinkFor(h.controller, step);

    report({phase: 'sql: insert _dune_str'});
    report({phase: 'sql: insert _dune_str', done: 50_000, total: 120_000});
    expect(step.activePhase).toBe('sql: insert _dune_str');
    expect(step.phaseDetail).toBe('50,000 of 120,000 rows');
    expect(step.done.size).toBe(0);

    // A different phase means the one before it finished - that is the only
    // signal either builder gives that a phase is over.
    report({phase: 'sql: insert _dune_node'});
    expect(step.done.has('sql: insert _dune_str')).toBe(true);
    expect(step.activePhase).toBe('sql: insert _dune_node');
    expect(step.phaseDetail).toBeUndefined();
  });

  test('a finished step is ticked all the way through', async () => {
    // Including the last phase of each tier, which no later report ever closes,
    // and the conditional reverse index the stub graph is too small to need.
    const h = makeHarness();
    withGraph(h, g.graph);
    await h.controller.load();

    for (const [step, phases] of [
      [h.controller.nodeMirrorStep, NODE_MIRROR_PHASES],
      [h.controller.edgeMirrorStep, EDGE_MIRROR_PHASES],
    ] as const) {
      expect(step.status).toBe('ready');
      expect(step.activePhase).toBeUndefined();
      expect(step.phaseDetail).toBeUndefined();
      expect([...step.done].sort()).toEqual(phases.map((p) => p.id).sort());
    }
  });

  test('a re-run starts from nothing done', async () => {
    // A retry rebuilds the whole tier, so what a previous attempt got through
    // is not still true of the current one.
    const h = makeHarness();
    withGraph(h, g.graph);
    const step = h.controller.edgeMirrorStep;
    step.done.add('sql: a phase from another run');
    step.activePhase = 'sql: a phase from another run';
    await h.controller.load();
    expect(step.done.has('sql: a phase from another run')).toBe(false);
  });
});

/**
 * How a timeline selection resolves to a node, and what it remembers about how
 * it got there.
 *
 * The interesting case is the *process* slice, which carries no
 * `rule_id`/`dep_id` arg and so cannot be a lifecycle instant: it resolves to
 * the rule its `dune.forced_by` names, wherever it was selected. That is a
 * second lookup on the same click, so the order matters, and the fact that the
 * node was reached through a process slice has to survive - it is what
 * `selectedProcessSlice()` reports and the panel bolds on (see
 * selection_info_panel.ts).
 *
 * All of it goes through the async cache, so every assertion is made after
 * letting the lookup land: the first frame that asks always answers
 * "no node yet".
 */
describe('nodeForSelection', () => {
  // A node-mirror-backed controller with a selection on some track that isn't
  // one of the plugin's own - i.e. the default workspace, where the reverse
  // link matters.
  async function selecting(sliceId: number): Promise<Harness> {
    const h = makeHarness();
    withGraph(h, g.graph);
    // Any non-zero count makes the process table's lookups run at all.
    h.canned.push({match: 'count(*) AS n FROM _dune_process', rows: [{n: 5}]});
    await h.controller.buildNodeMirror();
    h.selection = {
      kind: 'track_event',
      trackUri: 'some.other.plugin#Track',
      eventId: sliceId,
    };
    return h;
  }

  // The rule of the fixture graph, and the trace-side `rule_id` it was built
  // from - which is what a process slice's forcer names.
  const ruleNode = 0;
  const ruleId = g.graph.timingKeyOf(ruleNode);

  // Lets the pending lookup (and the promise chain behind it) settle.
  const settle = () => new Promise((r) => setTimeout(r, 0));

  test('a lifecycle instant resolves without asking about processes', async () => {
    const h = await selecting(42);
    // The lifecycle lookup finds the rule; `kind` 0 is the `rule` track's code.
    h.canned.push({
      match: 's.track_id = t.id',
      rows: [{slice_id: 42, kind: 0, key: BigInt(ruleId)}],
    });
    const before = h.sql.length;
    h.controller.nodeForSelection();
    await settle();
    expect(h.controller.nodeForSelection()).toBe(ruleNode);
    // No process probe: the slice was already accounted for, and this is the
    // path every ordinary click takes.
    expect(
      h.sql.slice(before).some((q) => q.includes('WHERE slice_id =')),
    ).toBe(false);
    // Not reached through a process, so nothing to bold.
    expect(h.controller.selectedProcessSlice()).toBeUndefined();
  });

  test('a process slice on its own track resolves to the forcing rule', async () => {
    const h = await selecting(42);
    // The lifecycle lookup finds nothing (no canned rows), so the process table
    // is asked - and it names the rule.
    h.canned.push({match: 'WHERE slice_id =', rows: [{rule_id: ruleId}]});
    h.controller.nodeForSelection();
    await settle();
    expect(h.controller.nodeForSelection()).toBe(ruleNode);
  });

  test('and remembers the slice it came through', async () => {
    const h = await selecting(42);
    h.canned.push({match: 'WHERE slice_id =', rows: [{rule_id: ruleId}]});
    h.controller.nodeForSelection();
    await settle();
    expect(h.controller.selectedProcessSlice()).toBe(42);
  });

  test('a slice that is neither resolves to nothing', async () => {
    const h = await selecting(42);
    // Both lookups come back empty - an unrelated slice, which is most of them.
    h.controller.nodeForSelection();
    await settle();
    expect(h.controller.nodeForSelection()).toBeUndefined();
    expect(h.controller.selectedProcessSlice()).toBeUndefined();
  });

  test('a lifecycle hit whose id collides with a process slice is not bolded', async () => {
    // The reason `selectedProcessSlice` is recorded during resolution rather
    // than compared against event ids in the panel: event ids are per track, so
    // an unrelated row can carry a real process slice's number.
    const h = await selecting(42);
    h.canned.push({
      match: 's.track_id = t.id',
      rows: [{slice_id: 42, kind: 0, key: BigInt(ruleId)}],
    });
    h.canned.push({match: 'WHERE slice_id =', rows: [{rule_id: ruleId}]});
    h.controller.nodeForSelection();
    await settle();
    expect(h.controller.nodeForSelection()).toBe(ruleNode);
    expect(h.controller.selectedProcessSlice()).toBeUndefined();
  });

  test('moving from a process row to a node row drops the bolded slice', async () => {
    // The node-backed tracks answer synchronously, so they never went through
    // the async cache - and the cache is also what records *how* the current
    // selection resolved. Leaving it behind kept the previous process's id
    // alive, which bolded a process entry the reader had navigated away from.
    const h = await selecting(42);
    h.canned.push({match: 'WHERE slice_id =', rows: [{rule_id: ruleId}]});
    h.controller.nodeForSelection();
    await settle();
    expect(h.controller.selectedProcessSlice()).toBe(42);
    // Now the rule's own row on the Dune workspace's rule track, which keys its
    // rows by `node_id` rather than by slice id.
    h.selection = {
      kind: 'track_event',
      trackUri: graphTrackUri('rule'),
      eventId: ruleNode,
    };
    expect(h.controller.nodeForSelection()).toBe(ruleNode);
    expect(h.controller.selectedProcessSlice()).toBeUndefined();
  });

  test('a process row on the Dune workspace track bolds the same slice', async () => {
    // The process track projects real slices verbatim, keyed by `slice.id`, so
    // "which process is selected" is the same answer inside the Dune workspace
    // as outside it - and it takes the query route there too, since the row
    // names only a rule id.
    const h = await selecting(42);
    h.selection = {
      kind: 'track_event',
      trackUri: graphTrackUri('process'),
      eventId: 42,
    };
    h.canned.push({match: 'WHERE slice_id =', rows: [{rule_id: ruleId}]});
    h.controller.nodeForSelection();
    await settle();
    expect(h.controller.nodeForSelection()).toBe(ruleNode);
    expect(h.controller.selectedProcessSlice()).toBe(42);
  });

  test('clearing the selection clears both answers', async () => {
    const h = await selecting(42);
    h.canned.push({match: 'WHERE slice_id =', rows: [{rule_id: ruleId}]});
    h.controller.nodeForSelection();
    await settle();
    h.selection = {kind: 'empty'};
    expect(h.controller.nodeForSelection()).toBeUndefined();
    expect(h.controller.selectedProcessSlice()).toBeUndefined();
  });

  test('neither lookup is attempted before the node mirror is built', async () => {
    // The table `ruleNodeForProcessSlice` reads doesn't exist yet, so asking
    // would be an error rather than a miss.
    const h = makeHarness();
    withGraph(h, g.graph);
    h.selection = {
      kind: 'track_event',
      trackUri: 'some.other.plugin#Track',
      eventId: 42,
    };
    const before = h.sql.length;
    h.controller.nodeForSelection();
    await settle();
    expect(
      h.sql.slice(before).some((q) => q.includes('FROM _dune_process')),
    ).toBe(false);
    expect(h.controller.nodeForSelection()).toBeUndefined();
  });

  test('and the mirror arriving re-resolves the same selection', async () => {
    // The "no node" a mirror-less lookup came back with is cached against the
    // selection, and building the mirror doesn't change the selection - so
    // unless the build drops the cache, the answer stays "no node" until the
    // reader clicks away and back. Which is precisely the state a trace big
    // enough to need a prompted load starts in.
    const h = makeHarness();
    withGraph(h, g.graph);
    h.canned.push({match: 'count(*) AS n FROM _dune_process', rows: [{n: 5}]});
    h.canned.push({match: 'WHERE slice_id =', rows: [{rule_id: ruleId}]});
    h.selection = {
      kind: 'track_event',
      trackUri: graphTrackUri('process'),
      eventId: 42,
    };
    h.controller.nodeForSelection();
    await settle();
    expect(h.controller.nodeForSelection()).toBeUndefined();

    await h.controller.buildNodeMirror();
    h.controller.nodeForSelection();
    await settle();
    expect(h.controller.nodeForSelection()).toBe(ruleNode);
    expect(h.controller.selectedProcessSlice()).toBe(42);
  });
});

/**
 * The second selection channel: a directory, rather than a node.
 *
 * A `gen-rules` span belongs to a directory and has no `rule_id` / `dep_id`, so
 * it cannot be a node - see `dirForSelection()`. Both halves of the span carry
 * the directory's dict id as their timing key, and that id is mapped back to a
 * `dune_dir.id` through the mirror's `_dune_gen_rules` table.
 *
 * The two channels are resolved by one lookup, so the tests that matter are the
 * ones where they could collide: a `gen-rules` key is a *dict* id and can carry
 * the same number as a real `rule_id`.
 */
describe('dirForSelection', () => {
  // The rule of the fixture graph and its trace-side `rule_id`, reused here as
  // a `gen-rules` key precisely because it is a number the graph can resolve.
  const ruleNode = 0;
  const ruleId = g.graph.timingKeyOf(ruleNode);

  const settle = () => new Promise((r) => setTimeout(r, 0));

  // A mirror-backed controller with `sliceId` selected on somebody else's
  // track, answering the lifecycle lookup with a `gen-rules` instant keyed by
  // `dirStrId`, and the dict-id -> directory map with `dirId`.
  async function selectingGenRules(
    sliceId: number,
    dirStrId: number,
    dirId?: number,
  ): Promise<Harness> {
    const h = makeHarness();
    withGraph(h, g.graph);
    await h.controller.buildNodeMirror();
    h.canned.push({
      match: 's.track_id = t.id',
      rows: [
        {
          slice_id: sliceId,
          kind: timingKindCode('genrules'),
          key: BigInt(dirStrId),
        },
      ],
    });
    if (dirId !== undefined) {
      h.canned.push({match: 'FROM _dune_gen_rules', rows: [{v: dirId}]});
    }
    h.selection = {
      kind: 'track_event',
      trackUri: 'some.other.plugin#Track',
      eventId: sliceId,
    };
    return h;
  }

  test('a gen-rules instant resolves to its directory', async () => {
    const h = await selectingGenRules(42, 900, 7);
    h.controller.dirForSelection();
    await settle();
    expect(h.controller.dirForSelection()).toBe(7);
  });

  test("and the span's other half resolves to the same directory", async () => {
    // `-start` and `-finish` both carry `dir_path_id`, so which one was clicked
    // is not something a reader should have to think about.
    const h = await selectingGenRules(43, 900, 7);
    h.controller.dirForSelection();
    await settle();
    expect(h.controller.dirForSelection()).toBe(7);
  });

  test('a gen-rules key is never read as a rule id', async () => {
    // The collision the `kind` check exists for: a directory's dict id and a
    // `rule_id` are different id spaces, so the same number means both. Read as
    // a rule it would select whichever rule happened to carry it.
    const h = await selectingGenRules(42, ruleId, 7);
    h.controller.nodeForSelection();
    await settle();
    expect(h.controller.nodeForSelection()).toBeUndefined();
    expect(h.controller.dirForSelection()).toBe(7);
  });

  test('a directory the mirror has no row for resolves to nothing', async () => {
    const h = await selectingGenRules(42, 900);
    h.controller.dirForSelection();
    await settle();
    expect(h.controller.dirForSelection()).toBeUndefined();
    expect(h.controller.nodeForSelection()).toBeUndefined();
  });

  test('an ordinary lifecycle instant resolves to a node and no directory', async () => {
    // The other side of the same exclusivity: one selection, one channel.
    const h = makeHarness();
    withGraph(h, g.graph);
    await h.controller.buildNodeMirror();
    h.canned.push({
      match: 's.track_id = t.id',
      rows: [{slice_id: 42, kind: timingKindCode('rule'), key: BigInt(ruleId)}],
    });
    h.selection = {
      kind: 'track_event',
      trackUri: 'some.other.plugin#Track',
      eventId: 42,
    };
    h.controller.nodeForSelection();
    await settle();
    expect(h.controller.nodeForSelection()).toBe(ruleNode);
    expect(h.controller.dirForSelection()).toBeUndefined();
  });

  test('the panel is revealed for a directory, once', async () => {
    // `revealPanelWhenSelected` follows the resolution rather than the raw
    // selection, so it fires when the query lands and not again while the same
    // directory stays selected.
    const h = await selectingGenRules(42, 900, 7);
    let reveals = 0;
    h.controller.revealPanelWhenSelected(() => reveals++);
    frame(h.controller);
    await settle();
    frame(h.controller);
    expect(reveals).toBe(1);
    frame(h.controller);
    expect(reveals).toBe(1);
  });
});

/**
 * The per-frame reveal poll, which is private because nothing outside the
 * canvas callback has any business running it - see `onFrame` in controller.ts.
 * A test has to drive it directly: the callback is what a selection change is
 * observable through, and there is no canvas here to schedule it.
 */
function frame(controller: DuneGraphController): void {
  (
    controller as unknown as {syncSelectionReveal(): void}
  ).syncSelectionReveal();
}

/**
 * The dir -> slice half of the channel.
 *
 * `goToDir` has no Dune-workspace branch to test, unlike `goToNode`: the four
 * tracks project nodes and a `gen-rules` span is not one, so there is only the
 * plain `goToSlice` route.
 */
describe('revealDirInExplorer', () => {
  test('brings the tab forward and leaves a request standing', () => {
    // The pane cannot be told directly - the two are different side-panel tabs
    // - and it needs several redraws to descend, so the request stays put
    // rather than being consumed on sight.
    const h = makeHarness();
    let revealed = 0;
    h.controller.revealExplorerWhenAsked(() => revealed++);

    expect(h.controller.explorerRevealRequest).toBeUndefined();
    h.controller.revealDirInExplorer(7);

    expect(revealed).toBe(1);
    expect(h.controller.explorerRevealRequest?.dirId).toBe(7);
  });

  test('asking twice for the same directory is two requests', () => {
    // Otherwise the second click does nothing: the pane tells requests apart
    // by serial, and the user has usually navigated away in between.
    const h = makeHarness();
    h.controller.revealDirInExplorer(7);
    const first = h.controller.explorerRevealRequest!.serial;
    h.controller.revealDirInExplorer(7);

    expect(h.controller.explorerRevealRequest!.serial).toBeGreaterThan(first);
  });
});

describe('goToDir', () => {
  test("selects the directory's gen-rules slice", async () => {
    const h = makeHarness();
    withGraph(h, g.graph);
    await h.controller.buildNodeMirror();
    h.canned.push({match: 'FROM dune_gen_rules', rows: [{v: 55}]});
    await h.controller.goToDir(7);
    expect(h.selected).toEqual([
      {trackUri: 'some.other.plugin#Track', eventId: 55},
    ]);
  });

  test('a directory with no gen-rules span is a no-op', async () => {
    const h = makeHarness();
    withGraph(h, g.graph);
    await h.controller.buildNodeMirror();
    await h.controller.goToDir(7);
    expect(h.selected).toEqual([]);
  });

  test('and nothing is selected before the mirror is built', async () => {
    // The table the lookup reads doesn't exist yet, so asking would be an error
    // rather than a miss.
    const h = makeHarness();
    withGraph(h, g.graph);
    const before = h.sql.length;
    await h.controller.goToDir(7);
    expect(h.selected).toEqual([]);
    expect(h.sql.slice(before).some((q) => q.includes('dune_gen_rules'))).toBe(
      false,
    );
  });
});
