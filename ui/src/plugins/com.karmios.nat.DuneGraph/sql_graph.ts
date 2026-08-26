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
 * Materializes the in-memory {@link BuildGraph} into Perfetto SQL tables so the
 * graph can be queried by relationship (e.g. distance between two nodes) in the
 * same SQL engine as the rest of the trace, and drives the distance query.
 *
 * **Two tiers.** The mirror is built in two independently-owned halves, because
 * their costs differ by orders of magnitude (see PERF_PLAN.LOCAL.md): the node
 * tier ({@link buildNodeMirror}) is one row per node plus its per-kind detail -
 * hundreds of thousands of rows on a monorepo-scale trace - while the edge tier
 * ({@link buildEdgeMirror}) is the edges, which on the same trace are 28.8M of
 * them (stored factored, so ~6.3M rows). The node tier is what the side panel
 * and the derived timeline track need; the edge tier is what the relation
 * functions and `distances()` need. The edge tier reads the node tier's
 * `_dune_rule` and `_dune_dep` (and owns an index on the former), so it must be
 * built after the node tier and disposed *before* it.
 *
 * **Every stored column is an integer.** The tables the rows are INSERTed into
 * hold ids, small codes and counts and nothing else; the text a query wants is
 * reconstituted by the PERFETTO VIEW over each of them, which is also where the
 * public column names and types live. Three mechanisms do that work, and they're
 * why the mirror fits in memory at monorepo scale:
 *
 * - **`dune_string(id, str)`** is the blob's intern table, copied in whole
 *   (663k rows / 57 MB on the monorepo trace). Every path the mirror mentions -
 *   a node's label, a rule's dir, a dep's path, a forcer's target - is a dict id
 *   joined against it rather than a repeated string, which is a ~2x saving over
 *   storing the text (the same path is referenced many times) and a feature in
 *   its own right: `SELECT * FROM dune_string WHERE str GLOB '*.cmi'`.
 * - **A node's kind is its id**, since the graph numbers rules `[0, ruleCount)`
 *   and deps `[ruleCount, nodeCount)` (see graph.ts). `ruleCount` is inlined into
 *   every generated statement, so no table and no edge row carries a kind column.
 * - **Codes, not words**: an outcome / resolution / `forced_by` kind is stored as
 *   its index in the corresponding list in graph.ts and mapped back by a CASE in
 *   the view.
 *
 * The mirror is split by kind rather than one wide table: `dune_node` carries
 * only what's meaningful for *every* node (identity, slice, forcing, timing);
 * `dune_rule` / `dune_dep` / `dune_rule_target` carry kind-specific detail,
 * keyed on the same `node_id`. This avoids NULL-heavy rule-only columns on
 * `dune_node` (e.g. an action duration) and columns whose meaning differs by
 * kind (a rule's cache-hit outcome vs. a dep's resolution). The detail tables
 * are keyed *on* `node_id` rather than reached via a foreign key column on
 * `dune_node`: `kind` already discriminates which detail table applies, so an
 * FK would be redundant, and every join is a plain `... USING (node_id)`.
 *
 * - `dune_node(node_id, kind, orig_id, slice_id, label, forced_by_kind,
 *   forced_by_target, ts, dur_ns, n_occurrences)` — one row per node, a typed
 *   PERFETTO VIEW over the raw `_dune_node` table the rows are inserted into,
 *   joined to the timing table (`lifecycle_sql.ts`) on (kind, orig_id).
 *   `node_id` is the node's identity everywhere (it's what the query tab
 *   chip-renders and what the relation functions take); `slice_id` is its
 *   primary lifecycle slice as a `SliceTable::Id` (`JOINID(slice.id)`, LEFT
 *   JOINed since a node whose timing never resolved has none, and many-to-one
 *   in reverse since a rule's start/finish/action instants share a `rule_id`) -
 *   descriptive timing data, not an identifier.
 *   `ts` is the slice's own timestamp; `dur_ns` the span's
 *   duration, NULL for an unfinished span; `n_occurrences` how many same-keyed
 *   spans were seen (>1 under watch mode, or for a dep built repeatedly).
 *   `forced_by_kind` / `forced_by_target` mirror the node's `forcedBy` (the
 *   target is the forcing rule id / dep path / dune-file path, or NULL).
 * - `dune_rule(node_id, rule_id, dir, outcome, action_slice_id, action_ts,
 *   action_dur_ns, n_targets, n_static_deps, n_dyn_stages, deps_unknown)` — one
 *   row per rule node, a view over `_dune_rule`. `outcome`: `executed` |
 *   `local-cache-hit` | `shared-cache-hit` | `failed-deps` | `failed-action` |
 *   `cancelled` | `unfinished` (the last meaning the span never ended, i.e. a
 *   truncated trace - not a failure). `deps_unknown` is 1 when dune reported
 *   that it couldn't determine the rule's deps: `n_static_deps` is 0 either
 *   way, so filter on this before reading a 0 as "this rule has no deps".
 * - `dune_dep(node_id, dep_id, path, resolution, status,
 *   resolved_rule_node_id, is_source)` — one row per dep node, a view over
 *   `_dune_dep`. `resolution`: `rule` | `source` | `expanded` | `unknown` |
 *   `unfinished` (`unknown` = dune couldn't tell because the dep's own build
 *   failed or was cancelled; `unfinished` = the span never ended);
 *   `status` (`ok` | `failed` | `cancelled`) is how building the dep itself
 *   ended and is independent of what it resolved to;
 *   `resolved_rule_node_id` is set
 *   iff `resolution = 'rule'` and that rule is itself a known node.
 * - `dune_rule_target(node_id, path, is_dir)` — a rule's output targets
 *   (`target_files`/`target_dirs`, each joined onto `dir` - see `joinDir` in
 *   graph.ts), one row per target. The one place the mirror still stores text:
 *   a target path is *constructed* (`dir` + a relative name) rather than
 *   interned, so it has no dict id, and it is the documented join key onto
 *   `dune_dep.path` - keeping it stored and indexed is what makes that join a
 *   444k-row index probe instead of a cross product. Write it deps-first
 *   (`FROM dune_dep d JOIN dune_rule_target t ON t.path = d.path`, 1.4 s on the
 *   monorepo trace): `USING (path)` lets SQLite drive from `dune_rule_target`
 *   instead, and since a dep's path comes out of a join to `dune_string` there
 *   is no index on that side to probe back with - that phrasing doesn't finish.
 *   A plain table, not a view: its only id-ish column is the synthetic
 *   `node_id`, which - unlike a real trace-processor table id - `JOINID` cannot
 *   apply to.
 * - `dune_string(id, str)` — the blob's intern table (see above). Also a plain
 *   table, for the same reason.
 * - `dune_dir(id, parent_id, name, path, depth, n_rules, n_deps, n_failed,
 *   t_rules, t_deps, t_failed, self_dur_ns, total_dur_ns)` — the build's
 *   directory hierarchy, one row per distinct directory *prefix*, shaped for an
 *   id/parent_id tree (a root - `_build`, `_opam`, `/usr`, or the top level -
 *   has a NULL `parent_id`; see dir_tree.ts for the segmentation). Its
 *   directories are the union of every rule's `dir` and the containing directory
 *   of every dep's path, because ~23% of the deps on a real trace (the opam
 *   switch, the compiler, `/usr/bin`) live under no rule's `dir` at all. The
 *   `n_*` columns count a directory's own members, the `t_*` columns its whole
 *   subtree, itself included; `n_failed` counts rules whose outcome is
 *   `failed-deps` or `failed-action` (a cancelled or unfinished rule is not a
 *   failure). `self_dur_ns` / `total_dur_ns` sum the *rule* spans of the
 *   directory / its subtree, 0 where nothing was timed - a dep's span is waiting
 *   for build work rather than build work, so adding it would double-count.
 *   The one table whose rows are neither nodes nor edges, so its ids are a dense
 *   space of their own with no relation to `node_id`; `name` and `path` are
 *   stored as text because a *prefix* of an interned directory is not itself
 *   interned, the same reason `dune_rule_target.path` is.
 * - `dune_edge(src, dst, forced, edge_kind, dyn_deps_stage)` — a typed
 *   PERFETTO VIEW, with `src` / `dst` the endpoints' `node_id`s (chip-rendered;
 *   join `dune_node USING`-style on them for an endpoint's label or slice).
 *   Directed edges
 *   where "source depends on dest" (dest is the prerequisite / upstream node):
 *     rule -> dep  (`edge_kind`: static | dynamic, latter carries `dyn_deps_stage`)
 *     dep  -> rule (`edge_kind`: resolved)
 *     dep  -> dep  (`edge_kind`: expanded)
 *   `forced` is 1 iff `dest` was forced into the build by `source` (i.e. dest's
 *   `forcedBy` names source); see `isForcedEdge` in graph.ts.
 *   **A rule's edges are not stored.** They are the members of the dep set the
 *   blob named for it, and the same set recurs across thousands of rules, so the
 *   view reconstructs them from the factored tables below - which is what takes
 *   the tier from 28.8M stored rows to ~6M (see {@link buildEdgeMirror}).
 *   Only a *dep* node's edges are still flat, in `_dune_edge(src, dst)`. `edge_kind`
 *   and `dyn_deps_stage` are per-arm constants of the view rather than stored
 *   columns, which is what retired the packed `flags` integer this tier used to
 *   carry. The relation functions read none of this: they read the arms
 *   directly (see {@link edgeArms}).
 * - `_dune_core(core_id, first_rowid, n)` /
 *   `_dune_core_member(core_id, dep_node_id)` — the shared *cores*: the common
 *   member prefix of the popular dep sets (688 cores holding 125,583 members on
 *   the monorepo trace, behind 47,181 of its 205,224 sets).
 * - `_dune_depset(set_id, core_id, first_rowid, n)` /
 *   `_dune_depset_add(set_id, dep_node_id)` — the dep sets: a core (or NULL) plus
 *   the members the set adds on top of it, which are disjoint from the core by
 *   construction. 205,224 sets / 4.03M adds on the monorepo trace, standing in
 *   for 28.1M rule -> dep edges.
 * - `_dune_rule_dyn_stage(node_id, stage, set_id)` — a rule's dynamic-dep
 *   stages, each naming a set of the same table (NULL for an empty stage). Rare:
 *   no real trace to hand has any dynamic deps at all.
 * - `_dune_forced_edge(dst, src)` — the forced edges, materialized. A node has
 *   at most *one* forcer (`forcedBy` is indexed by node id, see graph.ts), so
 *   there are at most `nodeCount` of these - 772,532 against 28.8M edges on the
 *   monorepo trace - and `dst` is their primary key. Cheap enough to make the
 *   forced walks a table lookup instead of a predicate over the whole relation.
 * - `_dune_node_out(node_id, first_rowid, n)` — forward adjacency for the *dep*
 *   nodes as a *rowid range*. Their edge rows are inserted in node-id order,
 *   i.e. in exactly the order of the in-memory CSR, so a node's out-edges are
 *   contiguous and can be found by rowid instead of through an index on `src`.
 * - `_dune_edge_all(src, dst)` — the whole edge relation, factored arms and flat
 *   ones alike, as a plain view. For the callers that scan the edge set in full
 *   (`graph_reachable_bfs!`, the distance query) and nothing else.
 * - `_dune_process(slice_id, rule_id)` — the trace's process slices, indexed by
 *   the rule that forced them. Not derived from the graph at all; owned by the
 *   node tier only so it shares its lifetime. See process_sql.ts.
 *
 * The two header tables (`_dune_core`, `_dune_depset`) and the member tables
 * they address are the mirror's one departure from "every table is keyed by
 * `node_id`": their key is the *dense index* `graph_build.ts` assigned each core
 * and set on arrival, not the blob's own `core_id` / `set_id`. Dense from zero
 * means the key is the rowid, so a header lookup is a primary-key hit and needs
 * no index; the blob's own ids are per-process join keys with no meaning outside
 * one blob (see `BuildGraph.coreIdOf`), nothing user-facing exposes them, and
 * the graph hands out the dense index anyway (`BuildGraph.depSetOf`), so
 * nothing has to translate. `_dune_rule.dep_set` holds the same dense index.
 *
 * `node_id` **is the in-memory graph's own node id** (see graph.ts): the graph
 * numbers its nodes densely from zero for exactly the reason the stdlib graph
 * macros want them to be, so the mirror inherits that numbering rather than
 * assigning a second one, and translating a node to a `node_id` and back is
 * arithmetic rather than a pair of 800k-entry maps. Every raw table is keyed by
 * it as an `INTEGER PRIMARY KEY`, i.e. as the rowid, so none of them needs a
 * `node_id` index either.
 *
 * `dune_node.orig_id` is the trace-side id (a dep's dict id, a rule's
 * `rule_id`), so it joins to the `dep_id` / `rule_id` args on the lifecycle
 * instants - and, for a dep, straight into `dune_string`. It is *not* the
 * display string: `label` is (a dep's resolved path, a rule's id), and it's what
 * the relation functions' `src_id`/`dst_id` report.
 *
 * It also defines a small library of transitive-relationship SQL functions -
 * see {@link createRelationFunctions} for the full inventory (bounded/unbounded
 * x forward/reverse x all-edges/forced-only, plus one-hop wrappers).
 */

