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

import m from 'mithril';
import {shortUuid} from '../../base/uuid';
import {formatPerfettoSql} from '../../components/query_table/sql_formatter';
import {
  QueryHistoryComponent,
  queryHistoryStorage,
} from '../../components/widgets/query_history';
import type {Trace} from '../../public/trace';
import {Box} from '../../widgets/box';
import {Button, ButtonVariant} from '../../widgets/button';
import {Callout} from '../../widgets/callout';
import {Intent} from '../../widgets/common';
import {Editor} from '../../widgets/editor';
import {HotkeyGlyphs} from '../../widgets/hotkey_glyphs';
import {SplitPanel} from '../../widgets/split_panel';
import {Stack, StackAuto} from '../../widgets/stack';
import {Tabs, type TabsTab} from '../../widgets/tabs';
import {
  TableList,
  type TableListEntry,
} from '../../components/query_table/table_list';
import SqlModulesPlugin from '../dev.perfetto.SqlModules';
import type {DuneGraphController} from './controller';
import {duneTableSections} from './dune_tables';
import {DuneQueryResults} from './query_results';

// One editor tab: an editor buffer plus the results view it runs into. Every
// field is readonly because the whole tab list is only ever moved forward by
// the pure helpers below, which replace tabs rather than mutate them - that's
// what makes the bookkeeping (auto-naming, close-the-active-one, reorder)
// testable without a mithril tree or a real `DuneQueryResults`.
export interface DunePageTab {
  readonly id: string;
  readonly title: string;
  readonly editorText: string;
  readonly results: DuneQueryResults;
}

// The page's entire state bar the sidebar toggle: which tabs exist, in what
// order, and which one is showing.
export interface DuneTabList {
  readonly tabs: readonly DunePageTab[];
  readonly activeTabId: string;
}

// Prefix for auto-named tabs; a rename replaces the whole title, so a renamed
// tab simply stops being counted by `nextTabTitle`.
const TAB_NAME_PREFIX = 'Query';

/**
 * The name a new tab gets when the caller doesn't supply one: `Query N` for the
 * lowest free N, as the core query page does. Lowest-free rather than
 * next-highest so closing "Query 2" of three and adding one reuses the gap
 * instead of climbing forever.
 */
export function nextTabTitle(tabs: readonly DunePageTab[]): string {
  const taken = new Set(tabs.map((t) => t.title));
  let n = 1;
  while (taken.has(`${TAB_NAME_PREFIX} ${n}`)) n++;
  return `${TAB_NAME_PREFIX} ${n}`;
}

/** Appends `tab` and focuses it. */
export function addTab(state: DuneTabList, tab: DunePageTab): DuneTabList {
  return {tabs: [...state.tabs, tab], activeTabId: tab.id};
}

/**
 * Drops the tab with `id`, or returns `state` unchanged when that would leave
 * the page with no tabs at all (the tab strip's close buttons are hidden in
 * that case, but a caller shouldn't have to know that). Closing the tab that
 * was showing moves to the one that took its place, or to the new last tab
 * when the closed one was last.
 */
export function closeTab(state: DuneTabList, id: string): DuneTabList {
  if (state.tabs.length <= 1) return state;
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index === -1) return state;
  const tabs = state.tabs.filter((t) => t.id !== id);
  if (state.activeTabId !== id) return {tabs, activeTabId: state.activeTabId};
  const next = Math.min(index, tabs.length - 1);
  return {tabs, activeTabId: tabs[next].id};
}

/** Retitles one tab, leaving the rest of the list (and the focus) alone. */
export function renameTab(
  state: DuneTabList,
  id: string,
  title: string,
): DuneTabList {
  return patchTab(state, id, (tab) => ({...tab, title}));
}

/** Replaces one tab's editor buffer. */
export function setTabText(
  state: DuneTabList,
  id: string,
  editorText: string,
): DuneTabList {
  return patchTab(state, id, (tab) => ({...tab, editorText}));
}

