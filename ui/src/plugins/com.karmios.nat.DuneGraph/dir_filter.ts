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
 * The filtered directory tree: which directories survive a path filter, how many
 * matches each holds, and what the tree looks like once the non-matching parts
 * are gone.
 *
 * ## Why this is client-side, when the unfiltered tree is not
 *
 * The unfiltered pane descends one indexed query at a time and never needs to
 * know what is deeper than the level it is drawing - `dune_dir`'s stored `t_*`
 * rollups answer "is there anything down there" for free.
 *
 * A *hard* filter cannot work that way. Hiding a directory requires knowing
 * whether its whole subtree holds a match, and the filter is arbitrary and
 * user-typed, so no stored rollup answers it. That leaves computing the rollup,
 * which needs the whole hierarchy at once - so while a filter is active the pane
 * reads all of `dune_dir` in one query (19k rows on the monorepo trace) and
 * everything here is arithmetic rather than SQL. Only member *rows* are still
 * fetched per directory.
 *
 * The one invariant this leans on is dir_tree.ts's: ids are dense from zero and
 * **a parent's id is always lower than its children's**. So id order is
 * topological order, a subtree rollup is one descending pass over an array, and
 * no recursion or child index is needed for it.
 *
 * ## What "matches" means
 *
 * Both kinds arrive here as per-directory counts from SQL (see
 * `matchingCounts`), so this class does not care *what* matched - only how much
 * did, and where. The two kinds are narrowed on different columns: a dep on its
 * own full path plus its `resolution`/`status`, a rule on the directory it is
 * filed under plus its `outcome`, since a rule's label is its bare dune id and
 * contains no path at all.
 *
 * A count of `undefined` for a kind means the filter says nothing about it, so
 * all of its members match and the stored `n_rules` / `n_deps` stand in.
 *
 * ## Compression
 *
 * Hard-filtering creates new single-child chains - filter to one deep path and
 * the tree above it would otherwise be a ladder of one-child rows. So this
 * re-runs the pane's pass-through compression over the *filtered* tree, with the
 * predicate reading "no matching members of its own, exactly one visible child".
 * That subsumes the SQL compression rather than composing with it, which is why
 * the filtered path ignores `compressedDirs` entirely.
 */

import type {DirEntry} from './dir_explorer';

/**
 * One row of the filtered tree.
 *
 * `dir` is the directory the row *is* - the deepest one of any collapsed run, so
 * its id is what a member query is keyed on and its counts are the ones to show.
 * `pathFrom` is the path of the row above it, which is what the label is measured
 * against (the same job `dirLabel` does for the unfiltered tree, and it has to be
 * carried here because a compressed run can start several levels above `dir`).
 */
export interface FilteredRow {
  readonly dir: DirEntry;
  // The parent *row*'s path, or '' for a root. Not `dir`'s own parent's path: a
  // collapsed run's label spans every directory it swallowed.
  readonly pathFrom: string;
  // Matching members of `dir` itself.
  readonly matchedRules: number;
  readonly matchedDeps: number;
  // Matching members of `dir`'s whole subtree, itself included.
  readonly subtreeMatchedRules: number;
  readonly subtreeMatchedDeps: number;
}

/**
 * A path filter applied to the whole directory hierarchy.
 *
 * Built once when the filter is submitted and then read synchronously by the
 * render - every question the filtered tree asks of it is a lookup or a slice of
 * a precomputed array.
 */
export class FilteredTree {
  // Indexed by directory id throughout. Dense and parent-before-child, so these
  // are plain arrays rather than maps - see the file header.
  private readonly matchedRules: Int32Array;
  private readonly matchedDeps: Int32Array;
  private readonly subtreeRules: Int32Array;
  private readonly subtreeDeps: Int32Array;
  private readonly childIds: number[][];
  private readonly byId: (DirEntry | undefined)[];
  // Parentless directories, in path order. Several is normal, not degenerate: a
  // build's paths are a mix of absolute and relative ones (see dir_tree.ts).
  private readonly rootIds: number[];

  /**
   * `ruleMatches` / `depMatches` are per-directory counts of matching members of
   * that kind, or **undefined meaning "all of them"** - which is what a filter
   * that says nothing about a kind means, and what lets the stored `n_rules` /
   * `n_deps` stand in with no query run (see `matchingCounts`).
   *
   * @param dirs Every directory, in id order (see `allDirs`).
   */
  constructor(
    dirs: readonly DirEntry[],
    ruleMatches: ReadonlyMap<number, number> | undefined,
    depMatches: ReadonlyMap<number, number> | undefined,
  ) {
    // Sized by the highest id rather than by `dirs.length`, so a gap in the ids
    // (which the invariant does not actually promise absent) cannot index out of
    // bounds.
    const size = dirs.reduce((n, d) => Math.max(n, d.id + 1), 0);
    this.matchedRules = new Int32Array(size);
    this.matchedDeps = new Int32Array(size);
    this.byId = new Array<DirEntry | undefined>(size);
    this.childIds = Array.from({length: size}, () => [] as number[]);
    const parentOf = new Int32Array(size).fill(-1);

    for (const dir of dirs) {
      this.byId[dir.id] = dir;
      // Undefined counts mean the filter says nothing about that kind, so every
      // member of it matches and the directory's own stored total is the count.
      this.matchedRules[dir.id] =
        ruleMatches === undefined ? dir.nRules : (ruleMatches.get(dir.id) ?? 0);
      this.matchedDeps[dir.id] =
        depMatches === undefined ? dir.nDeps : (depMatches.get(dir.id) ?? 0);
    }
    // Child lists and parent links, from the entries' own parentId.
    for (const dir of dirs) {
      if (dir.parentId === undefined) continue;
      parentOf[dir.id] = dir.parentId;
      this.childIds[dir.parentId]?.push(dir.id);
    }

    // The rollup: one descending pass, each directory adding its own totals into
    // its parent's. Descending is what makes this work in a single pass - by the
    // time id `i` is read, every id above it has already folded in its children.
    this.subtreeRules = Int32Array.from(this.matchedRules);
    this.subtreeDeps = Int32Array.from(this.matchedDeps);
    for (let id = size - 1; id > 0; id--) {
      const parent = parentOf[id];
      if (parent < 0) continue;
      this.subtreeRules[parent] += this.subtreeRules[id];
      this.subtreeDeps[parent] += this.subtreeDeps[id];
    }

    // Children in path order, so the filtered tree lists them the way the
    // unfiltered one's `ORDER BY d.path` does.
    for (const ids of this.childIds) {
      ids.sort((a, b) => comparePaths(this.byId[a], this.byId[b]));
    }
    this.rootIds = dirs
      .filter((d) => d.parentId === undefined)
      .map((d) => d.id)
      .sort((a, b) => comparePaths(this.byId[a], this.byId[b]));
  }

