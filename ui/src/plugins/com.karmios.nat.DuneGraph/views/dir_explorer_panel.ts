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
 * level at a time. The view for when you do not yet know which node you are
 * looking for; the other two both start from one.
 *
 * Where the rows come from is the `source` attr, not anything in here, because
 * this pane is mounted twice - as the side panel's Explorer tab over the SQL
 * mirror, and as a Data Explorer chart over a query's rows.
 *
 * **ARCHITECTURE.md, "The Explorer pane", is the design**: the two source shapes, why
 * the pane owns its tree state rather than using `LazyTreeNode`, how the
 * narrow-to-this-directory brush works, and why the hard filter is client-side.
 */

import m from 'mithril';
import {Icons} from '../../../base/semantic_icons';
import {Button} from '../../../widgets/button';
import {Callout} from '../../../widgets/callout';
import {EmptyState} from '../../../widgets/empty_state';
import {Icon} from '../../../widgets/icon';
import {Intent} from '../../../widgets/common';
import {Spinner} from '../../../widgets/spinner';
import type {DuneGraphController} from '../controller';
import type {DirEntry, MemberEntry} from '../model/dir_explorer';
import type {MemberFilter, WindowRel, WindowSpan} from '../model/dir_explorer';
import {
  INLINE_MEMBER_LIMIT,
  MEMBER_PAGE,
  compileFilter,
  filterActive,
  filterQuerySql,
  fingerprint,
} from '../model/dir_explorer';
import {copyToClipboard} from '../../../base/clipboard';
import type {DirExplorerSource} from './dir_explorer_source';
import {FilteredTree} from './dir_filter';
import {TextInput} from '../../../widgets/text_input';
import {
  MenuDivider,
  MenuItem,
  MenuTitle,
  PopupMenu,
} from '../../../widgets/menu';
import {
  DEP_RESOLUTIONS,
  DEP_STATUSES,
  FAILED_OUTCOMES,
  FAILED_STATUSES,
  FORCED_BY_KINDS,
  RULE_OUTCOMES,
} from '../model/graph';
import type {NodeKind} from '../model/graph';
import {TOP_LEVEL_LABEL, dirPathLabel} from '../model/dir_tree';
import {plural} from '../model/graph';
import {formatDurNs} from './node_display';
import {renderNodeCell, renderNodeCellActions} from './node_cell';
import {bulkNodeActions} from './node_tree_actions';

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

/**
 * How long the selection has to hold still before a followed window is applied.
 *
 * Dragging an area selection changes it every frame, and applying a window
 * costs the same pair of counting queries any other filter does - so this is
 * what keeps "follow the timeline" from issuing one per frame of a drag. Long
 * enough to cover a drag's own stutter, short enough that a click feels
 * immediate.
 */
const FOLLOW_DEBOUNCE_MS = 300;

/** The window relations, in menu order, with what each one asks. */
const WINDOW_RELS: ReadonlyArray<
  readonly [rel: WindowRel, label: string, title: string]
> = [
  [
    'at',
    'At the start',
    'In flight at the moment the selection starts - what else was running then',
  ],
  ['overlaps', 'Overlapping', 'In flight at any point during the selection'],
  ['within', 'Within', 'Started and finished inside the selection'],
  ['encloses', 'Around', 'Already running before it and still running after'],
];

/** The spans a window can be asked about, in menu order. */
const WINDOW_SPANS: ReadonlyArray<
  readonly [span: WindowSpan, label: string, title: string]
> = [
  [
    'node',
    'Own span',
    "The member's own lifecycle span. The only one a dep has.",
  ],
  [
    'action',
    'Action span',
    "A rule's action span, so a rule that spent the window waiting does not " +
      'match. Rules only - no dep has an action.',
  ],
  [
    'process',
    'Process spans',
    'Any process the action spawned. Rules only - no dep has one.',
  ],
];

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
  // Required rather than defaulted to the SQL mirror: a default would drag the
  // engine and the queries back into this file, and a mount that forgot its own
  // source would quietly show the whole mirror's tree instead of failing.
  readonly source: DirExplorerSource;

  // Narrow whatever else is looking at these rows to one directory. Absent in
  // the side panel, where the tree is the whole surface. A *toggle*: called on
  // every click, including on the already-narrowed directory, and which way it
  // goes is the caller's to decide - it owns the filter.
  //
  // A button on the row rather than the row's own click, which expands it.
  readonly onFilterToDir?: (dir: DirEntry) => void;

  // Comes back *in* because the pane cannot know it: what becomes of the
  // directory it handed to `onFilterToDir` is the caller's state. All the pane
  // does is draw that row's button pressed, which is what makes it read as a
  // toggle rather than a gesture with no way back.
  readonly filteredDirId?: number;
}

// One directory's child directories, once asked for.
interface ChildState {
  dirs?: readonly DirEntry[];
  loading: boolean;
  error?: string;
}

// The pages of one (directory, kind-filter) member list read so far.
interface MemberState {
  rows: readonly MemberEntry[];
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

  // Expanded rows, by `dirKey` / `bucketKey`. Absent = collapsed, which is the
  // initial state for every row including the roots' children. Survives a filter
  // change, re-keyed onto the new rows - see `apply`.
  private expanded = new Set<string>();

