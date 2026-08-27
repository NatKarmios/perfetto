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
 * The directory explorer's queries (dir_explorer.ts), captured through a stub
 * engine.
 *
 * There is no trace processor here, so what is checked is the SQL these
 * functions decide to issue plus the row reading around it - which is where a
 * mistake would actually live. Three of them would be invisible in review and
 * expensive in the pane:
 *
 * - `parent_id = NULL` instead of `IS NULL`, which is never true, so the tree
 *   would simply have no roots and the panel would render "Nothing to show".
 * - a missing `LIMIT` on the member query, which turns expanding one directory
 *   on the monorepo trace into 8,431 rows handed to mithril.
 * - a missing or wrong `ORDER BY`, which makes `OFFSET` paging incoherent (a
 *   page of an unordered result is not a page of anything) and silently drops
 *   and repeats members as the user clicks "show more".
 */

import type {Engine} from '../../trace_processor/engine';
import {
  INLINE_MEMBER_LIMIT,
  MEMBER_PAGE,
  childDirs,
  dirMemberIds,
  dirMembers,
  rootDirs,
  allDirs,
  compileFilter,
  matchingDepCounts,
  matchingRuleDirs,
} from './dir_explorer';
import {dirLabel, strippedDepLabel} from './dir_explorer_panel';

// A stub engine that records every statement and returns `rows` from each.
// `rows` are read through the real `iter` protocol, so the column names the
// readers ask for have to be the ones the queries select.
function stubEngine(rows: ReadonlyArray<Record<string, unknown>>): {
  engine: Engine;
  sql: string[];
} {
  const sql: string[] = [];
  const engine = {
    query: async (q: string) => {
      sql.push(q);
      let i = 0;
      const it = {
        valid: () => i < rows.length,
        next: () => {
          i++;
        },
      };
      // The reader indexes the iterator by column name; back it with whichever
      // row is current.
      return {
        iter: () =>
          new Proxy(it, {
            get: (target, prop) => {
              if (prop in target) return target[prop as keyof typeof target];
              return rows[i]?.[prop as string];
            },
          }),
      };
    },
  } as unknown as Engine;
  return {engine, sql};
}

// One `dune_dir` row, with every column the reader wants.
function dirRow(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: 'lib',
    path: '_build/default/lib',
    depth: 2,
    n_rules: 3,
    n_deps: 4,
    n_failed: 1,
    t_rules: 30,
    t_deps: 40,
    t_failed: 2,
    total_dur_ns: 1_500n,
    ...over,
  };
}

// Whitespace-insensitive containment, since the queries are template literals.
function has(sql: string, fragment: string): boolean {
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
  return flat(sql).includes(flat(fragment));
}

describe('rootDirs', () => {
  it('finds the roots with IS NULL, not = NULL', async () => {
    // `parent_id = NULL` is never true in SQL, so this exact phrasing is the
    // difference between a tree and an empty panel.
    const {engine, sql} = stubEngine([]);
    await rootDirs(engine);
    expect(sql).toHaveLength(1);
    expect(has(sql[0], 'SELECT id FROM dune_dir WHERE parent_id IS NULL')).toBe(
      true,
    );
    expect(sql[0]).not.toContain('parent_id = NULL');
  });

  it('orders the roots, and reads dune_dir', async () => {
    // There are genuinely several roots (`_build`, the opam switch, `/usr`, the
    // top level), so their order is a choice rather than a non-issue.
    const {engine, sql} = stubEngine([]);
    await rootDirs(engine);
    expect(has(sql[0], 'JOIN dune_dir d ON d.id = chain.id')).toBe(true);
    expect(has(sql[0], 'ORDER BY d.path')).toBe(true);
  });

  it('reads every column the panel needs off a row', async () => {
    const {engine} = stubEngine([dirRow()]);
    const [root] = await rootDirs(engine);
    expect(root).toEqual({
      id: 7,
      name: 'lib',
      path: '_build/default/lib',
      depth: 2,
      nRules: 3,
      nDeps: 4,
      nFailed: 1,
      tRules: 30,
      tDeps: 40,
      tFailed: 2,
      totalDurNs: 1_500n,
    });
  });

  it('reads an untimed directory as zero rather than as absent', async () => {
    // `total_dur_ns` is NULL for a subtree in which nothing was timed; the
    // panel compares it against 0n, so a NULL must not arrive as undefined.
    const {engine} = stubEngine([dirRow({total_dur_ns: null})]);
    const [root] = await rootDirs(engine);
    expect(root.totalDurNs).toBe(0n);
  });
});

