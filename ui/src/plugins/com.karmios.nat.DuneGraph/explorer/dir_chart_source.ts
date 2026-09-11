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
 * The Explorer pane's source over a Data Explorer chart's input rows: the
 * hierarchy comes from the mirror, and the chart's rows decide which of those
 * directories are drawn.
 *
 * **ARCHITECTURE.md, "The Explorer pane", is the design** - the two source shapes,
 * why counts and members are bounded differently, which way each query joins,
 * and what `DirExplorerSource` asks an implementation to promise. This file is
 * the queries.
 */

import {getErrorMessage} from '../../../base/errors';
import {quoteIdentifier} from '../../../components/widgets/datagrid/sql_utils';
import type {Engine} from '../../../trace_processor/engine';
import {NUM, STR} from '../../../trace_processor/query_result';
import type {DuneGraphController} from '../controller';
import type {
  DirEntry,
  MemberEntry,
  MemberFilter,
  PathFilter,
} from '../model/dir_explorer';
import {
  BOTH_KINDS,
  MEMBER_FROM,
  allDirs,
  filterActive,
  fingerprint,
  matchingRuleDirs,
  memberFilterWhere,
  memberKindArms,
  ruleDirsQuery,
} from '../model/dir_explorer';
import type {DirExplorerSource} from '../views/dir_explorer_source';
import type {NodeKind} from '../model/graph';

/** Per kind, how many nodes each directory holds - the tree's whole shape. */
type DirCounts = Readonly<Record<NodeKind, ReadonlyMap<number, number>>>;

// Where the up-front load - the counts and the hierarchy - has got to. Member
// pages are not part of it: they are fetched per expansion and their failures
// belong to the row that asked.
type ChartSourceState =
  | {readonly phase: 'idle'}
  | {readonly phase: 'loading'}
  | {
      readonly phase: 'ready';
      // Distinct nodes the query's rows named. Carried rather than recomputed
      // from `matchingCounts`, which is async; zero is the chart's "this query
      // named no nodes at all" state.
      readonly nodeCount: number;
    }
  | {readonly phase: 'error'; readonly message: string};

// Everything one load produced. Small by construction: bounded by `dune_dir`
// rather than by the chart's input.
interface LoadedTree {
  readonly dirs: readonly DirEntry[];
  // The *unfiltered* count channel, which is what `nodeCount` and
  // `subtreeDirIds` are read off - see the README on why neither follows the
  // pane's filter.
  readonly counts: DirCounts;
  // Child ids by parent id, over the whole mirror hierarchy - what a
  // narrow-to-this-directory click walks. `FilteredTree` holds the filtered
  // shape and keeps its copy private, so this is built here.
  readonly childIds: ReadonlyMap<number, readonly number[]>;
}

// Built once per mount by the chart's loader and thrown away with it (see
// `ChartLoaderEntry.custom`): the pane treats a new source object as new data,
// so one per render would collapse the tree every frame.
//
// The load is lazy and happens at most once per mirror version - a graph reload
// renumbers every node and rebuilds `dune_dir`, invalidating both the counts'
// `dir_id`s and the hierarchy they index into.
export class ChartDirExplorerSource implements DirExplorerSource {
  readonly rowDriven = true;

  private stateValue: ChartSourceState = {phase: 'idle'};
  private loadPromise?: Promise<LoadedTree>;
  private loadedVersion?: number;
  private loaded?: LoadedTree;
  // Counts under an *active* member filter. Keyed on the version too, so a
  // rebuilt mirror is never answered out of the old one's `dir_id`s.
  private readonly filteredCounts = new Map<string, Promise<DirCounts>>();
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

  get version(): number {
    return this.controller.mirrorVersion;
  }

  // Cheap; read every render.
  get state(): ChartSourceState {
    return this.stateValue;
  }

  // Safe to call every frame: the promise is cached, a rejected one stays
  // cached, and the message lands on `state` rather than at the caller.
  ensureLoaded(): void {
    void this.load().catch(() => {
      // Reported through `state`. Swallowed here so that a failed load is not
      // also an unhandled rejection every frame.
    });
  }

  // Called through `ChartLoaderEntry.custom`.
  dispose(): void {
    this.disposed = true;
    this.loadPromise = undefined;
    this.loaded = undefined;
    this.filteredCounts.clear();
    this.stateValue = {phase: 'idle'};
  }

