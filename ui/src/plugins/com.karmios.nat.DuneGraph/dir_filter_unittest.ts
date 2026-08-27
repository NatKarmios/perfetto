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
 * The filtered directory tree (dir_filter.ts).
 *
 * All of this is arithmetic over a hierarchy, so unlike the rest of the pane it
 * can be tested outright rather than through the SQL it generates - and it is
 * the part most worth testing, because every mistake here is silent. A rollup
 * that misses a level hides matches; a compression pass that goes one step too
 * far attributes members to the wrong directory; a hard filter that tests direct
 * matches instead of subtree matches hides every ancestor of every match, which
 * is to say the entire tree.
 */

import type {DirEntry} from './dir_explorer';
import {FilteredTree} from './dir_filter';

/**
 * Builds the `dune_dir` rows for a set of paths, the way the mirror would.
 *
 * Ids are assigned parent-before-child, which is dir_tree.ts's invariant and the
 * one thing {@link FilteredTree}'s single-pass rollup depends on. `n_rules` /
 * `n_deps` are given per path; the `t_*` rollups are computed here so the
 * fixtures stay readable.
 */
function dirs(
  spec: ReadonlyArray<readonly [path: string, nRules: number, nDeps: number]>,
): DirEntry[] {
  // Every path plus every prefix, shortest first, so a parent always precedes a
  // child and therefore gets a lower id.
  const paths = new Set<string>();
  for (const [path] of spec) {
    const segs = path.split('/');
    for (let i = 1; i <= segs.length; i++) {
      paths.add(segs.slice(0, i).join('/'));
    }
  }
  const ordered = [...paths].sort(
    (a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1),
  );
  const idOf = new Map(ordered.map((p, i) => [p, i]));
  const counts = new Map(spec.map(([path, r, d]) => [path, {r, d}]));

  const rows = ordered.map((path, id) => {
    const segs = path.split('/');
    const parent = segs.slice(0, -1).join('/');
    const own = counts.get(path) ?? {r: 0, d: 0};
    return {
      id,
      parentId: segs.length === 1 ? undefined : idOf.get(parent),
      name: segs[segs.length - 1],
      path,
      depth: segs.length - 1,
      nRules: own.r,
      nDeps: own.d,
      nFailed: 0,
      tRules: 0,
      tDeps: 0,
      tFailed: 0,
      totalDurNs: 0n,
    };
  });
  // Subtree rollups, descending, exactly as the mirror does them.
  const tRules = rows.map((r) => r.nRules);
  const tDeps = rows.map((r) => r.nDeps);
  for (let id = rows.length - 1; id > 0; id--) {
    const parent = rows[id].parentId;
    if (parent === undefined) continue;
    tRules[parent] += tRules[id];
    tDeps[parent] += tDeps[id];
  }
  return rows.map((r, i) => ({...r, tRules: tRules[i], tDeps: tDeps[i]}));
}

// Per-directory match counts keyed by path rather than by id, for readability.
// Both kinds take the same shape: a rule's attributes are per-rule, so "every
// rule in this directory matches" is no longer a special case.
function countsAt(
  entries: readonly DirEntry[],
  at: Readonly<Record<string, number>>,
): Map<number, number> {
  return new Map(
    Object.entries(at).map(([path, n]) => [idFor(entries, path), n]),
  );
}

function idFor(entries: readonly DirEntry[], path: string): number {
  const found = entries.find((d) => d.path === path);
  if (found === undefined) throw new Error(`no such dir: ${path}`);
  return found.id;
}

// The tree as `label` strings, depth-first, so a whole shape is one assertion.
function shape(tree: FilteredTree): string[] {
  const out: string[] = [];
  const walk = (rows: ReturnType<FilteredTree['roots']>, indent: string) => {
    for (const row of rows) {
      const suffix =
        row.pathFrom === ''
          ? row.dir.path
          : row.dir.path.slice(row.pathFrom.length + 1);
      out.push(`${indent}${suffix}`);
      walk(tree.childRows(row.dir.id, row.dir.path), `${indent}  `);
    }
  };
  walk(tree.roots(), '');
  return out;
}

