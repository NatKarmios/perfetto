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
 * The directory explorer's data layer: the three queries the pane descends
 * `dune_dir` with, and the rules for how many rows it asks for at a time.
 *
 * Split out from dir_explorer_panel.ts because this half is the half worth
 * testing. There is no trace processor in a unit test, so what can be checked
 * is the SQL these functions generate - which table they read, how they order,
 * how they page - and that is exactly where a mistake here would live: an
 * unbounded member query, a missing `ORDER BY`, a `WHERE parent_id = NULL` that
 * silently returns nothing.
 *
 * Every query is a probe of one of the two indexes the node tier builds for
 * this pane (`_dune_node(dir_id)`, `_dune_dir(parent_id)` - see sql_graph.ts).
 * Nothing here scans, and nothing walks a subtree: a directory's *subtree*
 * numbers are already stored on its row as the `t_*` rollups, so a level is one
 * index probe. That is what makes the pane affordable on a trace with 19k
 * directories and 818k nodes.
 *
 * The one recursion is `compressedDirs`, and it is bounded and linear
 * by construction - it follows single-child directories downwards and stops at
 * the first one with anything of its own to show, so it visits at most one row
 * per level of the tree and never fans out.
 */

import {toCaseInsensitiveGlob} from '../../components/widgets/datagrid/column_filter_menu';
import {sqlValue} from '../../components/widgets/datagrid/sql_utils';
import type {Engine} from '../../trace_processor/engine';
import {
  LONG_NULL,
  NUM,
  NUM_NULL,
  STR,
} from '../../trace_processor/query_result';
import type {NodeKind} from './graph';

/**
 * How many members one page of a bucket holds.
 *
 * A bucket exists precisely because a directory has too many members to list
 * (`_build/default` on the monorepo trace has 8,431 deps), so expanding one
 * cannot mean "and now render all of them" - that is the same wall of rows the
 * bucket was introduced to avoid, just one click further in. The remainder is
 * reachable through a "show more" row, which is the only place this number is
 * visible to the user.
 */
export const MEMBER_PAGE = 500;

/**
 * At how many members a directory stops listing them inline and starts
 * bucketing them by kind.
 *
 * Counted over the *visible* kinds only (see dir_explorer_panel.ts): hiding
 * dependencies is meant to make a dependency-heavy directory readable, and it
 * cannot do that if the presentation is chosen from the members that are no
 * longer shown.
 */
export const INLINE_MEMBER_LIMIT = 20;

/**
 * A compiled path filter: what the user typed, plus the GLOB it became.
 *
 * Both are kept - `pattern` is what the SQL uses, `text` is what the filter chip
 * shows and what a cache key is fingerprinted on. A compiled filter is immutable
 * and is the identity of "which rows are we showing"; changing the text makes a
 * new one rather than mutating this.
 */
export interface PathFilter {
  readonly text: string;
  readonly pattern: string;
}

// Characters that make a typed string a glob rather than a substring. `[` counts
// because a character class is how you write a case-insensitive letter by hand,
// which is exactly what `toCaseInsensitiveGlob` generates.
const GLOB_CHARS = /[*?[]/;

/**
 * Turns typed text into a {@link PathFilter}.
 *
 * Wildcards are detected rather than assumed either way, because the two things
 * people type want opposite treatment. `lib` means "anything with lib in it", so
 * it becomes a case-insensitive `*[lL][iI][bB]*` via the same helper the
 * DataGrid's column search uses. `lib/*.cmi` is a pattern the user wrote
 * deliberately: wrapping it in further stars would be harmless, but silently
 * case-folding it would not be, and either way it is theirs to write. So a
 * string containing a glob metacharacter is passed through verbatim.
 *
 * Returns undefined for blank text, which is "no filter" rather than "match
 * everything" - the caller uses it to clear.
 */
export function compileFilter(text: string): PathFilter | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  return {
    text: trimmed,
    pattern: GLOB_CHARS.test(trimmed)
      ? trimmed
      : toCaseInsensitiveGlob(trimmed),
  };
}

/**
 * The extra `AND` clause a filter contributes to a *member* query, or `''`.
 *
 * Two kinds, two rules, from what the filter is defined to match (see
 * dir_filter.ts): a dep is matched on its own full path, a rule on the directory
 * it is filed under. Within one directory query every rule shares that
 * directory, so a rule either always matches here or never does - which the
 * caller has already decided, and passes as `rulesMatch`. That is why this is a
 * predicate on deps only, and why the expensive column (`label`, which resolves
 * through a join to `dune_string`) is never the clause that *selects* rows: it is
 * always ANDed onto `dir_id = ?`, so it is tested against the handful of rows
 * that probe already found rather than against all 818k nodes.
 */