  // The directories of `id`'s subtree that hold input rows, `id` included -
  // what a "narrow everything else to this directory" click sends. Not the
  // whole subtree: a root's runs to thousands of directories holding none of
  // the query's rows, and each would be another value in the `dir_id IN (...)`
  // the filter becomes. Empty until the load lands.
  subtreeDirIds(id: number): readonly number[] {
    const loaded = this.loaded;
    if (loaded === undefined) return [];
    const out: number[] = [];
    const stack = [id];
    while (stack.length > 0) {
      const at = stack.pop()!;
      if (loaded.counts.rule.has(at) || loaded.counts.dep.has(at)) {
        out.push(at);
      }
      const children = loaded.childIds.get(at);
      if (children !== undefined) stack.push(...children);
    }
    return out;
  }

  // `subtreeDirIds` inverted - how a card reads its own brush back out of the
  // filters it was persisted as. Undefined for a set that is not one subtree,
  // since the caller is recovering state it can do without.
  //
  // Careful: `subtreeDirIds` returns only the directories holding rows, so a
  // click on a directory holding none of its own is indistinguishable from one
  // on the deepest descendant holding them all, and this answers with the
  // latter. Both brush the same rows; only the pressed row differs.
  rootOfDirIds(ids: readonly number[]): number | undefined {
    const loaded = this.loaded;
    if (loaded === undefined || ids.length === 0) return undefined;
    const byId = new Map(loaded.dirs.map((d) => [d.id, d]));

    // The root can only be the shallowest of them, since every other member is
    // to sit below it. Ties need no special case: where two members are equally
    // shallow, whichever is picked the other one fails the walk below.
    let root: DirEntry | undefined;
    for (const id of ids) {
      const dir = byId.get(id);
      if (dir === undefined) return undefined;
      if (root === undefined || dir.depth < root.depth) root = dir;
    }
    if (root === undefined) return undefined;

    // ...and it is the root only if the rest really do sit below it. Each walk
    // up is bounded by the depth difference and the hierarchy is a tree, so
    // this terminates without a visited set.
    const rootId = root.id;
    const rootDepth = root.depth;
    for (const id of ids) {
      let at = byId.get(id);
      while (at !== undefined && at.depth > rootDepth) {
        at = at.parentId === undefined ? undefined : byId.get(at.parentId);
      }
      if (at?.id !== rootId) return undefined;
    }
    return rootId;
  }

  // Unreachable: a row-driven source is never descended. Async so the throw
  // arrives as a rejection, which the pane's fetch wrappers catch - a
  // synchronous throw would escape a render.
  async rootDirs(): Promise<readonly DirEntry[]> {
    throw new Error(NOT_DESCENDED);
  }

  // As `rootDirs` above.
  async childDirs(): Promise<readonly DirEntry[]> {
    throw new Error(NOT_DESCENDED);
  }

  async allDirs(): Promise<readonly DirEntry[]> {
    return (await this.load()).dirs;
  }

  // Nothing to do with the chart's input: a rule's directory matches the
  // pattern or does not, and which rules the input named is settled by the
  // semi-join every query below carries. Hence the side panel's own query.
  matchingRuleDirs(path: PathFilter): Promise<ReadonlySet<number>> {
    return matchingRuleDirs(this.engine, path);
  }

  // Never undefined, unlike the SQL source's: undefined would send
  // `FilteredTree` to the stored `n_rules` / `n_deps` and draw the whole
  // mirror's tree, the exact bug this chart exists not to have.
  //
  // The interface's `ruleDirs` argument is deliberately not taken - one query
  // answers both kinds here, so it cannot depend on something only the
  // `kind === 'rule'` call is handed. See `countsWhere`.
  async matchingCounts(
    kind: NodeKind,
    filter: MemberFilter,
  ): Promise<ReadonlyMap<number, number>> {
    return (await this.countsFor(filter))[kind];
  }

  // One query per page, starting from `dir_id`, which is what keeps this
  // bounded. The promised short-page-ends-the-list falls out of the `LIMIT`.
  async dirMembers(
    id: number,
    kind: NodeKind | undefined,
    limit: number,
    offset: number,
    filter: MemberFilter = {},
    dirPathMatches: boolean = true,
  ): Promise<readonly MemberEntry[]> {
    const kinds = kind === undefined ? [] : [kind];
    const result = await this.engine.query(`
      SELECT n.node_id AS node_id, n.kind AS kind, n.label AS label
      ${memberFrom(filter)}
      WHERE ${this.memberWhere(id, kinds, filter, dirPathMatches)}
      ORDER BY n.kind DESC, n.label
      LIMIT ${limit} OFFSET ${offset}
    `);
    const members: MemberEntry[] = [];
    const it = result.iter({node_id: NUM, kind: STR, label: STR});
    for (; it.valid(); it.next()) {
      members.push({
        nodeId: it.node_id,
        kind: it.kind as NodeKind,
        label: it.label,
      });
    }
    return members;
  }

