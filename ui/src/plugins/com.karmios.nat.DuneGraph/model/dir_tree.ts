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
 * The build graph's directory hierarchy, as id/parent_id rows.
 *
 * Turns a stream of directory strings (a rule's context `dir`, the containing
 * directory of a dep's path) into one row per *distinct prefix*, which is the
 * shape a tree-mode DataGrid wants (`IdBasedTree`: id + parent_id + a path
 * column) and what the SQL mirror's `dune_dir` is built from - see sql_graph.ts.
 *
 * Deliberately pure: no engine, no graph, no dune vocabulary. Everything
 * dune-specific (what counts as "no directory", which nodes contribute) lives in
 * its caller.
 *
 * Segmentation is {@link splitPath}'s, so this agrees with the details panel's
 * trie: `/` and `@` are both boundaries, a *leading* one is not (which is what
 * keeps an absolute path's `/usr` a single root segment rather than an empty one
 * under a phantom root), and a trailing one produces no empty segment. Two
 * spellings of the same directory (`a/b` and `a/b/`) therefore intern to one
 * row, whose `path` is the canonical, separator-free-tail form.
 *
 * The empty string is a directory like any other: it is the *top level*, and it
 * gets a row (with an empty `name` and `path`) so that entries dune filed
 * nowhere are still counted somewhere. It is a root, i.e. it is not the parent
 * of `_build`; a tree of absolute and relative paths simply has several roots.
 */

import type {PathSeg} from './path_tree';
import {splitPath} from './path_tree';

/**
 * One directory. `id` is dense from zero, so it doubles as the rowid of the
 * table these rows are inserted into; `parentId` is absent for a root.
 *
 * `path` is the full path from the root and is the row's identity; `name` is
 * just this segment (with a leading `@` kept, since an alias marker is a literal
 * part of the name rather than hierarchy - the same rule `path_tree.ts` renders
 * leaves by).
 */
export interface DirRow {
  readonly id: number;
  readonly parentId?: number;
  readonly name: string;
  readonly path: string;
  readonly depth: number;
}

/**
 * The containing directory of `path`, i.e. everything before its last segment
 * boundary, or `''` when it has none (a top-level entry).
 *
 * Boundaries are {@link splitPath}'s: `/` and `@`, neither of them at index 0
 * (so `parentDir('/usr') === ''`, not `'/'`), and a trailing separator is part
 * of the last segment rather than a boundary of its own (`a/b/` is the same
 * entry as `a/b`, so both live in `a`).
 */
export function parentDir(path: string): string {
  let end = path.length;
  while (end > 1 && isSep(path[end - 1])) end--;
  for (let i = end - 1; i > 0; i--) {
    if (isSep(path[i])) return path.slice(0, i);
  }
  return '';
}

function isSep(c: string): boolean {
  return c === '/' || c === '@';
}

// This segment's display name. `/` is implied by the row's position in the tree
// and dropped; `@` is a literal alias marker and kept (`leafLabel` in
// path_tree.ts does the same for the trie's leaves).
function segName(seg: PathSeg): string {
  return (seg.sep === '@' ? '@' : '') + seg.name;
}

/**
 * Interns directories and their prefixes into {@link DirRow}s.
 *
 * Incremental rather than a one-shot function over a collection: the caller
 * (sql_graph.ts) walks ~800k nodes once and wants each node's directory id as it
 * goes. Collecting the strings first, building, then walking a second time to
 * look the ids up would mean re-deriving every dep's parent directory twice.
 *
 * Two invariants callers rely on, both from interning prefixes on the way down:
 *
 * - ids are dense from zero, in creation order;
 * - **a parent's id is always lower than its children's**, so a subtree rollup
 *   is one descending pass over `rows`, with no recursion and no
 *   parent_id index.
 */
export class DirTree {
  // Directory string -> row id. Holds every canonical path, plus any
  // non-canonical spelling that has been interned (`a/b/`), so a repeat lookup
  // never re-splits.
  private readonly ids = new Map<string, number>();
  private readonly dirRows: DirRow[] = [];

  // Interns every directory in `dirs`; the shorthand for a caller that has the
  // strings in hand and doesn't need the ids as it goes.
  static from(dirs: Iterable<string>): DirTree {
    const tree = new DirTree();
    for (const dir of dirs) tree.intern(dir);
    return tree;
  }

  // How many directories (i.e. rows) there are.
  get size(): number {
    return this.dirRows.length;
  }

  // Every directory, in id order.
  get rows(): readonly DirRow[] {
    return this.dirRows;
  }

  /**
   * The id of `dir`, creating its row - and a row for each of its ancestors
   * that doesn't have one yet - if this is the first time it's been seen.
   */
  intern(dir: string): number {
    const cached = this.ids.get(dir);
    if (cached !== undefined) return cached;
    const segs = splitPath(dir);
    // `dir` is '': the top level, a root row of its own.
    let id = segs.length === 0 ? this.addRow(undefined, '', '', 0) : -1;
    let parentId: number | undefined;
    let path = '';
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      path = i === 0 ? seg.name : path + seg.sep + seg.name;
      id = this.ids.get(path) ?? this.addRow(parentId, segName(seg), path, i);
      parentId = id;
    }
    // Remember this exact spelling too, in case it isn't the canonical one.
    this.ids.set(dir, id);
    return id;
  }

  // The id `dir` was interned as, or undefined if it never was. Accepts any
  // spelling {@link intern} has seen, plus every canonical path.
  idOf(dir: string): number | undefined {
    return this.ids.get(dir);
  }

  private addRow(
    parentId: number | undefined,
    name: string,
    path: string,
    depth: number,
  ): number {
    const id = this.dirRows.length;
    this.dirRows.push({id, parentId, name, path, depth});
    this.ids.set(path, id);
    return id;
  }
}