/**
 * Moves `draggedId` to sit immediately before `beforeId`, or to the end when
 * `beforeId` is undefined - the drop-target shape `Tabs` reports. An unknown
 * `beforeId` also means the end, since the only way to get one is a tab that
 * went away mid-drag.
 */
export function reorderTabs(
  state: DuneTabList,
  draggedId: string,
  beforeId: string | undefined,
): DuneTabList {
  const dragged = state.tabs.find((t) => t.id === draggedId);
  if (dragged === undefined) return state;
  // "Before myself" is where the dragged tab already is, so nothing moves.
  // `Tabs` does report it: dropping on the right half of the tab to our left
  // is phrased as "before the tab after that one", which is us. Guarding here
  // rather than letting it fall through, because by then the dragged tab is no
  // longer in `rest` to be found and it would be appended to the end instead.
  if (beforeId === draggedId) return state;
  const rest = state.tabs.filter((t) => t.id !== draggedId);
  const at =
    beforeId === undefined ? -1 : rest.findIndex((t) => t.id === beforeId);
  const tabs =
    at === -1
      ? [...rest, dragged]
      : [...rest.slice(0, at), dragged, ...rest.slice(at)];
  return {tabs, activeTabId: state.activeTabId};
}

function patchTab(
  state: DuneTabList,
  id: string,
  patch: (tab: DunePageTab) => DunePageTab,
): DuneTabList {
  const tabs = state.tabs.map((t) => (t.id === id ? patch(t) : t));
  return {tabs, activeTabId: state.activeTabId};
}

/**
 * A full page of SQL over the Dune graph tables: a strip of editor tabs, each
 * with its own editor buffer and its own {@link DuneQueryResults} below it, and
 * a query-history sidebar.
 *
 * The sibling of `DuneQueryTab` rather than a replacement for it - both wrap
 * the same surface-agnostic results view, which is where all the node-aware
 * rendering (kind chips, ＋/－ toggles, tree mode) lives. What the page adds
 * over the drawer tab is room: several queries kept side by side, and the
 * graph-load state called out *before* a query is run rather than reported as
 * an error afterwards (see `renderGraphState`).
 *
 * Not an `m.ClassComponent`: the plugin builds one and calls `render()` from
 * the page route, so the tabs and their results survive navigating away and
 * back - a mithril component would be torn down with the route.
 */
export class DuneQueryPage {
  private state: DuneTabList = {tabs: [], activeTabId: ''};
  // Deliberately a plain field rather than a registered setting: the toggle is
  // worth remembering for the session, not worth a line on the settings page.
  private sidebarVisible = true;

  constructor(
    private readonly trace: Trace,
    private readonly controller: DuneGraphController,
  ) {
    this.addTab();
  }

  /**
   * Opens a tab, focuses it, and optionally runs `query` in it straight away -
   * the entry point for anything that wants to hand the page a query (a
   * command, the omnibox, a "query this" affordance elsewhere in the plugin).
   */
  addTab(title?: string, query?: string, autoExecute?: boolean): void {
    const tab: DunePageTab = {
      id: shortUuid(),
      title: title ?? nextTabTitle(this.state.tabs),
      editorText: query ?? '',
      results: new DuneQueryResults(this.trace, this.controller, () =>
        this.trace.navigate('#!/viewer'),
      ),
    };
    this.state = addTab(this.state, tab);
    if (autoExecute === true) void this.execute(tab, tab.editorText);
  }

