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
 * Where the Explorer pane's rows come from - one interface, and the SQL mirror
 * behind the side panel's copy of the pane.
 *
 * dir_explorer_panel.ts is a large component and almost none of it is about
 * data: the expansion set, the inline/bucket decision, the paging, the label
 * arithmetic and the filter menu are all the same whatever is being explored.
 * The seven calls it makes into dir_explorer.ts are the only part that is
 * about *this* tree in *this* mirror, so they are the part that gets an
 * interface.
 * The pane is then mountable somewhere the tree is not `dune_dir` - a Data
 * Explorer chart driven by an arbitrary query's rows - without the rendering
 * being forked to do it.
 *
 * ## What an implementation has to promise
 *
 * The pane leans on rather more than the signatures, so the contract is spelt
 * out per member below. The three that are easy to get wrong, up front:
 *
 * - **Directory ids are the identity of everything.** They key the pane's
 *   caches and its expansion set, they are what a member query is asked for,
 *   and dir_filter.ts additionally requires them to be dense from zero with a
 *   parent's id always lower than its children's (see dir_tree.ts, which is
 *   where the SQL mirror's ids get that property). An implementation numbering
 *   directories some other way breaks the filtered tree silently.
 * - **Compression is the source's job, not the pane's.** {@link rootDirs} and
 *   {@link childDirs} return rows that may sit several directories below where
 *   they were asked for, and the pane labels a row by subtracting the path of
 *   the row *above* it rather than by looking at `name` (see `dirLabel`). What
 *   it must not get is a pass-through row, or two rows for one seed.
 * - **Members are paged, and a short page ends the list.** See
 *   {@link DirExplorerSource.dirMembers}.
 *
 * ## Two shapes of source, and which half of the pane each drives
 *
 * The pane has two modes, and which one it is in is the source's to declare
 * (see {@link DirExplorerSource.rowDriven}). A source over a *hierarchy* - the
 * SQL mirror - is descended lazily, a level at a time, and only builds a
 * `FilteredTree` when the user asks for one. A source over a *selection* - a
 * chart's input rows - has no lazy descent to offer at all: its per-directory
 * counts come from the rows it was handed, so it is permanently in the pane's
 * filtered mode and its {@link DirExplorerSource.rootDirs} /
 * {@link DirExplorerSource.childDirs} are never called.
 *
 * ## Versioning
 *
 * Everything the pane holds is derived from the source, so the source has to be
 * able to say when it stopped meaning what it meant - hence
 * {@link DirExplorerSource.version}. For the SQL mirror that is a graph reload,
 * which renumbers every node; for a source over a query's rows it will be the
 * rows changing under a mirror that never moved, which is exactly the case a
 * pane watching `controller.mirrorVersion` directly would miss.
 */

import type {Engine} from '../../trace_processor/engine';
import type {DuneGraphController} from './controller';
import type {
  DirEntry,
  MemberEntry,
  MemberFilter,
  PathFilter,
} from './dir_explorer';
import {
  allDirs,
  childDirs,
  dirMemberIds,
  dirMembers,
  matchingCounts,
  matchingRuleDirs,
  rootDirs,
} from './dir_explorer';
import type {NodeKind} from './graph';

/**
 * The directory tree the Explorer pane draws, and the members hanging off it.
 *
 * Two shapes of access, and the split is the pane's two modes rather than an
 * arbitrary grouping: {@link rootDirs} / {@link childDirs} are the lazy descent
 * the unfiltered pane makes a level at a time, and {@link allDirs} /
 * {@link matchingRuleDirs} / {@link matchingCounts} are the whole hierarchy at
 * once, which is what a hard filter needs (see dir_filter.ts for why it cannot
 * be done a level at a time). Members are fetched the same way in both modes.
 */
export interface DirExplorerSource {
  /**
   * Monotonic version of the data behind this source.
   *
   * The pane caches directory levels, member pages and the expansion set, all
   * keyed by directory id, and all of it stops meaning anything when the ids
   * do. Bumping this is how a source says so; the pane drops everything it
   * holds and starts again from the roots.
   *
   * Read every render, so it must be cheap - a field or a getter over one, not
   * a computation.
   */
  readonly version: number;

  /**
   * Whether this source's rows *are* a selection, rather than a hierarchy to
   * descend.
   *
   * This is the one thing the pane cannot work out for itself, and getting it
   * wrong is silent either way. The pane's default mode is the lazy descent
   * ({@link rootDirs} / {@link childDirs}), and it only builds a `FilteredTree`
   * when its own filter menu says a filter is active. A source whose counts
   * come from a query's rows is *always* narrowed - the counts are the filter -
   * so it needs the filtered mode with no filter typed, which is a state the
   * pane would otherwise never enter.
   *
   * Setting this changes two things about the pane, and nothing else:
   *
   * - It builds a `FilteredTree` up front, from {@link allDirs} and
   *   {@link matchingCounts} with an empty filter, and rebuilds it whenever
   *   {@link DirExplorerSource.version} moves.
   * - Its per-row counts read "3 of 1,204 rules" rather than "3 rules", and it
   *   drops the stored failure count and duration rollups, which describe every
   *   member of the directory rather than the selected ones.
   *
   * Note what it does *not* change: the pane's own filter bar and Filters menu
   * are offered either way. "Already narrowed" and "cannot be narrowed further"
   * are different claims, and only the first is what this flag means - an
   * implementation is expected to put the filter's predicates into the same
   * queries it answers {@link matchingCounts} and {@link dirMembers} from, so
   * that the two narrowings AND.
   *
   * True implies {@link matchingCounts} never returns undefined: "all of them"
   * has no meaning when the rows are the selection.
   */
  readonly rowDriven: boolean;

  /**
   * The tree's roots.
   *
   * There is normally more than one, and that is not a degenerate case: a
   * build's paths are a mix of absolute and relative ones. Ordering is the
   * source's to fix, but it must be stable across calls, since it is the order
   * the pane renders in.
   */
  rootDirs(): Promise<readonly DirEntry[]>;

  /**
   * The child directories of `id`, compressed past any run of pass-through
   * directories below each one.
   *
   * "Compressed" is the file header's second promise: one row per child, each
   * being the deepest directory its run of single-child scaffolding leads to,
   * with the honest `path` for wherever it landed.
   */
  childDirs(id: number): Promise<readonly DirEntry[]>;

  /**
   * Every directory, in id order.
   *
   * Read once per filter application rather than per expansion, and *not*
   * compressed: dir_filter.ts re-runs compression itself over the filtered
   * tree, and it needs the tree's real shape to do that. Id order is required,
   * not incidental - it is what makes the subtree rollup a single descending
   * pass (see dir_filter.ts).
   */
  allDirs(): Promise<readonly DirEntry[]>;

  /**
   * The directories whose own path matches, i.e. where *rules* can match at
   * all.
   *
   * A rule's label is its bare dune id and carries no path, so a rule is
   * matched on the directory it is filed under. The pane keeps the result and
   * passes membership of it back in as the `dirPathMatches` argument below,
   * where it is a constant rather than a predicate.
   */
  matchingRuleDirs(path: PathFilter): Promise<ReadonlySet<number>>;

  /**
   * How many members of `kind` match `filter` in each directory, keyed by
   * directory id - or **undefined meaning "all of them"**, when nothing in the
   * filter narrows that kind.
   *
   * That undefined is load-bearing rather than a convenience: it is what lets
   * `FilteredTree` fall back to the stored `n_rules` / `n_deps` and what keeps
   * a deps-only filter from having to count the rules at all. It is also
   * exactly what a row-driven source must never return: falling back to the
   * stored totals there would draw the whole mirror's tree.
   *
   * `ruleDirs` is what {@link matchingRuleDirs} returned, and is passed only
   * for `kind === 'rule'` - it is the path half of a rule's match test. An
   * implementation is free to ignore it and derive the same thing itself, which
   * is what one answering both kinds from a single query has to do (see
   * dir_chart_source.ts); what it must not do is drop the test.
   */
  matchingCounts(
    kind: NodeKind,
    filter: MemberFilter,
    ruleDirs?: ReadonlySet<number>,
  ): Promise<ReadonlyMap<number, number> | undefined>;

  /**
   * One page of the direct members of `id`, of `kind` if given and of both
   * kinds otherwise.
   *
   * The paging contract, which the pane's "show more" rows rest on:
   *
   * - The order must be stable across calls and must put rules before deps, so
   *   that consecutive `offset`s are pages of one list rather than of whatever
   *   came back that time.
   * - At most `limit` rows, and **a short page means there are no more** - the
   *   pane reads the end of the list off the row count rather than asking for a
   *   total, so a source that returns fewer rows than asked for while more
   *   remain hides them behind a "show more" that is never offered.
   *
   * `dirPathMatches` says whether this directory's own path matched the filter,
   * which is the rule arm's path test (see {@link matchingRuleDirs}); the dep
   * arm tests each dep's own label and does not need it.
   */
  dirMembers(
    id: number,
    kind: NodeKind | undefined,
    limit: number,
    offset: number,
    filter: MemberFilter,
    dirPathMatches: boolean,
  ): Promise<readonly MemberEntry[]>;

  /**
   * Every direct member of `id` of the given kinds, as node ids - what the bulk
   * ＋all / －all buttons act on.
   *
   * Unbounded, unlike {@link dirMembers}, and deliberately so: nothing is
   * rendered from these, the count is already on screen before the click, and
   * the caller is about to put them all in a Set. Still the *direct* members
   * of the directory rather than its subtree's, and still narrowed by the
   * active filter, so "add all" means the rows the row is claiming.
   */
  dirMemberIds(
    id: number,
    kinds: readonly NodeKind[],
    filter: MemberFilter,
    dirPathMatches: boolean,
  ): Promise<readonly number[]>;
}

/**
 * The Explorer over the SQL mirror - `dune_dir` and `dune_node` as built by the
 * node tier (see sql_graph.ts).
 *
 * A thin object: every member is the matching dir_explorer.ts function with the
 * engine bound. The queries, the compression and the paging all still live
 * there, because that is the half worth unit-testing and it is tested by
 * capturing the SQL it generates.
 *
 * `version` is the controller's `mirrorVersion` rather than a counter of this
 * object's own: what invalidates the pane's caches is the mirror being rebuilt,
 * which happens without this object being replaced.
 */
export class SqlDirExplorerSource implements DirExplorerSource {
  // The whole hierarchy, descended lazily: this is the mode the pane was
  // written for, and the filtered one is entered only when the user asks.
  readonly rowDriven = false;

  constructor(
    private readonly engine: Engine,
    private readonly controller: DuneGraphController,
  ) {}

  get version(): number {
    return this.controller.mirrorVersion;
  }

  rootDirs(): Promise<readonly DirEntry[]> {
    return rootDirs(this.engine);
  }

  childDirs(id: number): Promise<readonly DirEntry[]> {
    return childDirs(this.engine, id);
  }

  allDirs(): Promise<readonly DirEntry[]> {
    return allDirs(this.engine);
  }

  matchingRuleDirs(path: PathFilter): Promise<ReadonlySet<number>> {
    return matchingRuleDirs(this.engine, path);
  }

  matchingCounts(
    kind: NodeKind,
    filter: MemberFilter,
    ruleDirs?: ReadonlySet<number>,
  ): Promise<ReadonlyMap<number, number> | undefined> {
    return matchingCounts(this.engine, kind, filter, ruleDirs);
  }

  dirMembers(
    id: number,
    kind: NodeKind | undefined,
    limit: number,
    offset: number,
    filter: MemberFilter,
    dirPathMatches: boolean,
  ): Promise<readonly MemberEntry[]> {
    return dirMembers(
      this.engine,
      id,
      kind,
      limit,
      offset,
      filter,
      dirPathMatches,
    );
  }

  dirMemberIds(
    id: number,
    kinds: readonly NodeKind[],
    filter: MemberFilter,
    dirPathMatches: boolean,
  ): Promise<readonly number[]> {
    return dirMemberIds(this.engine, id, kinds, filter, dirPathMatches);
  }
}