describe('childDirs', () => {
  it('descends one level, by the indexed column', async () => {
    // `parent_id` is what the node tier indexes for exactly this query (see
    // sql_graph.ts). Descending by `path LIKE ...` instead would be a scan.
    const {engine, sql} = stubEngine([]);
    await childDirs(engine, 42);
    expect(has(sql[0], 'SELECT id FROM dune_dir WHERE parent_id = 42')).toBe(
      true,
    );
    expect(has(sql[0], 'ORDER BY d.path')).toBe(true);
  });

  it('reads a level with one query however deep the runs below it are', async () => {
    // The whole point of doing the compression in SQL: a chain of
    // `_build/default/lib/foo` collapses in the one round trip that lists the
    // level, not one round trip per link.
    const {engine, sql} = stubEngine([]);
    await childDirs(engine, 42);
    expect(sql).toHaveLength(1);
  });
});

describe('pass-through compression', () => {
  // The chain is the one recursion in this file, so what is worth pinning down
  // is that it stays linear and that "one row per seed" survives.

  it('follows only single-child directories, and only empty ones', async () => {
    // Both halves matter. Without the count check the chain would fan out over
    // whole subtrees; without the member check it would skip past directories
    // that have rules or deps of their own to show.
    const {engine, sql} = stubEngine([]);
    await childDirs(engine, 42);
    expect(has(sql[0], 'p.n_rules = 0 AND p.n_deps = 0')).toBe(true);
    expect(
      has(
        sql[0],
        'AND (SELECT count(*) FROM dune_dir WHERE parent_id = p.id) = 1',
      ),
    ).toBe(true);
  });

  it('steps to the single child, keyed on parent_id', async () => {
    const {engine, sql} = stubEngine([]);
    await childDirs(engine, 42);
    expect(has(sql[0], 'JOIN dune_dir k ON k.parent_id = c.id')).toBe(true);
  });

  it('emits terminals only, by negating the step condition', async () => {
    // This is what makes it exactly one row per seed. A GROUP BY / max(depth)
    // phrasing would be shorter but would lean on SQLite's bare-column rule for
    // the property the whole pane rests on.
    const {engine, sql} = stubEngine([]);
    await childDirs(engine, 42);
    expect(has(sql[0], 'WHERE NOT ( d.n_rules = 0 AND d.n_deps = 0')).toBe(
      true,
    );
    expect(sql[0].toUpperCase()).not.toContain('GROUP BY');
    expect(sql[0]).not.toContain('max(');
  });

  it('compresses the roots too', async () => {
    // A root that is pure scaffolding (`_build`, with only `default` under it)
    // should come back as `_build/default`, not as a row that only says "keep
    // going".
    const {engine, sql} = stubEngine([]);
    await rootDirs(engine);
    expect(has(sql[0], 'WITH RECURSIVE chain(id) AS')).toBe(true);
    expect(has(sql[0], 'p.n_rules = 0 AND p.n_deps = 0')).toBe(true);
  });

  it('returns the row it landed on, not the seed', async () => {
    // The reader takes `d.*`, so a compressed row's id/path/counts are the deep
    // directory's - which is what makes expanding it fetch the right children
    // and what the panel measures its label against.
    const {engine} = stubEngine([
      dirRow({id: 9, name: 'lib', path: '_build/default/lib', depth: 2}),
    ]);
    const [child] = await childDirs(engine, 1);
    expect([child.id, child.path]).toEqual([9, '_build/default/lib']);
  });
});