import {sqliteString} from '../../base/string_utils';
import type {Engine} from '../../trace_processor/engine';
import {LONG_NULL, NUM} from '../../trace_processor/query_result';
import {DirTree, parentDir} from './dir_tree';
import type {BuildGraph, NodeId, NodeTiming} from './graph';
import {
  DEP_RESOLUTIONS,
  DEP_STATUSES,
  FORCED_BY_KINDS,
  RULE_OUTCOMES,
} from './graph';
import {
  TIMING_TABLE,
  buildLifecycleTiming,
  timingKindCode,
} from './lifecycle_sql';
import type {PerfRun} from './perf';
import {measure, measureSync} from './perf';
import type {SqlProcessSlices} from './process_sql';
import {buildProcessSlices} from './process_sql';

// `dune_node` / `dune_rule` / `dune_dep` / `dune_edge` are typed PERFETTO VIEWS
// (so slice-id columns are real SliceTable::Ids, and the stored integer codes
// and dict ids read back as text) over the raw tables we actually INSERT the rows into - a CREATE
// PERFETTO TABLE/VIEW can't be chunk-inserted, and a plain CREATE TABLE can't
// express the column types. Internal queries (relation functions, distance) read
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
// The directory hierarchy: a raw table and its typed view like the node tables,
// plus a transient rule -> directory map the duration rollup is aggregated
// through and which is dropped again as soon as it has been (see
// {@link ruleDurationsByDir}).
const DIR_TABLE = 'dune_dir';
const RAW_DIR_TABLE = '_dune_dir';
const RULE_DIR_TABLE = '_dune_rule_dir';

