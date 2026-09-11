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
 * The filtered directory tree: which directories survive a path filter, how
 * many matches each holds, and what the tree looks like once the non-matching
 * parts are gone.
 *
 * **ARCHITECTURE.md, "The hard filter is client-side", is the why** - why none of
 * this is SQL, which dir_tree.ts invariant makes the rollup one array pass, and
 * why the compression is re-run here rather than composed with the SQL one.
 *
 * Both kinds arrive as per-directory counts from `matchingCounts`, so this does
 * not care *what* matched - only how much did, and where. A count of undefined
 * for a kind means the filter says nothing about it, so every member matches
 * and the stored `n_rules` / `n_deps` stand in.
 */

import type {DirEntry} from '../model/dir_explorer';

export interface FilteredRow {
  // The directory the row *is* - the deepest of any collapsed run, so its id is
  // what a member query is keyed on.
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

// A path filter applied to the whole hierarchy. Built once on submit, then read
// synchronously by the render: every question is a lookup or an array slice.
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

  // `dirs` is every directory in id order. `ruleMatches` / `depMatches` are
  // per-directory match counts, or undefined meaning "all of them".
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

  get empty(): boolean {
    return this.matchCount === 0;
  }

  // Summed over the roots: every directory is in exactly one root's subtree and
  // the rollup has already totalled each.
  get matchCount(): number {
    return this.rootIds.reduce(
      (n, id) => n + this.subtreeRules[id] + this.subtreeDeps[id],
      0,
    );
  }

  roots(): FilteredRow[] {
    return this.rootIds
      .filter((id) => this.hasMatch(id))
      .map((id) => this.rowFor(id, ''));
  }

  // Labelled relative to `parentPath`, which is `dirId`'s own path since it is
  // the row above them.
  childRows(dirId: number, parentPath: string): FilteredRow[] {
    return (this.childIds[dirId] ?? [])
      .filter((id) => this.hasMatch(id))
      .map((id) => this.rowFor(id, parentPath));
  }

  // Matching members of `dirId` itself.
  directMatches(dirId: number, kind: 'rule' | 'dep'): number {
    const counts = kind === 'rule' ? this.matchedRules : this.matchedDeps;
    return counts[dirId] ?? 0;
  }

  // Matching members of `dirId`'s whole subtree, itself included.
  subtreeMatches(dirId: number, kind: 'rule' | 'dep'): number {
    const counts = kind === 'rule' ? this.subtreeRules : this.subtreeDeps;
    return counts[dirId] ?? 0;
  }

  // The hard filter itself: a directory with no match anywhere below it gets no
  // row at all, rather than a dimmed one.
  hasMatch(dirId: number): boolean {
    return (
      this.subtreeMatches(dirId, 'rule') + this.subtreeMatches(dirId, 'dep') > 0
    );
  }

  // The id of the row that *displays* `dirId` - not `dirId` itself in general,
  // since a row is keyed on the deepest directory of the run it swallowed.
  // Well defined wherever the directory is visible, because a run is linear.
  // Undefined when nothing matching is under it.
  rowIdFor(dirId: number): number | undefined {
    if (!this.hasMatch(dirId)) return undefined;
    return this.rowFor(dirId, '').dir.id;
  }

  // Re-keys expanded ids onto this tree's rows, so a filter leaves the tree
  // where the user had it (see the README). The result stays closed upward
  // because compression only merges runs, so the images of an id's ancestors
  // are the ancestors of its image.
  remapExpanded(dirIds: Iterable<number>): Set<number> {
    const out = new Set<number>();
    for (const id of dirIds) {
      const row = this.rowIdFor(id);
      if (row !== undefined) out.add(row);
    }
    return out;
  }

  // A pass-through here means no *matching* members of its own and exactly one
  // *visible* child - dir_explorer.ts's `passThrough()` but strictly more
  // aggressive, since filtering removes both members and children.
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