  // Unbounded and unordered, like the SQL source's twin: nothing is rendered
  // from these and the caller is about to put them in a Set.
  async dirMemberIds(
    id: number,
    kinds: readonly NodeKind[],
    filter: MemberFilter = {},
    dirPathMatches: boolean = true,
  ): Promise<readonly number[]> {
    if (kinds.length === 0) return [];
    const result = await this.engine.query(`
      SELECT n.node_id AS node_id
      ${memberFrom(filter)}
      WHERE ${this.memberWhere(id, kinds, filter, dirPathMatches)}
    `);
    const ids: number[] = [];
    const it = result.iter({node_id: NUM});
    for (; it.valid(); it.next()) ids.push(it.node_id);
    return ids;
  }

  // The `WHERE` both member queries share. `dir_id` first because it is the
  // term that selects rows - an index probe of `_dune_node(dir_id)` - and the
  // input's semi-join last, because it narrows rather than drives.
  //
  // No `kind` clause when both kinds are wanted: `kind` is a computed column on
  // the view and a node has no third kind, so it would narrow nothing.
  private memberWhere(
    id: number,
    kinds: readonly NodeKind[],
    filter: MemberFilter,
    dirPathMatches: boolean,
  ): string {
    const parts: string[] = [];
    if (filterActive(filter)) {
      parts.push(
        memberFilterWhere(
          id,
          kinds.length === 0 ? BOTH_KINDS : kinds,
          filter,
          dirPathMatches,
        ),
      );
    } else {
      parts.push(`n.dir_id = ${id}`);
      if (kinds.length === 1) parts.push(`n.kind = '${kinds[0]}'`);
    }
    parts.push(`n.node_id IN (${this.inputIds()})`);
    return parts.join(' AND ');
  }

  // The version check is what makes a graph reload land: the pane asks again
  // when `version` moves, and this notices what it holds came from a mirror
  // that no longer exists.
  private load(): Promise<LoadedTree> {
    const version = this.controller.mirrorVersion;
    if (this.loadPromise === undefined || this.loadedVersion !== version) {
      this.loadedVersion = version;
      this.stateValue = {phase: 'loading'};
      this.loadPromise = this.fetch();
    }
    return this.loadPromise;
  }

  private async fetch(): Promise<LoadedTree> {
    try {
      // Issued together: neither needs the other's answer.
      const [dirs, counts] = await Promise.all([
        allDirs(this.engine),
        this.fetchCounts({}),
      ]);
      const loaded: LoadedTree = {dirs, counts, childIds: childIndex(dirs)};
      if (!this.disposed) {
        this.loaded = loaded;
        this.stateValue = {phase: 'ready', nodeCount: totalCount(counts)};
        this.controller.requestRedraw();
      }
      return loaded;
    } catch (e) {
      if (!this.disposed) {
        this.stateValue = {phase: 'error', message: getErrorMessage(e)};
        this.controller.requestRedraw();
      }
      throw e;
    }
  }

  // At most once per (mirror version, filter). A rejected entry is dropped, so
  // re-applying the same filter retries rather than repeating the error.
  private async countsFor(filter: MemberFilter): Promise<DirCounts> {
    if (!filterActive(filter)) return (await this.load()).counts;
    const key = `${this.controller.mirrorVersion}|${fingerprint(filter)}`;
    let pending = this.filteredCounts.get(key);
    if (pending === undefined) {
      pending = this.fetchCounts(filter);
      this.filteredCounts.set(key, pending);
      void pending.catch(() => {
        this.filteredCounts.delete(key);
      });
    }
    return pending;
  }