  render(): m.Children {
    const editorTabs = m(Tabs, {
      className: 'pf-dune-query-page__editor-tabs',
      tabs: this.state.tabs.map((tab): TabsTab => this.tabHandle(tab)),
      activeTabKey: this.state.activeTabId,
      reorderable: true,
      onTabChange: (key) => {
        this.state = {tabs: this.state.tabs, activeTabId: key};
      },
      onTabClose: (key) => {
        this.state = closeTab(this.state, key);
      },
      onTabRename: (key, title) => {
        this.state = renameTab(this.state, key, title);
      },
      onTabReorder: (key, beforeKey) => {
        this.state = reorderTabs(this.state, key, beforeKey);
      },
      newTabContent: [
        m(Button, {
          icon: 'add',
          className: 'pf-tabs__new-tab-btn',
          title: 'New query tab',
          onclick: () => this.addTab(),
        }),
        m('.pf-dune-query-page__tab-spacer'),
        m(Button, {
          icon: this.sidebarVisible ? 'right_panel_close' : 'right_panel_open',
          title: this.sidebarVisible ? 'Hide sidebar' : 'Show sidebar',
          active: this.sidebarVisible,
          onclick: () => {
            this.sidebarVisible = !this.sidebarVisible;
          },
        }),
      ],
    });

    if (!this.sidebarVisible) {
      return m('.pf-dune-query-page', editorTabs);
    }
    return m(
      '.pf-dune-query-page',
      m(SplitPanel, {
        direction: 'horizontal',
        initialSplit: {pixels: 500},
        controlledPanel: 'second',
        minSize: 100,
        firstPanel: editorTabs,
        secondPanel: this.renderSidebar(),
      }),
    );
  }

  // History and the table reference, as the core query page's sidebar has
  // them. Uncontrolled `Tabs`: which one is showing is a passing preference,
  // not state anything else needs to read.
  private renderSidebar(): m.Children {
    return m(Tabs, {
      className: 'pf-dune-query-page__sidebar',
      tabs: [
        {
          key: 'history',
          title: 'History',
          leftIcon: 'history',
          content: this.renderHistory(),
        },
        {
          key: 'tables',
          title: 'Tables',
          leftIcon: 'table_chart',
          content: this.renderTables(),
        },
      ],
    });
  }

  // The `dune_*` surface, then the trace's own stdlib. Opening a table puts
  // its query in a *new* tab (rather than replacing the active one, as the
  // history does): you go to the reference to start something, not to redo it.
  private renderTables(): m.Children {
    return m(TableList, {
      sections: duneTableSections(this.stdlibTables()),
      onQueryTable: (tableName, query) => this.addTab(tableName, query, true),
    });
  }

  // The stdlib catalogue, or undefined while it is still loading - or when the
  // SqlModules plugin is disabled, which is allowed: it is a declared
  // dependency of ours for ordering, not a hard requirement, and the Dune
  // sections are useful without it.
  private stdlibTables(): ReadonlyArray<TableListEntry> | undefined {
    if (!this.trace.plugins.isPluginEnabled(SqlModulesPlugin.id)) {
      return undefined;
    }
    return this.trace.plugins
      .getPlugin(SqlModulesPlugin)
      .getSqlModules()
      ?.listTables();
  }

  // A plain string title, deliberately: `Tabs` only offers inline rename on
  // tabs whose title is a string, and the rename it hands back is whatever the
  // handle showed - so dressing the title up (with a row count, say) would
  // cost the rename.
  private tabHandle(tab: DunePageTab): TabsTab {
    return {
      key: tab.id,
      title: tab.title,
      leftIcon: 'code',
      // Only when there's something to fall back to: `closeTab` refuses to
      // drop the last tab, so offering the button there would do nothing.
      closeButton: this.state.tabs.length > 1,
      content: this.renderTab(tab),
    };
  }

  private renderTab(tab: DunePageTab): m.Children {
    return m(SplitPanel, {
      direction: 'vertical',
      initialSplit: {percent: 50},
      minSize: 100,
      firstPanel: this.renderEditor(tab),
      secondPanel: tab.results.render(),
    });
  }