/**
 * Rows per `INSERT ... VALUES (row), (row), ...`.
 *
 * This used to be 500, on the theory that a multi-row VALUES is a compound
 * SELECT and so bounded by SQLite's 500-term compound-SELECT limit. It isn't in
 * the SQLite trace processor ships: 100,000 rows in one statement inserts 100,000
 * rows.
 *
 * 5,000 is the measured optimum, though by a much smaller margin than the
 * numbers this comment used to quote (112 s / 17 s / 10 s for 8M rows at 500 /
 * 5,000 / 20,000): those came from `trace_processor -q`, whose own per-statement
 * cost dominated them. Over the RPC path the plugin actually uses, 2M rows take
 * 4.2 / 3.8 / 6.1 s in wasm at 500 / 5,000 / 20,000 (native 3.0 / 2.3 / 2.8), so
 * this is worth a third off the build, not 6×. It also keeps a statement to
 * roughly 110 KB of SQL text, which is what has to cross into wasm.
 */
const INSERT_CHUNK = 5_000;

// Statements between yields back to the event loop (and progress reports). The
// edge tier is thousands of statements and minutes long on a large graph;
// without a real macrotask yield in there the UI can't repaint and the load
// looks like a hang. 10 statements is 50k rows - often enough to keep the
// progress line moving, rare enough that the yields themselves are noise.
const YIELD_EVERY = 10;

/**
 * Edge counts the edge tier is built against, in rows.
 *
 * Below the soft cap the tier is built as part of a plain load; above it, it has
 * to be asked for; past the hard cap it refuses, because there the build doesn't
 * get slow, it takes the engine down with it.
 *
 * Both come from measurement (see PERF_PLAN.LOCAL.md and PERF_SUMMARY.LOCAL.md),
 * both in the wasm engine rather than extrapolated from `trace_processor -q`,
 * which overstates the per-row cost by ~4×.
 *
 * **Note these count edges, not rows.** Since the tier was factored on dep sets
 * an edge is no longer a row: the monorepo trace's 28.8M edges are 6.33M stored
 * rows, and the whole tier - reverse indexes included - builds in **18.9 s for
 * +519 MB** of wasm heap (1,011 -> 1,530 MB), against 114 s and +1,895 MB when
 * every edge was a row. Edges are what the caps keep counting because by the
 * time they are consulted the graph is parsed and the exact edge count is known,
 * where the row count would have to be predicted. The *pre-parse* gate has the
 * opposite problem and so counts rows - see controller.ts's
 * AUTO_LOAD_EDGE_ROW_LIMIT.
 *
 * Both caps were raised by that measurement, each keeping the bar it was
 * originally set by:
 *
 * - The soft cap is about *time*: a few seconds is a fine thing to do inside a
 *   load. That used to be 2M edges at ~4 s; at 1.5 µs/edge it is now ~10M, and
 *   28.8M at 18.9 s still wants to be asked for.
 * - The hard cap is about *memory*, against a 4 GB ceiling on the memory32 build
 *   (16 GB on memory64, which every current browser loads - see
 *   `gn/standalone/wasm.gni`). At the measured 18 bytes/edge marginal, 100M
 *   edges is ~1.8 GB, which still fits alongside a trace and a node tier on
 *   memory32. The old 40M was set at 54 bytes/edge, i.e. the same ~2.2 GB.
 *
 * The soft cap therefore no longer separates any of the sample traces - the
 * monorepo trace is over it and the rest are orders of magnitude under - but it
 * is what stops a mid-size project paying for the tier unasked, and the band it
 * opens (2M-10M edges, now a plain load) is the point of factoring the tier.
 */