function memberFilterClause(
  filter: PathFilter | undefined,
  rulesMatch: boolean,
): string {
  if (filter === undefined) return '';
  const dep = `label GLOB ${sqlValue(filter.pattern)}`;
  // Rules are in or out wholesale; deps are tested individually.
  return rulesMatch
    ? ` AND (kind = 'rule' OR ${dep})`
    : ` AND (kind != 'rule' AND ${dep})`;
}

/**
 * One row of `dune_dir` (see sql_graph.ts), as the pane needs it.
 *
 * Both count triples are carried because both are used and neither costs a
 * query: the `n_*` are what the directory itself holds, and so decide whether
 * its members are listed inline or bucketed and what a bucket's header says;
 * the `t_*` are its whole subtree, and so are what a *collapsed* row can
 * honestly summarise, and what says whether a subtree has anything to show at
 * all under the current kind filter.
 */
export interface DirEntry {
  readonly id: number;
  /**
   * This directory's parent, absent for a root.
   *
   * Careful: on a *compressed* row (see {@link compressedDirs}) this is the
   * parent of the deep directory the row settled on, which is not the row above
   * it in the tree. It is here for {@link allDirs}, whose rows are uncompressed
   * and where it is the tree's actual shape. Everything that needs "the row
   * above" is passed that path explicitly instead - `dirLabel`'s `parentPath`,
   * `FilteredRow.pathFrom` - precisely so this field is never mistaken for it.
   */
  readonly parentId?: number;
  readonly name: string;
  readonly path: string;
  readonly depth: number;
  // Direct members: rules whose `dir` this is, deps whose path is directly in
  // it, and how many of those rules failed.
  readonly nRules: number;
  readonly nDeps: number;
  readonly nFailed: number;
  // The same three over the whole subtree, this directory included.
  readonly tRules: number;
  readonly tDeps: number;
  readonly tFailed: number;
  // Summed rule spans for the subtree, 0 where nothing in it was timed. The
  // directory's own (`self_dur_ns`) is deliberately not read: a row that can be
  // collapsed should summarise what it contains, and expanding it replaces the
  // summary with the children's own numbers rather than with a second total.
  readonly totalDurNs: bigint;
}

/** One member of a directory: a graph node, ready to render as a chip. */
export interface MemberEntry {
  readonly nodeId: number;
  readonly kind: NodeKind;
  readonly label: string;
}

// Every column a DirEntry needs. Selected off `d`, the compressed row the chain
// below settles on.
const DIR_COLUMNS = `
  d.id, d.parent_id, d.name, d.path, d.depth,
  d.n_rules, d.n_deps, d.n_failed,
  d.t_rules, d.t_deps, d.t_failed,
  d.total_dur_ns
`;

/**
 * Whether a directory is a *pass-through*: it holds nothing itself and leads to
 * exactly one place, so a row of its own would say only "keep going".
 *
 * This is what makes the pane a trie rather than a filesystem browser. A build's
 * paths are long and mostly scaffolding - `_build/default/lib/foo` is four rows
 * and three clicks to reach one directory that actually contains something - and
 * collapsing the runs is the difference between a tree you can read and one you
 * have to tunnel through.
 *
 * Deliberately absolute (`n_rules = 0 AND n_deps = 0`) rather than relative to
 * the kind toggles: compression decided by the current filter would restructure
 * the tree - and invalidate every cached level - on each toggle, and would move
 * rows around under the user for a filter that is meant only to hide some of
 * them.
 *
 * `{dir}` is the alias of the `dune_dir` row being tested. The child count is a
 * probe of `_dune_dir(parent_id)`, the same index the descent itself uses.
 */
function passThrough(dir: string): string {
  return `
    ${dir}.n_rules = 0 AND ${dir}.n_deps = 0
    AND (SELECT count(*) FROM dune_dir WHERE parent_id = ${dir}.id) = 1
  `;
}

/**
 * The chain that collapses runs of pass-through directories, as a recursive CTE
 * over one level's worth of seeds.
 *
 * Seeded with the directories at the level being listed, it replaces each
 * pass-through with its only child and repeats. The chain is linear - the step
 * only fires where there is exactly one child - so it produces at most one row
 * per level of the tree per seed, and terminates at the first directory that has
 * members of its own, or branches, or has no children at all.
 *
 * The final SELECT then keeps exactly the *terminal* rows, by the same predicate
 * the step is gated on: a row that is still a pass-through has a descendant in
 * the chain standing in for it, and a row that isn't is where its chain stopped.
 * That is one row per seed with no GROUP BY and no max() - which is worth having
 * over the shorter phrasings, because "one row per seed" is the property the
 * whole pane rests on.
 *
 * `{seeds}` is the WHERE clause naming the level to list.
 */
