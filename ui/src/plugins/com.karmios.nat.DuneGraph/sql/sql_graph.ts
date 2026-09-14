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
 * Materializes the in-memory {@link BuildGraph} into Perfetto SQL tables, so
 * the graph can be queried by relationship in the same engine as the rest of
 * the trace.
 *
 * **ARCHITECTURE.md, "The SQL mirror", is the reference**: the table inventory, what
 * each column means, the two tiers and the order between them, and the three
 * mechanisms (interned strings, kind-is-id, coded enums) that make it fit.
 * dune_tables.ts carries the same inventory as user-facing documentation, and
 * its unit test parses the `CREATE` strings below to keep the two in step.
 *
 * The one thing a reader of *this* file has to hold on to: the edge tier reads
 * the node tier's `_dune_rule` and `_dune_dep` and owns an index on the former,
 * so it must be built *after* the node tier and disposed *before* it.
 *
 * See {@link createRelationFunctions} for the relation functions, and
 * {@link edgeArms} for why the walks read the arms directly rather than going
 * through `dune_edge`.
 */

import {sqliteString} from '../../../base/string_utils';
import type {Engine} from '../../../trace_processor/engine';
import {LONG_NULL, NUM} from '../../../trace_processor/query_result';
import {DirTree, parentDir} from '../model/dir_tree';
import type {BuildGraph, NodeId, NodeTiming} from '../model/graph';
import {
  DEP_RESOLUTIONS,
  DEP_STATUSES,
  FAILED_OUTCOMES,
  FORCED_BY_KINDS,
  RULE_OUTCOMES,
} from '../model/graph';
import {
  LIFECYCLE_TIMING_PHASE,
  TIMING_TABLE,
  buildLifecycleTiming,
  timingKindCode,
} from './lifecycle_sql';
import type {Phase, PerfRun} from '../perf';
import {measure, measureSync} from '../perf';
import type {ProcessDetails, SqlProcessSlices} from './process_sql';
import {
  PROCESS_INDEX_PHASE,
  PROCESS_TABLE,
  buildProcessSlices,
} from './process_sql';

// `dune_node` / `dune_rule` / `dune_dep` / `dune_edge` are typed PERFETTO VIEWS
// (so slice-id columns are real SliceTable::Ids, and the stored integer codes
// and dict ids read back as text) over the raw tables we actually INSERT the rows into - a CREATE
// PERFETTO TABLE/VIEW can't be chunk-inserted, and a plain CREATE TABLE can't
// express the column types. Internal queries (the relation functions) read
// the raw tables directly.
const NODE_TABLE = 'dune_node';
const RAW_NODE_TABLE = '_dune_node';
const RULE_TABLE = 'dune_rule';
const RAW_RULE_TABLE = '_dune_rule';
const DEP_TABLE = 'dune_dep';
const RAW_DEP_TABLE = '_dune_dep';
const EDGE_TABLE = 'dune_edge';
// Dep-node edges only, now that a rule's are factored (see the file header).
const RAW_EDGE_TABLE = '_dune_edge';
// Forward adjacency as rowid ranges over RAW_EDGE_TABLE (see the file header).
const OUT_TABLE = '_dune_node_out';
// The factored dep sets a rule's static and dynamic edges are stored as.
const CORE_TABLE = '_dune_core';
const CORE_MEMBER_TABLE = '_dune_core_member';
const DEPSET_TABLE = '_dune_depset';
const DEPSET_ADD_TABLE = '_dune_depset_add';
const DYN_STAGE_TABLE = '_dune_rule_dyn_stage';
// The forced edges, materialized (see the file header).
const FORCED_EDGE_TABLE = '_dune_forced_edge';
// The whole edge relation as (src, dst), for the callers that scan it in full.
const ALL_EDGE_VIEW = '_dune_edge_all';
// Index on a *node*-tier table that only the edge tier needs, so the edge tier
// creates and drops it (see buildEdgeMirror).
const RULE_DEP_SET_INDEX = '_dune_rule_dep_set';
// The two tables with no view over them: their columns are already exactly what
// a query wants (see the file header).
const RULE_TARGET_TABLE = 'dune_rule_target';
const STRING_TABLE = 'dune_string';
// The typed view over `_dune_process`, plus the index that makes its
// rule -> node join a probe. Kept for the tier's lifetime, unlike
// RULE_DEP_SET_INDEX: one entry per *rule* (386k, ~1.5 MB), and the only route
// from a trace-side rule id back to a node there is.
const PROCESS_VIEW = 'dune_process';
const NODE_ORIG_ID_INDEX = '_dune_node_orig_id';
// The directory hierarchy, plus a transient rule -> directory map the duration
// rollup aggregates through and drops again (see {@link ruleDurationsByDir}).
const DIR_TABLE = 'dune_dir';
const RAW_DIR_TABLE = '_dune_dir';
const RULE_DIR_TABLE = '_dune_rule_dir';
// A node's span as a half-open interval, and the macro intersecting two of
// them across an edge.
const SPAN_VIEW = '_dune_span';
const BLOCKED_MACRO = 'dune_blocked';
// `dune_edge` with the macro already applied. Built with the edge tier, since
// that is the tier it reads (see {@link edgeBlockedView}).
const EDGE_BLOCKED_VIEW = 'dune_edge_blocked';

// Rows per `INSERT ... VALUES (row), (row), ...`. Not bounded by SQLite's
// 500-term compound-SELECT limit despite the resemblance: 100,000 rows in one
// statement inserts 100,000 rows.
//
// 5,000 is the measured optimum by a modest margin - over the RPC path, 2M rows
// take 4.2 / 3.8 / 6.1 s in wasm at 500 / 5,000 / 20,000 - and keeps a
// statement to ~110 KB of SQL text. **Measure this over RPC**, not with
// `trace_processor -q`, whose per-statement cost exaggerates the win ~6x.
const INSERT_CHUNK = 5_000;

// Statements between yields back to the event loop (and progress reports). The
// edge tier is thousands of statements and minutes long on a large graph;
// without a real macrotask yield in there the UI can't repaint and the load
// looks like a hang. 10 statements is 50k rows - often enough to keep the
// progress line moving, rare enough that the yields themselves are noise.
const YIELD_EVERY = 10;

// Edge count past which the edge tier refuses to build: past it the build does
// not get slow, it takes the engine down. A refusal rather than a question -
// there is no answer that would make the build survive. See ARCHITECTURE.md,
// "The one question, and the one refusal", for why it counts edges and not
// rows, and "Performance" for the measurement behind the number.
export const EDGE_HARD_LIMIT = 100_000_000;

// Where a build has got to. `phase` is an id from one of the manifests, so a
// caller holding one can place the report in the list of everything the build
// will do rather than only knowing what is happening now.
//
// Emitted when a phase *starts*, and again as rows go in for the phases that
// insert any. The start report is not redundant: {@link materializeTable}
// reports only every {@link YIELD_EVERY} statements, i.e. every 50,000 rows, so
// a small table finishes without emitting one and would never look active.
export interface MirrorProgress {
  // The manifest id of the phase now running.
  readonly phase: string;

  // Rows inserted so far, and how many the row source expects to yield. Only
  // the insert phases report these, and only every YIELD_EVERY statements.
  readonly done?: number;
  readonly total?: number;
}

// How a build reports itself while it runs. The inserts yield to the event loop
// between batches, so a report can actually be painted.
export interface MirrorOptions {
  // Per-phase timing breakdown; see perf.ts.
  readonly perf?: PerfRun;

  // Called at the start of every phase, and again as each insert phase flushes
  // (at most once per YIELD_EVERY statements). Cleared by the caller when the
  // build ends.
  readonly onProgress?: (p: MirrorProgress) => void;
}

// One unit of a mirror build, as something outside the builder can list. `id`
// is *exactly* the name the phase is measured under, which is what lets the
// unit test compare the manifests below against a `PerfRun`'s recorded phase
// names and fail the moment the two drift.
export interface MirrorPhase {
  // The `measure()` / `measureSync()` label. Console-facing, not for display.
  readonly id: string;

  // What a progress list shows. The side panel it renders in is narrow and
  // there are ~30 rows across both tiers, so these are short human labels
  // ('Dep sets') rather than the raw table names the ids carry
  // ('_dune_depset_add').
  readonly label: string;
}

// Everything {@link buildNodeMirror} does, in execution order. Hand-written and
// kept honest by a test rather than by construction: the phases hand locals to
// one another, so the alternative - an array of `{name, run}` descriptors driven
// by a loop - needs a shared mutable context object and turns a readable
// straight-line function into a state machine.
//
// The ids are built from the same constants the builder measures itself with,
// so renaming a table renames both halves; what the test catches is a phase
// being added, removed or reordered.
export const NODE_MIRROR_PHASES: readonly MirrorPhase[] = [
  // Not literally in buildNodeMirror: these two are measured inside
  // buildLifecycleTiming / buildProcessSlices, which it calls first. They are
  // node-tier work and cost node-tier time, so they are listed here and the
  // builder reports their start on their behalf.
  {id: LIFECYCLE_TIMING_PHASE, label: 'Timing'},
  {id: PROCESS_INDEX_PHASE, label: 'Processes'},
  {id: `sql: ${DIR_TABLE} census`, label: 'Directory census'},
  {id: `sql: insert ${STRING_TABLE}`, label: 'Strings'},
  {id: `sql: insert ${RAW_NODE_TABLE}`, label: 'Nodes'},
  {id: `sql: insert ${RAW_RULE_TABLE}`, label: 'Rules'},
  {id: `sql: insert ${RAW_DEP_TABLE}`, label: 'Deps'},
  {id: `sql: insert ${RULE_TARGET_TABLE}`, label: 'Targets'},
  {id: `sql: index ${RULE_TARGET_TABLE}`, label: 'Target index'},
  // The rule -> directory map and the rollup over it, from ruleDurationsByDir.
  // The map table is dropped again as soon as the sum has run.
  {id: `sql: insert ${RULE_DIR_TABLE}`, label: 'Rule directories'},
  {id: `sql: sum ${DIR_TABLE} durations`, label: 'Directory durations'},
  {id: `sql: insert ${RAW_DIR_TABLE}`, label: 'Directories'},
  {id: `sql: index ${DIR_TABLE} descent`, label: 'Directory index'},
  {id: `sql: index ${NODE_TABLE} rule ids`, label: 'Rule id index'},
  {id: 'sql: create node views', label: 'Views'},
];

/**
 * Everything {@link buildEdgeMirror} does, in execution order. See
 * {@link NODE_MIRROR_PHASES} for why this is a list rather than a refactor.
 */
export const EDGE_MIRROR_PHASES: readonly MirrorPhase[] = [
  {id: 'sql: edge census', label: 'Edge census'},
  {id: 'sql: member offsets', label: 'Member offsets'},
  {id: `sql: insert ${CORE_TABLE}`, label: 'Dep set cores'},
  {id: `sql: insert ${CORE_MEMBER_TABLE}`, label: 'Core members'},
  {id: `sql: insert ${DEPSET_TABLE}`, label: 'Dep sets'},
  {id: `sql: insert ${DEPSET_ADD_TABLE}`, label: 'Dep set additions'},
  {id: `sql: insert ${DYN_STAGE_TABLE}`, label: 'Dynamic stages'},
  {id: `sql: insert ${RAW_EDGE_TABLE}`, label: 'Dep edges'},
  {id: `sql: insert ${OUT_TABLE}`, label: 'Out edges'},
  {id: `sql: index ${DYN_STAGE_TABLE}`, label: 'Stage index'},
  {id: `sql: insert ${FORCED_EDGE_TABLE}`, label: 'Forced edges'},
  {id: 'sql: index the reverse path', label: 'Reverse index'},
  {id: 'sql: create edge views', label: 'Views'},
  {id: 'sql: create relation functions', label: 'Relation functions'},
];

// Opens a phase: reports its start, then measures it. Every measured region in
// the two builders goes through this rather than calling {@link measure}
// directly, so the manifests above describe something the build announces.
function phase<T>(
  opts: MirrorOptions,
  name: string,
  fn: (p: Phase) => Promise<T>,
): Promise<T> {
  opts.onProgress?.({phase: name});
  return measure(opts.perf, name, fn);
}

function phaseSync<T>(
  opts: MirrorOptions,
  name: string,
  fn: (p: Phase) => T,
): T {
  opts.onProgress?.({phase: name});
  return measureSync(opts.perf, name, fn);
}

