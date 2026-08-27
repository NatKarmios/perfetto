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
 * The Dune explorer side panel: the build's *directory* hierarchy, descended a
 * level at a time.
 *
 * The other two views of the graph both start from a node - the selection panel
 * from whatever is selected on the timeline, the query tab from a query. This
 * one starts from the build's shape, which is the thing you want when you don't
 * yet know which node you're looking for. It reads `dune_dir` and `dune_node`
 * out of the SQL mirror (see dir_explorer.ts for the queries) rather than the
 * in-memory graph, because the mirror is where the directory hierarchy exists
 * at all: `BuildGraph` knows each node's directory *string*, and the tree over
 * those strings is interned during the node-tier build and then discarded.
 *
 * ## Why this owns its tree state rather than using `LazyTreeNode`
 *
 * `widgets/tree.ts`'s `LazyTreeNode` is very nearly this component: collapsed to
 * start, `fetchData()` on first expand, children cached thereafter. What it
 * can't do is be *invalidated*. The kind toggles change how much a directory has
 * to show, and therefore whether its members are listed inline or bucketed by
 * kind - a directory with 5 rules and 4,000 deps is bucketed with both kinds
 * visible and inline with deps hidden - so a toggle has to be able to reach into
 * an already-expanded directory and re-decide that. `LazyTreeNode` keeps its
 * children in a private field with no way in, and forcing the issue with a
 * mithril `key` would destroy the component, which would collapse every
 * directory in the tree on every toggle.
 *
 * So the state lives here: which rows are expanded, which fetches have
 * completed, and which pages of a bucket have been read. That has a second
 * payoff - the caches are keyed by directory rather than by component, so
 * expansion state and loaded rows both survive a toggle, and toggling a kind
 * `off` never needs a query at all.
 *
 * ## What it costs
 *
 * Expanding a directory is two index probes at most (its child directories, and
 * one page of its members if they are to be listed inline); expanding a bucket
 * is one. Nothing here is recursive and nothing scans - see dir_explorer.ts.
 * Toggling a kind on can need a fetch for directories that are already expanded
 * and now cross the inline threshold, and those are issued lazily by the render
 * that needs them rather than all at once by the toggle.
 */

import m from 'mithril';
import {Button} from '../../widgets/button';
import {Callout} from '../../widgets/callout';
import {EmptyState} from '../../widgets/empty_state';
import {Icon} from '../../widgets/icon';
import {Intent} from '../../widgets/common';
import {Spinner} from '../../widgets/spinner';
import type {Trace} from '../../public/trace';
import type {DuneGraphController} from './controller';
import type {DirEntry, MemberEntry} from './dir_explorer';
import {
  INLINE_MEMBER_LIMIT,
  MEMBER_PAGE,
  childDirs,
  dirMemberIds,
  dirMembers,
  rootDirs,
} from './dir_explorer';
import type {NodeKind} from './graph';
import {plural} from './graph';
import {formatDurNs} from './node_display';
import {renderNodeCell, renderNodeCellActions} from './node_cell';
import {bulkNodeActions} from './node_tree_actions';

/**
 * How a directory with no path renders. `dune_dir` files anything dune reported
 * at the top level under the empty prefix (see dir_tree.ts), and a blank row
 * reads as a bug. Same label the Data Explorer hand-off uses for the same row -
 * kept in step by eye rather than shared, since that one has to be inlined into
 * generated SQL (see dir_tree_graph.ts).
 */
const TOP_LEVEL_LABEL = '(top level)';

/** The two kinds, in the order the pane lists them. */
const KINDS: readonly NodeKind[] = ['rule', 'dep'];

// Plural nouns for the kind toggles and bucket headers. `dep` is spelt out
// here: "Deps (8,431)" is a header, not a column name.
const KIND_LABEL: Record<NodeKind, string> = {
  rule: 'Rules',
  dep: 'Dependencies',
};