  private renderEditor(tab: DunePageTab): m.Children {
    return m('.pf-dune-query-page__editor-panel', [
      m(
        Box,
        {className: 'pf-dune-query-page__toolbar'},
        m(Stack, {orientation: 'horizontal'}, [
          m(Button, {
            label: 'Run Query',
            icon: 'play_arrow',
            loading: tab.results.isLoading,
            intent: tab.results.isLoading ? Intent.None : Intent.Primary,
            variant: ButtonVariant.Filled,
            onclick: () => void this.execute(tab, tab.editorText),
          }),
          m(
            Stack,
            {
              orientation: 'horizontal',
              className: 'pf-dune-query-page__hotkeys',
            },
            'or press',
            m(HotkeyGlyphs, {hotkey: 'Mod+Enter'}),
          ),
          m(StackAuto),
          m(Button, {
            label: 'Format',
            icon: 'format_align_left',
            title: 'Auto-format the SQL query',
            onclick: () => void this.format(tab.id, tab.editorText),
          }),
        ]),
      ),
      this.renderGraphState(),
      m(Editor, {
        language: 'perfetto-sql',
        text: tab.editorText,
        onUpdate: (text) => {
          this.state = setTabText(this.state, tab.id, text);
        },
        onExecute: (text) => void this.execute(tab, text),
        onFormat: (text) => void this.format(tab.id, text),
      }),
    ]);
  }

  /**
   * The one thing this page tells the user that the drawer tab can't: the
   * `dune_*` tables don't exist until the graph is loaded, and here we can say
   * so (and offer the load) *before* a query is typed rather than failing it
   * afterwards - see `DuneQueryResults.missingTables`. Same offer panel.ts and
   * dir_explorer_panel.ts make, so the same wording and the same button; the
   * button stays put while a load runs (disabled) so an in-flight load reads
   * as progress rather than as a dead control.
   */
  private renderGraphState(): m.Children {
    const {controller} = this;
    if (controller.nodeMirrorReady) return undefined;
    const {graphStep} = controller;
    const failed = graphStep.error !== undefined;
    let message: string;
    if (failed) {
      message = `The Dune graph failed to load: ${graphStep.error}`;
    } else if (controller.busy) {
      message = 'Loading the build graph…';
    } else {
      message =
        'The Dune graph is not loaded yet, so there are no dune_* tables ' +
        'to query.';
    }
    return m(
      Box,
      m(
        Callout,
        {
          className: 'pf-dune-query-page__graph-state',
          icon: failed ? 'error' : 'warning',
        },
        m('span', message),
        m(Button, {
          label: failed ? 'Retry' : 'Load graph',
          icon: 'play_arrow',
          intent: Intent.Primary,
          disabled: controller.busy,
          onclick: () => void controller.load(),
        }),
      ),
    );
  }

  // The history sidebar drives the *active* tab rather than opening a new one,
  // so re-running an old query is a replacement for what's in front of you.
  private renderHistory(): m.Children {
    return m(QueryHistoryComponent, {
      className: 'pf-dune-query-page__history',
      trace: this.trace,
      runQuery: (query: string) => {
        const tab = this.activeTab();
        if (tab !== undefined) void this.execute(tab, query);
      },
      setQuery: (query: string) => {
        this.state = setTabText(this.state, this.state.activeTabId, query);
      },
    });
  }

  private activeTab(): DunePageTab | undefined {
    return this.state.tabs.find((t) => t.id === this.state.activeTabId);
  }

  // `runQuery` owns the loading/error state and redraws itself, so all this
  // adds is the history entry - and the empty-query guard, which keeps a stray
  // Mod+Enter out of the history.
  private async execute(tab: DunePageTab, text: string): Promise<void> {
    if (text.trim() === '') return;
    queryHistoryStorage.saveQuery(text);
    await tab.results.runQuery(text);
  }

  private async format(id: string, text: string): Promise<void> {
    const formatted = await formatPerfettoSql(text);
    if (formatted === undefined) return;
    this.state = setTabText(this.state, id, formatted);
    m.redraw();
  }
}
