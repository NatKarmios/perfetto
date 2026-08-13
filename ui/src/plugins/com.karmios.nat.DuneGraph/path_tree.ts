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

// Groups a flat list of path-like ids into a tree, introducing nesting only
// where two or more entries actually share a directory - a chain of
// single-child directories collapses into one row instead of a line per
// segment. Generic over the payload (`T`) so it works for both dep ids and
// rule ids (which are filed under their own `dir` field rather than being
// paths themselves).
//
// Two separators are understood: `/` is an ordinary hierarchical separator
// (never shown as a character - the tree nesting or a merged label already
// implies it); `@` attaches an alias suffix to the preceding path component
// and is always shown literally (e.g. `_build/default@default`).

/**
 * A single path segment, paired with the separator that precedes it. `sep`
 * is `''` for the first segment of a path, otherwise `/` or `@`.
 */
export interface PathSeg {
  readonly sep: string;
  readonly name: string;
}

/**
 * An entry to place in the tree: the directory it lives under (`dir`, empty
 * for top-level) and its own segment (`leaf`), plus the payload to attach.
 */
export interface PathTreeItem<T> {
  readonly dir: readonly PathSeg[];
  readonly leaf: PathSeg;
  readonly item: T;
}

/**
 * A leaf row: an item that didn't get grouped with siblings, or the sole
 * survivor of a collapsed directory chain. `prefix` carries that collapsed
 * chain's display text (e.g. `G/` from a directory that only ever contained
 * `H`); it's empty when there was nothing to collapse.
 */
export interface PathTreeLeaf<T> {
  readonly kind: 'leaf';
  readonly prefix: string;
  readonly label: string;
  readonly item: T;
}

/**
 * A directory that holds two or more rows. `path` is the full, stable path
 * from the root (usable as a collapse-state key); `label` is only the
 * (possibly multi-segment, collapsed) run leading to this group from its
 * parent.
 */
export interface PathTreeGroup<T> {
  readonly kind: 'group';
  readonly path: string;
  readonly label: string;
  readonly rows: readonly PathTreeRow<T>[];
}

export type PathTreeRow<T> = PathTreeLeaf<T> | PathTreeGroup<T>;

// Tokenises `path` on `/` and `@` boundaries, keeping each separator with the
// segment that follows it. A leading `/` or `@` (i.e. one at index 0) isn't a
// boundary - there's no preceding segment for it to separate - so it's kept
// as a literal character in the first segment's name; this is what keeps an
// absolute path's leading `/` visible. A trailing separator (a `dir` field
// commonly ends in `/`) doesn't produce a phantom empty trailing segment.
export function splitPath(path: string): PathSeg[] {
  if (path === '') return [];
  const segs: PathSeg[] = [];
  let sep = '';
  let name = '';
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if ((c === '/' || c === '@') && i > 0) {
      segs.push({sep, name});
      sep = c;
      name = '';
    } else {
      name += c;
    }
  }
  if (name !== '') segs.push({sep, name});
  return segs;
}

// Splits a path-like entry into the directory it lives under and its own
// leaf segment (e.g. `A/B/C@E` -> dir `A/B/C`, leaf `@E`).
export function splitEntry(path: string): {
  dir: PathSeg[];
  leaf: PathSeg;
} {
  const segs = splitPath(path);
  if (segs.length === 0) return {dir: [], leaf: {sep: '', name: ''}};
  return {dir: segs.slice(0, -1), leaf: segs[segs.length - 1]};
}

interface TrieNode<T> {
  // Absent only for the root.
  readonly seg?: PathSeg;
  readonly children: Map<string, TrieNode<T>>;
  readonly leaves: Array<{seg: PathSeg; item: T}>;
}

function trieKey(seg: PathSeg): string {
  return JSON.stringify([seg.sep, seg.name]);
}

// Renders a run of merged directory segments as text, e.g. [A, /B] -> "A/B".
// The first segment in a run never shows its separator (it's the start of a
// fresh label, following a group boundary or the tree root).
function runText(run: readonly PathSeg[]): string {
  return run
    .map((seg, i) => (i === 0 ? seg.name : seg.sep + seg.name))
    .join('');
}

// A leaf's own display label: `/` is dropped (implied by its position),
// `@` is always kept (it's a literal alias marker, not hierarchy).
function leafLabel(seg: PathSeg): string {
  return (seg.sep === '@' ? '@' : '') + seg.name;
}

function leafRow<T>(
  run: readonly PathSeg[],
  seg: PathSeg,
  item: T,
): PathTreeLeaf<T> {
  let prefix = runText(run);
  if (run.length > 0 && seg.sep === '/') prefix += '/';
  return {kind: 'leaf', prefix, label: leafLabel(seg), item};
}

function displayText<T>(row: PathTreeRow<T>): string {
  return row.kind === 'leaf' ? row.prefix + row.label : row.label;
}

function sortRows<T>(rows: PathTreeRow<T>[]): PathTreeRow<T>[] {
  return rows.sort((a, b) => displayText(a).localeCompare(displayText(b)));
}

// Converts every direct content (attached leaves + child directories) of
// `node` into a row, each starting a fresh display run - this is where
// nesting "resets" after a group boundary (or at the tree root).
function convertChildren<T>(
  node: TrieNode<T>,
  fullPath: readonly PathSeg[],
): PathTreeRow<T>[] {
  const rows: PathTreeRow<T>[] = [];
  for (const leaf of node.leaves) {
    rows.push(leafRow([], leaf.seg, leaf.item));
  }
  for (const child of node.children.values()) {
    rows.push(convertNode(child, [], fullPath));
  }
  return sortRows(rows);
}

// Converts `node` into a single row. `run` is the pending, not-yet-emitted
// chain of collapsed segments leading to it (reset at the last group
// boundary); `fullPath` is the true, uncollapsed path from the root, used
// only for the stable group key. A node with exactly one content (a lone
// child directory, or a lone attached leaf) merges into its parent's run
// instead of becoming its own group - this is what collapses a chain of
// single-child directories into one row.
function convertNode<T>(
  node: TrieNode<T>,
  run: readonly PathSeg[],
  fullPath: readonly PathSeg[],
): PathTreeRow<T> {
  // Only the root has no `seg`, and the root is never converted via this
  // function (see buildPathTree), so this is always present here.
  const seg = node.seg!;
  const newRun = [...run, seg];
  const newFullPath = [...fullPath, seg];
  const total = node.children.size + node.leaves.length;
  if (total === 1) {
    if (node.leaves.length === 1) {
      return leafRow(newRun, node.leaves[0].seg, node.leaves[0].item);
    }
    const [only] = node.children.values();
    return convertNode(only, newRun, newFullPath);
  }
  return {
    kind: 'group',
    path: runText(newFullPath),
    label: runText(newRun),
    rows: convertChildren(node, newFullPath),
  };
}

/**
 * Groups `items` into a tree by their `dir`, introducing a group only where a
 * directory holds two or more rows - a directory chain that only ever leads
 * to a single row collapses into that row's `prefix` instead.
 */
export function buildPathTree<T>(
  items: readonly PathTreeItem<T>[],
): PathTreeRow<T>[] {
  const root: TrieNode<T> = {children: new Map(), leaves: []};
  for (const it of items) {
    let node = root;
    for (const seg of it.dir) {
      const key = trieKey(seg);
      let child = node.children.get(key);
      if (child === undefined) {
        child = {seg, children: new Map(), leaves: []};
        node.children.set(key, child);
      }
      node = child;
    }
    node.leaves.push({seg: it.leaf, item: it.item});
  }
  return convertChildren(root, []);
}
