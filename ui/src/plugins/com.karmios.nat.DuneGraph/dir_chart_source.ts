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
 * So there is exactly one thing to compute, and `dir_filter.ts` already does
 * everything downstream of it: the per-directory count channels. From those,
 * `FilteredTree` does the subtree rollup, the hard filter (a directory with no
 * matching rows gets no row at all), the pass-through compression over what
 * survives, and the expansion remapping - all client-side, all arithmetic.
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
 *   They come from the input rows rather than from a fresh `dune_node` probe -
 *   the probe would return every member of the directory, which is precisely the
 *   rows the query did *not* select - so paging is a slice of a list that was
 *   sorted once, at index time, into the order the SQL member query uses
 *   (`ORDER BY n.kind DESC, n.label`).
 *
 * ## The row cap
 *
 * The pane's own tree is lazy and needs no cap; the input is a materialised
 * result and does. One query, capped, read once per mount - see
 * {@link CHART_ROW_CAP} for the number and why the query asks for one row more
 * than it wants.
 */

import {getErrorMessage} from '../../base/errors';
import type {Engine} from '../../trace_processor/engine';
import {NUM, STR} from '../../trace_processor/query_result';
import type {DuneGraphController} from './controller';
import type {
  DirEntry,
  MemberEntry,
  MemberFilter,
  PathFilter,
} from './dir_explorer';
import {allDirs} from './dir_explorer';
import type {DirExplorerSource} from './dir_explorer_source';
import type {NodeKind} from './graph';

/**
 * How many of the query's rows the chart will hold.
 *
 * The tree below this is lazy - it draws one level at a time out of arithmetic -
 * so the cap is not about rendering. It is about the join's result being
 * materialised in the browser: every row here is a node id, a kind and a label
 * string, and a query over `dune_node` with no WHERE at all would hand back all
 * 818k of them.
 *
 * 50k is generous next to the built-in charts (a treemap caps at 50 rows, a
 * scatter at 2,000) and is meant to be: those cap what they can *draw*, and this
 * caps what it can *hold*. A directory tree over 50k nodes is still perfectly
 * readable, because the tree only ever renders the level you opened.
 *
 * The query asks for `CHART_ROW_CAP + 1` rows, which is how "the cap bit" is
 * known exactly rather than guessed at from a full page - the same trick the
 * pane's member paging plays in reverse.
 */
export const CHART_ROW_CAP = 50_000;

/**
 * One input row, resolved against the mirror: which node it named, and where
 * that node is filed.
 *
 * A superset of `MemberEntry`, deliberately - the member lists this source hands
 * the pane are these very objects, so `dirId` is the only field that is this
 * file's rather than the pane's.
 */
export interface ChartMemberRow extends MemberEntry {
  readonly dirId: number;
}

/**
 * The input rows arranged the two ways the pane asks for them.
 *
 * `counts` is what `FilteredTree` is built from and is therefore what decides
 * the shape of the whole tree; `members` is what a directory row expands into.
 * Both are derived in one pass by {@link indexChartRows}, which is pure and is
 * where the interesting part of this file is tested.
 */
export interface ChartRowIndex {
  /** Per kind, how many input rows each directory holds directly. */
  readonly counts: Readonly<Record<NodeKind, ReadonlyMap<number, number>>>;
  /**
   * Per directory, the input rows filed there - rules before deps and then by
   * label, which is the order {@link DirExplorerSource.dirMembers} pages
   * through.
   */
  readonly members: ReadonlyMap<number, readonly ChartMemberRow[]>;
}

/**
 * Where a source's one query has got to, for the chart to render around the
 * pane.
 *
 * A discriminated union rather than a bag of optional fields because the chart
 * switches on it exhaustively: each phase is a different thing to show, and
 * "no rows matched" has to be distinguishable from "not asked yet".
 */
export type ChartSourceState =
  | {readonly phase: 'idle'}
  | {readonly phase: 'loading'}
  | {
      readonly phase: 'ready';
      /** Distinct nodes the query's rows named. */
      readonly rowCount: number;
      /** Whether {@link CHART_ROW_CAP} bit, i.e. rows were dropped. */
      readonly truncated: boolean;
    }
  | {readonly phase: 'error'; readonly message: string};

// Everything one load produced, held for as long as the source lives.
interface LoadedRows {
  readonly dirs: readonly DirEntry[];
  readonly index: ChartRowIndex;
  // Child directory ids by parent id, over the *whole* mirror hierarchy - what
  // a narrow-to-this-directory click walks. Built here rather than taken off
  // `FilteredTree`, which keeps its own copy private and holds the filtered
  // shape rather than the real one.
  readonly childIds: ReadonlyMap<number, readonly number[]>;
}