describe('FilteredTree rollup', () => {
  it('counts a match against every ancestor, not just the parent', () => {
    // The rollup is the whole reason this class exists: a hard filter has to know
    // whether a match is anywhere *below* a row, however deep.
    const d = dirs([['a/b/c/d', 0, 5]]);
    const tree = new FilteredTree(d, new Map(), countsAt(d, {'a/b/c/d': 3}));
    for (const path of ['a', 'a/b', 'a/b/c', 'a/b/c/d']) {
      expect(tree.subtreeMatches(idFor(d, path), 'dep')).toBe(3);
    }
    // Only the directory that holds them counts them directly.
    expect(tree.directMatches(idFor(d, 'a/b/c/d'), 'dep')).toBe(3);
    expect(tree.directMatches(idFor(d, 'a/b'), 'dep')).toBe(0);
  });

  it('sums siblings into a shared ancestor', () => {
    const d = dirs([
      ['a/x', 0, 4],
      ['a/y', 0, 6],
    ]);
    const tree = new FilteredTree(
      d,
      new Map(),
      countsAt(d, {'a/x': 4, 'a/y': 1}),
    );
    expect(tree.subtreeMatches(idFor(d, 'a'), 'dep')).toBe(5);
    expect(tree.matchCount).toBe(5);
  });

  it('rolls rule matches up the same way as dep matches', () => {
    // The two kinds arrive in the same shape - per-directory counts - so this
    // class does not care what matched, only how much did and where.
    const d = dirs([
      ['lib', 3, 0],
      ['bin', 2, 0],
    ]);
    const tree = new FilteredTree(d, countsAt(d, {lib: 3}), new Map());
    expect(tree.directMatches(idFor(d, 'lib'), 'rule')).toBe(3);
    expect(tree.directMatches(idFor(d, 'bin'), 'rule')).toBe(0);
    expect(tree.matchCount).toBe(3);
  });

  it('reports nothing matching as empty', () => {
    const d = dirs([['a/b', 2, 2]]);
    const tree = new FilteredTree(d, new Map(), new Map());
    expect(tree.empty).toBe(true);
    expect(tree.roots()).toEqual([]);
  });
});

describe('FilteredTree hard filter', () => {
  it('drops a subtree with no matches but keeps the path to one', () => {
    const d = dirs([
      ['a/keep/x', 0, 1],
      ['a/drop/y', 0, 1],
      ['b/also-drop', 0, 1],
    ]);
    const tree = new FilteredTree(d, new Map(), countsAt(d, {'a/keep/x': 1}));
    // `a` survives only because of what is under it; `a/drop` and `b` go.
    expect(shape(tree)).toEqual(['a/keep/x']);
  });

  it('keeps a directory that matches on its own members', () => {
    const d = dirs([
      ['a/x', 0, 2],
      ['a/y', 0, 2],
    ]);
    const tree = new FilteredTree(
      d,
      new Map(),
      countsAt(d, {'a/x': 1, 'a/y': 1}),
    );
    // Two visible children, so `a` is a real branch point and stays a row.
    expect(shape(tree)).toEqual(['a', '  x', '  y']);
  });
});