  // The one query the tree's whole shape comes out of, and why there is no row
  // cap in this file: the `GROUP BY` collapses the input to at most two rows
  // per directory before anything crosses into the browser.
  //
  // **Whether the filter is cheaper here than in the side panel depends on the
  // query.** The side panel's path filter scans every dep in the build
  // (`dune_node.label` resolves through a join to `dune_string` with no index
  // on the string). Here the candidates are the input's distinct nodes, so a
  // query naming a few thousand rows is two orders of magnitude cheaper - but a
  // chart over a bare `SELECT * FROM dune_node` pays exactly what the side
  // panel pays. Hence submit-on-Enter with no debounce: the semi-join makes the
  // good case fast without making the worst case safe per keystroke.
  private async fetchCounts(filter: MemberFilter): Promise<DirCounts> {
    const result = await this.engine.query(`
      SELECT n.dir_id AS dir_id, n.kind AS kind, count(*) AS cnt
      ${this.matchingNodes(filter)}
      GROUP BY 1, 2
    `);
    const counts: Record<NodeKind, Map<number, number>> = {
      rule: new Map(),
      dep: new Map(),
    };
    const it = result.iter({dir_id: NUM, kind: STR, cnt: NUM});
    for (; it.valid(); it.next()) {
      counts[it.kind as NodeKind].set(it.dir_id, it.cnt);
    }
    return counts;
  }

  // The `FROM` / `JOIN` / `WHERE` selecting the input's nodes matching
  // `filter`. Split out from the aggregate so the selection reads on its own.
  private matchingNodes(filter: MemberFilter): string {
    return `
      ${memberFrom(filter)}
      JOIN (
        SELECT DISTINCT ${quoteIdentifier(this.nodeColumn)} AS node_id
        FROM (${this.query})
      ) q ON q.node_id = n.node_id
      ${countsWhere(filter)}
    `;
  }

  // Not de-duplicated: `IN` is a set test, so duplicates change nothing.
  //
  // `quoteIdentifier` because the column name comes from a chart's config -
  // persisted, user-typed - so it is not something to interpolate raw. This is
  // *identifier* quoting, not `sqlValue`'s string-literal quoting, which sits
  // next to it in the same module; conflating them is a bug both ways.
  private inputIds(): string {
    return `SELECT ${quoteIdentifier(this.nodeColumn)} FROM (${this.query})`;
  }
}

// The detail tables come in only when a filter reaches into them, which keeps
// the unfiltered queries as narrow as they were. When one is active they are
// joined whether or not it names a rule or dep column: both are primary-key
// probes, and picking them apart per field would be a second place for the
// filter's meaning to live.
function memberFrom(filter: MemberFilter): string {
  return filterActive(filter) ? MEMBER_FROM : 'FROM dune_node n';
}

// Nothing at all rather than a tautology when no filter is active: the arms
// would both be `1` and the clause a comparison on `kind`, a computed column,
// per row of the join.
//
// The rule arm's path test is a *subquery*, not the id set the pane holds from
// `matchingRuleDirs`: this is one query for both kinds, so it cannot depend on
// an argument only the rule call is given, and the set can be most of `dune_dir`
// (19k directories for a filter of `_build`), which costs more to inline than
// the scan it would save.
function countsWhere(filter: MemberFilter): string {
  if (!filterActive(filter)) return '';
  const rulePath =
    filter.path === undefined
      ? undefined
      : `n.dir_id IN (${ruleDirsQuery(filter.path)})`;
  return `WHERE ${memberKindArms(BOTH_KINDS, filter, rulePath)}`;
}

// Spelt out rather than left a bare throw: surfacing it means the pane took its
// lazy path against a row-driven source, which is a wiring mistake.
const NOT_DESCENDED =
  "The Dune directory chart draws its tree from its query's rows, so it has " +
  'no directory levels to descend. This is a bug: the pane should be in its ' +
  'filtered mode for a row-driven source.';

// Each node is counted once per (directory, kind), so this is the distinct
// nodes the input named - what the "named no nodes at all" state tests.
function totalCount(counts: DirCounts): number {
  let total = 0;
  for (const byDir of Object.values(counts)) {
    for (const n of byDir.values()) total += n;
  }
  return total;
}

// `DirEntry` carries a `parentId` and nothing about its children, so walking a
// subtree needs the edges turned round once.
function childIndex(
  dirs: readonly DirEntry[],
): ReadonlyMap<number, readonly number[]> {
  const out = new Map<number, number[]>();
  for (const dir of dirs) {
    if (dir.parentId === undefined) continue;
    const siblings = out.get(dir.parentId);
    if (siblings === undefined) out.set(dir.parentId, [dir.id]);
    else siblings.push(dir.id);
  }
  return out;
}