export const EDGE_SOFT_LIMIT = 10_000_000;
export const EDGE_HARD_LIMIT = 100_000_000;

/**
 * Edge count above which the reverse path is left unindexed.
 *
 * Forward walks never need an index (they read owner tables by primary key and
 * member tables by rowid range - see {@link edgeArms}), and neither does the
 * unbounded reverse BFS in principle (`graph_reachable_bfs!` reads the edge set
 * once however it's shaped). Only the *bounded* reverse walk - `dune_ancestors`
 * / `dune_parents` - has to find an edge by where it lands, which now means six
 * indexes rather than one (see {@link buildEdgeMirror}) over ~5M rows rather
 * than one over 28.8M.
 *
 * This used to be 2M, on an extrapolated ~1.1 GB for the index at 28M rows.
 * Measured in the wasm engine on the monorepo trace's 28.7M edges the single
 * `dst` index it used to mean was **27.5 s and +101 MB** - 11× cheaper than the
 * estimate - and now that the tier is factored the widest of the six indexes is
 * `_dune_depset_add(dep_node_id)` at 4.03M rows rather than one at 28.7M. It is
 * also what makes the reverse direction usable at all:
 * `dune_parents` on the most-depended node goes from **39.8 s to 1.2 s**, and
 * even `dune_all_ancestors`, which was supposed not to care, halves (43.4 s to
 * 19.1 s). So the two thresholds collapse into one: if the edge tier is built at
 * all, the indexes are built with it.
 *
 * The threshold and {@link SqlEdgeMirror.reverseIndexed} stay rather than being
 * deleted, because the index is still the first thing to give up if a graph ever
 * turns up that the edge tier itself fits but the index doesn't.
 */
export const REVERSE_INDEX_EDGE_LIMIT = EDGE_HARD_LIMIT;

// Directed dependency distance between two nodes, broken down by node kind.
// `total` is the number of hops on a shortest path; `dep`/`rule` are how many
// of the traversed nodes are deps / rules (so `total === dep + rule`). Counts
// path nodes excluding `fromId` - the same "anchor-relative" convention the
// relation functions below use.
export interface Distances {
  readonly total: number;
  readonly dep: number;
  readonly rule: number;
}

/**
 * How a build reports itself while it runs. Both tiers are long enough to need
 * one (the edge tier by minutes), and the inserts yield to the event loop
 * between batches so the report can actually be painted.
 */
export interface MirrorOptions {
  // Per-phase timing breakdown; see perf.ts.
  readonly perf?: PerfRun;

  // Called with a short human-readable description of where the build is up to,
  // at most once per YIELD_EVERY statements. Cleared by the caller when the
  // build ends.
  readonly onProgress?: (detail: string) => void;
}

/**
 * The cheap tier: `dune_node` + `dune_string` + the per-kind detail tables. Node
 * ids are the graph's own (see the file header), so there is nothing to
 * translate through.
 */
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

  // The node's lifecycle timing, read on demand - timing is no longer carried
  // on the node (see lifecycle_sql.ts). One query per call, so this is for the
  // handful of nodes a panel is actually showing, not for a sweep.
  timingFor(id: NodeId): Promise<NodeTiming>;
}

/**
 * The expensive tier: `dune_edge` plus everything that walks it (the relation
 * functions and `distances()`). Built on top of - and disposed before - the
 * {@link SqlNodeMirror} its endpoints come from.
 */
export interface SqlEdgeMirror extends AsyncDisposable {
  // How many edges were mirrored.
  readonly edgeCount: number;

  // Whether `_dune_edge` is indexed by `dst`, i.e. whether the *bounded* reverse
  // walks (`dune_ancestors` / `dune_parents`) can look an edge up rather than
  // scanning for it. See REVERSE_INDEX_EDGE_LIMIT.
  readonly reverseIndexed: boolean;