function compressedDirs(seeds: string): string {
  return `
    WITH RECURSIVE chain(id) AS (
      SELECT id FROM dune_dir WHERE ${seeds}
      UNION ALL
      SELECT k.id
      FROM chain c
      JOIN dune_dir p ON p.id = c.id
      JOIN dune_dir k ON k.parent_id = c.id
      WHERE ${passThrough('p')}
    )
    SELECT ${DIR_COLUMNS}
    FROM chain
    JOIN dune_dir d ON d.id = chain.id
    WHERE NOT (${passThrough('d')})
    ORDER BY d.path
  `;
}

/**
 * The tree's roots.
 *
 * There are several, and that is not a degenerate case: a build's paths are a
 * mix of absolute and relative ones, so `_build`, the opam switch, `/usr` and
 * the top level (the empty path, which is a directory like any other - see
 * dir_tree.ts) are all parentless. Ordered by path so that ordering is stable
 * rather than insertion-dependent.
 *
 * Compressed like every other level, so a root that is pure scaffolding comes
 * back as the first directory below it that isn't - `_build/default` rather than
 * `_build`.
 */
export async function rootDirs(engine: Engine): Promise<DirEntry[]> {
  // `IS NULL`, not `= NULL`: the latter is never true in SQL and would return
  // an empty tree.
  return readDirs(engine, compressedDirs('parent_id IS NULL'));
}

/**
 * The child directories of `id`, each collapsed past any run of pass-through
 * directories below it (see {@link compressedDirs}).
 *
 * So a child may come back as a directory several levels down - `default/lib`
 * rather than `default` - and its `path` is the honest one for wherever it
 * landed. What the pane *shows* is that path minus the parent's, which is why
 * the ordering is by `path` and not by `name`: `name` is only the last segment
 * of a compressed row and so isn't what the user reads.
 */
export async function childDirs(
  engine: Engine,
  id: number,
): Promise<DirEntry[]> {
  return readDirs(engine, compressedDirs(`parent_id = ${id}`));
}

/**
 * One page of the members of `id`, of `kind` if given and of both kinds
 * otherwise.
 *
 * Always bounded. An unbounded version of this query is the pane's one way to
 * hurt itself - `dune_node WHERE dir_id = ?` is an index probe, but a directory
 * holding 8,431 deps would still hand back 8,431 rows and ask mithril to render
 * them.
 *
 * `ORDER BY kind` puts rules before deps (`'dep' < 'rule'` descending), which
 * is the order the pane lists them in when it lists them inline. It is also
 * what makes paging coherent: an `OFFSET` into an unordered result is not a
 * page of anything.
 */
