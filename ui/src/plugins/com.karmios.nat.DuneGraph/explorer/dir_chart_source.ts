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
 * The Explorer pane over a *query's rows*: the source behind the Dune directory
 * chart (see dir_explorer_chart.ts).
 *
 * ## What this is a source of
 *
 * The pane's other source reads a hierarchy and descends it (see
 * `SqlDirExplorerSource`). This one reads a **selection**. The hierarchy still
 * comes from the mirror - `allDirs`, one query, ~19k rows on the monorepo trace,
 * with the dense parent-below-child ids `FilteredTree` needs - because that is
 * where the directory tree exists at all. What the chart's input rows decide
 * is which of those directories are drawn, and what hangs off them.
 *
 * The shape of the whole tree is then decided by one thing, and `dir_filter.ts`
 * already does everything downstream of it: the per-directory count channels.
 * From those, `FilteredTree` does the subtree rollup, the hard filter (a
 * directory with no matching rows gets no row at all), the pass-through
 * compression over what survives, and the expansion remapping - all
 * client-side, all arithmetic.
 *
 * ## Counts and members are fetched differently, because they are different
 * sizes
 *
 * This is the whole design of the file, so it is worth being explicit about.
 * The pane asks a source for two unrelated things, and the naive reading - pull
 * the input rows in once and derive both from them - ties both to the size of
 * the *input*, which is unbounded. A bare `SELECT ... FROM dune_node` chart -
 * one button away, since that is the "Dune nodes" source the side panel
 * appends - names all 818k nodes of the monorepo trace, and holding those in
 * the browser is not something to do at all, never mind to do behind a cap that
 * silently keeps an arbitrary 50k of them and draws a tree of whichever
 * directories they happened to land in.
 *
 * So the two are fetched separately, each bounded by what it is actually
 * bounded by:
 *
 * - **Counts** are an aggregate, and aggregates are what SQL is for. One
 *   `GROUP BY dir_id, kind` returns at most two rows per *directory* - ~38k
 *   rows at the very worst on the monorepo trace, and typically a handful -
 *   however many input rows went into it. Bounded by the mirror rather than by
 *   the input, it needs no cap, and the tree is complete at any scale. This is
 *   the same shape `matchingCounts` in dir_explorer.ts uses against the mirror.
 * - **Members** are needed only for the directories the user actually expands,
 *   and only one `MEMBER_PAGE` at a time, because the pane already pages them.
 *   So each page is its own bounded query rather than a slice of an array that
 *   had to exist first. That also means the input query is re-run per page -
 *   which is what the trace processor is for, and is the same trade the SQL
 *   source makes on every expansion.
 *
 * ## The pane's own filter, on top of the input's
 *
 * The rows are one narrowing; the pane's path box and Filters menu are another,
 * and both apply. That is possible precisely because nothing here is
 * materialised: every one of the three queries is re-issued when it is needed,
 * so the filter's predicates go into them the same way the input's semi-join
 * does. They are the *same* predicates the side panel builds - imported from
 * dir_explorer.ts rather than re-derived, since a filter's meaning is its
 * predicates and two spellings of them would be two things to keep in step.
 *
 * The one part that has to be spelt differently is the rule half of a path
 * filter, because a rule carries no path and is matched on its directory: a
 * member query is keyed on one `dir_id` and so takes it as a constant, while the
 * counts query spans directories and tests the column. See `countsWhere`.
 *
 * Two things deliberately do *not* follow the filter, both read off the
 * unfiltered load: `state.nodeCount`, which answers "did this column name any
 * Dune nodes at all" and is a statement about the chart's config rather than
 * about the pane's filter, and `subtreeDirIds`, which is where the query's rows
 * are and so is what a dashboard brush should name.
 *
 * ## De-duplication, and which way each query joins
 *
 * An input naming the same node more than once is normal rather than exotic: an
 * edge query has a `src` per edge, not per node. Counting join rows would then
 * count a node once per edge, so both queries have to count *nodes* rather
 * than rows, and each does it the way that suits its join direction:
 *
 * - The counts query is driven **from** the input - there is no directory to
 *   start at, and the input is normally the small side - so it de-duplicates
 *   the input first (`SELECT DISTINCT`) and then `count(*)` counts nodes.
 *   Distinct-then-count rather than `count(DISTINCT n.node_id)`: both sort, but
 *   this one sorts once for the whole query instead of building a b-tree per
 *   group, and it shrinks the probe count and the GROUP BY's input as well.
 * - The member queries are driven **into** it: they start from `dir_id`, which
 *   is one index probe returning a directory's handful of nodes, and test each
 *   against the input with `node_id IN (...)`. A semi-join returns each node
 *   once by construction, so there is nothing to de-duplicate, and the cost is
 *   bounded by the directory rather than by the input.
 *
 * ## What it guarantees against the interface's contract
 *
 * Point by point, since `DirExplorerSource`'s header asks implementations to say
 * so:
 *
 * - **Directory ids** are `dune_dir`'s own, straight from `allDirs`, so density
 *   and parent-below-child hold for the same reason they do in the side panel.
 *   The rows only ever *select* directories; they never invent one.
 * - **Compression is the source's job** - and this source cannot do it, which is
 *   why `rootDirs` and `childDirs` throw rather than return
 *   something plausible. A row-driven source has no way to compress a tree it
 *   only knows the leaves of, and it does not have to: `rowDriven` puts the pane
 *   permanently in its filtered mode, where levels come from `FilteredTree` and
 *   the compression is re-run there over the *filtered* shape. Those two methods
 *   are unreachable, and a throw says so where a `[]` would look like an empty
 *   build.
 * - **`matchingCounts` never returns undefined.** Undefined means "all of them",
 *   which for this source would mean falling back to the stored `n_rules` /
 *   `n_deps` and drawing the whole mirror. See `matchingCounts` below.
 * - **Members are paged, rules before deps, and a short page ends the list.**
 *   The order is `ORDER BY n.kind DESC, n.label`, the same one the SQL source's
 *   member query uses, so a page is a page of one list rather than of whatever
 *   came back that time.
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