// The cheap tier: `dune_node` + `dune_string` + the per-kind detail tables.
// Node ids are the graph's own, so there is nothing to translate through.
export interface SqlNodeMirror extends AsyncDisposable {
  // How many nodes were mirrored (== the `node_id` space's size).
  readonly nodeCount: number;

  // How many (kind, key) rows the timing table behind the mirror's `ts` /
  // `dur_ns` / `action_*` columns holds (see lifecycle_sql.ts).
  readonly timingRowCount: number;

  // How many process slices `_dune_process` indexes (see process_sql.ts).
  readonly processRowCount: number;

  // The rule node that forced a process slice, or undefined if the slice isn't
  // one, or names a rule the blob never recorded. The timeline's process track
  // keys its rows by slice id, so this is how one resolves back to a node (see
  // graph_track.ts, controller.ts).
  ruleNodeForProcessSlice(sliceId: number): Promise<NodeId | undefined>;

  // Every process a rule node's action spawned, with what it ran - the inverse
  // of the above, and the graph-side face of `processesForRuleId`. Empty for a
  // dep node: a process names the *rule* that forced it, and nothing else.
  processesForRule(id: NodeId): Promise<readonly ProcessDetails[]>;

  // The node's lifecycle timing, read on demand rather than carried on the node
  // (see lifecycle_sql.ts). One query per call, so this is for the handful of
  // nodes a panel is actually showing, not for a sweep.
  timingFor(id: NodeId): Promise<NodeTiming>;
}

/**
 * The expensive tier: `dune_edge` plus everything that walks it (the relation
 * functions). Built on top of - and disposed before - the
 * {@link SqlNodeMirror} its endpoints come from.
 */
export interface SqlEdgeMirror extends AsyncDisposable {
  // How many edges were mirrored.
  readonly edgeCount: number;
}

interface DroppableTable extends AsyncDisposable {
  readonly name: string;
}

/**
 * The node-id space the generated SQL is written against: how many nodes there
 * are, and where the rule/dep boundary falls in them. Both are inlined as
 * literals into every statement, which is what lets the mirror carry no `kind`
 * column anywhere (see the file header).
 */
interface NodeSpace {
  readonly ruleCount: number;
  readonly nodeCount: number;
}

function nodeSpace(graph: BuildGraph): NodeSpace {
  return {ruleCount: graph.ruleCount, nodeCount: graph.nodeCount};
}

// ---------------------------------------------------------------------------
// Expression fragments shared by the views and the relation functions.
// ---------------------------------------------------------------------------

// A node's kind, from its id alone (see graph.ts's id layout). `node` is an
// alias of `_dune_node`, or any relation carrying a `node_id`.
function kindExpr(node: string, space: NodeSpace): string {
  return `iif(${node}.node_id < ${space.ruleCount}, 'rule', 'dep')`;
}

// Ditto for a bare node-id expression (an `_dune_edge` endpoint, say).
function isRuleExpr(nodeId: string, space: NodeSpace): string {
  return `${nodeId} < ${space.ruleCount}`;
}

// The same kind, as the integer code the timing table is keyed by rather than
// the name the views expose (see lifecycle_sql.ts).
function timingKindExpr(node: string, space: NodeSpace): string {
  return `iif(${node}.node_id < ${space.ruleCount},
      ${timingKindCode('rule')}, ${timingKindCode('dep')})`;
}

// The LEFT JOIN {@link labelExpr} needs: a dep's label is its interned path, so
// only dep rows look anything up. `str` is the alias to bind `dune_string` to.
function labelJoin(node: string, str: string, space: NodeSpace): string {
  return `LEFT JOIN ${STRING_TABLE} ${str}
      ON ${node}.node_id >= ${space.ruleCount} AND ${str}.id = ${node}.orig_id`;
}

// A node's display label - a rule's bare id, a dep's interned path - matching
// `BuildGraph.labelOf`, `#<id>` fallback included (a dep whose dict id the blob
// never interned; a malformed blob, but visible rather than blank).
function labelExpr(node: string, str: string, space: NodeSpace): string {
  return `iif(${node}.node_id < ${space.ruleCount},
      cast(${node}.orig_id AS TEXT),
      coalesce(${str}.str, '#' || ${node}.orig_id))`;
}

// A CASE mapping a stored code column back to the text a view exposes:
// `values[i]` is the text for code `i + base`. Any other code (notably 0 for a
// `forced_by` kind that wasn't recorded) falls through to NULL.
function codeCase(col: string, values: readonly string[], base = 0): string {
  const arms = values.map((v, i) => `WHEN ${i + base} THEN '${v}'`);
  return `CASE ${col} ${arms.join(' ')} END`;
}

// Joins a `_dune_node` row to the lifecycle slice its span starts at, via the
// timing table. A node's slice id is not a column on its row, and a query
// wanting one also needs the `slice` row itself, since `JOINID(slice.id)` only
// holds for a column read straight off `slice`.
//
// Both halves are LEFT: a node whose timing never resolved keeps its row with a
// NULL `slice_id` rather than vanishing.
//
// One b-tree descent, because the timing table is keyed on (kind, key) as a
// real primary key. **Read `TIMING_TABLE`'s comment in lifecycle_sql.ts before
// changing either side**: the join's cost is entirely that table's shape
// (2.2 s to project 818k nodes with it, 208 s without). `dune_node` is the only
// caller. The `kind` side is written as the integer code the table stores.
function timingJoin(
  node: string,
  timing: string,
  slice: string,
  space: NodeSpace,
): string {
  return `
      LEFT JOIN ${TIMING_TABLE} ${timing}
        ON ${timing}.kind = ${timingKindExpr(node, space)}
        AND ${timing}.key = ${node}.orig_id
      LEFT JOIN slice ${slice}
        ON ${slice}.id =
          coalesce(${timing}.start_slice_id, ${timing}.finish_slice_id)`;
}

// ---------------------------------------------------------------------------
// Inserting rows.
// ---------------------------------------------------------------------------

/**
 * A table's rows as SQL text, produced on demand: `rows()` yields one
 * `(v1, v2, …)` tuple per row and {@link materializeTable} batches them into
 * INSERT statements.
 *
 * Deliberately a generator rather than an array of row objects. The edge tier is
 * 28M rows on a monorepo-scale trace, and an array of 7-field objects for them
 * was multiple GB of JS heap *before a single row was inserted* - the largest
 * single item in the perf plan's baseline. Nothing here is ever materialized:
 * the text for one batch (see {@link INSERT_CHUNK}) is the most that exists at
 * once.
 *
 * `count` is what the row source expects to yield, used for the progress
 * report; the phase's own row count is what was actually inserted.
 */
interface RowSource {
  readonly count: number;
  rows(): Iterable<string>;
}

// A nullable integer as SQL text. Every column the mirror stores is an id, a
// code or a count, so this (plus `sqliteString` for the two text columns) is all
// the escaping the inserts need.
function int(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value)
    ? 'NULL'
    : String(Math.trunc(value));
}

// Hands the event loop back so a redraw can run mid-build. `engine.query` only
// awaits a promise, which keeps everything on the microtask queue - a load that
// never returns to the macrotask queue paints nothing for its whole duration.
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Create `name` with the given column schema and populate it from `source`
// (chunked inserts, see INSERT_CHUNK). Pre-drops so a rebuild is idempotent;
// the returned handle drops the table when disposed. A plain (non-PERFETTO)
// table is used so it can be INSERTed into and queried ad-hoc in the Query page.
async function materializeTable(
  engine: Engine,
  name: string,
  schema: string,
  columns: readonly string[],
  source: RowSource,
  opts: MirrorOptions,
): Promise<DroppableTable> {
  await phase(opts, `sql: insert ${name}`, async (p) => {
    await engine.tryQuery(`DROP TABLE IF EXISTS ${name}`);
    await engine.query(`CREATE TABLE ${name} (${schema})`);
    const prefix = `INSERT INTO ${name} (${columns.join(', ')}) VALUES `;
    const batch: string[] = [];
    let inserted = 0;
    let statements = 0;
    let sqlChars = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      const sql = prefix + batch.join(', ');
      sqlChars += sql.length;
      statements++;
      inserted += batch.length;
      batch.length = 0;
      await engine.query(sql);
      if (statements % YIELD_EVERY === 0) {
        opts.onProgress?.({
          phase: `sql: insert ${name}`,
          done: inserted,
          total: source.count,
        });
        await yieldToUi();
      }
    };
    for (const row of source.rows()) {
      batch.push(row);
      if (batch.length >= INSERT_CHUNK) await flush();
    }
    await flush();
    p.rows(inserted);
    p.bytes(sqlChars);
    p.note(`${statements} statements`);
  });
  return {
    name,
    async [Symbol.asyncDispose](): Promise<void> {
      await engine.tryQuery(`DROP TABLE IF EXISTS ${name}`);
    },
  };
}

// ---------------------------------------------------------------------------
// The node tier.
// ---------------------------------------------------------------------------

function stringRows(graph: BuildGraph): RowSource {
  return {
    count: graph.stringCount,
    *rows(): Iterable<string> {
      for (const [id, str] of graph.strings()) {
        yield `(${id}, ${sqliteString(str)})`;
      }
    },
  };
}

function nodeRows(graph: BuildGraph, census: DirCensus): RowSource {
  return {
    count: graph.nodeCount,
    *rows(): Iterable<string> {
      for (let id = 0; id < graph.nodeCount; id++) {
        const target = int(graph.forcedByTargetIdOf(id));
        yield `(${id}, ${int(graph.traceIdOf(id))}, ` +
          `${graph.forcedByCodeOf(id)}, ${target}, ${census.dirId[id]})`;
      }
    },
  };
}

function ruleRows(graph: BuildGraph): RowSource {
  return {
    count: graph.ruleCount,
    *rows(): Iterable<string> {
      for (let id = 0; id < graph.ruleCount; id++) {
        const counts =
          `${graph.targetCount(id)}, ${graph.staticDepCount(id)}, ` +
          `${graph.dynStageCount(id)}`;
        const depsUnknown = graph.depsUnknownOf(id) ? 1 : 0;
        yield `(${id}, ${int(graph.dirStrIdOf(id))}, ${graph.outcomeCodeOf(id)}, ` +
          `${counts}, ${depsUnknown}, ${int(graph.depSetOf(id))})`;
      }
    },
  };
}

function depRows(graph: BuildGraph): RowSource {
  return {
    count: graph.depCount,
    *rows(): Iterable<string> {
      for (let id = graph.ruleCount; id < graph.nodeCount; id++) {
        const resolved = int(graph.resolvedRuleOf(id));
        yield `(${id}, ${graph.resolutionCodeOf(id)}, ${graph.statusCodeOf(id)}, ${resolved})`;
      }
    },
  };
}