describe('FilteredTree compression', () => {
  it('collapses a run the filter reduced to one child', () => {
    // The reason this pass exists. Unfiltered, `a` branches and so is a row of
    // its own; filtered to one leaf, the whole run is one row.
    const d = dirs([
      ['a/b/c/leaf', 0, 3],
      ['a/other', 0, 3],
    ]);
    const tree = new FilteredTree(d, new Map(), countsAt(d, {'a/b/c/leaf': 2}));
    expect(shape(tree)).toEqual(['a/b/c/leaf']);
  });

  it('stops at a directory with matching members of its own', () => {
    // `a/b` has a match, so it has rows to show and cannot be collapsed past -
    // going further would file its members under `a/b/c`.
    const d = dirs([
      ['a/b', 0, 4],
      ['a/b/c', 0, 4],
    ]);
    const tree = new FilteredTree(
      d,
      new Map(),
      countsAt(d, {'a/b': 1, 'a/b/c': 1}),
    );
    expect(shape(tree)).toEqual(['a/b', '  c']);
  });

  it('stops at a branch point', () => {
    const d = dirs([
      ['a/b/x', 0, 1],
      ['a/b/y', 0, 1],
    ]);
    const tree = new FilteredTree(
      d,
      new Map(),
      countsAt(d, {'a/b/x': 1, 'a/b/y': 1}),
    );
    expect(shape(tree)).toEqual(['a/b', '  x', '  y']);
  });

  it('collapses past a directory whose only matching child is deeper', () => {
    // `a/b` holds members but none matching, so it has nothing to show and is
    // collapsed through - the filtered predicate is about *matching* members,
    // not members.
    const d = dirs([
      ['a/b', 0, 9],
      ['a/b/c', 0, 1],
    ]);
    const tree = new FilteredTree(d, new Map(), countsAt(d, {'a/b/c': 1}));
    expect(shape(tree)).toEqual(['a/b/c']);
  });

  it('labels a collapsed root with its whole path', () => {
    const d = dirs([['_build/default/lib', 0, 1]]);
    const tree = new FilteredTree(
      d,
      new Map(),
      countsAt(d, {'_build/default/lib': 1}),
    );
    const [root] = tree.roots();
    expect([root.dir.path, root.pathFrom]).toEqual(['_build/default/lib', '']);
  });
});

describe('FilteredTree.autoExpand', () => {
  it('returns every ancestor of every match when it fits', () => {
    const d = dirs([
      ['a/x', 0, 1],
      ['a/y', 0, 1],
    ]);
    const tree = new FilteredTree(
      d,
      new Map(),
      countsAt(d, {'a/x': 1, 'a/y': 1}),
    );
    // `a` has to be open for `x` and `y` to be on screen; the leaves do not.
    const expand = tree.autoExpand(10);
    expect(expand).toEqual(new Set([idFor(d, 'a')]));
  });

  it('needs no expansion at all when compression got there first', () => {
    // Each of these is a single chain down to its one match, so the compression
    // pass turns each root into one row and there is nothing left to open. Worth
    // pinning: it is the case where the budget is irrelevant, and an empty set
    // here must not be confused with the give-up answer below.
    const spec = Array.from(
      {length: 12},
      (_, i) => [`root${i}/sub/leaf`, 0, 1] as const,
    );
    const d = dirs(spec);
    const tree = new FilteredTree(
      d,
      new Map(),
      countsAt(d, Object.fromEntries(spec.map(([p]) => [p, 1]))),
    );
    expect(tree.autoExpand(1)).toEqual(new Set());
  });

  it('gives up rather than half-expanding', () => {
    // A half-expanded tree is worse than a collapsed one: the user cannot tell
    // which unopened branches hold nothing from which ran out of budget. Two
    // matching leaves per root, so every root is a real branch point and has to
    // be opened for its matches to show.
    const spec = Array.from({length: 12}, (_, i) => i).flatMap(
      (i) =>
        [
          [`root${i}/x`, 0, 1],
          [`root${i}/y`, 0, 1],
        ] as const,
    );
    const d = dirs(spec);
    const tree = new FilteredTree(
      d,
      new Map(),
      countsAt(d, Object.fromEntries(spec.map(([p]) => [p, 1]))),
    );
    expect(tree.autoExpand(3)).toBeUndefined();
    expect(tree.autoExpand(100)?.size).toBe(12);
  });

  it('is budgeted on directories, not on matches', () => {
    // 50,000 matches in one place should expand; the budget is about how much
    // tree appears, not how much matched.
    const d = dirs([['a/b', 0, 50_000]]);
    const tree = new FilteredTree(d, new Map(), countsAt(d, {'a/b': 50_000}));
    expect(tree.autoExpand(1)).not.toBeUndefined();
  });
});