/**
 * Where a source's up-front load has got to, for the chart to render around the
 * pane.
 *
 * "The load" is the counts and the hierarchy - the two whole-tier reads the
 * tree's shape needs. Member pages are not part of it: they are fetched per
 * expansion and their failures belong to the row that asked, which is where the
 * pane already reports them.
 *
 * A discriminated union rather than a bag of optional fields because the chart
 * switches on it exhaustively: each phase is a different thing to show, and
 * "no rows matched" has to be distinguishable from "not asked yet".
 */
type ChartSourceState =
  | {readonly phase: 'idle'}
  | {readonly phase: 'loading'}
  | {
      readonly phase: 'ready';
      /**
       * Distinct nodes the query's rows named, i.e. the counts summed.
       *
       * Zero is the chart's "this query named no nodes at all" state, and is
       * the reason this is carried rather than recomputed from
       * {@link ChartDirExplorerSource.matchingCounts}, which is async.
       */
      readonly nodeCount: number;
    }
  | {readonly phase: 'error'; readonly message: string};

// Everything one load produced, held for as long as the source lives. Small by
// construction: two numbers per directory and one hierarchy, both bounded by
// `dune_dir` rather than by the chart's input.
interface LoadedTree {
  readonly dirs: readonly DirEntry[];
  /**
   * Per kind, how many of the input's nodes each directory holds directly, with
   * no member filter applied.
   *
   * The unfiltered channel specifically, because two things that must not follow
   * the pane's filter are read off it: `nodeCount`, which is the chart's "this
   * query named no Dune nodes at all" state and so is a claim about the column
   * the chart was configured with; and `subtreeDirIds`, which is where the
   * query's rows are and so is what a dashboard filter should name.
   */
  readonly counts: DirCounts;
  // Child directory ids by parent id, over the *whole* mirror hierarchy - what
  // a narrow-to-this-directory click walks. Built here rather than taken off
  // `FilteredTree`, which keeps its own copy private and holds the filtered
  // shape rather than the real one.
  readonly childIds: ReadonlyMap<number, readonly number[]>;
}

/**
 * The Explorer pane's source over a Data Explorer chart's input rows.
 *
 * Built once per mount by the chart's loader and thrown away with it (see
 * `ChartLoaderEntry.custom`), because the pane treats a new source object as new
 * data and drops every cache it holds: one per render would collapse the tree
 * every frame.
 *
 * The counts load is lazy and happens at most once per mirror version. A graph
 * reload renumbers every node and rebuilds `dune_dir`, which invalidates both
 * halves of what is held here - the counts' `dir_id`s and the hierarchy they
 * index into - so `version` follows `mirrorVersion` exactly as the SQL source's
 * does, and the next read re-runs the queries. Member pages need no such check:
 * they are read fresh from the mirror every time, and the pane drops the ones
 * it cached when `version` moves.
 */