interface DirExplorerPanelAttrs {
  readonly controller: DuneGraphController;
  // For `trace.engine`. Everything else comes through the controller, but the
  // queries here are the pane's own rather than the mirror's, so they are issued
  // directly the way query_tab.ts issues its own.
  readonly trace: Trace;
}

// One directory's child directories, once asked for.
interface ChildState {
  dirs?: DirEntry[];
  loading: boolean;
  error?: string;
}

// The pages of one (directory, kind-filter) member list read so far.
interface MemberState {
  rows: MemberEntry[];
  // No further page to ask for: the last read came back short, so the list is
  // complete and "show more" is not offered.
  atEnd: boolean;
  loading: boolean;
  error?: string;
}

/**
 * Root of the Dune explorer side panel.
 *
 * State is per-component-instance and so lives as long as the side panel tab's
 * vnode does. That is the right lifetime: it is all derived from the mirror and
 * cheap to rebuild, and a graph *reload* replaces the mirror underneath it -
 * which `view` notices through `controller.mirrorVersion` and clears.
 */
export class DirExplorerPanel
  implements m.ClassComponent<DirExplorerPanelAttrs>
{
  // Which kinds of member are shown. Pane-local rather than
  // `controller.hideRules`: that flag also empties the timeline's rule and
  // rule-action tracks (see graph_track.ts), so filtering this tree through it
  // would silently blank two tracks - and there is no `hideDeps` counterpart to
  // pair with it anyway.
  private readonly show: Record<NodeKind, boolean> = {rule: true, dep: true};

  // Expanded rows, by `rowKey`. Absent = collapsed, which is the initial state
  // for every row including the roots' children.
  private readonly expanded = new Set<string>();

  private readonly children = new Map<number, ChildState>();
  // Keyed by `memberKey`: a directory plus which kinds are being asked for.
  private readonly members = new Map<string, MemberState>();

  private roots?: DirEntry[];
  private rootsLoading = false;
  private rootsError?: string;

  // The mirror the caches above were read out of. A reload renumbers every node
  // and rebuilds `dune_dir` from scratch, so everything held here is stale.
  // `mirrorVersion` rather than `graphVersion`: the latter moves on every ＋/－
  // click, which would collapse the whole tree every time a node was added.
  private cachedVersion?: number;

  view({attrs}: m.CVnode<DirExplorerPanelAttrs>): m.Children {
    const {controller} = attrs;
    if (controller.mirrorVersion !== this.cachedVersion) {
      this.cachedVersion = controller.mirrorVersion;
      this.reset();
    }
    return m(
      '.pf-dune-graph.pf-dune-explorer',
      this.renderToolbar(attrs),
      m('.pf-dune-explorer__body', this.renderBody(attrs)),
    );
  }

  private reset(): void {
    this.children.clear();
    this.members.clear();
    this.expanded.clear();
    this.roots = undefined;
    this.rootsLoading = false;
    this.rootsError = undefined;
  }

  // The kind toggles. Both can be off at once - the pane then degenerates to a
  // plain directory tree, which is a legitimate way to look at a build's shape
  // and is why `visibleSubtree` special-cases it rather than blanking the pane.
  private renderToolbar(attrs: DirExplorerPanelAttrs): m.Children {
    if (!attrs.controller.nodeMirrorReady) return undefined;
    return m(
      '.pf-dune-graph__toolbar',
      m(
        '.pf-dune-graph__toolbar-buttons',
        KINDS.map((kind) =>
          m(Button, {
            label: KIND_LABEL[kind],
            icon: this.show[kind] ? 'visibility' : 'visibility_off',
            active: this.show[kind],
            title: this.show[kind]
              ? `Hide ${KIND_LABEL[kind].toLowerCase()}`
              : `Show ${KIND_LABEL[kind].toLowerCase()}`,
            onclick: () => {
              this.show[kind] = !this.show[kind];
            },
          }),
        ),
        m(Button, {
          label: 'Collapse all',
          icon: 'unfold_less',
          title: 'Collapse every directory',
          disabled: this.expanded.size === 0,
          onclick: () => this.expanded.clear(),
        }),
      ),
    );
  }

  private renderBody(attrs: DirExplorerPanelAttrs): m.Children {
    const {controller} = attrs;
    // `dune_dir` is built as part of the node tier, so there is nothing to show
    // until that is up. The offer to load it is the same one panel.ts makes,
    // repeated here so this tab is usable on its own rather than sending the
    // user to the other one first.
    if (!controller.nodeMirrorReady) {
      return m(
        EmptyState,
        {icon: 'account_tree', title: 'Directory tree not loaded'},
        m(
          '.pf-dune-graph__load-note',
          "The build's directories come from the graph's node tables, which " +
            'have not been built for this trace yet.',
        ),
        m(Button, {
          label: 'Load graph',
          icon: 'play_arrow',
          intent: Intent.Primary,
          disabled: controller.busy,
          onclick: () => void controller.load(),
        }),
      );
    }
    if (this.rootsError !== undefined) {
      return m(Callout, {icon: 'error'}, this.rootsError);
    }
    const roots = this.roots;
    if (roots === undefined) {
      this.loadRoots(attrs);
      return this.spinnerRow('Reading directories…');
    }
    const visible = roots.filter((d) => this.visibleSubtree(d));
    if (visible.length === 0) {
      return m(
        EmptyState,
        {icon: 'filter_alt', title: 'Nothing to show'},
        m(
          '.pf-dune-graph__load-note',
          'No directory holds anything of the kinds currently shown.',
        ),
      );
    }
    return m(
      '.pf-dune-tree',
      visible.map((dir) => this.renderDir(attrs, dir, '')),
    );
  }

  /**
   * Whether a directory is worth a row at all.
   *
   * With a kind hidden, a directory whose whole subtree holds only that kind has
   * nothing to show, and drawing it makes the tree scaffolding you have to click
   * through to find out there is nothing there. On a real trace this is most of
   * the tree: hiding dependencies otherwise leaves all of `/usr` and the opam
   * switch standing as empty directories.
   *
   * The exception is both kinds hidden, where every directory is empty by this
   * test and the whole pane would blank. That state is a plain directory tree
   * instead - see `renderToolbar`.
   */
  private visibleSubtree(dir: DirEntry): boolean {
    if (!this.show.rule && !this.show.dep) return true;
    return (
      (this.show.rule && dir.tRules > 0) || (this.show.dep && dir.tDeps > 0)
    );
  }

  // The kinds currently shown that this directory directly holds any of.
  private memberKinds(dir: DirEntry): NodeKind[] {
    return KINDS.filter(
      (k) => this.show[k] && (k === 'rule' ? dir.nRules : dir.nDeps) > 0,
    );
  }

  // How many of this directory's direct members are currently shown.
  private visibleMemberCount(dir: DirEntry): number {
    return (
      (this.show.rule ? dir.nRules : 0) + (this.show.dep ? dir.nDeps : 0)
    );
  }

  /**
   * One directory row.
   *
   * `parentPath` is the path of the row this one sits under, and is what the
   * label is measured against - a compressed row is several directories deep
   * (see dir_explorer.ts), so its `name` is only its last segment and showing
   * that would claim a hierarchy the tree isn't drawing. `''` for a root, whose
   * whole path is its label.
   */
  private renderDir(
    attrs: DirExplorerPanelAttrs,
    dir: DirEntry,
    parentPath: string,
  ): m.Children {
    const key = `dir:${dir.id}`;
    const open = this.expanded.has(key);
    const kinds = this.memberKinds(dir);
    const memberCount = this.visibleMemberCount(dir);
    return m(
      '.pf-dune-tree__group',
      m(
        '.pf-dune-tree__group-header',
        {onclick: () => this.toggle(key)},
        m(Icon, {
          icon: open ? 'expand_more' : 'chevron_right',
          className: 'pf-dune-tree__group-caret',
        }),
        m('span.pf-dune-explorer__dir-name', dirLabel(dir, parentPath)),
        m(
          'span.pf-dune-tree__group-count',
          this.renderCounts(dir, open),
        ),
        this.renderBulk(
          attrs,
          dir,
          kinds,
          memberCount,
        ),
      ),
      open &&
        m(
          '.pf-dune-tree__children',
          this.renderChildren(attrs, dir),
          this.renderMembers(attrs, dir, kinds, memberCount),
        ),
    );
  }

  /**
   * The ＋all / －all pair for a directory row or a bucket row, over the given
   * kinds.
   *
   * The node ids are fetched by the click rather than held: this tree is lazy,
   * and a row generally knows only its member *count* (off `dune_dir`) when it
   * is drawn - which is all a label needs. See `bulkNodeActions`.
   *
   * Omitted entirely, box and all, when there is nothing to act on: the box is
   * a padded flex container, so an empty one is visible as a gap.
   */
  private renderBulk(
    attrs: DirExplorerPanelAttrs,
    dir: DirEntry,
    kinds: readonly NodeKind[],
    count: number,
  ): m.Children {
    if (count === 0) return undefined;
    const where = dir.path === '' ? TOP_LEVEL_LABEL : dir.path;
    return m(
      'span.pf-dune-tree__group-actions',
      // The buttons are not part of the row's collapse toggle.
      {onclick: (e: Event) => e.stopPropagation()},
      bulkNodeActions(
        attrs.controller,
        count,
        () => dirMemberIds(attrs.trace.engine, dir.id, kinds),
        `directly in ${where}`,
      ),
    );
  }

  /**
   * A directory row's numbers: its subtree's while collapsed, its own once
   * open.
   *
   * Collapsed, the subtree total is the only honest summary - it is what is
   * hidden behind the caret. Open, the subtree total would be double-counting
   * what the children now show for themselves, so it becomes the direct counts,
   * which are what the rows immediately below add up to.
   */
  private renderCounts(dir: DirEntry, open: boolean): m.Children {
    const rules = open ? dir.nRules : dir.tRules;
    const deps = open ? dir.nDeps : dir.tDeps;
    const failed = open ? dir.nFailed : dir.tFailed;
    const parts: m.Children[] = [];
    if (this.show.rule && rules > 0) parts.push(`${plural(rules, 'rule')}`);
    if (this.show.dep && deps > 0) parts.push(`${plural(deps, 'dep')}`);
    if (this.show.rule && failed > 0) {
      parts.push(
        m('span.pf-dune-explorer__failed', `${failed} failed`),
      );
    }
    // Timing is rule spans only (see sql_graph.ts), so it belongs to the rules
    // and goes when they do.
    if (!open && this.show.rule && dir.totalDurNs > 0n) {
      parts.push(formatDurNs(Number(dir.totalDurNs)));
    }
    if (parts.length === 0) return undefined;
    // Interleaved rather than joined, since a part may be a vnode.
    return parts.flatMap((p, i) => (i === 0 ? [p] : [' · ', p]));
  }

  private renderChildren(
    attrs: DirExplorerPanelAttrs,
    dir: DirEntry,
  ): m.Children {
    const state = this.children.get(dir.id);
    if (state === undefined) {
      this.loadChildren(attrs, dir.id);
      return this.spinnerRow('Reading…');
    }
    if (state.error !== undefined) {
      return m(Callout, {icon: 'error'}, state.error);
    }
    if (state.dirs === undefined) return this.spinnerRow('Reading…');
    return state.dirs
      .filter((child) => this.visibleSubtree(child))
      .map((child) => this.renderDir(attrs, child, dir.path));
  }

  /**
   * A directory's own members: listed inline while there are few enough of
   * them, and behind a per-kind bucket otherwise.
   *
   * The threshold is on the *visible* count, so hiding dependencies genuinely
   * un-buckets a directory that only had too many because of them - which is
   * the point of the toggle. That is also the one case where toggling a kind on
   * costs a query: the inline list is a different member query from either
   * bucket's, and it is issued by the render that finds it missing.
   */
  private renderMembers(
    attrs: DirExplorerPanelAttrs,
    dir: DirEntry,
    kinds: readonly NodeKind[],
    memberCount: number,
  ): m.Children {
    if (kinds.length === 0) return undefined;
    if (memberCount <= INLINE_MEMBER_LIMIT) {
      return this.renderMemberList(attrs, dir, kinds, false);
    }
    return kinds.map((kind) => this.renderBucket(attrs, dir, kind));
  }

  private renderBucket(
    attrs: DirExplorerPanelAttrs,
    dir: DirEntry,
    kind: NodeKind,
  ): m.Children {
    const key = `bucket:${dir.id}:${kind}`;
    const open = this.expanded.has(key);
    const count = kind === 'rule' ? dir.nRules : dir.nDeps;
    return m(
      '.pf-dune-tree__group.pf-dune-explorer__bucket',
      m(
        '.pf-dune-tree__group-header',
        {onclick: () => this.toggle(key)},
        m(Icon, {
          icon: open ? 'expand_more' : 'chevron_right',
          className: 'pf-dune-tree__group-caret',
        }),
        `${KIND_LABEL[kind]} (${count.toLocaleString()})`,
        this.renderBulk(attrs, dir, [kind], count),
      ),
      open &&
        m(
          '.pf-dune-tree__children',
          this.renderMemberList(attrs, dir, [kind], true),
        ),
    );
  }

  /**
   * The member rows for one (directory, kinds) list, plus its "show more".
   *
   * `paged` says whether to offer further pages: an inline list is under the
   * threshold and so fits in the first page by construction, whereas a bucket's
   * does not, and its remainder is what "show more" reads.
   */
  private renderMemberList(
    attrs: DirExplorerPanelAttrs,
    dir: DirEntry,
    kinds: readonly NodeKind[],
    paged: boolean,
  ): m.Children {
    const key = memberKey(dir.id, kinds);
    let state = this.members.get(key);
    if (state === undefined) {
      // Serve from a superset already in hand rather than querying again: with
      // both kinds loaded, one kind's list is a filter of it. This is what makes
      // hiding a kind free in the common case.
      const filtered = this.filterFromLoaded(dir, kinds);
      if (filtered !== undefined) {
        state = filtered;
      } else {
        this.loadMembers(attrs, dir.id, kinds, 0);
        return this.spinnerRow('Reading…');
      }
    }
    if (state.error !== undefined) {
      return m(Callout, {icon: 'error'}, state.error);
    }
    const rows = state.rows.map((entry) =>
      this.renderMember(attrs, entry, dir.path),
    );
    if (state.loading) rows.push(this.spinnerRow('Reading…'));
    if (paged && !state.atEnd && !state.loading) {
      const total = kinds.reduce(
        (n, k) => n + (k === 'rule' ? dir.nRules : dir.nDeps),
        0,
      );
      const remaining = Math.max(0, total - state.rows.length);
      rows.push(
        m(
          '.pf-dune-explorer__more',
          m(Button, {
            label: `Show ${Math.min(remaining, MEMBER_PAGE).toLocaleString()} more of ${remaining.toLocaleString()}`,
            icon: 'expand_more',
            onclick: () =>
              this.loadMembers(attrs, dir.id, kinds, state.rows.length),
          }),
        ),
      );
    }
    return rows;
  }

  /**
   * A member row: the same chip every other DataGrid and the query tab draw for
   * a node id - kind chip, build/code icon, link to the slice - and the ＋/－
   * toggle.
   *
   * The one thing this pane does differently is drop the directory from a dep's
   * path: the row sits under a heading that already says `_build/default/lib`,
   * so repeating it on every row is noise that pushes the part you are actually
   * reading off the edge of a narrow panel. The full path stays on hover, since
   * an abbreviated row you can't expand has lost information.
   *
   * Clicking the link moves the timeline selection, which is what brings the
   * main Dune panel forward - the controller watches the selected node rather
   * than this pane hooking the click, so every route to a node behaves the same
   * (see `revealPanelWhenNodeSelected`).
   */
  private renderMember(
    attrs: DirExplorerPanelAttrs,
    entry: MemberEntry,
    dirPath: string,
  ): m.Children {
    const {controller} = attrs;
    const stripped = strippedDepLabel(entry, dirPath);
    return m(
      '.pf-dune-explorer__member',
      renderNodeCell(
        controller,
        entry.nodeId,
        stripped === undefined ? {} : {label: stripped, title: entry.label},
      ),
      m(
        'span.pf-dune-explorer__member-actions',
        renderNodeCellActions(controller, entry.nodeId),
      ),
    );
  }

  /**
   * A single-kind list derived from an already-loaded both-kinds list, or
   * undefined if there isn't one to derive it from.
   *
   * Only valid off a *complete* both-kinds list: a truncated one is the first
   * page of the two kinds interleaved, so filtering it would silently drop the
   * members past the cut. In practice the both-kinds list only exists for
   * directories under the inline threshold, where it is always complete.
   */
  private filterFromLoaded(
    dir: DirEntry,
    kinds: readonly NodeKind[],
  ): MemberState | undefined {
    if (kinds.length !== 1) return undefined;
    const all = this.members.get(memberKey(dir.id, KINDS));
    if (all === undefined || !all.atEnd || all.loading) return undefined;
    return {
      rows: all.rows.filter((r) => r.kind === kinds[0]),
      atEnd: true,
      loading: false,
    };
  }

  /**
   * Expand or collapse a row.
   *
   * Collapsing also discards any *failed* fetch under that row, which is what
   * makes expanding it again a retry. Successful fetches are kept: they are the
   * cache, and re-expanding a directory should be free.
   */
  private toggle(key: string): void {
    if (!this.expanded.has(key)) {
      this.expanded.add(key);
      return;
    }
    this.expanded.delete(key);
    const dirId = Number(key.slice(key.indexOf(':') + 1).split(':')[0]);
    if (this.children.get(dirId)?.error !== undefined) {
      this.children.delete(dirId);
    }
    for (const [memberId, state] of [...this.members]) {
      if (state.error !== undefined && memberId.startsWith(`${dirId}:`)) {
        this.members.delete(memberId);
      }
    }
  }

  private spinnerRow(label: string): m.Children {
    return m(
      '.pf-dune-graph__status.pf-dune-explorer__loading',
      m(Spinner),
      m('span', label),
    );
  }

  // ---------------------------------------------------------------------
  // Fetches. Each is fire-and-forget and marks its own slot busy first, so the
  // render that triggered it doesn't trigger it again next frame; each asks for
  // a redraw when it lands, since a promise resolving between frames doesn't
  // paint one (see controller.requestRedraw).
  // ---------------------------------------------------------------------

  private loadRoots(attrs: DirExplorerPanelAttrs): void {
    if (this.rootsLoading) return;
    this.rootsLoading = true;
    void rootDirs(attrs.trace.engine)
      .then((dirs) => {
        this.roots = dirs;
      })
      .catch((e) => {
        this.rootsError = `Could not read dune_dir: ${errorText(e)}`;
      })
      .finally(() => {
        this.rootsLoading = false;
        attrs.controller.requestRedraw();
      });
  }

  private loadChildren(attrs: DirExplorerPanelAttrs, id: number): void {
    const existing = this.children.get(id);
    if (existing?.loading === true) return;
    const state: ChildState = {loading: true};
    this.children.set(id, state);
    void childDirs(attrs.trace.engine, id)
      .then((dirs) => {
        state.dirs = dirs;
      })
      .catch((e) => {
        state.error = `Could not read subdirectories: ${errorText(e)}`;
      })
      .finally(() => {
        state.loading = false;
        attrs.controller.requestRedraw();
      });
  }

  private loadMembers(
    attrs: DirExplorerPanelAttrs,
    id: number,
    kinds: readonly NodeKind[],
    offset: number,
  ): void {
    const key = memberKey(id, kinds);
    const state: MemberState = this.members.get(key) ?? {
      rows: [],
      atEnd: false,
      loading: false,
    };
    if (state.loading) return;
    state.loading = true;
    this.members.set(key, state);
    // Both kinds wanted means no kind filter at all, which is one query rather
    // than two and is what `dirMembers` takes `undefined` for.
    const kind = kinds.length === 1 ? kinds[0] : undefined;
    void dirMembers(attrs.trace.engine, id, kind, MEMBER_PAGE, offset)
      .then((rows) => {
        state.rows = offset === 0 ? rows : [...state.rows, ...rows];
        // A short page is the last page. Asking for the count separately would
        // be a second query to learn what the row count already says.
        state.atEnd = rows.length < MEMBER_PAGE;
      })
      .catch((e) => {
        state.error = `Could not read directory contents: ${errorText(e)}`;
      })
      .finally(() => {
        state.loading = false;
        attrs.controller.requestRedraw();
      });
  }
}

