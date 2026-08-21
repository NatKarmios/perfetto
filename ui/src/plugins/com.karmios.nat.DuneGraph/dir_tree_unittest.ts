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

import type {DirRow} from './dir_tree';
import {DirTree, parentDir} from './dir_tree';

// A row as `path@depth`, with its parent's path (or `-` for a root) - the whole
// interesting content of a row in one readable string.
function show(rows: readonly DirRow[]): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows.map((r) => {
    const parent = r.parentId === undefined ? '-' : byId.get(r.parentId)!.path;
    return `${r.path}@${r.depth} ^${parent} =${r.name}`;
  });
}

describe('parentDir', () => {
  it('drops the last segment', () => {
    expect(parentDir('a/b/c')).toBe('a/b');
    expect(parentDir('_build/default/lib/x.cmi')).toBe('_build/default/lib');
  });

  it('returns the top level for a path with no separator', () => {
    expect(parentDir('dune-project')).toBe('');
    expect(parentDir('')).toBe('');
  });

  it('treats a leading separator as part of the first segment', () => {
    // The parent of `/usr` is the top level, not a phantom `/` root.
    expect(parentDir('/usr')).toBe('');
    expect(parentDir('/usr/bin')).toBe('/usr');
    expect(parentDir('/usr/bin/ocamlopt')).toBe('/usr/bin');
  });

  it('ignores a trailing separator', () => {
    // `a/b/` names the same entry as `a/b`, so it lives in `a`.
    expect(parentDir('a/b/')).toBe('a');
    expect(parentDir('a/')).toBe('');
    expect(parentDir('/')).toBe('');
  });

  it('treats @ as a boundary, like splitPath', () => {
    expect(parentDir('_build/default@default')).toBe('_build/default');
  });
});

describe('DirTree', () => {
  it('interns every prefix of a nested directory', () => {
    const tree = DirTree.from(['_build/default/lib']);
    expect(show(tree.rows)).toEqual([
      '_build@0 ^- =_build',
      '_build/default@1 ^_build =default',
      '_build/default/lib@2 ^_build/default =lib',
    ]);
    expect(tree.size).toBe(3);
  });

  it('shares a prefix between siblings, creating it once', () => {
    const tree = DirTree.from([
      '_build/default/lib',
      '_build/default/bin',
      '_build/install',
    ]);
    expect(show(tree.rows)).toEqual([
      '_build@0 ^- =_build',
      '_build/default@1 ^_build =default',
      '_build/default/lib@2 ^_build/default =lib',
      '_build/default/bin@2 ^_build/default =bin',
      '_build/install@1 ^_build =install',
    ]);
  });

  it('gives an absolute path a single root segment', () => {
    // The leading `/` is not a boundary, so `/usr` is one root row rather than
    // an empty root holding `usr`.
    const tree = DirTree.from(['/usr/bin', '/usr/lib/ocaml']);
    expect(show(tree.rows)).toEqual([
      '/usr@0 ^- =/usr',
      '/usr/bin@1 ^/usr =bin',
      '/usr/lib@1 ^/usr =lib',
      '/usr/lib/ocaml@2 ^/usr/lib =ocaml',
    ]);
  });

  it('keeps relative, absolute and top-level entries as separate roots', () => {
    const tree = DirTree.from(['_build/default', '', '/usr/bin', '_opam/bin']);
    const roots = tree.rows.filter((r) => r.parentId === undefined);
    expect(roots.map((r) => r.path)).toEqual(['_build', '', '/usr', '_opam']);
    expect(roots.every((r) => r.depth === 0)).toBe(true);
  });

  it('gives the empty (top-level) directory a row of its own', () => {
    const tree = DirTree.from(['']);
    expect(tree.rows).toEqual([
      {id: 0, parentId: undefined, name: '', path: '', depth: 0},
    ]);
    expect(tree.idOf('')).toBe(0);
  });

  it('interns a duplicate directory to the same id, adding no rows', () => {
    const tree = new DirTree();
    const first = tree.intern('_build/default/lib');
    expect(tree.intern('_build/default/lib')).toBe(first);
    expect(tree.intern('')).toBe(3);
    expect(tree.intern('')).toBe(3);
    // A prefix that arrives as a directory in its own right is the row that was
    // already interned for it, not a new one.
    expect(tree.intern('_build/default')).toBe(1);
    expect(tree.size).toBe(4);
  });

  it('canonicalizes a trailing separator to the same row', () => {
    const tree = new DirTree();
    expect(tree.intern('_build/default/')).toBe(1);
    expect(tree.intern('_build/default')).toBe(1);
    expect(tree.size).toBe(2);
    // Both spellings are answerable, and only the canonical one is stored.
    expect(tree.idOf('_build/default/')).toBe(1);
    expect(tree.rows[1].path).toBe('_build/default');
  });

  it('keeps an @ alias as a segment, showing the marker in its name', () => {
    const tree = DirTree.from(['_build/default@default/lib']);
    expect(show(tree.rows)).toEqual([
      '_build@0 ^- =_build',
      '_build/default@1 ^_build =default',
      '_build/default@default@2 ^_build/default =@default',
      '_build/default@default/lib@3 ^_build/default@default =lib',
    ]);
  });

  it('answers idOf only for directories it has seen', () => {
    const tree = DirTree.from(['a/b']);
    expect(tree.idOf('a')).toBe(0);
    expect(tree.idOf('a/b')).toBe(1);
    expect(tree.idOf('a/b/c')).toBeUndefined();
    expect(tree.idOf('')).toBeUndefined();
  });

  it('numbers every parent below its children (so a rollup is one pass)', () => {
    // The invariant sql_graph.ts's subtree totals depend on.
    const tree = DirTree.from([
      'z/y/x',
      '',
      '/abs/one',
      'z/y',
      'a',
      'z/w/v/u',
      '/abs/two/three',
    ]);
    for (const row of tree.rows) {
      if (row.parentId !== undefined) expect(row.parentId).toBeLessThan(row.id);
      expect(tree.rows[row.id]).toBe(row);
    }
    // Every row's parent is really its path's parent directory.
    for (const row of tree.rows) {
      const parent =
        row.parentId === undefined ? undefined : tree.rows[row.parentId].path;
      expect(parent).toBe(row.depth === 0 ? undefined : parentDir(row.path));
    }
  });
});