  // Directed distances following build-dependency edges from `fromId` to
  // `toId`, or undefined if `toId` is unreachable from `fromId`.
  distances(fromId: number, toId: number): Promise<Distances | undefined>;
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

/**
 * SQL joining a `_dune_node` row (`node`) to the lifecycle slice its span
 * starts at, via the timing table. A node's slice id is no longer a column on
 * its row - it comes from this join (see lifecycle_sql.ts) - so every internal
 * query that wants one needs this, and every one of them also needs the slice
 * row itself, since `JOINID(slice.id)` only holds for a column read straight
 * off `slice`.
 *
 * Both halves are LEFT: a node whose timing never resolved to a lifecycle
 * instant keeps its row with a NULL `slice_id` rather than vanishing from the
 * mirror.
 *
 * Against a `PERFETTO TABLE` each probe is a scan of the whole timing table, so
 * this is an expensive join - a full `dune_node` projection on a monorepo-scale
 * trace is ~80 s. It has a known two-line fix that is *not* currently
 * affordable; see the comment on `TIMING_TABLE` in lifecycle_sql.ts before
 * touching either side of it. `dune_node` is now the only caller: the relation
 * functions used to pay it twice per projected row to report endpoint slice ids,
 * and stopped needing it once their endpoints became `node_id`s. The `kind` side
 * of the key is written here as the integer code that table stores, not as the
 * name the views expose.
 */
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
  await measure(opts.perf, `sql: insert ${name}`, async (p) => {
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
        opts.onProgress?.(
          `${name}: ${inserted.toLocaleString()} of ` +
            `${source.count.toLocaleString()} rows`,
        );
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

function nodeRows(graph: BuildGraph): RowSource {
  return {
    count: graph.nodeCount,
    *rows(): Iterable<string> {
      for (let id = 0; id < graph.nodeCount; id++) {
        const target = int(graph.forcedByTargetIdOf(id));
        yield `(${id}, ${int(graph.traceIdOf(id))}, ${graph.forcedByCodeOf(id)}, ${target})`;
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

// Which rule outcomes `n_failed` counts: dune's two real failures. `cancelled`
// and `unfinished` are not failures (an interrupted or truncated build is not a
// broken one) and a cache hit is a success.
const FAILED_OUTCOME_CODES: ReadonlySet<number> = new Set([
  RULE_OUTCOMES.indexOf('failed-deps'),
  RULE_OUTCOMES.indexOf('failed-action'),
]);

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
  't_rules',
  't_deps',
  't_failed',
  'self_dur_ns',
  'total_dur_ns',
];

/**
 * The directory hierarchy plus each directory's direct membership, from one pass
 * over the nodes.
 *
 * Both kinds of node contribute a directory - a rule its `dir`, a dep the
 * directory its path lives in - because ~23% of the deps on a real trace live
 * under no rule's `dir` at all (the opam switch, the compiler, `/usr/bin`), so a
 * rule-dir-only tree would silently hide every dependency on them. Rules and
 * deps are counted separately, so a directory holding only deps is still a
 * visible row rather than an empty one.
 *
 * The counts are computed here rather than by aggregating `_dune_rule` /
 * `_dune_dep` in SQL because the pass that has to happen anyway - interning
 * every directory, which cannot be done in SQL without recursive string
 * splitting - already visits every node. The SQL alternative would also want a
 * dir id *per node* to group by (818k rows of resident pages), and the mirror
 * has very little room for those (see PERF_SUMMARY.LOCAL.md).
 */
interface DirCensus {
  readonly tree: DirTree;

  // Each rule node's directory id, indexed by node id (rules are the first
  // `ruleCount` nodes). Only RULE_DIR_TABLE reads it.
  readonly ruleDirId: Int32Array;

  // Per directory id: rules whose `dir` it is, deps whose path is directly in
  // it, and how many of those rules failed. All three are `tree.size` long.
  readonly nRules: Int32Array;
  readonly nDeps: Int32Array;
  readonly nFailed: Int32Array;
}

// The directory a rule is filed under, spelled the way dir_tree.ts wants it:
// dune reports the top level either as no `dir` at all or as `.`, and `joinDir`
// (graph.ts) already treats the two identically, so they must not become two
// rows.
function ruleDirKey(dir: string | undefined): string {
  return dir === undefined || dir === '.' ? '' : dir;
}

function censusDirs(graph: BuildGraph): DirCensus {
  const tree = new DirTree();
  const ruleDirId = new Int32Array(graph.ruleCount);
  // Grown as directories are interned; a directory that exists only as an
  // intermediate prefix is never bumped, so these end up at most `tree.size`
  // long and are padded out below.
  const nRules: number[] = [];
  const nDeps: number[] = [];
  const nFailed: number[] = [];
  const bump = (counts: number[], id: number) => {
    while (counts.length <= id) counts.push(0);
    counts[id]++;
  };
  for (let id = 0; id < graph.ruleCount; id++) {
    const dirId = tree.intern(ruleDirKey(graph.dirOf(id)));
    ruleDirId[id] = dirId;
    bump(nRules, dirId);
    if (FAILED_OUTCOME_CODES.has(graph.outcomeCodeOf(id))) {
      bump(nFailed, dirId);
    }
  }
  for (let id = graph.ruleCount; id < graph.nodeCount; id++) {
    // A dep's path is its interned string; its directory is everything before
    // the last segment boundary.
    bump(nDeps, tree.intern(parentDir(graph.path(graph.traceIdOf(id)))));
  }
  const sized = (counts: number[]): Int32Array => {
    const out = new Int32Array(tree.size);
    out.set(counts);
    return out;
  };
  return {
    tree,
    ruleDirId,
    nRules: sized(nRules),
    nDeps: sized(nDeps),
    nFailed: sized(nFailed),
  };
}

// RULE_DIR_TABLE's rows: a rule's *trace-side* id (which is what the timing
// table is keyed by) against its directory.
function ruleDirRows(graph: BuildGraph, census: DirCensus): RowSource {
  return {
    count: graph.ruleCount,
    *rows(): Iterable<string> {
      for (let id = 0; id < graph.ruleCount; id++) {
        yield `(${graph.traceIdOf(id)}, ${census.ruleDirId[id]})`;
      }
    },
  };
}

/**
 * Each directory's own rules' total span duration, summed in SQL and read back
 * as one row per directory.
 *
 * This is the one part of the directory tier that can't be computed from the
 * graph: a node's timing lives only in `_dune_timing`. The shape is the one the
 * perf work endorses (see PERF_SUMMARY.LOCAL.md) - **scan** the timing table and
 * **probe** a small rowid-keyed map table, never the reverse. A per-driving-row
 * probe of the timing table is the mirror's historically expensive path, and
 * joining `_dune_rule` to it instead would need an index on `_dune_node.orig_id`
 * that costs more pages than this whole map table.
 *
 * The map table is dropped again as soon as the aggregate has run: keeping it
 * would leave ~386k rows of pages resident for the rest of the load, and
 * everything downstream only ever wants the per-directory total. Durations are
 * accumulated as `bigint` because their sum genuinely exceeds 2^53 at monorepo
 * scale (~3.4e16 ns over all rules), i.e. a `number` would not be exact.
 */
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
    await measure(opts.perf, `sql: sum ${DIR_TABLE} durations`, async (p) => {
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
  const totalDurNs = [...selfDurNs];
  for (let id = dirs.length - 1; id > 0; id--) {
    const parent = dirs[id].parentId;
    if (parent === undefined) continue;
    tRules[parent] += tRules[id];
    tDeps[parent] += tDeps[id];
    tFailed[parent] += tFailed[id];
    totalDurNs[parent] += totalDurNs[id];
  }
  return {
    count: dirs.length,
    *rows(): Iterable<string> {
      for (const dir of dirs) {
        yield `(${dir.id}, ${int(dir.parentId)}, ${sqliteString(dir.name)}, ` +
          `${sqliteString(dir.path)}, ${dir.depth}, ` +
          `${census.nRules[dir.id]}, ${census.nDeps[dir.id]}, ` +
          `${census.nFailed[dir.id]}, ${tRules[dir.id]}, ${tDeps[dir.id]}, ` +
          `${tFailed[dir.id]}, ${selfDurNs[dir.id]}, ${totalDurNs[dir.id]})`;
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

/**
 * Builds the node tier of the mirror (`dune_string` / `dune_node` / `dune_rule`
 * / `dune_dep` / `dune_rule_target` / `dune_dir`, plus the timing table they
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
    for (const view of [NODE_TABLE, RULE_TABLE, DEP_TABLE, DIR_TABLE]) {
      await engine.tryQuery(`DROP VIEW IF EXISTS ${view}`);
    }
  };
  await dropViews();

  // Timing comes from SQL now, and the views join it, so it has to exist before
  // they're created (and be dropped after them - see the dispose below).
  const lifecycle = await buildLifecycleTiming(engine, perf);
  // Nothing in the mirror joins this one - the timeline's process track reads
  // it straight by name - but it is built and dropped with the tier so that
  // `nodeMirrorReady` gates it too (see controller.ts).
  const processes: SqlProcessSlices = await buildProcessSlices(engine, perf);

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
      'forced_by_kind INTEGER, forced_by_target_id INTEGER',
    ['node_id', 'orig_id', 'forced_by_kind', 'forced_by_target_id'],
    nodeRows(graph),
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
  await measure(perf, `sql: index ${RULE_TARGET_TABLE}`, async (p) => {
    await engine.query(
      `CREATE INDEX ${RULE_TARGET_TABLE}_node_id ` +
        `ON ${RULE_TARGET_TABLE}(node_id)`,
    );
    await engine.query(
      `CREATE INDEX ${RULE_TARGET_TABLE}_path ON ${RULE_TARGET_TABLE}(path)`,
    );
    p.rows(2 * targets.count);
  });

  // The directory tier (see the file header and dir_tree.ts). Last of the raw
  // tables because its duration rollup reads the timing table, and because it is
  // the one table built from a *query's* result as well as from the graph.
  const dirs = measureSync(perf, `sql: ${DIR_TABLE} census`, (p) => {
    const census = censusDirs(graph);
    p.rows(census.tree.size);
    return census;
  });
  const selfDurNs = await ruleDurationsByDir(engine, graph, dirs, opts);
  const rawDirTable = await materializeTable(
    engine,
    RAW_DIR_TABLE,
    'id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, path TEXT, ' +
      'depth INTEGER, n_rules INTEGER, n_deps INTEGER, n_failed INTEGER, ' +
      't_rules INTEGER, t_deps INTEGER, t_failed INTEGER, ' +
      'self_dur_ns INTEGER, total_dur_ns INTEGER',
    DIR_COLUMNS,
    dirRows(dirs, selfDurNs),
    opts,
  );

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
  await measure(perf, 'sql: create node views', async () => {
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

/**
 * The one full pass over the in-memory CSR the edge tier still makes, and the
 * two things only a full pass can answer:
 *
 * - `edgeCount`, the number of edges the mirror represents. Not the number of
 *   stored *rows* any more - a rule's edges are stored factored, so the two
 *   differ by ~6x - but it is what the caps are written against and what the
 *   panel reports, so it is still counted exactly rather than estimated.
 * - `forcedSrc[dst]`, the source of `dst`'s forced edge or -1. A node records a
 *   single forcer (see `isForcedEdge` in graph.ts), so this is a column, not a
 *   list - which is the whole reason {@link FORCED_EDGE_TABLE} is affordable.
 *
 * `forcedSrc` is *not* just `graph.forcerOf`: a node's recorded forcer need not
 * list it as a dependency, and on the monorepo trace 45,503 of 818,035 recorded
 * forcers name no edge at all. Only pairs that really are edges belong in the
 * forced edge table, which is why this reads the CSR rather than the forcer
 * column. Filling it by `dst` also makes the table's rows unique in `dst` (a
 * duplicated `src -> dst` edge, e.g. a dep listed both statically and
 * dynamically, collapses into the one row), which is what lets `dst` be its
 * INTEGER PRIMARY KEY.
 */
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
// The edge relation, as SQL.
//
// A rule's edges are not stored; they are its dep set's members, which is one
// join from the set's core plus one range scan of the set's own adds (the
// factoring is depth 1 - a core never references another core - so no recursion
// is involved anywhere below). That makes the relation a five-arm union, and
// everything that reads edges reads it through one of the three shapes here:
//
// - {@link edgeArms} - the arms as *join chains off a known node*, for a single
//   hop in a walk. This is the shape the relation functions use, and the one
//   the perf of the whole tier rests on: see the comment there.
// - {@link ALL_EDGE_VIEW} - the arms as a plain `(src, dst)` view, for the
//   callers that scan the whole relation (`graph_reachable_bfs!`).
// - {@link EDGE_TABLE} - the same arms with `forced` / `edge_kind` /
//   `dyn_deps_stage` decorations, i.e. the public compatibility view.
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

/**
 * The arms of the edge relation as join chains reaching the nodes one hop from
 * `source` (a node-id expression) in direction `dir`, each with the expression
 * naming the endpoint the hop lands on.
 *
 * **Each arm is spliced into its own recursive term** rather than joined as one
 * union - that is the load-bearing decision in this file, and it was measured,
 * not assumed. SQLite pushes a *constant* constraint down into a compound
 * subquery happily (`WHERE src = 12345` against the union view is ~0.15 ms),
 * but it does not push down a constraint that comes from joining the recursive
 * table: `JOIN <union view> e ON e.src = s.node_id` inside a recursive term
 * re-derives the whole relation per iteration. On a synthetic 5.4M-row stand-in
 * for this mirror a depth-2 walk cost **2.7 s** that way against **~0 ms** with
 * the arms as separate recursive terms - a >1,000x difference that only grows
 * with the real trace's 28.8M. SQLite allows a recursive CTE to have several
 * recursive terms as long as each references the recursive table once, which is
 * what makes this expressible at all.
 *
 * So: `dune_edge` stays a compatibility view for ad-hoc SQL (where a constant
 * constraint *is* pushed down and the view is fine), and the walks get the arms.
 *
 * The two directions are different join chains over the same tables, not the
 * same chain read backwards, because the forward path is rowid ranges (no index
 * on an owner column) while the reverse path probes the member tables by
 * `dep_node_id` and then walks back up to the rules through the indexes listed
 * in {@link buildEdgeMirror}.
 *
 * `forcedOnly` restricts to forced edges, which are materialized flat, so both
 * directions collapse to a single arm over {@link FORCED_EDGE_TABLE} - no flag
 * test and no range scan (this is what `dune_forcers` / `dune_forced` walk).
 */
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
    // dep node's own out-edges, still flat, by rowid range exactly as before.
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
 * - `graph_reachable_bfs!` and the distance query, which scan the edge set once
 * however it is shaped, so there is nothing a constraint or an index could save
 * them. Written driving from the *owner* tables, so a full scan of it is a scan
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
 * has always exposed. `edge_kind` and `dyn_deps_stage` are per-arm constants
 * now that the arms are separate (which is what retired the `flags` word and
 * its packing), and `forced` is a primary-key probe into
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
 * Builds the edge tier of the mirror (`dune_edge` + the relation functions +
 * `distances()`) on top of an already-built {@link SqlNodeMirror}, whose
 * `node_id` space the edge endpoints live in.
 *
 * A rule's edges are stored *factored* - as the dep set the blob named, shared
 * across every rule that named it - so this is no longer one row per edge: on
 * the monorepo trace it is ~6M rows for 28.8M edges. What it still is, is the
 * expensive half of the mirror, so it is built as its own step and the caller
 * decides when (or whether) to pay for it. Past {@link EDGE_HARD_LIMIT} edges it
 * refuses outright rather than taking the engine down: there is no partial state
 * to leave behind, since nothing has been created yet at that point.
 *
 * Rebuilding is idempotent. The returned handle must be disposed *before* the
 * node mirror it was built against: its view joins `_dune_dep`, the relation
 * functions read `_dune_node` and `_dune_rule`, and it owns an index on
 * `_dune_rule`.
 */
export async function buildEdgeMirror(
  engine: Engine,
  graph: BuildGraph,
  nodes: SqlNodeMirror,
  opts: MirrorOptions = {},
): Promise<SqlEdgeMirror> {
  const {perf} = opts;
  // The node-id space the generated statements are written against is the
  // *mirrored* one, which is where the endpoints have to exist.
  const space: NodeSpace = {
    ruleCount: graph.ruleCount,
    nodeCount: nodes.nodeCount,
  };

  // One pass over the CSR: the exact edge count the caps are checked against
  // (rather than the CSR's slot count, which includes references to nodes the
  // blob never recorded) and the forced edges.
  const census = measureSync(perf, 'sql: edge census', (p) => {
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
  const {coreOffsets, setOffsets, depOffsets} = measureSync(
    perf,
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
  await measure(perf, `sql: index ${DYN_STAGE_TABLE}`, async (p) => {
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
  const reverseIndexed = edgeCount <= REVERSE_INDEX_EDGE_LIMIT;
  if (reverseIndexed) {
    await measure(perf, 'sql: index the reverse path', async (p) => {
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
  }

  // The internal (src, dst) view the full-relation scans read, and the public
  // typed view. Both spell out the same five arms - see {@link edgeArms} for
  // why the walks do *not* read either of them.
  await measure(perf, 'sql: create edge views', async () => {
    await engine.query(allEdgeView());
    await engine.query(edgeView());
  });

  await measure(perf, 'sql: create relation functions', async () => {
    // graph_reachable_bfs! lives in this stdlib module.
    await engine.query('INCLUDE PERFETTO MODULE graphs.search');
    // Parameterized transitive-relationship functions + list-macro wrappers.
    await createRelationFunctions(engine, space);
  });

  return {
    edgeCount,
    reverseIndexed,

    async distances(
      fromId: number,
      toId: number,
    ): Promise<Distances | undefined> {
      const result = await engine.query(distanceQuery(fromId, toId, space));
      const row = result.firstRow({
        reachable: NUM,
        total: NUM,
        dep: NUM,
        rule: NUM,
      });
      if (row.reachable === 0) return undefined;
      return {total: row.total, dep: row.dep, rule: row.rule};
    },

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
// `step_kind` selects which already-tracked column acts as the step counter -
// there are only two node kinds, so no extra walk state is needed. A node
// expands (takes another hop) only while its OWN counted value is still short
// of the budget, i.e. the budget is tested "stop at the boundary": with
// `step_kind='dep', max_steps=3` a node reached at dep_distance=3 does not
// expand further, so its own children are excluded, but a node it already
// reached via a *free* (non-counted) hop earlier is still included. Concretely,
// on an alternating dep/rule chain this includes the rule that produced the
// 3rd dep, but not a 4th dep past it. `max_steps=0` returns no rows for any
// `step_kind` (the seed can't expand). An invalid `step_kind` (anything but
// NULL/'dep'/'rule') returns no rows rather than silently meaning "every hop
// counts".
//
// `UNION` (not ALL) dedupes states so the walk terminates on repeated visits;
// `nodeCount` (the graph's total node count, inlined as a literal - cheaper
// than a per-row subquery) is an unconditional depth cap independent of
// `max_steps`: a simple path can have at most `nodeCount - 1` hops, so this can
// never change the result on a DAG, but protects against a cyclic input graph
// (built from trace args at runtime, so not guaranteed acyclic) - without it, a
// cycle increments `distance` every lap forever and nothing in the UI can
// interrupt a runaway query.
//
// Multiple states can reach the same node at different (rule_distance,
// dep_distance) splits (a min-hop path need not be a min-`step_kind`-count
// path), so `walk` collapses to one row per node via `row_number()`, ordered by
// the counted column first - the reported split is the node's minimum under
// whichever metric `step_kind` selects, not necessarily its minimum `distance`.
//
// `walk` is MATERIALIZED so the recursion runs once and the projection below is
// a lookup per reached node. This was worth 0.3 s against >90 s for
// `dune_children` on merlin's widest rule (1,266 children) back when the
// projection also joined `slice` for the endpoints' slice ids: the planner drove
// the whole query from `slice` (that join can't be probed by id off a LEFT JOINed
// timing row) and re-ran the recursive walk per slice. That join is gone now that
// the endpoints are `node_id`s, so the hint may no longer be load-bearing - but
// the projection still joins `_dune_node` and `dune_string` per row, and nothing
// in the UI can interrupt a query that picks the bad plan, so it stays.
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
// The parent-tree walk used to re-join the edge relation to confirm each
// (parent, child) pair was an edge. It is one by construction - the BFS built
// the parent tree out of the same edge set - so that join was redundant, and
// with a rule's edges no longer stored it would have been the one place a hop
// had to be expanded twice. Dropped.
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

/**
 * Defines the parameterized transitive-relationship helpers, exposed for ad-hoc
 * SQL (e.g. via the query tab). All-pairs closure doesn't scale, so these are
 * all single-source, and each is implemented the way its question wants to be
 * answered rather than routed through one general-purpose walk:
 *
 * - `dune_descendants(node_id, max_steps, step_kind)` /
 *   `dune_ancestors(node_id, max_steps, step_kind)` — the general bounded walk
 *   (recursive CTE; see `boundedBody`). `max_steps` NULL means unbounded;
 *   `step_kind` NULL means every hop counts, 'dep'/'rule' means only hops
 *   landing on that kind count.
 * - `dune_all_descendants(node_id)` / `dune_all_ancestors(node_id)` — the
 *   unbounded fast path, built on the stdlib's cycle-safe `graph_reachable_bfs!`
 *   rather than the hand-rolled recursive walk.
 * - `dune_children(node_id)` / `dune_parents(node_id)` — one hop (see
 *   `wrapperBody`).
 * - `dune_forcers(node_id)` / `dune_forced(node_id)` — the unbounded fast path
 *   restricted to forced edges only, so every row returned is forced by
 *   construction; `dune_forcers` walks up (what transitively forced
 *   `node_id`), `dune_forced` walks down (what `node_id` transitively forced).
 *
 * All eight return the same 9-column shape (`RELATION_COLS`):
 *   (src_*, dst_*, distance, rule_distance, dep_distance)
 * `src` is the depender (upstream), `dst` the prerequisite, regardless of which
 * direction the function walks; `distance == rule_distance + dep_distance`.
 * The distances are anchor-relative: they count the path nodes traversed AWAY
 * FROM `node_id`, excluding `node_id` itself. (This is a behaviour change for
 * ancestors, which used to count away from the *far* end of the path instead -
 * the two directions already agreed on `distance` for a shared (src, dst) pair
 * but could disagree on the rule/dep split whenever `kind(src) != kind(dst)`.
 * Anchor-relative counting is required for the `step_kind` budget to mean the
 * same thing in both directions; the cost is that the two directions can now
 * disagree on the split for a pair they both report.)
 *
 * There's no `forced` column any more - dropping it halves the work of every
 * unbounded call, which used to run a second forced-only BFS just to compute
 * it. Per-edge forcing is still on `dune_edge.forced`; to annotate a result
 * with transitive forced-reachability, join against `dune_forced`/`dune_forcers`:
 *   SELECT d.*, f.dst IS NOT NULL AS forced
 *   FROM dune_descendants(42, NULL, NULL) d
 *   LEFT JOIN dune_forced(42) f USING (dst)
 *
 * `dune_descendants`/`dune_ancestors` used to take a single `node_id` arg; that
 * form is gone - a `RETURNS TABLE` function is registered as a virtual table
 * keyed by name only, so the old and new arity can't coexist. Use
 * `dune_all_descendants`/`dune_all_ancestors` for the old unbounded behaviour.
 *
 * Every function above has a same-named `!` list-macro wrapper taking
 * `starts TableOrSubquery` in place of `node_id` (plus any trailing scalar
 * args, see `RELATION_FUNCTIONS`): runs the function once per `node_id` in
 * `starts` and unions the results, e.g.
 * `dune_descendants!(starts, max_steps, step_kind)`, `dune_parents!(starts)`.
 * CREATE OR REPLACE keeps reload idempotent for both functions and macros
 * (macros can't be dropped - there's no `DROP PERFETTO MACRO` - so a stale one
 * would otherwise survive a graph rebuild anyway).
 */
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

// Single-source directed BFS from `fromId`, then walk the BFS parent tree back
// up from `toId` to reconstruct one shortest path and count its nodes by kind.
//
// The BFS macro yields each reachable node once with the id of its first
// encountered predecessor, so `path` is a simple parent walk (no cycles, no
// exponential blow-up) that terminates on reaching `fromId` or a self/NULL
// parent. `reachable` distinguishes an unreachable `toId` (no row) from a
// genuine distance of 0 (fromId == toId).
//
// This reports the dep/rule split *of a shortest total-hop path*. Minimizing
// dep-only or rule-only counts independently would be a different weighting and
// a separate query.
//
// `bfs` is MATERIALIZED for the reason spelled out in `bfsBody`: it is read from
// inside the recursive `path` walk, and without the hint the C++ BFS runs again
// for every hop of the path it is reconstructing.
function distanceQuery(fromId: number, toId: number, space: NodeSpace): string {
  return `
    WITH
    bfs AS MATERIALIZED (
      SELECT node_id, parent_node_id
      FROM graph_reachable_bfs!(
        ${edgeSet('down')},
        (SELECT ${fromId} AS node_id)
      )
    ),
    path(node_id, parent_node_id) AS (
      SELECT node_id, parent_node_id FROM bfs WHERE node_id = ${toId}
      UNION ALL
      SELECT b.node_id, b.parent_node_id
      FROM bfs b JOIN path p ON b.node_id = p.parent_node_id
      WHERE p.node_id != ${fromId}
        AND p.parent_node_id IS NOT NULL
        AND p.parent_node_id != p.node_id
    )
    SELECT
      (SELECT count(*) FROM bfs WHERE node_id = ${toId}) AS reachable,
      (SELECT count(*) FROM path WHERE node_id != ${fromId}) AS total,
      (SELECT count(*) FROM path
        WHERE node_id != ${fromId}
          AND NOT (${isRuleExpr('node_id', space)})) AS dep,
      (SELECT count(*) FROM path
        WHERE node_id != ${fromId}
          AND ${isRuleExpr('node_id', space)}) AS rule
  `;
}