/**
 * Arranges input rows into the per-directory channels the pane reads.
 *
 * Pure, and separated from the query for the usual reason: this is the part
 * where a mistake would be silent. A count keyed on the wrong thing draws the
 * wrong tree, and a member list in the wrong order makes "show more" hand back
 * pages of an unordered result - neither of which the SQL would notice.
 *
 * @param rows The input rows, already de-duplicated by node.
 */
export function indexChartRows(rows: readonly ChartMemberRow[]): ChartRowIndex {
  const members = new Map<number, ChartMemberRow[]>();
  const counts: Record<NodeKind, Map<number, number>> = {
    rule: new Map(),
    dep: new Map(),
  };
  for (const row of rows) {
    const list = members.get(row.dirId);
    if (list === undefined) members.set(row.dirId, [row]);
    else list.push(row);
    const byKind = counts[row.kind];
    byKind.set(row.dirId, (byKind.get(row.dirId) ?? 0) + 1);
  }
  // Rules before deps and then by label - the order `dirMembers` promises, and
  // the same one its SQL twin gets from `ORDER BY n.kind DESC, n.label`. Sorted
  // once here rather than per page, since every page is a slice of this.
  for (const list of members.values()) {
    list.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'rule' ? -1 : 1;
      return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
    });
  }
  return {counts, members};
}

/**
 * The Explorer pane's source over a Data Explorer chart's input rows.
 *
 * Built once per mount by the chart's loader and thrown away with it (see
 * `ChartLoaderEntry.custom`), because the pane treats a new source object as new
 * data and drops every cache it holds: one per render would collapse the tree
 * every frame.
 *
 * The load is lazy and happens at most once per mirror version. A graph reload
 * renumbers every node and rebuilds `dune_dir`, which invalidates both halves of
 * what is held here - the rows' `dir_id`s and the hierarchy they index into - so
 * `version` follows `mirrorVersion` exactly as the SQL source's does, and
 * the next read re-runs the query.
 */
export class ChartDirExplorerSource implements DirExplorerSource {
  readonly rowDriven = true;

  private stateValue: ChartSourceState = {phase: 'idle'};
  private loadPromise?: Promise<LoadedRows>;
  private loadedVersion?: number;
  private loaded?: LoadedRows;
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

  /** Where the one query has got to. Cheap; read every render. */
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

  /** Frees the rows. Called through `ChartLoaderEntry.custom`. */
  dispose(): void {
    this.disposed = true;
    this.loadPromise = undefined;
    this.loaded = undefined;
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
      if (loaded.index.members.has(at)) out.push(at);
      const children = loaded.childIds.get(at);
      if (children !== undefined) stack.push(...children);
    }
    return out;
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
   * Every directory, since a rule's path test cannot narrow anything here.
   *
   * The pane only asks this while applying a path filter, and a row-driven
   * source offers no filter UI at all (see `rowDriven`), so this is reached only
   * if that ever changes. Returning "all of them" keeps the rule arm neutral,
   * which is the same thing an absent path filter means.
   */
  async matchingRuleDirs(_path: PathFilter): Promise<ReadonlySet<number>> {
    return new Set((await this.load()).dirs.map((d) => d.id));
  }

  /**
   * How many input rows of `kind` each directory holds - the count channel
   * that is this chart's filter.
   *
   * Never undefined, unlike the SQL source's. Undefined means "every member of
   * this kind matches", which sends `FilteredTree` to the stored `n_rules` /
   * `n_deps` and draws the whole mirror's tree - the exact bug this chart exists
   * to not have. A directory absent from the map holds no selected rows and so
   * gets no row at all.
   *
   * `filter` is ignored, and can only be the empty one: the pane hides its
   * filter UI for a row-driven source, so nothing can put anything in it.
   */
  async matchingCounts(
    kind: NodeKind,
    _filter: MemberFilter,
  ): Promise<ReadonlyMap<number, number>> {
    return (await this.load()).index.counts[kind];
  }

  /**
   * One page of `id`'s members, sliced out of the input rows filed there.
   *
   * A slice rather than a query: the rows are already in hand, and a `dir_id`
   * probe of `dune_node` would return the directory's *whole* membership rather
   * than the part the query selected. Short page ends the list, as promised -
   * which falls out of the slice.
   */
  async dirMembers(
    id: number,
    kind: NodeKind | undefined,
    limit: number,
    offset: number,
  ): Promise<readonly MemberEntry[]> {
    const rows = await this.membersOf(id, kind);
    return rows.slice(offset, offset + limit);
  }