/**
 * What a directory row is called: its path relative to the row above it.
 *
 * For an uncompressed row that is just its own name; for a compressed one it is
 * the whole run that was collapsed (`default/lib`), which is the only label that
 * describes where clicking it goes. The trailing `/` marks it as a directory,
 * matching `PathTreeView`'s group headers.
 *
 * The parent's path is a prefix of the child's, and the separator between them is
 * a single character (`/` or `@` - see dir_tree.ts), so the suffix is a slice.
 * The top-level directory (the empty path) is the one row with no name at all,
 * and it is never a parent - a tree of absolute and relative paths simply has
 * several roots - so it only ever appears as its own label.
 *
 * Exported for its unit test: the slice is the sort of arithmetic that is right
 * or off by one, and being off by one here silently eats the first character of
 * every nested directory's name.
 */
export function dirLabel(
  dir: Pick<DirEntry, 'path'>,
  parentPath: string,
): string {
  if (dir.path === '') return TOP_LEVEL_LABEL;
  const suffix =
    parentPath === '' ? dir.path : dir.path.slice(parentPath.length + 1);
  return `${suffix}/`;
}

/**
 * A dep's path with its containing directory dropped, or undefined when there is
 * nothing to drop.
 *
 * Undefined rather than the unchanged label, so the caller can tell "abbreviated,
 * put the full path on hover" from "already as short as it gets" and not attach a
 * tooltip that just repeats the row.
 *
 * Only deps: a rule's label is its bare dune id, which contains no path at all -
 * its directory is a *property* of the rule rather than a prefix of its name, so
 * there is nothing here to strip.
 *
 * The separator is checked rather than assumed. The directory came from
 * `parentDir` over this very path (see dir_tree.ts), so the prefix does match in
 * practice - but a silent `slice()` past a non-separator would chop a real
 * character off the name, and a wrong label on a build artefact is worse than an
 * unabbreviated one. Both separators (`/` and `@`) are one character, which is
 * what makes this a slice at all.
 */
export function strippedDepLabel(
  entry: Pick<MemberEntry, 'kind' | 'label'>,
  dirPath: string,
): string | undefined {
  if (entry.kind !== 'dep') return undefined;
  // The top level, whose members' paths have no directory part to begin with.
  if (dirPath === '') return undefined;
  const {label} = entry;
  if (!label.startsWith(dirPath)) return undefined;
  const sep = label[dirPath.length];
  if (sep !== '/' && sep !== '@') return undefined;
  const rest = label.slice(dirPath.length + 1);
  // An `@alias` marker is part of the name rather than hierarchy, the same rule
  // dir_tree.ts's `segName` and path_tree.ts's leaves follow.
  const stripped = sep === '@' ? `@${rest}` : rest;
  return stripped === '' ? undefined : stripped;
}

// The cache key for one member list: a directory plus which kinds it holds.
// Both kinds is its own key rather than the union of the two single-kind ones,
// because it is a different query (and a differently paged one).
function memberKey(id: number, kinds: readonly NodeKind[]): string {
  return `${id}:${[...kinds].sort().join('+')}`;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