export class ChartDirExplorerSource implements DirExplorerSource {
  readonly rowDriven = true;

  private stateValue: ChartSourceState = {phase: 'idle'};
  private loadPromise?: Promise<LoadedTree>;
  private loadedVersion?: number;
  private loaded?: LoadedTree;
  // Counts under an *active* member filter, by `${version}|${fingerprint}` -
  // see `countsFor`. Keyed on the version as well, so a rebuilt mirror is never
  // answered out of the old one's `dir_id`s.
  private readonly filteredCounts = new Map<string, Promise<DirCounts>>();
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

  get version(): number {
    return this.controller.mirrorVersion;
  }

  /** Where the up-front load has got to. Cheap; read every render. */
  get state(): ChartSourceState {
    return this.stateValue;
  }

  /**
   * Starts the load if it has not started, so the chart can render the state of
   * it rather than an empty tree.
   *
   * Idempotent and safe to call every frame: the promise is cached, a rejected
   * one stays cached (a failing query is not retried once a frame), and the
   * message is on `state` rather than thrown at the caller.
   */
  ensureLoaded(): void {
    void this.load().catch(() => {
      // Reported through `state`. Swallowed here so that a failed load is not
      // also an unhandled rejection every frame.
    });
  }

  /** Frees the counts. Called through `ChartLoaderEntry.custom`. */
  dispose(): void {
    this.disposed = true;
    this.loadPromise = undefined;
    this.loaded = undefined;
    this.filteredCounts.clear();
    this.stateValue = {phase: 'idle'};
  }

  /**
   * The directories of `id`'s subtree that actually hold input rows, `id`
   * included.
   *
   * What a "narrow everything else to this directory" click sends, and
   * deliberately not the whole subtree: the mirror's subtree under a root runs
   * to thousands of directories, nearly all of which hold none of the query's
   * rows, and every one of them would be another value in the `dir_id IN (...)`
   * the filter becomes. Dropping them cannot change which rows match, since a
   * directory with no rows selects none.
   *
   * Read off the counts rather than off a member list: a directory holds rows
   * exactly when one of the two count channels names it, which is the same test
   * `FilteredTree` drew the row by.
   *
   * Empty until the load lands, which is also when the chart first offers the
   * click.
   */
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

  /**
   * The directory whose subtree `ids` is, or undefined if they are not one.
   *
   * The inverse of `subtreeDirIds`, and the way a card reads its own brush back
   * out of the filters it was persisted as: the brush is a set of `dir_id`s and
   * nothing records which directory produced it, but a set that came from there
   * has exactly one member every other member sits under, and that member is
   * the directory the click named.
   *
   * Undefined for anything that is not that - an id this mirror has never heard
   * of, two unrelated subtrees, a set left over from a graph since rebuilt. The
   * caller is recovering state it can equally do without, so a set that cannot
   * be explained is dropped rather than guessed at.
   *
   * Careful: `subtreeDirIds` returns only the directories that hold rows, so a
   * click on a directory holding none of its own is indistinguishable from one
   * on the deepest descendant that holds them all, and this answers with the
   * latter. Both brush the same rows; what differs is which row draws pressed.
   */
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

  /**
   * Unreachable: a row-driven source is never descended a level at a time (see
   * the file header and `DirExplorerSource.rowDriven`).
   *
   * Async so that the throw arrives as a rejection, which is what the pane's
   * fetch wrappers catch and turn into a message. A synchronous throw would
   * escape a render.
   */
  async rootDirs(): Promise<readonly DirEntry[]> {
    throw new Error(NOT_DESCENDED);
  }

  /** Unreachable, for the same reason as `rootDirs` above. */
  async childDirs(): Promise<readonly DirEntry[]> {
    throw new Error(NOT_DESCENDED);
  }

  /** The mirror's hierarchy, unchanged - see the file header. */
  async allDirs(): Promise<readonly DirEntry[]> {
    return (await this.load()).dirs;
  }

  /**
   * The directories whose own path matches - the rule half of a path filter.
   *
   * Nothing to do with the chart's input, and so not this source's own question
   * at all: it is a scan of `dune_dir`'s `path` column, and a rule's directory
   * either matches the pattern or does not, whether or not the query named that
   * rule. Which rules the *input* named is settled separately, by the semi-join
   * every query below carries. So this delegates to the same query the side
   * panel's source runs.
   */
  matchingRuleDirs(path: PathFilter): Promise<ReadonlySet<number>> {
    return matchingRuleDirs(this.engine, path);
  }