describe('dirMembers', () => {
  it('is always bounded, and pages by offset', async () => {
    const {engine, sql} = stubEngine([]);
    await dirMembers(engine, 9, undefined);
    expect(has(sql[0], `LIMIT ${MEMBER_PAGE} OFFSET 0`)).toBe(true);
  });

  it('orders rules before deps, then by label', async () => {
    // Descending, because 'rule' > 'dep'. The order is also what makes OFFSET
    // paging coherent - see this file's header.
    const {engine, sql} = stubEngine([]);
    await dirMembers(engine, 9, undefined);
    expect(has(sql[0], 'ORDER BY kind DESC, label')).toBe(true);
  });

  it('filters by kind only when asked, probing dir_id either way', async () => {
    const {engine, sql} = stubEngine([]);
    await dirMembers(engine, 9, undefined);
    await dirMembers(engine, 9, 'dep');
    expect(has(sql[0], 'WHERE dir_id = 9')).toBe(true);
    expect(sql[0]).not.toContain('kind =');
    expect(has(sql[1], "WHERE dir_id = 9 AND kind = 'dep'")).toBe(true);
  });

  it('honours an explicit page', async () => {
    const {engine, sql} = stubEngine([]);
    await dirMembers(engine, 9, 'rule', 25, 500);
    expect(has(sql[0], 'LIMIT 25 OFFSET 500')).toBe(true);
  });

  it('reads a member row', async () => {
    const {engine} = stubEngine([
      {node_id: 11, kind: 'rule', label: '4821'},
      {node_id: 12, kind: 'dep', label: 'lib/x.cmi'},
    ]);
    expect(await dirMembers(engine, 9, undefined)).toEqual([
      {nodeId: 11, kind: 'rule', label: '4821'},
      {nodeId: 12, kind: 'dep', label: 'lib/x.cmi'},
    ]);
  });
});

describe('dirMemberIds', () => {
  it('asks for one kind or both, without a limit', async () => {
    // Unbounded on purpose: nothing is rendered from this, and the caller knows
    // the count (n_rules + n_deps) before the click. See dir_explorer.ts.
    const {engine, sql} = stubEngine([]);
    await dirMemberIds(engine, 3, ['rule']);
    await dirMemberIds(engine, 3, ['rule', 'dep']);
    expect(has(sql[0], "WHERE dir_id = 3 AND kind IN ('rule')")).toBe(true);
    expect(has(sql[1], "WHERE dir_id = 3 AND kind IN ('rule', 'dep')")).toBe(
      true,
    );
    expect(sql.some((q) => q.includes('LIMIT'))).toBe(false);
  });

  it('issues no query at all for no kinds', async () => {
    // Both toggles off. A `kind IN ()` is a syntax error, and the answer is
    // known without asking.
    const {engine, sql} = stubEngine([]);
    expect(await dirMemberIds(engine, 3, [])).toEqual([]);
    expect(sql).toHaveLength(0);
  });

  it('reads the ids', async () => {
    const {engine} = stubEngine([{node_id: 4}, {node_id: 8}]);
    expect(await dirMemberIds(engine, 3, ['dep'])).toEqual([4, 8]);
  });
});

describe('paging constants', () => {
  it('lists a whole inline directory within one page', async () => {
    // The panel lists a directory's members inline when there are at most
    // INLINE_MEMBER_LIMIT of them and never offers "show more" for that list,
    // so the first page has to be able to hold all of them. If MEMBER_PAGE ever
    // dropped below the threshold, an inline list would silently truncate.
    expect(MEMBER_PAGE).toBeGreaterThanOrEqual(INLINE_MEMBER_LIMIT);
  });
});

describe('dirLabel', () => {
  const at = (path: string) => ({path});

  it('labels a root with its whole path', () => {
    expect(dirLabel(at('_build'), '')).toBe('_build/');
    expect(dirLabel(at('/usr'), '')).toBe('/usr/');
  });

  it('labels a nested directory relative to the row above it', () => {
    expect(dirLabel(at('_build/default'), '_build')).toBe('default/');
  });

  it('labels a compressed row with the whole run it collapsed', () => {
    // The point of the compression: the label has to describe where clicking
    // goes, which is several directories down, not just the last segment.
    expect(dirLabel(at('_build/default/lib/foo'), '_build')).toBe(
      'default/lib/foo/',
    );
  });

  it('treats an @ boundary like a / one', () => {
    // Both are separators in dir_tree.ts's segmentation, and both are one
    // character, which is what makes the suffix a slice.
    expect(dirLabel(at('_build/default@alias'), '_build/default')).toBe(
      'alias/',
    );
  });

  it('names the top level rather than rendering a blank row', () => {
    expect(dirLabel(at(''), '')).toBe('(top level)');
  });

  it('does not eat the first character of a nested name', () => {
    // The off-by-one this function exists to get right: the separator between
    // parent and child is consumed, the child's first character is not.
    const label = dirLabel(at('a/bcd'), 'a');
    expect(label).toBe('bcd/');
    expect(label.startsWith('cd')).toBe(false);
  });
});

