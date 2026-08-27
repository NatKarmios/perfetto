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
import type {MemberFilter} from './dir_explorer';
import {
  INLINE_MEMBER_LIMIT,
  MEMBER_PAGE,
  allDirs,
  childDirs,
  compileFilter,
  dirMemberIds,
  dirMembers,
  filterActive,
  fingerprint,
  matchingCounts,
  matchingRuleDirs,
  rootDirs,
} from './dir_explorer';
import {FilteredTree} from './dir_filter';
import {TextInput} from '../../widgets/text_input';
import {MenuDivider, MenuItem, PopupMenu} from '../../widgets/menu';
import {DEP_RESOLUTIONS, DEP_STATUSES, RULE_OUTCOMES} from './graph';
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

/**
 * How many directories a filter may auto-expand before the tree is left
 * collapsed instead.
 *
 * A filter that narrows to a handful of places should show them without further
 * clicking; one that still matches half the build should not dump half the
 * hierarchy on screen. The budget counts *directories to expand* rather than
 * matches, because expanding is per-directory: a pattern hitting 50,000 deps in
 * three directories is worth expanding and one hitting 200 deps across 200
 * directories is not.
 *
 * The value is a guess, not a measurement - it wants trying against a real
 * monorepo trace and moving.
 */
const AUTO_EXPAND_LIMIT = 50;

/**
 * The "at least this long" thresholds offered, in nanoseconds.
 *
 * Presets rather than a number box: the useful question is an order of magnitude
 * ("which of these took more than a moment"), a second input in a narrow side
 * panel is a real cost, and a typed duration needs a unit parser nothing else
 * here wants.
 */
const DURATION_THRESHOLDS: ReadonlyArray<readonly [label: string, ns: bigint]> =
  [
    ['≥ 1ms', 1_000_000n],
    ['≥ 10ms', 10_000_000n],
    ['≥ 100ms', 100_000_000n],
    ['≥ 1s', 1_000_000_000n],
    ['≥ 10s', 10_000_000_000n],
  ];

// What "failed" selects, across both kinds: dune's two real rule failures and a
// dep whose own build failed. A cancelled or unfinished node is not a failure
// (an interrupted or truncated build is not a broken one), matching
// `FAILED_OUTCOME_CODES` in sql_graph.ts.
const FAILED_OUTCOMES = ['failed-deps', 'failed-action'] as const;
const FAILED_STATUSES = ['failed'] as const;

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
export class DirExplorerPanel implements m.ClassComponent<DirExplorerPanelAttrs> {
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