  /**
   * How many of the input's nodes of `kind` each directory holds that also match
   * `filter` - the count channel the tree's shape comes out of.
   *
   * Two narrowings, ANDed, and both are real: the input's semi-join (which is
   * what makes this chart a picture of its query) and the pane's own member
   * filter, which the pane offers here exactly as it does in the side panel. An
   * empty filter is the common case and costs no second query - it is the load's
   * own counts.
   *
   * Never undefined, unlike the SQL source's. Undefined means "every member of
   * this kind matches", which sends `FilteredTree` to the stored `n_rules` /
   * `n_deps` and draws the whole mirror's tree - the exact bug this chart exists
   * to not have. A directory absent from the map holds nothing matching and so
   * gets no row at all.
   *
   * The interface's third argument, `ruleDirs`, is deliberately not taken. One
   * query answers both kinds here, so it cannot depend on something only the
   * `kind === 'rule'` call is handed; it spells the rule path test as a subquery
   * over the same `dune_dir` scan instead - see `countsWhere`.
   */
  async matchingCounts(
    kind: NodeKind,
    filter: MemberFilter,
  ): Promise<ReadonlyMap<number, number>> {
    return (await this.countsFor(filter))[kind];
  }

  /**
   * One page of `id`'s members that the input named, in the pane's paging
   * order.
   *
   * One query per page rather than a slice of rows held in memory: the input
   * can name every node in the build, and a directory's own membership cannot,
   * so starting from `dir_id` is what keeps this bounded. A short page ends the
   * list, as promised - which falls out of the `LIMIT`.
   */
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

  /**
   * Every member of `id` of the given kinds that the input named, as node ids -
   * what the bulk ＋all / －all buttons act on.
   *
   * Unbounded in row count, like the SQL source's twin and for the same reason:
   * nothing is rendered from these, the count is already on screen before the
   * click, and it is still one directory's *direct* members rather than a scan
   * of the input. Unordered, also like the twin - the caller is about to put
   * them in a Set.
   */
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

  /**
   * The `WHERE` body both member queries share: the directory, the kinds asked
   * for, the pane's member filter, and membership of the input.
   *
   * `dir_id` first because it is the term that selects rows - it is an index
   * probe of `_dune_node(dir_id)` returning a directory's handful of nodes (see
   * sql_graph.ts), which everything else then tests rather than searches. The
   * input's semi-join is last for the same reason it is in the side panel's
   * queries: it narrows, it does not drive.
   *
   * With no filter this is exactly what it always was, and in particular carries
   * no `kind` clause when both kinds are wanted: `kind` is a computed column on
   * the view and a node has no third kind, so the clause would narrow nothing.
   * With one, the per-kind arms come from dir_explorer.ts unchanged - the two
   * kinds are narrowed on different columns, so a filter *is* a pair of arms and
   * the kind test is what picks between them.
   *
   * @param id The directory to list.
   * @param kinds The kinds to keep, or empty for "both".
   * @param filter The pane's member filter, possibly the empty one.
   * @param dirPathMatches Whether `id`'s own path matched the filter, which is
   *   the rule arm's path test (see `matchingRuleDirs`).
   */
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

  /**
   * The counts and the hierarchy, fetched at most once per mirror version.
   *
   * The version check is what makes a graph reload land: the pane drops its
   * caches when `version` moves and asks again, and this notices that what
   * it holds was read out of a mirror that no longer exists.
   */
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
      // Two queries, both of them whole-tier reads rather than per-row work:
      // the mirror's hierarchy, and the input's counts over it. Issued together
      // because neither needs the other's answer.
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

  /**
   * The counts for `filter`, fetched at most once per (mirror version, filter).
   *
   * The empty filter is the load's own counts, so the pane's default state and
   * every render of it cost nothing beyond the load. An active filter is one
   * further query - the same one, with predicates - and it is asked for once per
   * apply rather than per render, so it is cached but not retried: a rejected
   * entry is dropped, which makes re-applying the same filter a retry rather
   * than an instant repeat of the error.
   */
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