describe('strippedDepLabel', () => {
  const dep = (label: string) => ({kind: 'dep' as const, label});

  it('drops the directory the row already sits under', () => {
    expect(
      strippedDepLabel(dep('_build/default/lib/x.cmi'), '_build/default/lib'),
    ).toBe('x.cmi');
  });

  it('leaves a path several levels below the directory intact below it', () => {
    // Cannot happen through `dir_id` (a dep is filed under `parentDir` of its
    // own path), but if it ever did, dropping only the heading's part is the
    // honest answer rather than the basename.
    expect(strippedDepLabel(dep('a/b/c/d'), 'a/b')).toBe('c/d');
  });

  it('keeps an @ alias marker, which is name rather than hierarchy', () => {
    // Same rule dir_tree.ts's `segName` and path_tree.ts's leaves follow.
    expect(
      strippedDepLabel(dep('_build/default@alias'), '_build/default'),
    ).toBe('@alias');
  });

  it('leaves rules alone', () => {
    // A rule's label is its bare dune id; its directory is a property of the
    // rule, not a prefix of its name, so there is nothing to strip.
    expect(
      strippedDepLabel({kind: 'rule', label: '4821'}, '_build/default/lib'),
    ).toBeUndefined();
  });

  it('abbreviates nothing at the top level', () => {
    expect(strippedDepLabel(dep('dune-project'), '')).toBeUndefined();
  });

  it('refuses to slice where the prefix is not a whole segment', () => {
    // The guard that matters: `_build/defaults/x` under `_build/default` shares
    // a string prefix but not a path one, and slicing blind would render it as
    // `s/x`. A wrong label on a build artefact is worse than a long one.
    expect(
      strippedDepLabel(dep('_build/defaults/x.cmi'), '_build/default'),
    ).toBeUndefined();
  });

  it('refuses when the path is not under the directory at all', () => {
    expect(
      strippedDepLabel(dep('/usr/bin/ocamlopt'), '_build/default'),
    ).toBeUndefined();
  });

  it('does not abbreviate a path down to nothing', () => {
    // A dep whose path *is* the directory has no remainder; an empty label
    // would render as a blank row.
    expect(strippedDepLabel(dep('a/b/'), 'a/b')).toBeUndefined();
  });
});

describe('compileFilter', () => {
  it('treats plain text as a case-insensitive substring', () => {
    // What someone typing `lib` means, and the same conversion the DataGrid's
    // own column search uses.
    expect(compileFilter('lib')?.pattern).toBe('*[lL][iI][bB]*');
  });

  it('passes a glob through verbatim', () => {
    // A pattern with wildcards was written deliberately. Case-folding it would
    // silently change what the user asked for.
    for (const text of ['lib/*.cmi', 'a?c', '[abc]x']) {
      expect(compileFilter(text)?.pattern).toBe(text);
    }
  });

  it('keeps the typed text alongside the pattern', () => {
    // The chip shows what was typed, not the glob it became.
    expect(compileFilter('lib')?.text).toBe('lib');
  });

  it('trims, and reads blank as no filter', () => {
    expect(compileFilter('  lib  ')?.text).toBe('lib');
    expect(compileFilter('')).toBeUndefined();
    expect(compileFilter('   ')).toBeUndefined();
  });
});