  private readonly children = new Map<number, ChildState>();
  // Keyed by `memberKey`: a directory plus which kinds are being asked for.
  private readonly members = new Map<string, MemberState>();

  private roots?: readonly DirEntry[];
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
  // How many members the source offered before the filter narrowed them. Only
  // a row-driven source has such a number, recorded when the empty filter is
  // applied; in the side panel an empty filter means no tree at all.
  private selectedCount?: number;
  private filterLoading = false;
  private filterError?: string;

  // The source the caches above were read out of, and which version of it. Both
  // are the identity of "what these rows mean": a graph reload renumbers every
  // node and rebuilds `dune_dir` from scratch (which the SQL source reports as
  // a new `mirrorVersion`), and being re-mounted against a *different* source
  // replaces the tree wholesale even where neither side's counter moved.
  // Version numbers are per source, so the two checks are not redundant.
  private cachedSource?: DirExplorerSource;
  private cachedVersion?: number;

  /**
   * Whether the window follows the timeline selection, and what it last saw.
   *
   * Live and static are not two kinds of filter: the filter always holds a
   * resolved window, and this only says whether a selection change refills it.
   * Turning it off therefore freezes the window where it is, which is the
   * static version, with no second code path behind it.
   */
  private followSelection = false;
  private followKey = '';
  private followTimer?: ReturnType<typeof setTimeout>;
  // The relation and span a window is (re)built with - the menu's choice, kept
  // here rather than read back off the filter so that choosing one while no
  // window is applied still means something.
  private windowRel: WindowRel = 'overlaps';
  private windowSpan: WindowSpan = 'node';

  // The directory the pane has been asked to expand to, and the serial of the
  // request it came from - see `expandToward`, which works through it a level
  // per redraw. The serial is what makes asking twice for the same directory
  // two requests rather than one.
  private revealTarget?: {readonly id: number; readonly path: string};
  private revealSerial = 0;

  view({attrs}: m.CVnode<DirExplorerPanelAttrs>): m.Children {
    const {source} = attrs;
    if (source !== this.cachedSource || source.version !== this.cachedVersion) {
      this.cachedSource = source;
      this.cachedVersion = source.version;
      this.reset(attrs);
    }
    this.takeRevealRequest(attrs);
    this.syncFollowedWindow(attrs);
    return m(
      '.pf-dune-graph.pf-dune-explorer',
      this.renderToolbar(attrs),
      m('.pf-dune-explorer__body', this.renderBody(attrs)),
    );
  }

  // The debounce is the one thing here that outlives the vnode.
  onremove(): void {
    clearTimeout(this.followTimer);
  }

  /**
   * Refills the window from the timeline selection, once it has held still.
   *
   * Polled from the view rather than hooked onto a selection event: a selection
   * change already redraws, and there is no event to hook - the controller
   * polls for its own selection work the same way (see controller.ts's
   * onFrame). The timer is what makes it a debounce rather than a poll: the
   * last change of a drag is the only one that reaches `applyWindow`.
   */
  private syncFollowedWindow(attrs: DirExplorerPanelAttrs): void {
    if (!this.followSelection) return;
    const window = attrs.controller.selectedWindow();
    const key = window === undefined ? '' : `${window.startNs}-${window.endNs}`;
    if (key === this.followKey) return;
    this.followKey = key;
    clearTimeout(this.followTimer);
    this.followTimer = setTimeout(() => {
      this.applyWindow(attrs, window);
      attrs.controller.requestRedraw();
    }, FOLLOW_DEBOUNCE_MS);
  }

  /**
   * Puts `window` into the filter under the current relation and span, or drops
   * the window when there is no selection to take one from.
   *
   * Only the window changes: everything else the user has selected is a
   * separate question and survives the timeline moving under it.
   */
  private applyWindow(
    attrs: DirExplorerPanelAttrs,
    window: {readonly startNs: bigint; readonly endNs: bigint} | undefined,
  ): void {
    this.apply(attrs, {
      ...this.filter,
      window:
        window === undefined
          ? undefined
          : {...window, rel: this.windowRel, span: this.windowSpan},
    });
  }

  private reset(attrs: DirExplorerPanelAttrs): void {
    this.children.clear();
    this.members.clear();
    this.expanded.clear();
    // Named a directory of the mirror that has been replaced, and every id in
    // it with it (see `cachedVersion`). The request is not re-served against
    // the new one: it was a click on a panel showing the old.
    this.revealTarget = undefined;
    // The tree is rebuilt from the new mirror; what the user typed survives,
    // since it is their input rather than derived state.
    this.tree = undefined;
    this.ruleDirs = undefined;
    // Belongs to the source that was replaced, not to this one - and it is not
    // recomputed until an empty filter is applied, so a stale one would sit
    // under the chip claiming a total from a query that is off screen.
    this.selectedCount = undefined;
    this.filterLoading = false;
    this.filterError = undefined;
    this.roots = undefined;
    this.rootsLoading = false;
    this.rootsError = undefined;
    // The filter survived but everything derived from it was dropped, and the
    // pane is only coherent while the two agree - otherwise the tree renders
    // from unfiltered counts while the member queries still carry the filter,
    // and `dirPathMatches` claims every directory's path matched. So re-apply.
    //
    // Only where `apply` has something to do: an empty filter on a hierarchy
    // source is the lazy descent already set up, and re-applying would also
    // empty the draft box. A row-driven source's empty filter *is* its tree.
    //
    // `filterLoading` is cleared above rather than below because `apply` bails
    // on a busy pane, so a reset mid-apply would drop the re-apply and leave
    // exactly the split state this avoids.
    if (filterActive(this.filter) || attrs.source.rowDriven) {
      this.apply(attrs, this.filter);
    }
  }