  /** Whether anything at all matched. */
  get empty(): boolean {
    return this.matchCount === 0;
  }

  /**
   * How many members matched, across the whole build.
   *
   * Summed over the roots, since every directory is in exactly one root's
   * subtree and the rollup has already totalled each.
   */
  get matchCount(): number {
    return this.rootIds.reduce(
      (n, id) => n + this.subtreeRules[id] + this.subtreeDeps[id],
      0,
    );
  }

  /** The filtered tree's top-level rows. */
  roots(): FilteredRow[] {
    return this.rootIds
      .filter((id) => this.hasMatch(id))
      .map((id) => this.rowFor(id, ''));
  }

  /**
   * The visible child rows of directory `dirId`, labelled relative to
   * `parentPath` - which is that directory's own path, since it is the row above
   * them.
   */
  childRows(dirId: number, parentPath: string): FilteredRow[] {
    return (this.childIds[dirId] ?? [])
      .filter((id) => this.hasMatch(id))
      .map((id) => this.rowFor(id, parentPath));
  }

  /** Matching members of `dirId` itself, of one kind. */
  directMatches(dirId: number, kind: 'rule' | 'dep'): number {
    const counts = kind === 'rule' ? this.matchedRules : this.matchedDeps;
    return counts[dirId] ?? 0;
  }

  /** Matching members of `dirId`'s whole subtree, itself included. */
  subtreeMatches(dirId: number, kind: 'rule' | 'dep'): number {
    const counts = kind === 'rule' ? this.subtreeRules : this.subtreeDeps;
    return counts[dirId] ?? 0;
  }

  /**
   * Whether `dirId`'s subtree holds anything the filter matched.
   *
   * This is the hard filter: a directory with no match anywhere below it gets no
   * row at all, rather than a dimmed one.
   */
  hasMatch(dirId: number): boolean {
    return (
      this.subtreeMatches(dirId, 'rule') + this.subtreeMatches(dirId, 'dep') > 0
    );
  }

  /**
   * The id of the row that *displays* directory `dirId`, or undefined when
   * nothing matching is under it and so it has no row at all.
   *
   * Not `dirId` itself, in general: compression means a row is keyed on the
   * deepest directory of the run it swallowed, so `_build` may be displayed by
   * the row for `_build/default/lib`. Well defined wherever the directory is
   * visible, because a run is linear - descending from an ancestor of `dirId`
   * passes through it and carries on to the same terminal that descending from
   * `dirId` reaches.
   */
  rowIdFor(dirId: number): number | undefined {
    if (!this.hasMatch(dirId)) return undefined;
    return this.rowFor(dirId, '').dir.id;
  }

  /**
   * Re-keys a set of expanded directory ids onto this tree's rows, dropping the
   * ones nothing matching is under any more.
   *
   * This is what lets a filter leave the tree where the user had it. Keeping the
   * ids verbatim would not: compression re-decides which directory a row is
   * keyed on, so an id that named a row before the filter can name a swallowed
   * directory after it, and the row that swallowed it would render collapsed.
   *
   * The result stays closed upward - a row is only reachable when every row
   * above it is expanded - because compression only ever merges runs, so the
   * images of an id's ancestors are the ancestors of its image.
   */
  remapExpanded(dirIds: Iterable<number>): Set<number> {
    const out = new Set<number>();
    for (const id of dirIds) {
      const row = this.rowIdFor(id);
      if (row !== undefined) out.add(row);
    }
    return out;
  }

  /**
   * The row for directory `id`, collapsing any run of pass-through directories
   * below it first.
   *
   * A directory is a pass-through here when it has no *matching* members of its
   * own and exactly one *visible* child - the filtered analogue of
   * `passThrough()` in dir_explorer.ts, and strictly more aggressive, since
   * filtering removes both members and children.
   */
  private rowFor(id: number, pathFrom: string): FilteredRow {
    let at = id;
    for (;;) {
      if (this.matchedRules[at] + this.matchedDeps[at] > 0) break;
      const visible = (this.childIds[at] ?? []).filter((c) => this.hasMatch(c));
      if (visible.length !== 1) break;
      at = visible[0];
    }
    // Non-null: every id reached is either `id` itself or a child of a directory
    // that exists, and both come from `dirs`.
    const dir = this.byId[at]!;
    return {
      dir,
      pathFrom,
      matchedRules: this.matchedRules[at],
      matchedDeps: this.matchedDeps[at],
      subtreeMatchedRules: this.subtreeRules[at],
      subtreeMatchedDeps: this.subtreeDeps[at],
    };
  }
}

function comparePaths(a?: DirEntry, b?: DirEntry): number {
  const pa = a?.path ?? '';
  const pb = b?.path ?? '';
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}