  /** Every member of `id` of the given kinds, as node ids - the bulk actions. */
  async dirMemberIds(
    id: number,
    kinds: readonly NodeKind[],
  ): Promise<readonly number[]> {
    const rows = await this.membersOf(id, undefined);
    return rows.filter((r) => kinds.includes(r.kind)).map((r) => r.nodeId);
  }

  private async membersOf(
    id: number,
    kind: NodeKind | undefined,
  ): Promise<readonly ChartMemberRow[]> {
    const rows = (await this.load()).index.members.get(id) ?? [];
    return kind === undefined ? rows : rows.filter((r) => r.kind === kind);
  }

  /**
   * The rows and the hierarchy, fetched at most once per mirror version.
   *
   * The version check is what makes a graph reload land: the pane drops its
   * caches when `version` moves and asks again, and this notices that what
   * it holds was read out of a mirror that no longer exists.
   */
  private load(): Promise<LoadedRows> {
    const version = this.controller.mirrorVersion;
    if (this.loadPromise === undefined || this.loadedVersion !== version) {
      this.loadedVersion = version;
      this.stateValue = {phase: 'loading'};
      this.loadPromise = this.fetch();
    }
    return this.loadPromise;
  }

  private async fetch(): Promise<LoadedRows> {
    try {
      // Two queries, both of them whole-tier reads rather than per-row work:
      // the mirror's hierarchy, and the chart's own input. Issued together
      // because neither needs the other's answer.
      const [dirs, rows] = await Promise.all([
        allDirs(this.engine),
        this.fetchRows(),
      ]);
      const loaded: LoadedRows = {
        dirs,
        index: indexChartRows(rows.rows),
        childIds: childIndex(dirs),
      };
      if (!this.disposed) {
        this.loaded = loaded;
        this.stateValue = {
          phase: 'ready',
          rowCount: rows.rows.length,
          truncated: rows.truncated,
        };
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
   * The chart's input rows, mapped onto graph nodes.
   *
   * One query, and the whole of what this chart reads of its input. The join is
   * driven from the (small) input side into `dune_node`'s primary key, so the
   * cost is one probe per input row rather than a scan.
   *
   * De-duplication is client-side rather than a `SELECT DISTINCT`: an input
   * naming the same node twice is normal (an edge query has a `src` per edge,
   * not per node), and `DISTINCT` would sort the whole join to find that out,
   * whereas a `Set` of node ids costs nothing on rows that are being read
   * anyway. It does mean the cap counts rows rather than nodes, which is the
   * honest reading of "the query returned more than we will hold".
   */
  private async fetchRows(): Promise<{
    rows: ChartMemberRow[];
    truncated: boolean;
  }> {
    const result = await this.engine.query(`
      SELECT
        n.dir_id AS dir_id,
        n.node_id AS node_id,
        n.kind AS kind,
        n.label AS label
      FROM dune_node n
      JOIN (${this.query}) q ON q.${quoteIdent(this.nodeColumn)} = n.node_id
      LIMIT ${CHART_ROW_CAP + 1}
    `);
    const rows: ChartMemberRow[] = [];
    const seen = new Set<number>();
    let read = 0;
    const it = result.iter({
      dir_id: NUM,
      node_id: NUM,
      kind: STR,
      label: STR,
    });
    for (; it.valid(); it.next()) {
      // The row past the cap is asked for only to be counted: it is what says
      // the cap bit, and it is not kept.
      read++;
      if (read > CHART_ROW_CAP) break;
      if (seen.has(it.node_id)) continue;
      seen.add(it.node_id);
      rows.push({
        dirId: it.dir_id,
        nodeId: it.node_id,
        kind: it.kind as NodeKind,
        label: it.label,
      });
    }
    return {rows, truncated: read > CHART_ROW_CAP};
  }
}

// What `rootDirs` / `childDirs` say when a row-driven source is asked to be
// descended. Spelt out rather than left as a bare throw: if this ever surfaces
// it means the pane took its lazy path against a source that has no levels to
// give, which is a wiring mistake and not something a user did.
const NOT_DESCENDED =
  "The Dune directory chart draws its tree from its query's rows, so it has " +
  'no directory levels to descend. This is a bug: the pane should be in its ' +
  'filtered mode for a row-driven source.';

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

/**
 * A column name as a SQL identifier.
 *
 * The name comes from a chart's config, which is persisted in dashboards and
 * typed by a user, so it is not something to interpolate raw. Note that this
 * is identifier quoting, and has nothing to do with `sqlValue`'s string-literal
 * quoting - conflating the two is a bug in both directions.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