  /**
   * The path filter box, the Filters menu, and Collapse all.
   *
   * The kind toggles live *in* the menu, at the head of their own sections (see
   * `renderFilterMenu`): they are the coarsest filter there is, and having them
   * outside meant the two halves of "which members do I want" sat in different
   * places.
   */
  private renderToolbar(attrs: DirExplorerPanelAttrs): m.Children {
    if (!attrs.controller.nodeMirrorReady) return undefined;
    // The same toolbar whatever the source. A row-driven source is *already*
    // narrowed by the query behind it, but that is not a reason to withhold the
    // filter: it re-queries for everything it shows, so the filter's predicates
    // go into those queries alongside the input's semi-join and the two
    // narrowings simply AND (see dir_chart_source.ts).
    return m(
      '.pf-dune-graph__toolbar',
      this.renderFilterBar(attrs),
      m(
        '.pf-dune-graph__toolbar-buttons',
        this.renderFilterMenu(attrs),
        m(Button, {
          label: 'Copy SQL',
          icon: 'content_copy',
          title:
            'Copy a query for the members the tree is showing, to run on the ' +
            'query page',
          disabled: this.visibleKinds().length === 0,
          onclick: () => {
            void copyToClipboard(
              filterQuerySql(this.visibleKinds(), this.filter),
            );
          },
        }),
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

  // Submitted on Enter only: applying a filter costs a scan of every dep in the
  // build, so no debounce and no filter-as-you-type. Same rule for a row-driven
  // source - see `fetchCounts` in dir_chart_source.ts for why.
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

  // Exact, not approximate: the counts come from the rollup the tree is drawn
  // from. Qualified by `selectedCount` where there is a second narrowing to
  // qualify against, since "412 matching" out of a chart's 1,204 rows and out
  // of the build's 818k nodes are very different claims. Unqualified when the
  // two are equal - "1,204 of 1,204" is the same number twice.
  private filterSummary(): string {
    const tree = this.tree;
    if (tree === undefined) return '';
    const n = tree.matchCount;
    const of = this.selectedCount;
    return of === undefined || of === n
      ? `${n.toLocaleString()} matching`
      : `${n.toLocaleString()} of ${of.toLocaleString()} matching`;
  }

  // Three queries, then the tree. Whatever was expanded stays expanded,
  // re-keyed onto the new rows; nothing is opened for the user.
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
    const bothHidden = !this.show.rule && !this.show.dep;
    return m(
      PopupMenu,
      {
        trigger: m(Button, {
          label: n === 0 ? 'Filters' : `Filters (${n})`,
          icon: 'filter_alt',
          active: n > 0,
          title: 'Choose which members the tree shows',
        }),
      },
      m(MenuItem, {
        label: 'Failed only',
        icon: this.isFailedOnly() ? 'check_box' : 'check_box_outline_blank',
        title:
          'Rules that failed, and deps whose own build failed. Cancelled and ' +
          'unfinished are not failures.',
        disabled: bothHidden,
        closePopupOnClick: false,
        onclick: () => this.toggleFailedOnly(attrs),
      }),
      this.renderSetSubmenu(
        attrs,
        'Forced by',
        FORCED_BY_KINDS,
        'forcedBy',
        undefined,
      ),
      m(
        MenuItem,
        {label: 'Duration', icon: 'timer', disabled: bothHidden},
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
      this.renderWindowSubmenu(attrs, bothHidden),

      m(MenuTitle, {label: KIND_LABEL.rule}),
      this.renderKindToggle('rule'),
      this.renderSetSubmenu(
        attrs,
        'Outcome',
        RULE_OUTCOMES,
        'outcomes',
        'rule',
      ),
      m(MenuItem, {
        label: 'Deps unknown',
        icon:
          this.filter.depsUnknown === true
            ? 'check_box'
            : 'check_box_outline_blank',
        title:
          "Rules whose deps dune couldn't determine - n_static_deps reads 0 " +
          'either way, so this is how to tell the two apart',
        disabled: !this.show.rule,
        closePopupOnClick: false,
        onclick: () =>
          this.apply(attrs, {
            ...this.filter,
            depsUnknown: this.filter.depsUnknown === true ? undefined : true,
          }),
      }),

      m(MenuTitle, {label: KIND_LABEL.dep}),
      this.renderKindToggle('dep'),
      this.renderSetSubmenu(
        attrs,
        'Resolution',
        DEP_RESOLUTIONS,
        'resolutions',
        'dep',
      ),
      this.renderSetSubmenu(attrs, 'Status', DEP_STATUSES, 'statuses', 'dep'),

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

  /**
   * The in-flight window: which slice of time, read which way, against which
   * span.
   *
   * The window itself is never typed in - it is whatever the timeline
   * selection names, taken once on click or refilled on every change while
   * "Follow" is on. That is the whole reason there is no third input in this
   * panel: the timeline already *is* a time picker, and a better one.
   */
  private renderWindowSubmenu(
    attrs: DirExplorerPanelAttrs,
    bothHidden: boolean,
  ): m.Children {
    const window = this.filter.window;
    const selected = attrs.controller.selectedWindow();
    // Nothing to take a window from, and nothing to follow either.
    const noSelection = selected === undefined;
    const active = WINDOW_RELS.find(([rel]) => rel === window?.rel);
    const items: m.Children[] = [
      m(MenuItem, {
        label: 'Follow timeline selection',
        icon: this.followSelection ? 'check_box' : 'check_box_outline_blank',
        title:
          'Refill the window whenever the timeline selection changes. Turn ' +
          'it off to freeze the window where it is.',
        closePopupOnClick: false,
        onclick: () => {
          this.followSelection = !this.followSelection;
          if (!this.followSelection) return;
          // Applied now rather than on the next selection change, which may
          // never come: the box is ticked to mean "use what is selected".
          this.followKey =
            selected === undefined
              ? ''
              : `${selected.startNs}-${selected.endNs}`;
          this.applyWindow(attrs, selected);
        },
      }),
      m(MenuDivider),
      ...WINDOW_RELS.map(([rel, label, title]) =>
        m(MenuItem, {
          label,
          title: noSelection
            ? 'Select a slice, or drag a time range on the timeline, first'
            : title,
          icon: window?.rel === rel ? 'check' : undefined,
          disabled: noSelection && window?.rel !== rel,
          closePopupOnClick: false,
          onclick: () => {
            // Clicking the active relation clears the window, so the submenu
            // is its own off switch - the same shape the Duration one has.
            if (window?.rel === rel) {
              this.followSelection = false;
              this.apply(attrs, {...this.filter, window: undefined});
              return;
            }
            this.windowRel = rel;
            this.applyWindow(attrs, selected);
          },
        }),
      ),
      m(MenuDivider),
      ...WINDOW_SPANS.map(([span, label, title]) =>
        m(MenuItem, {
          label,
          title,
          icon: this.windowSpan === span ? 'check' : undefined,
          closePopupOnClick: false,
          onclick: () => {
            this.windowSpan = span;
            // Re-applied against the window already in force, not against the
            // selection: the span is what is being changed, not when.
            if (window === undefined) return;
            this.apply(attrs, {...this.filter, window: {...window, span}});
          },
        }),
      ),
    ];
    return m(
      MenuItem,
      {
        label: active === undefined ? 'In flight' : `In flight (${active[1]})`,
        icon: 'schedule',
        disabled: bothHidden,
      },
      items,
    );
  }

  // Which kinds are on screen, which is what a copied query has to ask for -
  // the kind toggles are the pane's own and are not part of `MemberFilter`.
  private visibleKinds(): readonly NodeKind[] {
    return KINDS.filter((k) => this.show[k]);
  }

  // The *first* item under each heading, and what everything below it is gated
  // on: a disabled `Outcome` submenu under a hidden `Rules` says why it would
  // have no effect. The selections are kept while a kind is hidden.
  private renderKindToggle(kind: NodeKind): m.Children {
    const on = this.show[kind];
    const noun = KIND_LABEL[kind].toLowerCase();
    return m(MenuItem, {
      label: `Show ${noun}`,
      icon: on ? 'check_box' : 'check_box_outline_blank',
      title: on ? `Hide ${noun}` : `Show ${noun}`,
      closePopupOnClick: false,
      onclick: () => {
        this.show[kind] = !this.show[kind];
      },
    });
  }

  // One multi-select group: a submenu of values, each a checkable item. Nothing
  // selected means "no opinion" rather than "nothing matches", so the submenu
  // needs no explicit "any" entry - unchecking everything is that. Disabled when
  // its kind is hidden, since it could then change nothing on screen.
  private renderSetSubmenu<
    K extends 'outcomes' | 'resolutions' | 'statuses' | 'forcedBy',
  >(
    attrs: DirExplorerPanelAttrs,
    label: string,
    values: readonly string[],
    key: K,
    // The kind this narrows, or undefined for one that narrows both - which is
    // then only dead when neither kind is shown at all.
    kind: NodeKind | undefined,
  ): m.Children {
    const selected: ReadonlySet<string> = this.filter[key] ?? new Set();
    const suffix = selected.size === 0 ? '' : ` (${selected.size})`;
    return m(
      MenuItem,
      {
        label: `${label}${suffix}`,
        icon: 'checklist',
        // Narrowing a kind that isn't shown would do nothing visible.
        disabled:
          kind === undefined
            ? !this.show.rule && !this.show.dep
            : !this.show[kind],
      },
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
    const {
      path,
      outcomes,
      resolutions,
      statuses,
      depsUnknown,
      minDurNs,
      forcedBy,
      window,
    } = this.filter;
    return [
      path !== undefined,
      outcomes !== undefined,
      resolutions !== undefined,
      statuses !== undefined,
      depsUnknown === true,
      minDurNs !== undefined,
      forcedBy !== undefined,
      window !== undefined,
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
   * Whatever was expanded stays expanded, re-keyed onto the new rows: a filter
   * narrows what is on screen without moving the user somewhere else. Nothing is
   * opened for them - the per-directory match counts are what say where to look
   * next.
   */
  private apply(attrs: DirExplorerPanelAttrs, filter: MemberFilter): void {
    // An empty filter is "no filter" for a hierarchy source, which is the lazy
    // descent and no tree at all. For a row-driven one it is the *only* filter
    // there is - the rows already are the selection - so it takes this path
    // like any other and the tree gets built from the source's counts.
    if (!filterActive(filter) && !attrs.source.rowDriven) {
      this.clearFilter();
      attrs.controller.requestRedraw();
      return;
    }
    if (this.filterLoading) return;
    this.filterLoading = true;
    this.filterError = undefined;
    const {source} = attrs;
    void (async () => {
      // The directories the path matched come first: the rule counts are keyed
      // off them, since a rule carries no path of its own to test.
      const dirsP = source.allDirs();
      const ruleDirs =
        filter.path === undefined
          ? undefined
          : await source.matchingRuleDirs(filter.path);
      const [dirs, ruleCounts, depCounts] = await Promise.all([
        dirsP,
        source.matchingCounts('rule', filter, ruleDirs),
        source.matchingCounts('dep', filter),
      ]);
      const tree = new FilteredTree(dirs, ruleCounts, depCounts);
      this.filter = filter;
      this.ruleDirs = ruleDirs;
      this.tree = tree;
      // The unnarrowed total, for the chip to qualify a filter against. Only a
      // row-driven source gets here with an empty filter (the early return
      // above), so this is exactly the "before my filter" number and only exists
      // where there is one.
      if (!filterActive(filter)) this.selectedCount = tree.matchCount;
      // A filter changes which rows exist, so nothing cached under the previous
      // one (or under no filter) describes this view.
      this.children.clear();
      this.members.clear();
      this.expanded = remapKeys(this.expanded, tree);
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

  /** Drops the filter entirely, box and all. */
  private clearFilter(): void {
    this.draft = '';
    // Otherwise the next selection change quietly reinstates a window the user
    // just cleared.
    this.followSelection = false;
    clearTimeout(this.followTimer);
    this.filter = {};
    this.tree = undefined;
    this.ruleDirs = undefined;
    this.filterError = undefined;
    this.children.clear();
    this.members.clear();
  }

  /**
   * Picks up an "expand to this directory" request from the controller, which
   * is how the directory panel reaches this pane - the two are different
   * side-panel tabs and neither holds the other.
   *
   * **ARCHITECTURE.md, "Revealing a directory in the tree", is the design** -
   * both directions of that route, why the request is a serial, and the two
   * directories the walk below cannot reach.
   *
   * By serial, not by id: the descent below spans several redraws, so the
   * request cannot be cleared on sight, and the same directory asked for twice
   * has to restart it rather than read as the request already served.
   *
   * The path is taken now and kept: it is the mirror's own answer and it is
   * synchronous (see controller.ts's `dirPath`), and it is what the walk
   * matches on, since a compressed row carries the id of the deep directory it
   * settled on rather than of the one asked for.
   */
  private takeRevealRequest(attrs: DirExplorerPanelAttrs): void {
    const request = attrs.controller.explorerRevealRequest;
    if (request === undefined || request.serial === this.revealSerial) return;
    this.revealSerial = request.serial;
    const path = attrs.controller.dirPath(request.dirId);
    this.revealTarget =
      path === undefined ? undefined : {id: request.dirId, path};
  }

  /**
   * Expands every row above the directory asked for, one level per call.
   *
   * Called from `renderBody` rather than from the request, because getting
   * there is a descent through rows that mostly are not read yet: a level that
   * has to be fetched stops the walk, and the redraw the fetch asks for
   * resumes it. Idempotent, so the renders in between cost nothing.
   *
   * Two things it cannot do, both by the pane's own design rather than by
   * omission: a directory whose subtree holds nothing of the kinds shown has
   * no row (see `visibleSubtree`), and a pass-through one is swallowed by
   * compression. Either way the walk stops at the nearest row that does exist
   * and gives up, rather than expanding the whole tree looking for one that
   * does not. On merlin that is 5 of the 308 directories with a `gen-rules`
   * span, and none of them for the first reason.
   */
  private expandToward(attrs: DirExplorerPanelAttrs): void {
    const target = this.revealTarget;
    if (target === undefined) return;
    let parent: DirEntry | undefined;
    for (;;) {
      const rows = this.levelRows(attrs, parent);
      if (rows === undefined) return; // being read; resumes on the redraw
      const next = rowToward(rows, target);
      if (next === undefined) {
        this.revealTarget = undefined; // no row leads there
        return;
      }
      // The target's own row is expanded too: it is the one being revealed,
      // and a row whose members are showing is what says the walk arrived.
      this.expanded.add(dirKey(next.id));
      if (next.id === target.id || next.path === target.path) {
        this.revealTarget = undefined;
        return;
      }
      // Every step is strictly deeper, so this terminates on any source - a
      // level that contained its own parent would otherwise spin the browser
      // rather than fail.
      if (parent !== undefined && next.path.length <= parent.path.length) {
        this.revealTarget = undefined;
        return;
      }
      parent = next;
    }
  }

  /**
   * The rows drawn at one level - the roots when `dir` is undefined - as
   * `renderBody` and `renderChildren` draw them, for the walk above to follow.
   *
   * `undefined` means "not read yet", which is the walk's cue to stop: the
   * fetch it starts asks for a redraw, and that redraw resumes it. A level
   * that *failed* to read reads as empty rather than as pending, so the walk
   * gives up instead of retrying every frame.
   */
  private levelRows(
    attrs: DirExplorerPanelAttrs,
    dir?: DirEntry,
  ): readonly DirEntry[] | undefined {
    const tree = this.tree;
    if (tree !== undefined) {
      // The whole hierarchy is in memory under a filter, so every level is a
      // lookup and the walk runs to the end in one call.
      const rows =
        dir === undefined ? tree.roots() : tree.childRows(dir.id, dir.path);
      return rows.map((row) => row.dir);
    }
    if (dir === undefined) return this.roots;
    const state = this.children.get(dir.id);
    if (state === undefined) {
      this.loadChildren(attrs, dir.id);
      return undefined;
    }
    if (state.error !== undefined) return [];
    return state.dirs;
  }

  private renderBody(attrs: DirExplorerPanelAttrs): m.Children {
    const {controller} = attrs;
    // `dune_dir` is built as part of the node tier, so there is nothing to show
    // until that is up - see `renderMirrorNotLoaded` for the offer to build it.
    if (!controller.nodeMirrorReady) return renderMirrorNotLoaded(controller);
    if (this.filterError !== undefined) {
      return m(Callout, {icon: 'error'}, this.filterError);
    }
    if (this.rootsError !== undefined) {
      return m(Callout, {icon: 'error'}, this.rootsError);
    }
    // Filtered: the roots come from the client-side tree, which already knows
    // which subtrees hold a match (see dir_filter.ts). Unfiltered: the lazy
    // query.
    const tree = this.tree;
    let visible: {dir: DirEntry; from: string}[];
    if (tree !== undefined) {
      visible = tree
        .roots()
        .map((row) => ({dir: row.dir, from: row.pathFrom}))
        .filter(({dir}) => this.visibleSubtree(dir));
    } else if (attrs.source.rowDriven) {
      // The tree a row-driven source needs, built the same way an applied
      // filter's is and with the same guards: `apply` marks itself busy
      // synchronously, so the renders before it lands do not re-issue it, and a
      // failure sets `filterError`, which returns above rather than here.
      this.apply(attrs, this.filter);
      return this.spinnerRow('Reading directories…');
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
    // After `visible`, so the roots are in and the filtered tree is built:
    // both are what the walk descends from. Before the rows are drawn, so an
    // expansion it makes is on screen this frame rather than the next.
    this.expandToward(attrs);
    return m(
      '.pf-dune-tree',
      visible.map(({dir, from}) => this.renderDir(attrs, dir, from)),
    );
  }

  // With a kind hidden, a directory whose whole subtree holds only that kind is
  // scaffolding you click through to find nothing - on a real trace, most of
  // the tree (all of `/usr` and the opam switch). Both kinds hidden is the
  // exception: that state is a plain directory tree, see `renderToolbar`.
  private visibleSubtree(dir: DirEntry): boolean {
    if (!this.show.rule && !this.show.dep) return true;
    return KINDS.some(
      (k) => this.show[k] && this.shownSubtreeCount(dir, k) > 0,
    );
  }

  // Whether the rows on screen are a subset of what the directories hold - the
  // tree's existence, not `filterActive(this.filter)`: a row-driven source is
  // narrowed with no filter typed. Gates which counts may be shown bare.
  private narrowed(): boolean {
    return this.tree !== undefined;
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

  // `parentPath` is the path of the row above, which is what the label is
  // measured against; `''` for a root. See `dirLabel`.
  private renderDir(
    attrs: DirExplorerPanelAttrs,
    dir: DirEntry,
    parentPath: string,
  ): m.Children {
    const key = dirKey(dir.id);
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
        this.renderSelect(attrs, dir),
        m('span.pf-dune-tree__group-count', this.renderCounts(dir, open)),
        this.renderBulk(attrs, dir, kinds, memberCount, attrs.onFilterToDir),
      ),
      open &&
        m(
          '.pf-dune-tree__children',
          this.renderChildren(attrs, dir),
          this.renderMembers(attrs, dir, kinds, memberCount),
        ),
    );
  }

  // Selecting the directory itself, beside its name rather than out with the
  // member actions on the right: it acts on the directory, which is what the
  // name names, while everything in the actions box acts on what the directory
  // *holds*.
  //
  // Only where dune generated rules for this directory. Everywhere else
  // `goToDir` resolves no slice and returns, so the button would be a control
  // that does nothing on the ~15% of rows that have no span (see
  // model/dir_explorer.ts's `DirEntry.nGenRules`).
  private renderSelect(
    attrs: DirExplorerPanelAttrs,
    dir: DirEntry,
  ): m.Children {
    if (dir.nGenRules !== 1) return undefined;
    return m(
      'span.pf-dune-tree__group-select',
      // Not part of the row's collapse toggle: the header's own `onclick`
      // would otherwise expand the directory as well as select it.
      {onclick: (e: Event) => e.stopPropagation()},
      m(Button, {
        icon: Icons.UpdateSelection,
        compact: true,
        title: `Select ${dirPathLabel(dir.path)}`,
        onclick: () => void attrs.controller.goToDir(dir.id),
      }),
    );
  }

  // The node ids are fetched by the click rather than held: a row generally
  // knows only its member count when drawn. Omitted box and all when there is
  // nothing to act on, since the box is a padded flex container and an empty
  // one shows as a gap. `onFilterToDir` rides in the same box, directory rows
  // only - a bucket is one kind of one directory.
  private renderBulk(
    attrs: DirExplorerPanelAttrs,
    dir: DirEntry,
    kinds: readonly NodeKind[],
    count: number,
    narrowTo?: (dir: DirEntry) => void,
  ): m.Children {
    if (count === 0 && narrowTo === undefined) return undefined;
    const where = dirPathLabel(dir.path);
    // Whether *this* row is the one the caller's filter names. By id, since
    // that is what was handed out, and through `rowIdFor` first exactly as the
    // expansion set goes through `remapKeys`: compression re-decides which
    // directory carries a row on every rebuild. Undefined back means nothing
    // matching is under the brushed directory, so no row draws pressed.
    const narrowedTo = attrs.filteredDirId;
    const narrowedRow =
      narrowedTo === undefined
        ? undefined
        : (this.tree?.rowIdFor(narrowedTo) ?? narrowedTo);
    const narrowedHere = narrowedRow !== undefined && narrowedRow === dir.id;
    return m(
      'span.pf-dune-tree__group-actions',
      // The buttons are not part of the row's collapse toggle. This is what
      // keeps the narrowing toggle from also expanding the directory - the
      // header's own `onclick` would otherwise see the same click.
      {onclick: (e: Event) => e.stopPropagation()},
      // Offered whatever this directory holds *directly*, unlike the bulk pair:
      // narrowing is to the subtree, and a directory of pure scaffolding with
      // 5,000 rows below it is exactly the one worth narrowing to.
      narrowTo !== undefined &&
        m(Button, {
          icon: 'filter_alt',
          // Filled and pressed together: the fill is what reads at a glance in
          // a column of identical outline icons, and `active` is what says the
          // button is a state rather than an action (see widgets/button.ts).
          iconFilled: narrowedHere,
          active: narrowedHere,
          compact: true,
          title: narrowedHere
            ? `Stop narrowing everything else to ${where}`
            : `Narrow everything else to ${where} and below`,
          onclick: () => narrowTo(dir),
        }),
      count > 0 &&
        bulkNodeActions(
          attrs.controller,
          count,
          () =>
            attrs.source.dirMemberIds(
              dir.id,
              kinds,
              this.filter,
              this.dirPathMatches(dir),
            ),
          `directly in ${where}`,
        ),
    );
  }

  // Subtree totals while collapsed - that is what is behind the caret - and
  // direct counts once open, where a subtree total would double-count what the
  // children now show for themselves.
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
      return this.narrowed() && n !== of
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
    // so neither can be narrowed to the rows on screen. Dropped whenever those
    // are a subset rather than shown as an unqualified number next to qualified
    // ones.
    if (!this.narrowed() && this.show.rule && failed > 0) {
      parts.push(m('span.pf-dune-explorer__failed', `${failed} failed`));
    }
    // Timing is rule spans only (see sql_graph.ts), so it belongs to the rules
    // and goes when they do.
    if (!this.narrowed() && !open && this.show.rule && dir.totalDurNs > 0n) {
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

  // Inline while there are few enough, behind a per-kind bucket otherwise. The
  // threshold is on the *visible* count, so hiding deps genuinely un-buckets a
  // directory - and is the one case where toggling a kind on costs a query,
  // since the inline list is a different member query from either bucket's.
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
    const key = bucketKey(dir.id, kind);
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

  // The same chip every other DataGrid draws for a node id, with one
  // difference: a dep's path loses its directory, since the row already sits
  // under a heading saying it. The full path stays on hover.
  //
  // Clicking the link moves the timeline selection, and the controller - not
  // this pane - is what brings the main panel forward, so every route to a
  // node behaves the same (see `revealPanelWhenSelected`).
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

  // Only valid off a *complete* both-kinds list: a truncated one is the first
  // page of the two kinds interleaved, so filtering it would silently drop the
  // members past the cut.
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
    const dirId = dirIdOfKey(key);
    if (this.children.get(dirId)?.error !== undefined) {
      this.children.delete(dirId);
    }
    for (const [memberId, state] of [...this.members]) {
      if (state.error !== undefined && memberId.startsWith(`${dirId}:`)) {
        this.members.delete(memberId);
      }
    }
  }

  // Both kinds is its own key, not the union of the two single-kind ones: it is
  // a different, differently paged query. The filter is in the key because it
  // changes which rows independently of which kinds - belt and braces, since
  // the caches are cleared on apply, but a key without it would be a silently
  // wrong cache hit if that stopped being true.
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
    void attrs.source
      .rootDirs()
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
    void attrs.source
      .childDirs(id)
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
    void attrs.source
      .dirMembers(id, kind, MEMBER_PAGE, offset, this.filter, dirPathMatches)
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
 * What {@link renderMirrorNotLoaded} is standing in for, so the prompt names the
 * thing the caller could not draw rather than a generic table.
 */
interface MirrorDependant {
  /** The absent surface's own icon, so the prompt still looks like its card. */
  readonly icon: string;
  readonly title: string;
  /** What is missing and where it would have come from. */
  readonly note: string;
}

// The directory tree's, which is what this prompt was written for and stays the
// default so the two tree surfaces need not repeat themselves.
const DIR_TREE_DEPENDANT: MirrorDependant = {
  icon: 'account_tree',
  title: 'Directory tree not loaded',
  note:
    "The build's directories come from the graph's node tables, which have " +
    'not been built for this trace yet.',
};

// The prompt shown in place of a surface whose node tier has not been built.
// Exported rather than inlined because four surfaces need the same offer and
// the chart cannot mount the pane to get it: the pane needs a source, and a
// source that cannot read anything yet is not one. `what` says which surface
// is missing; it defaults to the directory tree.
export function renderMirrorNotLoaded(
  controller: DuneGraphController,
  what: MirrorDependant = DIR_TREE_DEPENDANT,
): m.Children {
  return m(
    EmptyState,
    {icon: what.icon, title: what.title},
    m('.pf-dune-graph__load-note', what.note),
    m(Button, {
      label: 'Load graph',
      icon: 'play_arrow',
      intent: Intent.Primary,
      disabled: controller.busy,
      onclick: () => void controller.load(),
    }),
  );
}

// A row's label: its path relative to the row above it - its own name when
// uncompressed, the whole collapsed run (`default/lib`) when not. The parent's
// path is a prefix and both separators are one character (see dir_tree.ts), so
// the suffix is a slice. The top-level directory is never a parent, so it only
// appears as its own label.
//
// Exported for its unit test: off by one here silently eats the first character
// of every nested directory's name.
export function dirLabel(
  dir: Pick<DirEntry, 'path'>,
  parentPath: string,
): string {
  if (dir.path === '') return TOP_LEVEL_LABEL;
  const suffix =
    parentPath === '' ? dir.path : dir.path.slice(parentPath.length + 1);
  return `${suffix}/`;
}

// A dep's path with its containing directory dropped, or undefined when there
// is nothing to drop - so the caller can tell "abbreviated, put the full path
// on hover" from "already as short as it gets".
//
// Only deps: a rule's label is its bare dune id and contains no path.
//
// The separator is checked rather than assumed: a silent `slice()` past a
// non-separator would chop a real character off the name, and a wrong label on
// a build artefact is worse than an unabbreviated one.
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

/**
 * Row keys. A directory row and its per-kind buckets are separate collapsible
 * rows of the same directory, so they need separate keys off the same id.
 *
 * Built through functions rather than inline templates because the expansion set
 * has to be *re-keyed* when a filter changes which directory a row is keyed on
 * (see {@link remapKeys}), which means parsing them back again.
 */
/**
 * Which row of a level leads to a directory: the row that *is* it, else the
 * deepest row whose path contains it.
 *
 * Deepest, because several can: a build's paths mix absolute and relative
 * ones, so the top level (path `''`) is nominally above every root, and
 * following it would descend into the wrong subtree and give up there.
 */
function rowToward(
  rows: readonly DirEntry[],
  target: {readonly id: number; readonly path: string},
): DirEntry | undefined {
  let best: DirEntry | undefined;
  for (const row of rows) {
    if (row.id === target.id || row.path === target.path) return row;
    if (!target.path.startsWith(`${row.path}/`) && row.path !== '') continue;
    if (best === undefined || row.path.length > best.path.length) best = row;
  }
  return best;
}

function dirKey(id: number): string {
  return `dir:${id}`;
}

function bucketKey(id: number, kind: NodeKind): string {
  return `bucket:${id}:${kind}`;
}

// The directory id a row key names.
function dirIdOfKey(key: string): number {
  return Number(key.slice(key.indexOf(':') + 1).split(':')[0]);
}

// Both kinds of key move: `dir:<_build>` can become `dir:<_build/default/lib>`
// and a bucket travels with its directory. Keys whose directory has nothing
// matching under it any more are dropped.
function remapKeys(keys: ReadonlySet<string>, tree: FilteredTree): Set<string> {
  const out = new Set<string>();
  for (const key of keys) {
    const row = tree.rowIdFor(dirIdOfKey(key));
    if (row === undefined) continue;
    if (key.startsWith('bucket:')) {
      out.add(bucketKey(row, key.slice(key.lastIndexOf(':') + 1) as NodeKind));
    } else {
      out.add(dirKey(row));
    }
  }
  return out;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