describe('filtered member queries', () => {
  const filter = {text: 'x', pattern: '*x*'};

  it('tests deps on their path and lets matching rules through wholesale', async () => {
    // A rule is matched on its directory, which is constant within one directory
    // query - so rules are in or out as a group and only deps get a per-row test.
    const {engine, sql} = stubEngine([]);
    await dirMembers(engine, 9, undefined, 500, 0, filter, true);
    expect(has(sql[0], "AND (kind = 'rule' OR label GLOB '*x*')")).toBe(true);
  });

  it('excludes rules entirely when their directory did not match', async () => {
    const {engine, sql} = stubEngine([]);
    await dirMembers(engine, 9, undefined, 500, 0, filter, false);
    expect(has(sql[0], "AND (kind != 'rule' AND label GLOB '*x*')")).toBe(true);
  });

  it('keeps the filter off the driving clause', async () => {
    // The whole affordability argument: `dir_id` selects the rows and the
    // expensive `label` predicate is only ever ANDed onto it, so an expansion
    // tests a handful of rows rather than all 818k.
    const {engine, sql} = stubEngine([]);
    await dirMembers(engine, 9, 'dep', 500, 0, filter, false);
    const flat = sql[0].replace(/\s+/g, ' ');
    expect(flat.indexOf('dir_id = 9')).toBeLessThan(flat.indexOf('label GLOB'));
    expect(has(sql[0], 'LIMIT 500 OFFSET 0')).toBe(true);
  });

  it('applies the filter to bulk add/remove too', async () => {
    // Otherwise "add all" silently ignores the thing the user narrowed by.
    const {engine, sql} = stubEngine([]);
    await dirMemberIds(engine, 3, ['rule', 'dep'], filter, false);
    expect(has(sql[0], "AND (kind != 'rule' AND label GLOB '*x*')")).toBe(true);
  });

  it('adds nothing when there is no filter', async () => {
    const {engine, sql} = stubEngine([]);
    await dirMembers(engine, 9, undefined);
    await dirMemberIds(engine, 9, ['dep']);
    expect(sql.some((q) => q.includes('GLOB'))).toBe(false);
  });

  it('escapes a quote in the pattern', async () => {
    // Reused from the DataGrid's `sqlValue` rather than hand-rolled.
    const {engine, sql} = stubEngine([]);
    await dirMembers(engine, 9, 'dep', 500, 0, {text: "a'b", pattern: "a'b"});
    expect(has(sql[0], "label GLOB 'a''b'")).toBe(true);
  });
});

describe("the filter's global match queries", () => {
  const filter = {text: 'x', pattern: '*x*'};

  it('matches rules by directory, over 19k rows rather than 818k', async () => {
    // A rule's label is its bare dune id, so it is matched on the directory it
    // is filed under - which is what turns the expensive half of this filter
    // into the cheap half.
    const {engine, sql} = stubEngine([]);
    await matchingRuleDirs(engine, filter);
    expect(has(sql[0], "SELECT id FROM dune_dir WHERE path GLOB '*x*'")).toBe(
      true,
    );
  });

  it('aggregates dep matches per directory rather than returning them', async () => {
    // This is the pane's one real scan; returning one row per directory instead
    // of one per match is what keeps the result small.
    const {engine, sql} = stubEngine([]);
    await matchingDepCounts(engine, filter);
    expect(has(sql[0], "WHERE kind = 'dep' AND label GLOB '*x*'")).toBe(true);
    expect(has(sql[0], 'GROUP BY dir_id')).toBe(true);
  });

  it('reads the whole hierarchy in one query, in id order', async () => {
    // Id order is topological order (see dir_tree.ts), which is what lets the
    // rollup be a single descending pass.
    const {engine, sql} = stubEngine([]);
    await allDirs(engine);
    expect(sql).toHaveLength(1);
    expect(has(sql[0], 'FROM dune_dir d ORDER BY d.id')).toBe(true);
    expect(sql[0].toUpperCase()).not.toContain('RECURSIVE');
  });

  it('selects parent_id, which the client-side tree is built from', async () => {
    const {engine} = stubEngine([dirRow({parent_id: 4})]);
    const [dir] = await allDirs(engine);
    expect(dir.parentId).toBe(4);
  });

  it('reads a root parent_id as absent', async () => {
    const {engine} = stubEngine([dirRow({parent_id: null})]);
    const [dir] = await allDirs(engine);
    expect(dir.parentId).toBeUndefined();
  });
});