  /**
   * How many of the input's nodes matching `filter` each directory holds, per
   * kind.
   *
   * The one query the tree's whole shape comes out of, and the reason there is
   * no row cap anywhere in this file: the `GROUP BY` collapses the input to at
   * most two rows per directory before anything crosses into the browser, so
   * the result is bounded by `dune_dir` (~19k rows) whatever the input's size.
   *
   * The join is driven from the (de-duplicated) input side into `dune_node`'s
   * primary key, so the cost is one probe per distinct input node rather than a
   * scan - see the file header on why the de-duplication is here rather than in
   * the aggregate.
   *
   * **Whether the filter is cheaper here than in the side panel depends entirely
   * on the query.** The side panel's path filter is a scan of every dep in the
   * build, because `dune_node.label` resolves through a join to `dune_string`
   * with no index on the string, and it has all 818k nodes to test. Here the
   * candidates are the input's distinct nodes instead, so a query naming a few
   * thousand rows makes the same filter two orders of magnitude cheaper - but a
   * chart over a bare `SELECT * FROM dune_node` names the whole build and pays
   * exactly what the side panel pays. That is why this is still submit-on-Enter
   * with no debounce: the semi-join makes the good case fast without making the
   * worst case safe to run per keystroke.
   */
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

  /**
   * The `FROM` / `JOIN` / `WHERE` that select exactly the input's nodes matching
   * `filter` - the one selection this source is a source of.
   *
   * Split out from the aggregate above it so that the selection reads on its
   * own: the join is what makes those counts a count of *the query's* nodes
   * rather than of the mirror's.
   */
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

  // The input's node id column, as a one-column relation to test membership of.
  // Not de-duplicated: `IN` is a set test, so duplicates change nothing and
  // sorting them out would cost the member queries the very thing starting from
  // `dir_id` bought them.
  //
  // `quoteIdentifier`, because the column name comes from a chart's config -
  // persisted in dashboards, typed by a user - and so is not something to
  // interpolate raw. Note that this is *identifier* quoting and has nothing to
  // do with `sqlValue`'s string-literal quoting, which sits next to it in the
  // same module; conflating the two is a bug in both directions.
  private inputIds(): string {
    return `SELECT ${quoteIdentifier(this.nodeColumn)} FROM (${this.query})`;
  }
}

/**
 * The `FROM` a query narrowed by `filter` needs.
 *
 * The detail tables come in only when there is a filter to reach into them,
 * which keeps the unfiltered queries - the ones that run on every chart, on
 * every mirror version - exactly as narrow as they were. When a filter is
 * active they are joined whether or not that particular filter names a rule or
 * dep column: both are primary-key probes (`node_id` is their rowid), and
 * picking the joins apart per field would be a second place for the filter's
 * meaning to live.
 */
function memberFrom(filter: MemberFilter): string {
  return filterActive(filter) ? MEMBER_FROM : 'FROM dune_node n';
}

/**
 * The counts query's `WHERE`, or nothing at all when no filter is active.
 *
 * Nothing at all rather than a tautology: with no filter the arms are both `1`
 * and the clause would be a comparison on `kind`, a computed column, for every
 * row of the join.
 *
 * The rule arm's path test is a *subquery* here, not the id set the pane already
 * holds from `matchingRuleDirs`. Two reasons, and the first is correctness: this
 * is one query for both kinds, so it cannot depend on an argument only the
 * `kind === 'rule'` call is given. The second is that the set can be most of
 * `dune_dir` - a filter of `_build` matches 19k directories on the monorepo
 * trace - and inlining that many values into the statement costs more than the
 * scan it was meant to save.
 */
function countsWhere(filter: MemberFilter): string {
  if (!filterActive(filter)) return '';
  const rulePath =
    filter.path === undefined
      ? undefined
      : `n.dir_id IN (${ruleDirsQuery(filter.path)})`;
  return `WHERE ${memberKindArms(BOTH_KINDS, filter, rulePath)}`;
}

// What `rootDirs` / `childDirs` say when a row-driven source is asked to be
// descended. Spelt out rather than left as a bare throw: if this ever surfaces
// it means the pane took its lazy path against a source that has no levels to
// give, which is a wiring mistake and not something a user did.
const NOT_DESCENDED =
  "The Dune directory chart draws its tree from its query's rows, so it has " +
  'no directory levels to descend. This is a bug: the pane should be in its ' +
  'filtered mode for a row-driven source.';

// Every counted node, over both kinds. The counts are per (directory, kind) and
// each node is counted once, so this is the number of distinct nodes the input
// named - which is what the chart's "named no nodes at all" state tests.
function totalCount(counts: DirCounts): number {
  let total = 0;
  for (const byDir of Object.values(counts)) {
    for (const n of byDir.values()) total += n;
  }
  return total;
}

/**
 * Child directory ids by parent id, over every directory in the mirror.
 *
 * The `DirEntry` rows carry a `parentId` and nothing else about their children,
 * so walking a subtree needs the edges turned round once.
 */
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