export async function dirMembers(
  engine: Engine,
  id: number,
  kind: NodeKind | undefined,
  limit: number = MEMBER_PAGE,
  offset: number = 0,
  filter?: PathFilter,
  rulesMatch: boolean = true,
): Promise<MemberEntry[]> {
  const kindFilter = kind === undefined ? '' : ` AND kind = '${kind}'`;
  const result = await engine.query(`
    SELECT node_id, kind, label
    FROM dune_node
    WHERE dir_id = ${id}${kindFilter}${memberFilterClause(filter, rulesMatch)}
    ORDER BY kind DESC, label
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
 * Every direct member of `id` of the given kinds, as node ids - what the bulk
 * add/remove buttons act on.
 *
 * Deliberately the directory's *direct* members rather than its subtree's. The
 * subtree count runs to six figures on a real trace (`t_deps` under `_build` on
 * the monorepo trace), and the graph pane it would be feeding is an SVG of one
 * dot per node; "add all" should mean the rows this directory is showing, which
 * is what a bounded, non-recursive query returns.
 *
 * Takes the same filter as {@link dirMembers}, so while a filter is active "add
 * all" means "add all *matching*". Ignoring it would make the button quietly
 * disregard the thing the user just asked to narrow by.
 *
 * Unbounded in row count, unlike {@link dirMembers}, because a node id is 8
 * bytes and the caller is about to put every one of them into a Set - there is
 * no rendering involved, so the number that matters is `n_rules + n_deps` and
 * it is known before the click.
 */
export async function dirMemberIds(
  engine: Engine,
  id: number,
  kinds: readonly NodeKind[],
  filter?: PathFilter,
  rulesMatch: boolean = true,
): Promise<number[]> {
  if (kinds.length === 0) return [];
  const list = kinds.map((k) => `'${k}'`).join(', ');
  const result = await engine.query(`
    SELECT node_id
    FROM dune_node
    WHERE dir_id = ${id} AND kind IN (${list})${memberFilterClause(filter, rulesMatch)}
  `);
  const ids: number[] = [];
  const it = result.iter({node_id: NUM});
  for (; it.valid(); it.next()) ids.push(it.node_id);
  return ids;
}

/**
 * Every directory in the build, in id order - the whole of `dune_dir`.
 *
 * Read in one go, and only when a filter is applied. Hard-filtering the tree
 * means deciding whether a *subtree* holds a match, which no per-level query can
 * answer, so the filtered view is computed client-side over the whole hierarchy
 * (see dir_filter.ts) rather than descended a level at a time. At 19k rows on the
 * monorepo trace that is a few MB and one query - cheaper than the per-level
 * queries it replaces, and paid once per filter rather than once per click.
 *
 * `dune_dir`'s ids are dense from zero and a parent's id is always lower than its
 * children's (see dir_tree.ts), so id order is also topological order, which is
 * what lets the rollup be one descending pass.
 */
export async function allDirs(engine: Engine): Promise<DirEntry[]> {
  return readDirs(
    engine,
    `SELECT ${DIR_COLUMNS} FROM dune_dir d ORDER BY d.id`,
  );
}

/**
 * The directories whose own path matches `filter` - i.e. the directories in
 * which *rules* match.
 *
 * A rule's label is its bare dune id, which contains no path, so a rule is
 * matched on the directory it is filed under instead. That makes this a scan of
 * `dune_dir`'s unindexed `path` column - but of 19k rows, not 818k, so matching
 * rules by directory turned the expensive half of this filter into the cheap
 * half. Every rule in a returned directory matches, which is why only ids come
 * back: the count is the directory's own `n_rules`.
 */
export async function matchingRuleDirs(
  engine: Engine,
  filter: PathFilter,
): Promise<Set<number>> {
  const result = await engine.query(`
    SELECT id FROM dune_dir WHERE path GLOB ${sqlValue(filter.pattern)}
  `);
  const ids = new Set<number>();
  const it = result.iter({id: NUM});
  for (; it.valid(); it.next()) ids.add(it.id);
  return ids;
}

/**
 * How many *deps* match `filter` in each directory, keyed by directory id.
 *
 * This is the pane's one real scan: a dep is matched on its own full path, which
 * lives in `dune_node.label` - a column computed by the view through a join to
 * `dune_string`, with no index on the string. So there is no phrasing of this
 * that avoids visiting every dep in the build (818k nodes on the monorepo trace,
 * most of them deps).
 *
 * That is accepted here and nowhere else in this file, for one reason: it is paid
 * once, when the user presses Enter, rather than once per directory expanded. The
 * per-expansion member query keeps this same predicate ANDed onto its `dir_id`
 * probe (see {@link memberFilterClause}), so it never becomes the clause that
 * selects rows. Aggregating by `dir_id` here rather than returning the matches
 * themselves is what keeps the result small - one row per directory that has any.
 */
export async function matchingDepCounts(
  engine: Engine,
  filter: PathFilter,
): Promise<Map<number, number>> {
  const result = await engine.query(`
    SELECT dir_id, count(*) AS n
    FROM dune_node
    WHERE kind = 'dep' AND label GLOB ${sqlValue(filter.pattern)}
    GROUP BY dir_id
  `);
  const counts = new Map<number, number>();
  const it = result.iter({dir_id: NUM, n: NUM});
  for (; it.valid(); it.next()) counts.set(it.dir_id, it.n);
  return counts;
}

async function readDirs(engine: Engine, query: string): Promise<DirEntry[]> {
  const result = await engine.query(query);
  const dirs: DirEntry[] = [];
  const it = result.iter({
    id: NUM,
    parent_id: NUM_NULL,
    name: STR,
    path: STR,
    depth: NUM,
    n_rules: NUM,
    n_deps: NUM,
    n_failed: NUM,
    t_rules: NUM,
    t_deps: NUM,
    t_failed: NUM,
    total_dur_ns: LONG_NULL,
  });
  for (; it.valid(); it.next()) {
    dirs.push({
      id: it.id,
      parentId: it.parent_id ?? undefined,
      name: it.name,
      path: it.path,
      depth: it.depth,
      nRules: it.n_rules,
      nDeps: it.n_deps,
      nFailed: it.n_failed,
      tRules: it.t_rules,
      tDeps: it.t_deps,
      tFailed: it.t_failed,
      totalDurNs: it.total_dur_ns ?? 0n,
    });
  }
  return dirs;
}