function ruleTargetRows(graph: BuildGraph): RowSource {
  let count = 0;
  for (let id = 0; id < graph.ruleCount; id++) count += graph.targetCount(id);
  return {
    count,
    *rows(): Iterable<string> {
      for (let id = 0; id < graph.ruleCount; id++) {
        for (const {path, isDir} of graph.ruleTargets(id)) {
          yield `(${id}, ${sqliteString(path)}, ${isDir ? 1 : 0})`;
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The directory tier (part of the node tier: `dune_dir`, see the file header).
// ---------------------------------------------------------------------------

// Which rule outcomes `n_failed` counts, as codes: the shared FAILED_OUTCOMES
// list, resolved once so the counting loop below can test a code rather than
// the word behind it.
const FAILED_OUTCOME_CODES: ReadonlySet<number> = new Set(
  FAILED_OUTCOMES.map((outcome) => RULE_OUTCOMES.indexOf(outcome)),
);

// The columns of RAW_DIR_TABLE, in insert order. Named once because the schema,
// the INSERT and the view all have to agree on them.
const DIR_COLUMNS = [
  'id',
  'parent_id',
  'name',
  'path',
  'depth',
  'n_rules',
  'n_deps',
  'n_failed',
  'n_gen_rules',
  't_rules',
  't_deps',
  't_failed',
  't_gen_rules',
  'self_dur_ns',
  'total_dur_ns',
];

// The directory hierarchy plus each directory's direct membership, from one
// pass over the nodes.
//
// Both kinds contribute a directory - a rule its `dir`, a dep the directory its
// path lives in - because ~23% of the deps on a real trace live under no rule's
// `dir` at all (the opam switch, the compiler, `/usr/bin`). Rules and deps are
// counted separately, so a directory holding only deps is still a visible row.
//
// A third contribution has no members at all: a directory dune ran `gen-rules`
// for, which need hold no rule and no dep anywhere beneath it. These are the
// only rows whose whole *subtree* can be empty - every other row is a member's
// directory or a prefix on the way to one - which is why `n_gen_rules` is
// stored and rolled up rather than derived: the explorer's hard filter cannot
// walk a subtree a level at a time, so hiding, or finding, them has to be a
// test on a stored rollup. **ARCHITECTURE.md, "Why it is shaped this way", has
// the proportions** and why the keys are dict ids rather than strings.
//
// The counts come from here rather than an aggregate over `_dune_node.dir_id`
// because the pass that has to happen anyway - interning every directory, which
// SQL cannot do without recursive string splitting - already visits every node.
// The aggregate stays a consistency check: it is a scan of 818k rows to recover
// numbers this loop already has, and it could not produce `self_dur_ns` anyway.
interface DirCensus {
  readonly tree: DirTree;

  // Each node's directory id, indexed by node id: a rule's `dir`, a dep's
  // containing directory - the same two contributions the tree is interned
  // from, so `dune_node.dir_id` and `dune_dir`'s `n_rules` / `n_deps` agree by
  // construction. Read by RULE_DIR_TABLE (its rule prefix) and by
  // {@link nodeRows}.
  readonly dirId: Int32Array;

  // Per directory id: rules whose `dir` it is, deps whose path is directly in
  // it, how many of those rules failed, and whether dune ran `gen-rules` for
  // it. All four are `tree.size` long. `nGenRules` is 0 or 1 on every trace
  // measured - a directory has at most one `gen-rules` span - but it is a count
  // rather than a flag so a trace that breaks that says so instead of lying.
  readonly nRules: Int32Array;
  readonly nDeps: Int32Array;
  readonly nFailed: Int32Array;
  readonly nGenRules: Int32Array;

  // The `gen-rules` directories as parallel arrays, one entry per key read from
  // the timing table: the dict id it is keyed by, against its id in `tree`.
  // Nothing reads these yet - they are what a table keyed on `dune_dir.id` has
  // to join a `genrules` timing row back through.
  readonly genRulesStrIds: Int32Array;
  readonly genRulesDirIds: Int32Array;
}

// The directory a rule is filed under, spelled the way dir_tree.ts wants it:
// dune reports the top level either as no `dir` at all or as `.`, and `joinDir`
// (graph.ts) already treats the two identically, so they must not become two
// rows.
function ruleDirKey(dir: string | undefined): string {
  return dir === undefined || dir === '.' ? '' : dir;
}

function censusDirs(
  graph: BuildGraph,
  genRulesStrIds: readonly number[],
): DirCensus {
  const tree = new DirTree();
  const dirId = new Int32Array(graph.nodeCount);
  // Grown as directories are interned; a directory that exists only as an
  // intermediate prefix is never bumped, so these end up at most `tree.size`
  // long and are padded out below.
  const nRules: number[] = [];
  const nDeps: number[] = [];
  const nFailed: number[] = [];
  const nGenRules: number[] = [];
  const bump = (counts: number[], id: number) => {
    while (counts.length <= id) counts.push(0);
    counts[id]++;
  };
  // First, so the directories dune generated rules for are in the tree before
  // anything asks for a node's directory id.
  const genRulesDirIds = new Int32Array(genRulesStrIds.length);
  for (let i = 0; i < genRulesStrIds.length; i++) {
    const dir = tree.intern(graph.path(genRulesStrIds[i]));
    genRulesDirIds[i] = dir;
    bump(nGenRules, dir);
  }
  for (let id = 0; id < graph.ruleCount; id++) {
    const dir = tree.intern(ruleDirKey(graph.dirOf(id)));
    dirId[id] = dir;
    bump(nRules, dir);
    if (FAILED_OUTCOME_CODES.has(graph.outcomeCodeOf(id))) {
      bump(nFailed, dir);
    }
  }
  for (let id = graph.ruleCount; id < graph.nodeCount; id++) {
    // A dep's path is its interned string; its directory is everything before
    // the last segment boundary.
    const dir = tree.intern(parentDir(graph.path(graph.traceIdOf(id))));
    dirId[id] = dir;
    bump(nDeps, dir);
  }
  const sized = (counts: number[]): Int32Array => {
    const out = new Int32Array(tree.size);
    out.set(counts);
    return out;
  };
  return {
    tree,
    dirId,
    nRules: sized(nRules),
    nDeps: sized(nDeps),
    nFailed: sized(nFailed),
    nGenRules: sized(nGenRules),
    genRulesStrIds: Int32Array.from(genRulesStrIds),
    genRulesDirIds,
  };
}

// The dict ids of the directories dune ran `gen-rules` for, straight off the
// timing table (see lifecycle_sql.ts). Filtered on `kind` rather than read as
// bare keys: a `genrules` key and a dep's `orig_id` are both dict ids in the
// same space, so an unfiltered read would intern deps as directories.
//
// Ids rather than the strings themselves - which the emitter interns for this
// very reason - because the census wants the *paths* and can resolve them out
// of the dict the blob parse already holds, instead of megabytes of text coming
// back through SQL.
async function genRulesDirStrIds(engine: Engine): Promise<number[]> {
  const result = await engine.query(`
    SELECT DISTINCT key AS str_id
    FROM ${TIMING_TABLE}
    WHERE kind = ${timingKindCode('genrules')}
  `);
  const ids: number[] = [];
  const it = result.iter({str_id: NUM});
  for (; it.valid(); it.next()) ids.push(it.str_id);
  return ids;
}

// RULE_DIR_TABLE's rows: a rule's *trace-side* id (which is what the timing
// table is keyed by) against its directory.
function ruleDirRows(graph: BuildGraph, census: DirCensus): RowSource {
  return {
    count: graph.ruleCount,
    *rows(): Iterable<string> {
      for (let id = 0; id < graph.ruleCount; id++) {
        yield `(${graph.traceIdOf(id)}, ${census.dirId[id]})`;
      }
    },
  };
}

// Each directory's own rules' total span duration - the one part of the
// directory tier that cannot be computed from the graph, since a node's timing
// lives only in `_dune_timing`.
//
// **Scan** the timing table and **probe** a small rowid-keyed map table, never
// the reverse: a per-driving-row probe of the timing table is the mirror's
// historically expensive path, and joining `_dune_rule` to it instead would
// need an index on `_dune_node.orig_id` costing more pages than the map table.
//
// The map table is dropped as soon as the aggregate has run - keeping it would
// leave ~386k rows of pages resident. Durations accumulate as `bigint` because
// their sum genuinely exceeds 2^53 at monorepo scale (~3.4e16 ns).
async function ruleDurationsByDir(
  engine: Engine,
  graph: BuildGraph,
  census: DirCensus,
  opts: MirrorOptions,
): Promise<bigint[]> {
  const durations = new Array<bigint>(census.tree.size).fill(0n);
  const map = await materializeTable(
    engine,
    RULE_DIR_TABLE,
    'rule_id INTEGER PRIMARY KEY, dir_id INTEGER',
    ['rule_id', 'dir_id'],
    ruleDirRows(graph, census),
    opts,
  );
  try {
    await phase(opts, `sql: sum ${DIR_TABLE} durations`, async (p) => {
      const result = await engine.query(`
        SELECT m.dir_id AS dir_id, sum(t.dur_ns) AS dur_ns
        FROM ${TIMING_TABLE} t
        JOIN ${RULE_DIR_TABLE} m ON m.rule_id = t.key
        WHERE t.kind = ${timingKindCode('rule')}
        GROUP BY 1
      `);
      const it = result.iter({dir_id: NUM, dur_ns: LONG_NULL});
      let rows = 0;
      for (; it.valid(); it.next()) {
        rows++;
        // NULL where every one of the directory's rules is unfinished.
        durations[it.dir_id] = it.dur_ns ?? 0n;
      }
      p.rows(rows);
    });
  } finally {
    await map[Symbol.asyncDispose]();
  }
  return durations;
}

/**
 * RAW_DIR_TABLE's rows: a directory, its direct counts and its subtree totals.
 *
 * The subtree totals are rolled up here, in one descending pass, rather than by
 * a recursive CTE in the view. A directory's id is always higher than its
 * parent's (see dir_tree.ts), so by the time the pass reaches a row its own
 * subtree has already been summed into it - no recursion, no `parent_id` index,
 * and no per-query walk behind a view every caller reads.
 */
function dirRows(census: DirCensus, selfDurNs: readonly bigint[]): RowSource {
  const dirs = census.tree.rows;
  const tRules = census.nRules.slice();
  const tDeps = census.nDeps.slice();
  const tFailed = census.nFailed.slice();
  const tGenRules = census.nGenRules.slice();
  const totalDurNs = [...selfDurNs];
  for (let id = dirs.length - 1; id > 0; id--) {
    const parent = dirs[id].parentId;
    if (parent === undefined) continue;
    tRules[parent] += tRules[id];
    tDeps[parent] += tDeps[id];
    tFailed[parent] += tFailed[id];
    tGenRules[parent] += tGenRules[id];
    totalDurNs[parent] += totalDurNs[id];
  }
  return {
    count: dirs.length,
    *rows(): Iterable<string> {
      for (const dir of dirs) {
        yield `(${dir.id}, ${int(dir.parentId)}, ${sqliteString(dir.name)}, ` +
          `${sqliteString(dir.path)}, ${dir.depth}, ` +
          `${census.nRules[dir.id]}, ${census.nDeps[dir.id]}, ` +
          `${census.nFailed[dir.id]}, ${census.nGenRules[dir.id]}, ` +
          `${tRules[dir.id]}, ${tDeps[dir.id]}, ${tFailed[dir.id]}, ` +
          `${tGenRules[dir.id]}, ${selfDurNs[dir.id]}, ` +
          `${totalDurNs[dir.id]})`;
      }
    },
  };
}

// The typed view over RAW_DIR_TABLE. Nothing to reconstitute - a directory row
// is already what a query wants - but declaring the column types is what lets
// the query tab and a DataGrid introspect it, and it keeps `dune_dir` in the
// same public-view / raw-table split as the rest of the tier.
function dirView(): string {
  const types = DIR_COLUMNS.map(
    (c) => `${c} ${c === 'name' || c === 'path' ? 'STRING' : 'LONG'}`,
  );
  return `
      CREATE PERFETTO VIEW ${DIR_TABLE}(
        ${types.join(',\n        ')}
      ) AS
      SELECT ${DIR_COLUMNS.join(', ')} FROM ${RAW_DIR_TABLE}
  `;
}

// The typed view over `_dune_process`. `slice_id` is sourced as `s.id` from the
// join rather than as the stored integer, so it carries a real
// `SliceTable::Id`; `ts` / `dur_ns` come off the same row, making the join one
// primary-key probe per process slice.
//
// `nullif(s.dur, -1)` is what keeps `dur_ns` honest - see README.md, "Traps
// worth knowing". The same normalisation appears again as the `it.dur >= 0n`
// guard behind {@link ProcessDetails} and has to: `scalarsForRule` reads
// `s.dur` off the raw table, so it never passes through this view.
//
// Two things about the node join:
//
// - It is LEFT: a process can name a rule the blob never recorded, and such a
//   row should report a NULL node rather than vanish.
// - `node_id < ruleCount` is not redundant. A dep's `orig_id` is a dict id in a
//   numbering unrelated to rule ids, so without it the join would match
//   whatever dep shared the number. It is also the term that lets SQLite use
//   the *partial* NODE_ORIG_ID_INDEX, written with the same predicate.
//
// Only rule-forced processes appear: `_dune_process` is filtered to the
// `rule <id>` forcer form, so `rule_id` is never NULL here.
function processView(space: NodeSpace): string {
  return `
      CREATE PERFETTO VIEW ${PROCESS_VIEW}(
        slice_id JOINID(slice.id),
        ts LONG,
        dur_ns LONG,
        rule_id LONG,
        node_id LONG
      ) AS
      -- nullif: perfetto's -1 for a slice that never finished, normalised to
      -- NULL so this reads like every other duration in the mirror.
      SELECT s.id AS slice_id, s.ts AS ts, nullif(s.dur, -1) AS dur_ns,
        p.rule_id AS rule_id, n.node_id AS node_id
      FROM ${PROCESS_TABLE} p
      JOIN slice s ON s.id = p.slice_id
      LEFT JOIN ${RAW_NODE_TABLE} n
        ON n.node_id < ${space.ruleCount} AND n.orig_id = p.rule_id
  `;
}

// A node's span as a half-open interval, for the one purpose needing two spans
// at once: {@link blockedMacro}.
//
// Deliberately *not* a slice of `dune_node`, which publishes `ts` and `dur_ns`
// already: reading them off that view would drag its two `dune_string` probes
// along (SQLite does not eliminate a join whose columns nothing selects), and
// the blocked macro probes a node per *endpoint*, twice per edge row.
//
// The interval is the one the timeline track draws: `ts` is the *start*
// instant's own timestamp and the length is the lifecycle `dur_ns`, not
// `finish.ts - start.ts`. Not interchangeable - a span collapsed to a single
// `-resolved` instant has no distinct finish timestamp, so the subtraction
// would call it zero-length.
//
// `dur_ns IS NULL` means the span never finished, so `end_ts` runs to
// `trace_end()`. A node with no lifecycle timing at all is absent: the joins
// are INNER, and the macro's LEFT JOIN is what turns that into a NULL.
function spanView(space: NodeSpace): string {
  return `
      CREATE PERFETTO VIEW ${SPAN_VIEW}(
        node_id LONG,
        ts LONG,
        end_ts LONG
      ) AS
      SELECT n.node_id AS node_id, s.ts AS ts,
        coalesce(s.ts + t.dur_ns, trace_end()) AS end_ts
      FROM ${RAW_NODE_TABLE} n
      JOIN ${TIMING_TABLE} t
        ON t.kind = ${timingKindExpr('n', space)} AND t.key = n.orig_id
      JOIN slice s ON s.id = coalesce(t.start_slice_id, t.finish_slice_id)
  `;
}

// `dune_blocked!(edges)`, documented for users in dune_tables.ts. An edge means
// "src depends on dst", so the two spans overlap exactly over the stretch where
// src was live and dst was still being built:
//
//   blocked_ns = max(0, min(src_end, dst_end) - max(src_ts, dst_ts))
//
// Zero and NULL differ. Zero is a real answer - disjoint spans, so dst cost src
// nothing. NULL means an endpoint has no lifecycle timing, so the question has
// no answer for that edge; SQLite's multi-argument `min`/`max` propagate it.
//
// Input columns pass through untouched (`e.*`), so this composes with anything
// edge-shaped, the relation functions included.
//
// `CREATE OR REPLACE` because macros cannot be dropped - there is no
// `DROP PERFETTO MACRO` - so a stale one would survive a rebuild.
function blockedMacro(): string {
  return `
      CREATE OR REPLACE PERFETTO MACRO ${BLOCKED_MACRO}(
        edges TableOrSubquery
      )
      RETURNS TableOrSubquery AS
      (
        SELECT e.*,
          max(0, min(es.end_ts, ds.end_ts) - max(es.ts, ds.ts)) AS blocked_ns
        FROM ($edges) e
        LEFT JOIN ${SPAN_VIEW} es ON es.node_id = e.src
        LEFT JOIN ${SPAN_VIEW} ds ON ds.node_id = e.dst
      )
  `;
}

/**
 * Builds the node tier of the mirror (`dune_string` / `dune_node` / `dune_rule`
 * / `dune_dep` / `dune_rule_target` / `dune_dir` / `dune_process`, plus the
 * timing table they
 * join) from `graph` and returns a handle that answers per-node timing and drops everything
 * it made when disposed. Rebuilding is idempotent: any pre-existing tables of
 * the same name are dropped first.
 *
 * The edges live in a separate, far more expensive tier - see
 * {@link buildEdgeMirror}.
 */
export async function buildNodeMirror(
  engine: Engine,
  graph: BuildGraph,
  opts: MirrorOptions = {},
): Promise<SqlNodeMirror> {
  const {perf} = opts;
  const space = nodeSpace(graph);

  // Drop the views up front, not just before their own CREATE: they join the
  // timing table, and the rebuild below replaces it. This only matters when a
  // previous build failed part-way and left them behind (a clean rebuild always
  // goes through the caller's dispose first), but then a stale view would make
  // the timing rebuild the confusing failure instead of this one.
  const dropViews = async () => {
    for (const view of [
      NODE_TABLE,
      RULE_TABLE,
      DEP_TABLE,
      DIR_TABLE,
      PROCESS_VIEW,
      SPAN_VIEW,
    ]) {
      await engine.tryQuery(`DROP VIEW IF EXISTS ${view}`);
    }
  };
  await dropViews();

  // Timing comes from SQL now, and the views join it, so it has to exist before
  // they're created (and be dropped after them - see the dispose below).
  //
  // These two measure themselves (they take a PerfRun, not the options), so
  // their start is reported here on their behalf rather than through `phase()`
  // - see NODE_MIRROR_PHASES, which lists them first for the same reason.
  opts.onProgress?.({phase: LIFECYCLE_TIMING_PHASE});
  const lifecycle = await buildLifecycleTiming(engine, perf);
  // Nothing in the mirror joins this one - the timeline's process track reads
  // it straight by name - but it is built and dropped with the tier so that
  // `nodeMirrorReady` gates it too (see controller.ts).
  opts.onProgress?.({phase: PROCESS_INDEX_PHASE});
  const processes: SqlProcessSlices = await buildProcessSlices(engine, perf);

  // The directory census runs first, ahead of every insert: `_dune_node.dir_id`
  // comes out of it. Only the census moves up - RAW_DIR_TABLE itself is still
  // built last, because its duration rollup has to read the timing table.
  //
  // The census proper is a pure pass over the graph; the one query it needs is
  // read here and handed to it, rather than the pass reaching for an engine of
  // its own. It is folded into this phase rather than given one of its own
  // because it is a keyed range scan of the table the phase above just built,
  // and the census is what it exists for.
  const dirs = await phase(opts, `sql: ${DIR_TABLE} census`, async (p) => {
    const census = censusDirs(graph, await genRulesDirStrIds(engine));
    p.rows(census.tree.size);
    return census;
  });

  // The raw/plain tables (chunked inserts; pre-dropped for idempotent reload).
  // `node_id` / `id` are declared INTEGER PRIMARY KEY, i.e. they *are* the
  // rowid, so every lookup and join on them is already a primary-key hit and
  // none of these needs an index of its own.
  const stringTable = await materializeTable(
    engine,
    STRING_TABLE,
    'id INTEGER PRIMARY KEY, str TEXT',
    ['id', 'str'],
    stringRows(graph),
    opts,
  );
  const rawNodeTable = await materializeTable(
    engine,
    RAW_NODE_TABLE,
    'node_id INTEGER PRIMARY KEY, orig_id INTEGER, ' +
      'forced_by_kind INTEGER, forced_by_target_id INTEGER, dir_id INTEGER',
    ['node_id', 'orig_id', 'forced_by_kind', 'forced_by_target_id', 'dir_id'],
    nodeRows(graph, dirs),
    opts,
  );
  const rawRuleTable = await materializeTable(
    engine,
    RAW_RULE_TABLE,
    'node_id INTEGER PRIMARY KEY, dir_str_id INTEGER, outcome INTEGER, ' +
      'n_targets INTEGER, n_static_deps INTEGER, n_dyn_stages INTEGER, ' +
      'deps_unknown INTEGER, dep_set INTEGER',
    [
      'node_id',
      'dir_str_id',
      'outcome',
      'n_targets',
      'n_static_deps',
      'n_dyn_stages',
      'deps_unknown',
      'dep_set',
    ],
    ruleRows(graph),
    opts,
  );
  const rawDepTable = await materializeTable(
    engine,
    RAW_DEP_TABLE,
    'node_id INTEGER PRIMARY KEY, resolution INTEGER, status INTEGER, ' +
      'resolved_rule_node_id INTEGER',
    ['node_id', 'resolution', 'status', 'resolved_rule_node_id'],
    depRows(graph),
    opts,
  );
  const targets = ruleTargetRows(graph);
  const ruleTargetTable = await materializeTable(
    engine,
    RULE_TARGET_TABLE,
    'node_id INTEGER, path TEXT, is_dir INTEGER',
    ['node_id', 'path', 'is_dir'],
    targets,
    opts,
  );

  // The only detail table with a non-rowid key, and the only text the mirror
  // stores: `path` is indexed because joining a rule's targets onto
  // `dune_dep.path` (the documented "what build-dep is this output" query) is
  // otherwise a cross product. Plain (non-PERFETTO) indexes on a plain table;
  // dropped automatically when their table is dropped.
  await phase(opts, `sql: index ${RULE_TARGET_TABLE}`, async (p) => {
    await engine.query(
      `CREATE INDEX ${RULE_TARGET_TABLE}_node_id ` +
        `ON ${RULE_TARGET_TABLE}(node_id)`,
    );
    await engine.query(
      `CREATE INDEX ${RULE_TARGET_TABLE}_path ON ${RULE_TARGET_TABLE}(path)`,
    );
    p.rows(2 * targets.count);
  });

  // The directory table itself (see the file header and dir_tree.ts). Last of
  // the raw tables because its duration rollup reads the timing table, and
  // because it is the one table built from a *query's* result as well as from
  // the graph. Its census already ran, above.
  const selfDurNs = await ruleDurationsByDir(engine, graph, dirs, opts);
  const rawDirTable = await materializeTable(
    engine,
    RAW_DIR_TABLE,
    'id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, path TEXT, ' +
      'depth INTEGER, n_rules INTEGER, n_deps INTEGER, n_failed INTEGER, ' +
      'n_gen_rules INTEGER, t_rules INTEGER, t_deps INTEGER, ' +
      't_failed INTEGER, t_gen_rules INTEGER, ' +
      'self_dur_ns INTEGER, total_dur_ns INTEGER',
    DIR_COLUMNS,
    dirRows(dirs, selfDurNs),
    opts,
  );

  // What the directory explorer walks the tree with (dir_explorer.ts). Both are
  // *descent* keys rather than identities, so neither is a rowid and neither
  // comes for free:
  //
  // - `_dune_node(dir_id)` is the one that matters. Listing a directory's
  //   members is `WHERE dir_id = ?`, and unindexed that is a scan of every node
  //   in the build - 818k rows on the monorepo trace - once per directory
  //   expanded. Indexed it is a probe returning the handful of rows asked for.
  // - `_dune_dir(parent_id)` is the same shape for the tree's own edges
  //   (`WHERE parent_id = ?`, and `IS NULL` for the roots). 19k rows is small
  //   enough that a scan would be survivable, but it is paid on every single
  //   expansion, and an index over 19k rows is nothing.
  //
  // Plain indexes on plain tables, so both are dropped with their table.
  await phase(opts, `sql: index ${DIR_TABLE} descent`, async (p) => {
    await engine.query(
      `CREATE INDEX ${RAW_NODE_TABLE}_dir_id ON ${RAW_NODE_TABLE}(dir_id)`,
    );
    await engine.query(
      `CREATE INDEX ${RAW_DIR_TABLE}_parent_id ` +
        `ON ${RAW_DIR_TABLE}(parent_id)`,
    );
    p.rows(graph.nodeCount + dirs.tree.size);
  });

  // What `dune_process` joins a rule id back to its node with (see
  // {@link processView}). Partial, so it is one entry per rule rather than per
  // node - a dep's `orig_id` is a dict id that no rule id is ever looked up
  // against, so indexing the dep half would be pure waste. Kept for the tier's
  // lifetime rather than created and dropped around the join, since the view
  // resolves it lazily on every query and this is the only rule id -> node
  // route the mirror has. Dropped with its table.
  await phase(opts, `sql: index ${NODE_TABLE} rule ids`, async (p) => {
    await engine.query(
      `CREATE INDEX ${NODE_ORIG_ID_INDEX} ON ${RAW_NODE_TABLE}(orig_id) ` +
        `WHERE node_id < ${space.ruleCount}`,
    );
    p.rows(graph.ruleCount);
  });

  // Typed views over the raw tables: this is where the stored integers become
  // the public schema again - dict ids resolve through `dune_string`, codes
  // through a CASE, a node's kind from which side of `ruleCount` its id falls,
  // and the slice-id columns become SliceTable::Ids, which a plain CREATE TABLE
  // can't declare. The id columns
  // are sourced as `slice.id` from a join (not a raw INTEGER col) so they
  // genuinely carry the id type - the same way the stdlib declares JOINID
  // columns.
  //
  // All three views pick up their timing by joining the timing table on
  // (kind, orig_id), so `slice_id` / `ts` / `dur_ns` / `n_occurrences` and a
  // rule's `action_*` are computed in SQL rather than inserted from JS. Every
  // join is LEFT: a node whose timing never resolved to a lifecycle instant
  // should still get a row (with NULLs) rather than vanish from the mirror, and
  // a cache-hit rule ran no action at all.
  await phase(opts, 'sql: create node views', async () => {
    // The `forced_by` target is a rule id for a RULE forcer (printed as-is) and
    // a dict id for every other kind that names anything (resolved through the
    // intern table) - so the join is skipped for RULE, whose payload would
    // otherwise collide with an unrelated dict entry.
    const ruleForcer = FORCED_BY_KINDS.indexOf('RULE') + 1;
    await engine.query(`
      CREATE PERFETTO VIEW ${NODE_TABLE}(
        node_id LONG,
        kind STRING,
        orig_id LONG,
        slice_id JOINID(slice.id),
        label STRING,
        forced_by_kind STRING,
        forced_by_target STRING,
        dir_id LONG,
        ts LONG,
        dur_ns LONG,
        n_occurrences LONG
      ) AS
      SELECT n.node_id, ${kindExpr('n', space)} AS kind,
        n.orig_id, s.id AS slice_id, ${labelExpr('n', 'ls', space)} AS label,
        ${codeCase('n.forced_by_kind', FORCED_BY_KINDS, 1)} AS forced_by_kind,
        CASE
          WHEN n.forced_by_target_id IS NULL THEN NULL
          WHEN n.forced_by_kind = ${ruleForcer}
            THEN cast(n.forced_by_target_id AS TEXT)
          ELSE coalesce(fs.str, '#' || n.forced_by_target_id)
        END AS forced_by_target,
        n.dir_id,
        s.ts AS ts, t.dur_ns AS dur_ns, t.occurrence_count AS n_occurrences
      FROM ${RAW_NODE_TABLE} n
      ${labelJoin('n', 'ls', space)}
      LEFT JOIN ${STRING_TABLE} fs
        ON n.forced_by_kind != ${ruleForcer} AND fs.id = n.forced_by_target_id
      ${timingJoin('n', 't', 's', space)}
    `);
    await engine.query(`
      CREATE PERFETTO VIEW ${RULE_TABLE}(
        node_id LONG,
        rule_id LONG,
        dir STRING,
        outcome STRING,
        action_slice_id JOINID(slice.id),
        action_ts LONG,
        action_dur_ns LONG,
        n_targets LONG,
        n_static_deps LONG,
        n_dyn_stages LONG,
        deps_unknown LONG
      ) AS
      SELECT r.node_id, n.orig_id AS rule_id, ds.str AS dir,
        ${codeCase('r.outcome', RULE_OUTCOMES)} AS outcome,
        s.id AS action_slice_id, s.ts AS action_ts, t.dur_ns AS action_dur_ns,
        r.n_targets, r.n_static_deps, r.n_dyn_stages, r.deps_unknown
      FROM ${RAW_RULE_TABLE} r
      JOIN ${RAW_NODE_TABLE} n ON n.node_id = r.node_id
      LEFT JOIN ${STRING_TABLE} ds ON ds.id = r.dir_str_id
      LEFT JOIN ${TIMING_TABLE} t
        ON t.kind = ${timingKindCode('action')} AND t.key = n.orig_id
      LEFT JOIN slice s ON s.id = coalesce(t.start_slice_id, t.finish_slice_id)
    `);
    await engine.query(`
      CREATE PERFETTO VIEW ${DEP_TABLE}(
        node_id LONG,
        dep_id LONG,
        path STRING,
        resolution STRING,
        status STRING,
        resolved_rule_node_id LONG,
        is_source LONG
      ) AS
      SELECT d.node_id, n.orig_id AS dep_id,
        coalesce(ps.str, '#' || n.orig_id) AS path,
        ${codeCase('d.resolution', DEP_RESOLUTIONS)} AS resolution,
        ${codeCase('d.status', DEP_STATUSES)} AS status,
        d.resolved_rule_node_id,
        iif(d.resolution = ${DEP_RESOLUTIONS.indexOf('source')}, 1, 0)
          AS is_source
      FROM ${RAW_DEP_TABLE} d
      JOIN ${RAW_NODE_TABLE} n ON n.node_id = d.node_id
      LEFT JOIN ${STRING_TABLE} ps ON ps.id = n.orig_id
    `);
    await engine.query(dirView());
    await engine.query(processView(space));
    // The span view and the macro over it: cheap to define, and defining the
    // macro here rather than with the edge tier keeps it usable over any
    // src/dst-shaped table (a hand-written one included) while only the node
    // tier is up. A macro body is expanded, not resolved, at CREATE time, so
    // the order of these two does not matter.
    await engine.query(spanView(space));
    await engine.query(blockedMacro());
  });

  return {
    nodeCount: graph.nodeCount,
    timingRowCount: lifecycle.rowCount,
    processRowCount: processes.rowCount,

    async ruleNodeForProcessSlice(
      sliceId: number,
    ): Promise<NodeId | undefined> {
      const ruleId = await processes.ruleIdForSliceId(sliceId);
      return ruleId === undefined ? undefined : graph.nodeForRuleId(ruleId);
    },

    async processesForRule(id: NodeId): Promise<readonly ProcessDetails[]> {
      if (!graph.has(id) || !graph.isRule(id)) return [];
      // `timingKeyOf` is a rule node's own `rule_id` - the same id space the
      // `dune.forced_by` arg names, verified end to end on merlin's trace (see
      // process_sql.ts).
      return processes.processesForRuleId(graph.timingKeyOf(id));
    },

    async timingFor(id: NodeId): Promise<NodeTiming> {
      if (!graph.has(id)) return {};
      const isRule = graph.isRule(id);
      // A rule wants its action span alongside its own, in one query; a dep has
      // no action.
      const kinds = isRule ? (['rule', 'action'] as const) : (['dep'] as const);
      const timings = await lifecycle.timings(graph.timingKeyOf(id), kinds);
      return {
        timing: timings.get(isRule ? 'rule' : 'dep'),
        actionTiming: timings.get('action'),
      };
    },

    async [Symbol.asyncDispose](): Promise<void> {
      await dropViews();
      await rawNodeTable[Symbol.asyncDispose]();
      await rawRuleTable[Symbol.asyncDispose]();
      await rawDepTable[Symbol.asyncDispose]();
      await ruleTargetTable[Symbol.asyncDispose]();
      await rawDirTable[Symbol.asyncDispose]();
      // After the views, all three of which resolve strings through it.
      await stringTable[Symbol.asyncDispose]();
      // Last: the views above join it.
      await lifecycle[Symbol.asyncDispose]();
      await processes[Symbol.asyncDispose]();
    },
  };
}

// ---------------------------------------------------------------------------
// The edge tier.
// ---------------------------------------------------------------------------

/**
 * Where each owner's stored members start in its member table, as a running
 * total: the count of every *stored* member (dangling references never reach
 * SQL, so this is not the in-memory table's own offset array) preceding owner
 * `owner`'s run. `offsets[count]` is therefore the total row count, and
 * `offsets[owner] + 1` the rowid the owner's first member lands on - rows are
 * inserted in this same owner order into a freshly created table, so SQLite's
 * rowids run 1..N with it.
 *
 * Shared by the two member tables (`_dune_core_member`, `_dune_depset_add`),
 * whose accessors have the same shape.
 */
function memberOffsets(
  count: number,
  start: (owner: number) => number,
  end: (owner: number) => number,
  target: (i: number) => number,
): Int32Array {
  const offsets = new Int32Array(count + 1);
  let total = 0;
  for (let owner = 0; owner < count; owner++) {
    offsets[owner] = total;
    for (let i = start(owner); i < end(owner); i++) {
      if (target(i) >= 0) total++;
    }
  }
  offsets[count] = total;
  return offsets;
}

// The same, for the *dep* nodes' out-edges - the only edges still stored flat
// (see the file header). Indexed by node id across the whole space so
// {@link outRows} can stay as it is: a rule contributes a zero-length run,
// which is exactly what a node with no stored out-edges already looked like.
function depEdgeOffsets(graph: BuildGraph): Int32Array {
  const offsets = new Int32Array(graph.nodeCount + 1);
  let total = 0;
  for (let id = 0; id < graph.nodeCount; id++) {
    offsets[id] = total;
    if (id < graph.ruleCount) continue;
    for (let i = graph.outStart(id); i < graph.outEnd(id); i++) {
      if (graph.outTarget(i) >= 0) total++;
    }
  }
  offsets[graph.nodeCount] = total;
  return offsets;
}

// The one full pass over the in-memory CSR the edge tier makes, for the two
// things only a full pass answers: `edgeCount` (edges, not stored rows - the
// two differ by ~6x, and the caps are written against edges), and
// `forcedSrc[dst]`, the source of `dst`'s forced edge or -1.
//
// `forcedSrc` is *not* just `graph.forcerOf`: a node's recorded forcer need not
// list it as a dependency, and 45,503 of the monorepo trace's 818,035 recorded
// forcers name no edge at all. Only real edges belong in the forced edge table.
// Filling it by `dst` also makes its rows unique in `dst` - a dep listed both
// statically and dynamically collapses into one row - which is what lets `dst`
// be its INTEGER PRIMARY KEY.
interface EdgeCensus {
  readonly edgeCount: number;
  readonly forcedSrc: Int32Array;
  readonly forcedCount: number;
}

function censusEdges(graph: BuildGraph): EdgeCensus {
  const forcedSrc = new Int32Array(graph.nodeCount).fill(-1);
  let edgeCount = 0;
  let forcedCount = 0;
  for (let source = 0; source < graph.nodeCount; source++) {
    for (let i = graph.outStart(source); i < graph.outEnd(source); i++) {
      const dest = graph.outTarget(i);
      if (dest < 0) continue;
      edgeCount++;
      if (graph.forcerOf(dest) === source && forcedSrc[dest] < 0) {
        forcedSrc[dest] = source;
        forcedCount++;
      }
    }
  }
  return {edgeCount, forcedSrc, forcedCount};
}

// One header row per owner, mapping it to the rowid range of its run in the
// member table (see {@link memberOffsets}). Unlike `_dune_node_out` every owner
// gets a row even when its run is empty: the row carries the owner's other
// columns too (a set's `core_id`), and a set with no adds still has a core.
function ownerRows(offsets: Int32Array, extra?: (owner: number) => string) {
  const count = offsets.length - 1;
  return {
    count,
    *rows(): Iterable<string> {
      for (let owner = 0; owner < count; owner++) {
        const cols = extra === undefined ? '' : `, ${extra(owner)}`;
        yield `(${owner}${cols}, ${offsets[owner] + 1}, ${
          offsets[owner + 1] - offsets[owner]
        })`;
      }
    },
  };
}

// One row per stored member, in owner order - which is what makes the header
// tables' rowid ranges work. Dangling references are skipped, exactly as they
// are for the flat edges.
function memberRows(
  offsets: Int32Array,
  start: (owner: number) => number,
  end: (owner: number) => number,
  target: (i: number) => number,
): RowSource {
  const count = offsets.length - 1;
  return {
    count: offsets[count],
    *rows(): Iterable<string> {
      for (let owner = 0; owner < count; owner++) {
        for (let i = start(owner); i < end(owner); i++) {
          const node = target(i);
          if (node >= 0) yield `(${owner}, ${node})`;
        }
      }
    },
  };
}

// One row per (rule, dynamic-dep stage): the stage's dep set, or NULL for an
// empty stage (`3||5` in the blob is three stages, the middle one with no deps -
// see graph.ts). Rare enough that this is usually empty: the monorepo trace has
// no dynamic deps at all.
function dynStageRows(graph: BuildGraph): RowSource {
  let count = 0;
  for (let id = 0; id < graph.ruleCount; id++) count += graph.dynStageCount(id);
  return {
    count,
    *rows(): Iterable<string> {
      for (let id = 0; id < graph.ruleCount; id++) {
        const stages = graph.dynStageCount(id);
        for (let stage = 0; stage < stages; stage++) {
          yield `(${id}, ${stage}, ${int(graph.dynStageSetOf(id, stage))})`;
        }
      }
    },
  };
}

// The dep nodes' flat out-edges, in node order (so the rowid ranges in
// {@link outRows} address them).
function depEdgeRows(graph: BuildGraph, count: number): RowSource {
  return {
    count,
    *rows(): Iterable<string> {
      for (let id = graph.ruleCount; id < graph.nodeCount; id++) {
        for (let i = graph.outStart(id); i < graph.outEnd(id); i++) {
          const target = graph.outTarget(i);
          if (target >= 0) yield `(${id}, ${target})`;
        }
      }
    },
  };
}

// The forced edges (see {@link censusEdges}), keyed by `dst`: one row per node
// that some node forced into the build *and* depends on.
function forcedEdgeRows(census: EdgeCensus): RowSource {
  return {
    count: census.forcedCount,
    *rows(): Iterable<string> {
      const {forcedSrc} = census;
      for (let dst = 0; dst < forcedSrc.length; dst++) {
        if (forcedSrc[dst] >= 0) yield `(${dst}, ${forcedSrc[dst]})`;
      }
    },
  };
}

// One row per node that has any out-edges, mapping it to the rowid range of its
// run in the edge table (see {@link depEdgeOffsets}). Nodes with none are simply
// absent, which is exactly what a join against this wants.
function outRows(offsets: Int32Array): RowSource {
  const nodeCount = offsets.length - 1;
  let count = 0;
  for (let id = 0; id < nodeCount; id++) {
    if (offsets[id + 1] > offsets[id]) count++;
  }
  return {
    count,
    *rows(): Iterable<string> {
      for (let id = 0; id < nodeCount; id++) {
        const n = offsets[id + 1] - offsets[id];
        if (n > 0) yield `(${id}, ${offsets[id] + 1}, ${n})`;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The edge relation, as SQL. A rule's edges are its dep set's members - one
// join from the set's core plus a range scan of the set's own adds, and the
// factoring is depth 1, so nothing below recurses. That makes the relation a
// five-arm union, read through one of three shapes:
//
// - {@link edgeArms} - join chains off a known node, for one hop in a walk.
//   What the relation functions use, and what the tier's perf rests on.
// - {@link ALL_EDGE_VIEW} - a plain `(src, dst)` view, for the callers that
//   scan the whole relation (`graph_reachable_bfs!`).
// - {@link EDGE_TABLE} - the same arms decorated, i.e. the public view.
// ---------------------------------------------------------------------------

// The member side of a rule arm, given the alias of its `_dune_depset` row:
// either the set's core's members or the set's own adds, both reached by rowid
// range off a header table (see {@link memberOffsets}), so neither member table
// needs an index on its owner column.
//
// The core join is an inner join on purpose: 158,043 of the monorepo trace's
// 205,224 sets have no core, and `xs.core_id IS NULL` has to drop those rows
// rather than emit a NULL endpoint.
function coreMemberJoin(set: string): string {
  return `JOIN ${CORE_TABLE} xc ON xc.core_id = ${set}.core_id
        JOIN ${CORE_MEMBER_TABLE} xm
          ON xm.rowid >= xc.first_rowid
          AND xm.rowid < xc.first_rowid + xc.n`;
}

function depSetAddJoin(set: string): string {
  return `JOIN ${DEPSET_ADD_TABLE} xa
          ON xa.rowid >= ${set}.first_rowid
          AND xa.rowid < ${set}.first_rowid + ${set}.n`;
}

// The arms of the edge relation as join chains reaching the nodes one hop from
// `source` in direction `dir`, each with the expression naming the endpoint.
//
// **Each arm is spliced into its own recursive term** rather than joined as one
// union. That is the load-bearing decision in this file and it was measured -
// see ARCHITECTURE.md, "Why it is shaped this way", for the numbers. SQLite allows a
// recursive CTE several recursive terms as long as each references the
// recursive table once, which is what makes it expressible at all.
//
// The two directions are different join chains over the same tables, not one
// chain read backwards: the forward path is rowid ranges (no index on an owner
// column) while the reverse path probes the member tables by `dep_node_id` and
// walks back up to the rules through the indexes {@link buildEdgeMirror} makes.
//
// `forcedOnly` restricts to forced edges, which are materialized flat, so both
// directions collapse to one arm over {@link FORCED_EDGE_TABLE}.
interface EdgeArm {
  readonly join: string;
  readonly dest: string;
}

function edgeArms(
  dir: Direction,
  source: string,
  opts: {forcedOnly?: boolean} = {},
): readonly EdgeArm[] {
  if (opts.forcedOnly) {
    return dir === 'down'
      ? [
          {
            join: `JOIN ${FORCED_EDGE_TABLE} xf ON xf.src = ${source}`,
            dest: 'xf.dst',
          },
        ]
      : [
          {
            join: `JOIN ${FORCED_EDGE_TABLE} xf ON xf.dst = ${source}`,
            dest: 'xf.src',
          },
        ];
  }
  if (dir === 'down') {
    // A rule node's set (static) or one stage's set (dynamic), expanded; then a
    // dep node's own out-edges, still flat, by rowid range.
    const ruleSet = `JOIN ${RAW_RULE_TABLE} xr ON xr.node_id = ${source}
        JOIN ${DEPSET_TABLE} xs ON xs.set_id = xr.dep_set`;
    const stageSet = `JOIN ${DYN_STAGE_TABLE} xg ON xg.node_id = ${source}
        JOIN ${DEPSET_TABLE} xs ON xs.set_id = xg.set_id`;
    return [
      {
        join: `${ruleSet}\n        ${coreMemberJoin('xs')}`,
        dest: 'xm.dep_node_id',
      },
      {
        join: `${ruleSet}\n        ${depSetAddJoin('xs')}`,
        dest: 'xa.dep_node_id',
      },
      {
        join: `${stageSet}\n        ${coreMemberJoin('xs')}`,
        dest: 'xm.dep_node_id',
      },
      {
        join: `${stageSet}\n        ${depSetAddJoin('xs')}`,
        dest: 'xa.dep_node_id',
      },
      {
        join: `JOIN ${OUT_TABLE} xo ON xo.node_id = ${source}
        JOIN ${RAW_EDGE_TABLE} xe
          ON xe.rowid >= xo.first_rowid
          AND xe.rowid < xo.first_rowid + xo.n`,
        dest: 'xe.dst',
      },
    ];
  }
  // Upwards: from a dep node to everything that names it. Two chains per owner
  // kind - the dep is either one of its set's own adds, or a member of the
  // set's core, which every set sharing that core inherits.
  const viaAdd = `JOIN ${DEPSET_ADD_TABLE} xa ON xa.dep_node_id = ${source}`;
  const viaCore = `JOIN ${CORE_MEMBER_TABLE} xm ON xm.dep_node_id = ${source}
        JOIN ${DEPSET_TABLE} xs ON xs.core_id = xm.core_id`;
  return [
    {
      join: `${viaCore}\n        JOIN ${RAW_RULE_TABLE} xr ON xr.dep_set = xs.set_id`,
      dest: 'xr.node_id',
    },
    {
      join: `${viaAdd}\n        JOIN ${RAW_RULE_TABLE} xr ON xr.dep_set = xa.set_id`,
      dest: 'xr.node_id',
    },
    {
      join: `${viaCore}\n        JOIN ${DYN_STAGE_TABLE} xg ON xg.set_id = xs.set_id`,
      dest: 'xg.node_id',
    },
    {
      join: `${viaAdd}\n        JOIN ${DYN_STAGE_TABLE} xg ON xg.set_id = xa.set_id`,
      dest: 'xg.node_id',
    },
    {join: `JOIN ${RAW_EDGE_TABLE} xe ON xe.dst = ${source}`, dest: 'xe.src'},
  ];
}

/**
 * The whole edge relation as `(src, dst)`, for the callers that read it in full
 * - `graph_reachable_bfs!`, which scans the edge set once however it is shaped,
 * so there is nothing a constraint or an index could save it. Written driving from the *owner* tables, so a full scan of it is a scan
 * of `_dune_rule` with a rowid-range scan of the member tables per set.
 *
 * A plain view, not a PERFETTO one: it is internal, its two columns need no
 * declared types, and PERFETTO views cannot be created over a plain table's
 * rowid ranges without naming every column.
 */
function allEdgeView(): string {
  return `
    CREATE VIEW ${ALL_EDGE_VIEW} AS
    SELECT xr.node_id AS src, xm.dep_node_id AS dst
      FROM ${RAW_RULE_TABLE} xr
      JOIN ${DEPSET_TABLE} xs ON xs.set_id = xr.dep_set
      ${coreMemberJoin('xs')}
    UNION ALL
    SELECT xr.node_id, xa.dep_node_id
      FROM ${RAW_RULE_TABLE} xr
      JOIN ${DEPSET_TABLE} xs ON xs.set_id = xr.dep_set
      ${depSetAddJoin('xs')}
    UNION ALL
    SELECT xg.node_id, xm.dep_node_id
      FROM ${DYN_STAGE_TABLE} xg
      JOIN ${DEPSET_TABLE} xs ON xs.set_id = xg.set_id
      ${coreMemberJoin('xs')}
    UNION ALL
    SELECT xg.node_id, xa.dep_node_id
      FROM ${DYN_STAGE_TABLE} xg
      JOIN ${DEPSET_TABLE} xs ON xs.set_id = xg.set_id
      ${depSetAddJoin('xs')}
    UNION ALL
    SELECT xe.src, xe.dst FROM ${RAW_EDGE_TABLE} xe`;
}

/**
 * The public `dune_edge` view: the same five arms, with the columns the mirror
 * exposes. `edge_kind` and `dyn_deps_stage` are per-arm constants rather than
 * stored columns, since the arms are separate, and `forced` is a primary-key
 * probe into
 * {@link FORCED_EDGE_TABLE} keyed by `dst` - at most one row per `dst`, so the
 * LEFT JOIN cannot multiply an arm's rows.
 *
 * `UNION ALL` throughout: a set's adds are its members minus its core, so the
 * first two arms are disjoint by construction (the blob contract guarantees it,
 * and `graph_build.ts` asserts it at ingest). If that ever regresses the fix is
 * `UNION`, at the cost of a sort over the whole relation.
 */
function edgeView(): string {
  const resolvedCode = DEP_RESOLUTIONS.indexOf('rule');
  // `forced` for an arm, given its endpoint expressions: dst's forcer (if it
  // has one) has to be this very src.
  const forcedJoin = (dst: string) =>
    `LEFT JOIN ${FORCED_EDGE_TABLE} xf ON xf.dst = ${dst}`;
  const forced = (src: string) => `iif(xf.src = ${src}, 1, 0) AS forced`;
  const ruleSet = `JOIN ${DEPSET_TABLE} xs ON xs.set_id = xr.dep_set`;
  const stageSet = `JOIN ${DEPSET_TABLE} xs ON xs.set_id = xg.set_id`;
  return `
    CREATE PERFETTO VIEW ${EDGE_TABLE}(
      src LONG,
      dst LONG,
      forced LONG,
      edge_kind STRING,
      dyn_deps_stage LONG
    ) AS
    SELECT xr.node_id AS src, xm.dep_node_id AS dst,
      ${forced('xr.node_id')},
      'static' AS edge_kind, NULL AS dyn_deps_stage
      FROM ${RAW_RULE_TABLE} xr
      ${ruleSet}
      ${coreMemberJoin('xs')}
      ${forcedJoin('xm.dep_node_id')}
    UNION ALL
    SELECT xr.node_id, xa.dep_node_id, ${forced('xr.node_id')},
      'static', NULL
      FROM ${RAW_RULE_TABLE} xr
      ${ruleSet}
      ${depSetAddJoin('xs')}
      ${forcedJoin('xa.dep_node_id')}
    UNION ALL
    SELECT xg.node_id, xm.dep_node_id, ${forced('xg.node_id')},
      'dynamic', xg.stage
      FROM ${DYN_STAGE_TABLE} xg
      ${stageSet}
      ${coreMemberJoin('xs')}
      ${forcedJoin('xm.dep_node_id')}
    UNION ALL
    SELECT xg.node_id, xa.dep_node_id, ${forced('xg.node_id')},
      'dynamic', xg.stage
      FROM ${DYN_STAGE_TABLE} xg
      ${stageSet}
      ${depSetAddJoin('xs')}
      ${forcedJoin('xa.dep_node_id')}
    UNION ALL
    SELECT xe.src, xe.dst, ${forced('xe.src')},
      iif(xd.resolution = ${resolvedCode}, 'resolved', 'expanded'), NULL
      FROM ${RAW_EDGE_TABLE} xe
      JOIN ${RAW_DEP_TABLE} xd ON xd.node_id = xe.src
      ${forcedJoin('xe.dst')}`;
}

/**
 * `dune_edge_blocked`: {@link edgeView} with {@link blockedMacro} already
 * applied, so the whole edge relation carries a `blocked_ns` column.
 *
 * Pure convenience - `dune_blocked!(dune_edge)` is the same query - but it is
 * the form worth having by name, because "which edges cost time" is the
 * question the column exists to answer and a view is what an ad-hoc query, a
 * saved query, or the query tab can name.
 *
 * The same caution applies as to `dune_edge` itself: the relation is 28.8M rows
 * on a monorepo-scale trace and this adds two span probes to each of them, so
 * it is something to filter (`WHERE src = ...`, a join against a node set), not
 * something to `SELECT *` from.
 */
function edgeBlockedView(): string {
  return `
    CREATE PERFETTO VIEW ${EDGE_BLOCKED_VIEW}(
      src LONG,
      dst LONG,
      forced LONG,
      edge_kind STRING,
      dyn_deps_stage LONG,
      blocked_ns LONG
    ) AS
    SELECT * FROM ${BLOCKED_MACRO}!(${EDGE_TABLE})`;
}

// Builds the edge tier on top of an already-built {@link SqlNodeMirror}, whose
// `node_id` space the endpoints live in. Past {@link EDGE_HARD_LIMIT} it
// refuses outright, with no partial state to leave behind since nothing has
// been created at that point.
//
// Rebuilding is idempotent. The returned handle must be disposed *before* the
// node mirror: its view joins `_dune_dep`, the relation functions read
// `_dune_node` and `_dune_rule`, and it owns an index on `_dune_rule`.
export async function buildEdgeMirror(
  engine: Engine,
  graph: BuildGraph,
  nodes: SqlNodeMirror,
  opts: MirrorOptions = {},
): Promise<SqlEdgeMirror> {
  // The node-id space the generated statements are written against is the
  // *mirrored* one, which is where the endpoints have to exist.
  const space: NodeSpace = {
    ruleCount: graph.ruleCount,
    nodeCount: nodes.nodeCount,
  };

  // One pass over the CSR: the exact edge count the hard cap is checked against
  // (rather than the CSR's slot count, which includes references to nodes the
  // blob never recorded) and the forced edges.
  const census = phaseSync(opts, 'sql: edge census', (p) => {
    const computed = censusEdges(graph);
    p.rows(computed.edgeCount);
    p.note(`${computed.forcedCount.toLocaleString()} forced`);
    return computed;
  });
  const edgeCount = census.edgeCount;
  if (edgeCount > EDGE_HARD_LIMIT) {
    throw new Error(
      `This graph has ${edgeCount.toLocaleString()} edges, past the ` +
        `${EDGE_HARD_LIMIT.toLocaleString()} the edge tables can be built ` +
        'for - materializing them would exhaust the trace processor heap and ' +
        'take the whole trace down with it. The graph itself, the node ' +
        'tables and the side panel all work without them.',
    );
  }

  // Where every stored member lands, which is what the header tables' rowid
  // ranges are.
  const {coreOffsets, setOffsets, depOffsets} = phaseSync(
    opts,
    'sql: member offsets',
    (p) => {
      const offsets = {
        coreOffsets: memberOffsets(
          graph.coreCount,
          (c) => graph.coreMemberStart(c),
          (c) => graph.coreMemberEnd(c),
          (i) => graph.coreMemberTarget(i),
        ),
        setOffsets: memberOffsets(
          graph.depSetCount,
          (set) => graph.depSetAddStart(set),
          (set) => graph.depSetAddEnd(set),
          (i) => graph.depSetAddTarget(i),
        ),
        depOffsets: depEdgeOffsets(graph),
      };
      p.rows(
        offsets.coreOffsets[graph.coreCount] +
          offsets.setOffsets[graph.depSetCount] +
          offsets.depOffsets[graph.nodeCount],
      );
      return offsets;
    },
  );

  // Drop the views first: they read from the raw tables materializeTable
  // recreates.
  await engine.tryQuery(`DROP VIEW IF EXISTS ${EDGE_BLOCKED_VIEW}`);
  await engine.tryQuery(`DROP VIEW IF EXISTS ${EDGE_TABLE}`);
  await engine.tryQuery(`DROP VIEW IF EXISTS ${ALL_EDGE_VIEW}`);

  const coreTable = await materializeTable(
    engine,
    CORE_TABLE,
    'core_id INTEGER PRIMARY KEY, first_rowid INTEGER, n INTEGER',
    ['core_id', 'first_rowid', 'n'],
    ownerRows(coreOffsets),
    opts,
  );
  const coreMemberTable = await materializeTable(
    engine,
    CORE_MEMBER_TABLE,
    'core_id INTEGER, dep_node_id INTEGER',
    ['core_id', 'dep_node_id'],
    memberRows(
      coreOffsets,
      (c) => graph.coreMemberStart(c),
      (c) => graph.coreMemberEnd(c),
      (i) => graph.coreMemberTarget(i),
    ),
    opts,
  );
  const depSetTable = await materializeTable(
    engine,
    DEPSET_TABLE,
    'set_id INTEGER PRIMARY KEY, core_id INTEGER, first_rowid INTEGER, ' +
      'n INTEGER',
    ['set_id', 'core_id', 'first_rowid', 'n'],
    ownerRows(setOffsets, (s) => int(graph.coreOfDepSet(s))),
    opts,
  );
  const depSetAddTable = await materializeTable(
    engine,
    DEPSET_ADD_TABLE,
    'set_id INTEGER, dep_node_id INTEGER',
    ['set_id', 'dep_node_id'],
    memberRows(
      setOffsets,
      (s) => graph.depSetAddStart(s),
      (s) => graph.depSetAddEnd(s),
      (i) => graph.depSetAddTarget(i),
    ),
    opts,
  );
  const stages = dynStageRows(graph);
  const dynStageCount = stages.count;
  const dynStageTable = await materializeTable(
    engine,
    DYN_STAGE_TABLE,
    'node_id INTEGER, stage INTEGER, set_id INTEGER',
    ['node_id', 'stage', 'set_id'],
    stages,
    opts,
  );
  const rawEdgeTable = await materializeTable(
    engine,
    RAW_EDGE_TABLE,
    'src INTEGER, dst INTEGER',
    ['src', 'dst'],
    depEdgeRows(graph, depOffsets[graph.nodeCount]),
    opts,
  );
  const outTable = await materializeTable(
    engine,
    OUT_TABLE,
    'node_id INTEGER PRIMARY KEY, first_rowid INTEGER, n INTEGER',
    ['node_id', 'first_rowid', 'n'],
    outRows(depOffsets),
    opts,
  );
  // The one index the *forward* path needs, because this is the only owner
  // table not keyed by its owner column (a rule has several stages, so
  // `node_id` can't be the rowid, and the stages are not scanned by rowid range
  // - `_dune_depset` is reached from each stage's `set_id`). Unconditional,
  // unlike the reverse-path indexes below: a downward hop would otherwise scan
  // the whole table per rule. Free in practice - no dune trace to hand records
  // a single dynamic dep - but a graph that did would make every walk quadratic.
  await phase(opts, `sql: index ${DYN_STAGE_TABLE}`, async (p) => {
    await engine.query(
      `CREATE INDEX IF NOT EXISTS ${DYN_STAGE_TABLE}_node_id ` +
        `ON ${DYN_STAGE_TABLE}(node_id)`,
    );
    p.rows(dynStageCount);
  });

  const forcedEdgeTable = await materializeTable(
    engine,
    FORCED_EDGE_TABLE,
    'dst INTEGER PRIMARY KEY, src INTEGER',
    ['dst', 'src'],
    forcedEdgeRows(census),
    opts,
  );

  // Indexes, all of them on the *reverse* path: a walk downwards reads owner
  // tables by primary key and member tables by rowid range (see
  // {@link edgeArms}), so nothing forward needs one. Upwards, every arm starts
  // from a `dep_node_id` and has to climb back to the rules, and the forced
  // walk downwards needs `src`.
  //
  // `_dune_rule(dep_set)` is an index on a *node*-tier table that only this
  // tier uses, so this tier creates and drops it; it goes away by itself if the
  // node tier is rebuilt underneath us.
  //
  // Plain (non-PERFETTO) indexes on plain tables - a PERFETTO INDEX is not used
  // to serve a join probe (see PERF_SUMMARY.LOCAL.md), which is the trap this
  // design would otherwise walk straight into.
  await phase(opts, 'sql: index the reverse path', async (p) => {
    const index = async (table: string, column: string) => {
      await engine.query(
        `CREATE INDEX IF NOT EXISTS ${table}_${column} ON ${table}(${column})`,
      );
    };
    await index(CORE_MEMBER_TABLE, 'dep_node_id');
    await index(DEPSET_ADD_TABLE, 'dep_node_id');
    await index(DEPSET_TABLE, 'core_id');
    await index(DYN_STAGE_TABLE, 'set_id');
    await index(RAW_EDGE_TABLE, 'dst');
    await index(FORCED_EDGE_TABLE, 'src');
    await engine.query(
      `CREATE INDEX IF NOT EXISTS ${RULE_DEP_SET_INDEX} ` +
        `ON ${RAW_RULE_TABLE}(dep_set)`,
    );
    p.rows(
      coreOffsets[graph.coreCount] +
        setOffsets[graph.depSetCount] +
        graph.depSetCount +
        depOffsets[graph.nodeCount] +
        census.forcedCount +
        graph.ruleCount,
    );
  });

  // The internal (src, dst) view the full-relation scans read, and the public
  // typed view. Both spell out the same five arms - see {@link edgeArms} for
  // why the walks do *not* read either of them.
  await phase(opts, 'sql: create edge views', async () => {
    await engine.query(allEdgeView());
    await engine.query(edgeView());
    await engine.query(edgeBlockedView());
  });

  await phase(opts, 'sql: create relation functions', async () => {
    // graph_reachable_bfs! lives in this stdlib module.
    await engine.query('INCLUDE PERFETTO MODULE graphs.search');
    // Parameterized transitive-relationship functions + list-macro wrappers.
    await createRelationFunctions(engine, space);
  });

  return {
    edgeCount,

    async [Symbol.asyncDispose](): Promise<void> {
      // Drop the relation function/macro vtabs first (a stale one left around
      // after the raw tables are dropped fails opaquely - "no such table:
      // _dune_depset" - on the next ad-hoc query instead of cleanly), then the
      // views, then the raw tables they (or the query tab) read from.
      // Macros can't be dropped - there's no `DROP PERFETTO MACRO` - but
      // CREATE OR REPLACE on the next reload handles them.
      for (const {name} of RELATION_FUNCTIONS) {
        await engine.tryQuery(`DROP TABLE IF EXISTS ${name}`);
      }
      // Before EDGE_TABLE, which it selects from.
      await engine.tryQuery(`DROP VIEW IF EXISTS ${EDGE_BLOCKED_VIEW}`);
      await engine.tryQuery(`DROP VIEW IF EXISTS ${EDGE_TABLE}`);
      await engine.tryQuery(`DROP VIEW IF EXISTS ${ALL_EDGE_VIEW}`);
      // Ours, on someone else's table (see above).
      await engine.tryQuery(`DROP INDEX IF EXISTS ${RULE_DEP_SET_INDEX}`);
      await forcedEdgeTable[Symbol.asyncDispose]();
      await outTable[Symbol.asyncDispose]();
      await rawEdgeTable[Symbol.asyncDispose]();
      await dynStageTable[Symbol.asyncDispose]();
      await depSetAddTable[Symbol.asyncDispose]();
      await depSetTable[Symbol.asyncDispose]();
      await coreMemberTable[Symbol.asyncDispose]();
      await coreTable[Symbol.asyncDispose]();
    },
  };
}

// A directed walk direction: 'down' follows edges forward (descendants - what
// `node_id` depends on), 'up' follows them in reverse (ancestors - what
// depends on `node_id`).
type Direction = 'down' | 'up';

// Shared 9-column result shape for every relation function below. `src` is
// the depender (upstream), `dst` the prerequisite, regardless of which
// direction the function walks; both are `node_id`s, so a result row feeds
// straight back into another relation function (or joins to `dune_node`).
const RELATION_COLS = `
    src LONG, src_kind STRING, src_id STRING,
    dst LONG, dst_kind STRING, dst_id STRING,
    distance LONG, rule_distance LONG, dep_distance LONG`;

// Every relation function, and the extra scalar args (beyond `node_id`) its
// `!` list-macro wrapper forwards. Also doubles as the drop-list on dispose.
const RELATION_FUNCTIONS: ReadonlyArray<{
  readonly name: string;
  readonly extraArgs: readonly string[];
}> = [
  {name: 'dune_descendants', extraArgs: ['max_steps', 'step_kind']},
  {name: 'dune_ancestors', extraArgs: ['max_steps', 'step_kind']},
  {name: 'dune_all_descendants', extraArgs: []},
  {name: 'dune_all_ancestors', extraArgs: []},
  {name: 'dune_children', extraArgs: []},
  {name: 'dune_parents', extraArgs: []},
  {name: 'dune_forcers', extraArgs: []},
  {name: 'dune_forced', extraArgs: []},
];

// The whole edge set for a directed walk, shaped the way `graph_reachable_bfs!`
// wants it: 'up' reverses the graph by swapping the endpoint columns. Only the
// unbounded fast path uses this - the BFS reads the edge set once and in full,
// so there is nothing a constraint, an index or a rowid range could save it,
// which is exactly the case the union view is good at. `forcedOnly` restricts to
// forced edges (`dune_forcers` / `dune_forced`), which are materialized flat, so
// every row a caller gets back is forced by construction.
function edgeSet(dir: Direction, opts: {forcedOnly?: boolean} = {}): string {
  const from = opts.forcedOnly ? FORCED_EDGE_TABLE : ALL_EDGE_VIEW;
  return dir === 'down'
    ? `(SELECT src AS source_node_id, dst AS dest_node_id FROM ${from})`
    : `(SELECT dst AS source_node_id, src AS dest_node_id FROM ${from})`;
}

// The value `step_kind` selects as the walk's step-budget counter: every hop
// (`distance`) when NULL, else only hops landing on that kind. `prefix` lets
// the same expression be written against a correlated row alias (e.g. `s.`)
// inside the recursive term, or bare column names in a plain SELECT outside it.
function countedExpr(prefix: string): string {
  return `CASE $step_kind
        WHEN 'dep' THEN ${prefix}dep_distance
        WHEN 'rule' THEN ${prefix}rule_distance
        ELSE ${prefix}distance END`;
}

// Projects a `walk(node_id, distance, rule_distance, dep_distance)` CTE (one
// row per reached node) into the shared 9-column relation shape, placing the
// anchor (`param`) on the correct side - `src` for a 'down' walk (anchor is the
// depender), `dst` for an 'up' walk (anchor is the prerequisite) - and
// excluding the anchor itself (`distance > 0`) from the result.
function relationProjection(
  dir: Direction,
  param: string,
  space: NodeSpace,
): string {
  // The walked node (`wn`, joined via the `walk` CTE) and the anchor (`a`), each
  // needing its kind and label reconstituted from its id and the intern table.
  const walkedKind = kindExpr('wn', space);
  const walkedLabel = labelExpr('wn', 'wl', space);
  const anchorKind = kindExpr('a', space);
  const anchorLabel = labelExpr('a', 'al', space);
  const cols =
    dir === 'down'
      ? `a.node_id AS src, ${anchorKind} AS src_kind, ${anchorLabel} AS src_id,
      w.node_id AS dst, ${walkedKind} AS dst_kind, ${walkedLabel} AS dst_id`
      : `w.node_id AS src, ${walkedKind} AS src_kind, ${walkedLabel} AS src_id,
      a.node_id AS dst, ${anchorKind} AS dst_kind, ${anchorLabel} AS dst_id`;
  return `
    SELECT
      ${cols},
      w.distance AS distance, w.rule_distance AS rule_distance, w.dep_distance AS dep_distance
    FROM walk w
    JOIN ${RAW_NODE_TABLE} wn ON wn.node_id = w.node_id
    ${labelJoin('wn', 'wl', space)}
    JOIN ${RAW_NODE_TABLE} a ON a.node_id = ${param}
    ${labelJoin('a', 'al', space)}
    WHERE w.distance > 0`;
}

// The recursive bounded walk backing `dune_descendants` / `dune_ancestors`.
//
// `step_kind` picks which already-tracked column is the step counter, so no
// extra walk state is needed. **The budget stops at the boundary**: a node
// expands only while its OWN counted value is short of it, so with
// `step_kind='dep', max_steps=3` a node at dep_distance=3 does not expand, but
// one it already reached by a *free* hop is still included - on an alternating
// chain, the rule that produced the 3rd dep but not a 4th dep past it.
// `max_steps=0` returns no rows for any `step_kind`; an invalid `step_kind`
// returns no rows rather than silently meaning "every hop counts".
//
// `UNION` (not ALL) dedupes states so repeated visits terminate. `nodeCount`,
// inlined as a literal, is an unconditional depth cap: a simple path has at
// most `nodeCount - 1` hops, so it cannot change the result on a DAG, but the
// input graph is built from trace args and is not guaranteed acyclic, and a
// cycle would increment `distance` every lap with nothing able to interrupt it.
//
// Several states can reach one node at different (rule_distance, dep_distance)
// splits, so `walk` collapses to one row per node via `row_number()` ordered by
// the counted column first: the reported split is the node's minimum under
// whichever metric `step_kind` selects, not necessarily its minimum `distance`.
//
// `walk` is MATERIALIZED so the recursion runs once. Worth 0.3 s against >90 s
// for `dune_children` on merlin's widest rule back when the projection also
// joined `slice` and the planner drove the query from there. That join is gone,
// so the hint may no longer be load-bearing - but the projection still joins
// `_dune_node` and `dune_string` per row and nothing can interrupt a bad plan.
function boundedBody(dir: Direction, param: string, space: NodeSpace): string {
  // One recursive term per arm of the edge relation (see {@link edgeArms} for
  // why they are not one joined union), each carrying the same budget test and
  // the same distance bookkeeping.
  const arms = edgeArms(dir, 's.node_id').map(
    ({join, dest}) => `
      SELECT ${dest}, s.distance + 1,
        s.rule_distance + iif(${isRuleExpr(dest, space)}, 1, 0),
        s.dep_distance + iif(${isRuleExpr(dest, space)}, 0, 1)
      FROM states s
      ${join}
      WHERE ($max_steps IS NULL OR (${countedExpr('s.')}) < $max_steps)
        AND s.distance < ${space.nodeCount}`,
  );
  return `
    WITH RECURSIVE
    states(node_id, distance, rule_distance, dep_distance) AS (
      SELECT node_id, 0, 0, 0 FROM ${RAW_NODE_TABLE}
      WHERE node_id = ${param}
        AND ($step_kind IS NULL OR $step_kind IN ('dep', 'rule'))
      UNION${arms.join('\n      UNION')}
    ),
    walk AS MATERIALIZED (
      SELECT node_id, distance, rule_distance, dep_distance FROM (
        SELECT node_id, distance, rule_distance, dep_distance,
          row_number() OVER (
            PARTITION BY node_id
            ORDER BY (${countedExpr('')}), distance, rule_distance
          ) AS rn
        FROM states
      )
      WHERE rn = 1
    )
    ${relationProjection(dir, param, space)}`;
}

// The unbounded fast path backing `dune_all_descendants` / `dune_all_ancestors`
// / `dune_forcers` / `dune_forced`: the stdlib's cycle-safe C++
// `graph_reachable_bfs!` (over `edgeSet`, forced-only when `opts.forcedOnly`)
// followed by a walk of its parent tree that adds up the traversed nodes' kinds
// - reading each node's kind off its id rather than joining back to
// `_dune_node`.
//
// The parent-tree walk deliberately does *not* re-join the edge relation to
// confirm each (parent, child) pair is an edge: it is one by construction, the
// BFS having built the parent tree out of that same edge set. With a rule's
// edges stored factored, such a join would be the one place a hop had to be
// expanded twice.
//
// `bfs` is MATERIALIZED for the same reason `walk` is in `boundedBody`, and with
// the same order of magnitude at stake: it is referenced from inside the
// recursive parent-tree walk, so without the hint the C++ BFS is re-run once per
// iteration of it (`dune_all_descendants` on merlin's widest rule: 2.3 s
// against 0.3 s).
function bfsBody(
  dir: Direction,
  param: string,
  space: NodeSpace,
  opts: {forcedOnly?: boolean} = {},
): string {
  return `
    WITH RECURSIVE
    bfs AS MATERIALIZED (
      SELECT node_id, parent_node_id FROM graph_reachable_bfs!(
        ${edgeSet(dir, opts)},
        (SELECT ${param} AS node_id))
    ),
    walk(node_id, distance, rule_distance, dep_distance) AS (
      SELECT node_id, 0, 0, 0 FROM bfs WHERE node_id = ${param}
      UNION ALL
      SELECT b.node_id, w.distance + 1,
        w.rule_distance + iif(${isRuleExpr('b.node_id', space)}, 1, 0),
        w.dep_distance + iif(${isRuleExpr('b.node_id', space)}, 0, 1)
      FROM walk w
      JOIN bfs b ON b.parent_node_id = w.node_id
    )
    ${relationProjection(dir, param, space)}`;
}

// One-hop wrapper body for `dune_children` / `dune_parents`: the bounded walk
// with `max_steps=1`. More correct than a raw single join on `dune_edge` would
// be, since the walk's dedup collapses any duplicate edges.
function wrapperBody(fn: string, param: string): string {
  return `SELECT * FROM ${fn}(${param}, 1, NULL)`;
}

// The eight transitive-relationship functions plus their `!` list-macro
// wrappers. **The inventory is documented twice for readers who are not this
// file's**: ARCHITECTURE.md, "The SQL mirror", and dune_tables.ts's DUNE_FUNCTIONS /
// DUNE_MACROS, which is what the query page's sidebar shows.
//
// What belongs here instead is why there are eight rather than one general
// walk: all-pairs closure does not scale, so each is single-source, and each is
// implemented the way its question wants answering - a recursive CTE for the
// bounded walks (`boundedBody`), the stdlib's cycle-safe `graph_reachable_bfs!`
// for the unbounded ones, one hop for the children/parents pair
// (`wrapperBody`), and the same BFS restricted to forced edges for the forcer
// pair. All eight return `RELATION_COLS`.
//
// A `RETURNS TABLE` function is registered as a virtual table keyed by *name*
// only, so no two arities of one name can coexist - which is why the unbounded
// forms are separately named rather than the same function with fewer
// arguments. `CREATE OR REPLACE` keeps a reload idempotent for both functions
// and macros, the latter because macros cannot be dropped at all.
async function createRelationFunctions(
  engine: Engine,
  space: NodeSpace,
): Promise<void> {
  const define = (name: string, args: string, body: string) =>
    engine.query(`
      CREATE OR REPLACE PERFETTO FUNCTION ${name}(${args})
      RETURNS TABLE(${RELATION_COLS}) AS
      ${body}`);

  // Base bounded walk.
  await define(
    'dune_descendants',
    'node_id LONG, max_steps LONG, step_kind STRING',
    boundedBody('down', '$node_id', space),
  );
  await define(
    'dune_ancestors',
    'node_id LONG, max_steps LONG, step_kind STRING',
    boundedBody('up', '$node_id', space),
  );

  // Unbounded fast path.
  await define(
    'dune_all_descendants',
    'node_id LONG',
    bfsBody('down', '$node_id', space),
  );
  await define(
    'dune_all_ancestors',
    'node_id LONG',
    bfsBody('up', '$node_id', space),
  );

  // One hop.
  await define(
    'dune_children',
    'node_id LONG',
    wrapperBody('dune_descendants', '$node_id'),
  );
  await define(
    'dune_parents',
    'node_id LONG',
    wrapperBody('dune_ancestors', '$node_id'),
  );

  // Forced-edge closure.
  await define(
    'dune_forcers',
    'node_id LONG',
    bfsBody('up', '$node_id', space, {forcedOnly: true}),
  );
  await define(
    'dune_forced',
    'node_id LONG',
    bfsBody('down', '$node_id', space, {forcedOnly: true}),
  );

  // `!` list-macro wrappers: run the function per `node_id` in `starts` and
  // union the results, forwarding any trailing scalar args unchanged.
  for (const {name, extraArgs} of RELATION_FUNCTIONS) {
    const macroParams = [
      'starts TableOrSubquery',
      ...extraArgs.map((a) => `${a} Expr`),
    ];
    const callArgs = ['s.node_id', ...extraArgs.map((a) => `$${a}`)];
    await engine.query(`
      CREATE OR REPLACE PERFETTO MACRO ${name}(${macroParams.join(', ')})
      RETURNS TableOrSubquery AS
      (SELECT d.* FROM ($starts) s JOIN ${name}(${callArgs.join(', ')}) d)`);
  }
}