  // The submitted path filter and the tree it produced, or undefined for the
  // unfiltered pane. `draft` is what is in the text box, which only becomes
  // `filter` on Enter: applying it costs a scan of every dep in the build (see
  // `matchingDepCounts`), so it is not something to do per keystroke.
  private draft = '';
  // The submitted filter. Attribute selections (outcome, resolution, …) apply on
  // click; only the path waits for Enter, since only the path costs a scan.
  private filter: MemberFilter = {};
  private tree?: FilteredTree;
  // The directories whose path matched, so a member query can be told whether
  // rules match *here* rather than testing each rule's directory (see
  // `matchingRuleDirs`).
  private ruleDirs?: ReadonlySet<number>;
  private filterLoading = false;
  private filterError?: string;

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
    // The tree is rebuilt from the new mirror; what the user typed survives,
    // since it is their input rather than derived state.
    this.tree = undefined;
    this.ruleDirs = undefined;
    this.filterLoading = false;
    this.filterError = undefined;
    this.roots = undefined;
    this.rootsLoading = false;
    this.rootsError = undefined;
  }

  /**
   * The path filter box and the kind toggles.
   *
   * The kind toggles can both be off at once - the pane then degenerates to a
   * plain directory tree, which is a legitimate way to look at a build's shape
   * and is why `visibleSubtree` special-cases it rather than blanking the pane.
   */
  private renderToolbar(attrs: DirExplorerPanelAttrs): m.Children {
    if (!attrs.controller.nodeMirrorReady) return undefined;
    return m(
      '.pf-dune-graph__toolbar',
      this.renderFilterBar(attrs),
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
        this.renderFilterMenu(attrs),
      ),
    );
  }

  /**
   * The filter input, and the active filter as a dismissible chip.
   *
   * Submitted on Enter only. Applying a filter costs a scan of every dep in the
   * build (see `matchingDepCounts`), which is fine once but is not something to
   * do while someone is still typing - so there is deliberately no debounce and
   * no filter-as-you-type.
   */
  private renderFilterBar(attrs: DirExplorerPanelAttrs): m.Children {
    return m(
      '.pf-dune-explorer__filter',
      m(TextInput, {
        placeholder: 'Filter by path, e.g. lib or _build/**.cmi …',
        title:
          'A plain string matches anywhere in a path, case-insensitively. A ' +
          'string containing * ? or [ is used as a glob. Escape with a ' +
          'backslash to match one of those literally (\\* \\? \\[), and ' +
          '\\\\ for a literal backslash. Press Enter to apply.',
        value: this.draft,
        oninput: (e: Event) => {
          this.draft = (e.target as HTMLInputElement).value;
        },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter') this.applyPath(attrs);
        },
      }),
      this.filterLoading && m(Spinner),
      filterActive(this.filter) &&
        !this.filterLoading &&
        m(
          'span.pf-dune-explorer__filter-chip',
          // Deliberately not the pattern itself: it is in the input box
          // immediately to the left, and repeating it costs the width the count
          // needs in a narrow panel.
          m('span.pf-dune-explorer__filter-count', this.filterSummary()),
          m(Button, {
            icon: 'close',
            compact: true,
            title: this.clearTitle(),
            onclick: () => this.clearFilter(),
          }),
        ),
    );
  }

  // What the chip says about the filter's reach. Exact rather than approximate:
  // the counts come from the same rollup the tree itself is drawn from.
  private filterSummary(): string {
    const tree = this.tree;
    if (tree === undefined) return '';
    return `${tree.matchCount.toLocaleString()} matching`;
  }

  /**
   * Applies whatever is in the box: three queries, then the tree.
   *
   * Auto-expansion is all-or-nothing (see `FilteredTree.autoExpand`). When the
   * filter narrows to few enough places, every ancestor chain is opened so the
   * matches are simply on screen; when it does not, the tree is left as the user
   * had it and the per-directory match counts are what guide the next click.
   */
  /**
   * The attribute filters, as a popup menu.
   *
   * These apply on click rather than waiting for Enter: unlike the path, none of
   * them touches an unindexed text column, so the queries behind them are a
   * primary-key join onto columns the mirror already stores.
   *
   * A kind whose attributes nothing selects matches all of its members - see
   * `MemberFilter`. "Show me the failed rules" is therefore this menu plus the
   * Dependencies toggle, which is the pane's existing answer to "which kinds am I
   * looking at" and a better one than a filter on one kind silently emptying the
   * other.
   */
  private renderFilterMenu(attrs: DirExplorerPanelAttrs): m.Children {
    const n = this.selectionCount();
    return m(
      PopupMenu,
      {
        trigger: m(Button, {
          label: n === 0 ? 'Filters' : `Filters (${n})`,
          icon: 'filter_alt',
          active: n > 0,
          title: 'Narrow the tree by rule outcome, dep resolution, or duration',
        }),
      },
      m(MenuItem, {
        label: 'Failed only',
        icon: this.isFailedOnly() ? 'check_box' : 'check_box_outline_blank',
        title:
          'Rules that failed, and deps whose own build failed. Cancelled and ' +
          'unfinished are not failures.',
        closePopupOnClick: false,
        onclick: () => this.toggleFailedOnly(attrs),
      }),
      m(MenuDivider),
      this.renderSetSubmenu(attrs, 'Rule outcome', RULE_OUTCOMES, 'outcomes'),
      m(MenuItem, {
        label: 'Rule deps unknown',
        icon:
          this.filter.depsUnknown === true
            ? 'check_box'
            : 'check_box_outline_blank',
        title:
          "Rules whose deps dune couldn't determine - n_static_deps reads 0 " +
          'either way, so this is how to tell the two apart',
        closePopupOnClick: false,
        onclick: () =>
          this.apply(attrs, {
            ...this.filter,
            depsUnknown: this.filter.depsUnknown === true ? undefined : true,
          }),
      }),
      m(MenuDivider),
      this.renderSetSubmenu(
        attrs,
        'Dep resolution',
        DEP_RESOLUTIONS,
        'resolutions',
      ),
      this.renderSetSubmenu(attrs, 'Dep status', DEP_STATUSES, 'statuses'),
      m(MenuDivider),
      m(
        MenuItem,
        {label: 'Duration', icon: 'timer'},
        DURATION_THRESHOLDS.map(([label, ns]) =>
          m(MenuItem, {
            label,
            icon: this.filter.minDurNs === ns ? 'check' : undefined,
            closePopupOnClick: false,
            onclick: () =>
              this.apply(attrs, {
                ...this.filter,
                // Clicking the active threshold clears it, so the submenu is its
                // own off switch.
                minDurNs: this.filter.minDurNs === ns ? undefined : ns,
              }),
          }),
        ),
      ),
      m(MenuDivider),
      m(MenuItem, {
        label: 'Clear all filters',
        icon: 'clear',
        disabled: !filterActive(this.filter),
        onclick: () => {
          this.clearFilter();
          attrs.controller.requestRedraw();
        },
      }),
    );
  }

  // One multi-select group: a submenu of values, each a checkable item. Nothing
  // selected means "no opinion" rather than "nothing matches", so the submenu
  // needs no explicit "any" entry - unchecking everything is that.
  private renderSetSubmenu<K extends 'outcomes' | 'resolutions' | 'statuses'>(
    attrs: DirExplorerPanelAttrs,
    label: string,
    values: readonly string[],
    key: K,
  ): m.Children {
    const selected: ReadonlySet<string> = this.filter[key] ?? new Set();
    const suffix = selected.size === 0 ? '' : ` (${selected.size})`;
    return m(
      MenuItem,
      {label: `${label}${suffix}`, icon: 'checklist'},
      values.map((value) =>
        m(MenuItem, {
          label: value,
          icon: selected.has(value) ? 'check' : undefined,
          closePopupOnClick: false,
          onclick: () => {
            const next = new Set(selected);
            if (next.has(value)) next.delete(value);
            else next.add(value);
            this.apply(attrs, {
              ...this.filter,
              [key]: next.size === 0 ? undefined : next,
            } as MemberFilter);
          },
        }),
      ),
    );
  }

  // How many attribute groups are narrowing anything, for the button's badge.
  // Groups rather than values: "Filters (2)" should mean two things are being
  // asked, not that one of them names two outcomes.
  private selectionCount(): number {
    const {path, outcomes, resolutions, statuses, depsUnknown, minDurNs} =
      this.filter;
    return [
      path !== undefined,
      outcomes !== undefined,
      resolutions !== undefined,
      statuses !== undefined,
      depsUnknown === true,
      minDurNs !== undefined,
    ].filter(Boolean).length;
  }

  // Whether the selections are exactly the failed-only shortcut's.
  private isFailedOnly(): boolean {
    const sameAs = (a: ReadonlySet<string> | undefined, b: readonly string[]) =>
      a !== undefined && a.size === b.length && b.every((v) => a.has(v));
    return (
      sameAs(this.filter.outcomes, FAILED_OUTCOMES) &&
      sameAs(this.filter.statuses, FAILED_STATUSES)
    );
  }

  // The shortcut sets the two real selections rather than being a filter of its
  // own, so what it did is visible in the submenus and can be adjusted there.
  private toggleFailedOnly(attrs: DirExplorerPanelAttrs): void {
    const on = this.isFailedOnly();
    this.apply(attrs, {
      ...this.filter,
      outcomes: on ? undefined : new Set(FAILED_OUTCOMES),
      statuses: on ? undefined : new Set(FAILED_STATUSES),
    });
  }

  // The clear button's tooltip: what is currently being asked.
  private clearTitle(): string {
    const parts: string[] = [];
    if (this.filter.path !== undefined) parts.push(this.filter.path.text);
    if (this.selectionCount() > (this.filter.path === undefined ? 0 : 1)) {
      parts.push('attribute filters');
    }
    return parts.length === 0
      ? 'Clear the filter'
      : `Clear the filter (${parts.join(' + ')})`;
  }

  // Applies the path box's contents on top of the current attribute selections.
  private applyPath(attrs: DirExplorerPanelAttrs): void {
    this.apply(attrs, {...this.filter, path: compileFilter(this.draft)});
  }

  /**
   * Replaces the active filter and rebuilds the tree: up to three queries, then
   * the rollup.
   *
   * Auto-expansion is all-or-nothing (see `FilteredTree.autoExpand`). When the
   * filter narrows to few enough places, every ancestor chain is opened so the
   * matches are simply on screen; when it does not, the tree is left as the user
   * had it and the per-directory match counts are what guide the next click.
   */
  private apply(attrs: DirExplorerPanelAttrs, filter: MemberFilter): void {
    if (!filterActive(filter)) {
      this.clearFilter();
      attrs.controller.requestRedraw();
      return;
    }
    if (this.filterLoading) return;
    this.filterLoading = true;
    this.filterError = undefined;
    const {engine} = attrs.trace;
    void (async () => {
      // The directories the path matched come first: the rule counts are keyed
      // off them, since a rule carries no path of its own to test.
      const dirsP = allDirs(engine);
      const ruleDirs =
        filter.path === undefined
          ? undefined
          : await matchingRuleDirs(engine, filter.path);
      const [dirs, ruleCounts, depCounts] = await Promise.all([
        dirsP,
        matchingCounts(engine, 'rule', filter, ruleDirs),
        matchingCounts(engine, 'dep', filter),
      ]);
      const tree = new FilteredTree(dirs, ruleCounts, depCounts);
      this.filter = filter;
      this.ruleDirs = ruleDirs;
      this.tree = tree;
      // A filter changes which rows exist, so nothing cached under the previous
      // one (or under no filter) describes this view.
      this.children.clear();
      this.members.clear();
      const expand = tree.autoExpand(AUTO_EXPAND_LIMIT);
      if (expand !== undefined) {
        this.expanded.clear();
        for (const id of expand) this.expanded.add(`dir:${id}`);
      }
    })()
      .catch((e) => {
        this.filterError = `Could not apply the filter: ${errorText(e)}`;
        this.filter = {};
        this.tree = undefined;
        this.ruleDirs = undefined;
      })
      .finally(() => {
        this.filterLoading = false;
        attrs.controller.requestRedraw();
      });
  }

  private clearFilter(): void {
    this.draft = '';
    this.filter = {};
    this.tree = undefined;
    this.ruleDirs = undefined;
    this.filterError = undefined;
    this.children.clear();
    this.members.clear();
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
    if (this.filterError !== undefined) {
      return m(Callout, {icon: 'error'}, this.filterError);
    }
    if (this.rootsError !== undefined) {
      return m(Callout, {icon: 'error'}, this.rootsError);
    }
    // Filtered: the roots come from the client-side tree, which already knows
    // which subtrees hold a match (see dir_filter.ts). Unfiltered: the lazy
    // query, as before.
    const tree = this.tree;
    let visible: {dir: DirEntry; from: string}[];
    if (tree !== undefined) {
      visible = tree
        .roots()
        .map((row) => ({dir: row.dir, from: row.pathFrom}))
        .filter(({dir}) => this.visibleSubtree(dir));
    } else {
      const roots = this.roots;
      if (roots === undefined) {
        this.loadRoots(attrs);
        return this.spinnerRow('Reading directories…');
      }
      visible = roots
        .filter((d) => this.visibleSubtree(d))
        .map((dir) => ({dir, from: ''}));
    }
    if (visible.length === 0) {
      return m(
        EmptyState,
        {icon: 'filter_alt', title: 'Nothing to show'},
        m(
          '.pf-dune-graph__load-note',
          filterActive(this.filter)
            ? 'Nothing matches the current filter in the kinds currently shown.'
            : 'No directory holds anything of the kinds currently shown.',
        ),
      );
    }
    return m(
      '.pf-dune-tree',
      visible.map(({dir, from}) => this.renderDir(attrs, dir, from)),
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
    return KINDS.some(
      (k) => this.show[k] && this.shownSubtreeCount(dir, k) > 0,
    );
  }

  /**
   * How many members of `kind` this directory has that the pane would show -
   * matching ones while a filter is active, all of them otherwise.
   *
   * Everything downstream counts through here: which buckets exist, whether the
   * members go inline, what the bulk buttons act on. That is what makes a filter
   * narrow the pane rather than merely annotate it.
   */
  private shownCount(dir: DirEntry, kind: NodeKind): number {
    if (this.tree !== undefined) return this.tree.directMatches(dir.id, kind);
    return kind === 'rule' ? dir.nRules : dir.nDeps;
  }

  // The same over the whole subtree, for a collapsed row's summary.
  private shownSubtreeCount(dir: DirEntry, kind: NodeKind): number {
    if (this.tree !== undefined) return this.tree.subtreeMatches(dir.id, kind);
    return kind === 'rule' ? dir.tRules : dir.tDeps;
  }

  // The kinds currently shown that this directory directly holds any of.
  private memberKinds(dir: DirEntry): NodeKind[] {
    return KINDS.filter((k) => this.show[k] && this.shownCount(dir, k) > 0);
  }

  // How many of this directory's direct members are currently shown.
  private visibleMemberCount(dir: DirEntry): number {
    return KINDS.reduce(
      (n, k) => n + (this.show[k] ? this.shownCount(dir, k) : 0),
      0,
    );
  }

  /**
   * Whether this directory's *path* satisfies the path filter.
   *
   * A rule is matched on the directory it is filed under, so the path half of a
   * rule's test is constant across a directory - which is why the member queries
   * take it as a flag rather than testing each row. True when there is no path
   * filter, since then nothing about the path excludes anything.
   */
  private dirPathMatches(dir: DirEntry): boolean {
    return this.ruleDirs === undefined || this.ruleDirs.has(dir.id);
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
        m('span.pf-dune-tree__group-count', this.renderCounts(dir, open)),
        this.renderBulk(attrs, dir, kinds, memberCount),
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
        () =>
          dirMemberIds(
            attrs.trace.engine,
            dir.id,
            kinds,
            this.filter,
            this.dirPathMatches(dir),
          ),
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
    const total = (k: NodeKind) =>
      open
        ? k === 'rule'
          ? dir.nRules
          : dir.nDeps
        : k === 'rule'
          ? dir.tRules
          : dir.tDeps;
    const shown = (k: NodeKind) =>
      open ? this.shownCount(dir, k) : this.shownSubtreeCount(dir, k);
    // While filtering, "3 of 1,204 rules" - the bare total would claim rows this
    // row is not showing. Both numbers are exact: they come from the same rollup
    // the tree itself is drawn from.
    const count = (k: NodeKind, noun: string) => {
      const n = shown(k);
      const of = total(k);
      return filterActive(this.filter) && n !== of
        ? `${n.toLocaleString()} of ${plural(of, noun)}`
        : plural(n, noun);
    };
    const rules = shown('rule');
    const deps = shown('dep');
    const failed = open ? dir.nFailed : dir.tFailed;
    const parts: m.Children[] = [];
    if (this.show.rule && rules > 0) parts.push(count('rule', 'rule'));
    if (this.show.dep && deps > 0) parts.push(count('dep', 'dep'));
    // The failure count and the duration are stored rollups over *all* members,
    // so neither can be narrowed to the matches. Dropped while filtering rather
    // than shown as an unqualified number next to qualified ones.
    if (!filterActive(this.filter) && this.show.rule && failed > 0) {
      parts.push(m('span.pf-dune-explorer__failed', `${failed} failed`));
    }
    // Timing is rule spans only (see sql_graph.ts), so it belongs to the rules
    // and goes when they do.
    if (
      !filterActive(this.filter) &&
      !open &&
      this.show.rule &&
      dir.totalDurNs > 0n
    ) {
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
    // Filtered: no query at all. The whole hierarchy is already in memory (it
    // has to be, to know which subtrees hold a match), so a level is a lookup -
    // and it is compressed against the *filtered* tree, which is what stops a
    // narrow filter from leaving a ladder of one-child rows.
    const tree = this.tree;
    if (tree !== undefined) {
      return tree
        .childRows(dir.id, dir.path)
        .filter((row) => this.visibleSubtree(row.dir))
        .map((row) => this.renderDir(attrs, row.dir, row.pathFrom));
    }
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
    const count = this.shownCount(dir, kind);
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
    const key = this.memberKey(dir.id, kinds);
    let state = this.members.get(key);
    if (state === undefined) {
      // Serve from a superset already in hand rather than querying again: with
      // both kinds loaded, one kind's list is a filter of it. This is what makes
      // hiding a kind free in the common case.
      const filtered = this.filterFromLoaded(dir, kinds);
      if (filtered !== undefined) {
        state = filtered;
      } else {
        this.loadMembers(attrs, dir.id, kinds, 0, this.dirPathMatches(dir));
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
      const total = kinds.reduce((n, k) => n + this.shownCount(dir, k), 0);
      const remaining = Math.max(0, total - state.rows.length);
      rows.push(
        m(
          '.pf-dune-explorer__more',
          m(Button, {
            label: `Show ${Math.min(remaining, MEMBER_PAGE).toLocaleString()} more of ${remaining.toLocaleString()}`,
            icon: 'expand_more',
            onclick: () =>
              this.loadMembers(
                attrs,
                dir.id,
                kinds,
                state.rows.length,
                this.dirPathMatches(dir),
              ),
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
    const all = this.members.get(this.memberKey(dir.id, KINDS));
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

  /**
   * The cache key for one member list: a directory, which kinds, and which
   * filter.
   *
   * Both kinds is its own key rather than the union of the two single-kind ones,
   * because it is a different query and a differently paged one. The filter is in
   * the key because it changes *which rows* independently of which kinds - the
   * caches are also cleared when a filter is applied, so this is belt and braces,
   * but a member list keyed only by kind would be a silently wrong cache hit if
   * that ever stopped being true.
   */
  private memberKey(id: number, kinds: readonly NodeKind[]): string {
    const f = fingerprint(this.filter);
    return `${id}:${[...kinds].sort().join('+')}:${f}`;
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
    dirPathMatches: boolean,
  ): void {
    const key = this.memberKey(id, kinds);
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
    void dirMembers(
      attrs.trace.engine,
      id,
      kind,
      MEMBER_PAGE,
      offset,
      this.filter,
      dirPathMatches,
    )
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

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
