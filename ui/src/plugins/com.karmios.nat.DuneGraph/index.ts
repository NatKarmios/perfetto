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
import {z} from 'zod';
import type {App} from '../../public/app';
import type {PerfettoPlugin} from '../../public/plugin';
import type {Trace} from '../../public/trace';
import DataExplorerPlugin from '../dev.perfetto.DataExplorer';
import {
  AUTO_LOAD_ROW_LIMIT_SETTING,
  DEFAULT_AUTO_LOAD_ROW_LIMIT,
  DuneGraphController,
} from './controller';
import {exploreDirTree} from './data_explorer_handoff';
import {registerNodeColumnRenderer} from './node_cell';
import {DirExplorerPanel} from './dir_explorer_panel';
import {DuneGraphPanel} from './panel';
import {DuneQueryPage} from './query_page';
import {DuneQueryTab} from './query_tab';
import {dumpPerfRuns} from './perf';
import './styles.scss';

const PLUGIN_ID = 'com.karmios.nat.DuneGraph';
const SIDE_PANEL_URI = `${PLUGIN_ID}#Nodes`;
const EXPLORER_URI = `${PLUGIN_ID}#Explorer`;
const QUERY_TAB_URI = `${PLUGIN_ID}#Query`;
// Route of the full-page query surface; '#!' + this is the fragment the sidebar
// entry links to and the command navigates to.
const QUERY_PAGE_ROUTE = '/dune_query';
// Omnibox trigger for the Dune-graph SQL mode (':' and '>' are already taken).
const QUERY_TRIGGER = '@';

export default class implements PerfettoPlugin {
  static readonly id = PLUGIN_ID;
  static readonly description =
    'Explore the Dune build graph extracted from the trace.';
  // For the directory-tree hand-off (data_explorer_handoff.ts), which calls
  // into the Data Explorer's public API. Declaring it orders the two plugins'
  // onTraceLoad but does *not* enable the dependency, so the hand-off still
  // checks that it is enabled before reaching for it.
  static readonly dependencies = [DataExplorerPlugin];

  /**
   * Registers the one number the user is asked about: how big a build graph
   * may be before opening its trace stops loading it and starts offering to
   * (see controller.ts's AUTO_LOAD_ROW_LIMIT_SETTING for why it is rows, and
   * why it is the only such number).
   *
   * Here rather than in `onTraceLoad` for two reasons: `init()` reads the value
   * while the trace is loading, and a trace-scoped registration lives in the
   * trace's `DisposableStack`, so the setting would vanish off the settings
   * page whenever no trace was open - which is exactly when someone would go
   * looking for it after being made to wait. The plugin manager injects our
   * plugin id, so it files itself under this plugin with no extra work.
   */
  static async onActivate(app: App): Promise<void> {
    app.settings.register({
      id: AUTO_LOAD_ROW_LIMIT_SETTING,
      name: 'Dune graph: load without asking below (edge rows)',
      description:
        'Estimated stored edge rows below which the Dune build graph loads ' +
        'as soon as the trace opens. Above it the side panel ' +
        'shows what a load would cost and waits to be asked. 0 always asks; ' +
        'there is no upper bound, so a large enough number never asks. Takes ' +
        'effect the next time a trace is opened.',
      // No .max(): "never ask" is worth being able to express, and the number
      // it takes is the estimate, which has no ceiling of its own.
      schema: z.number().int().min(0),
      defaultValue: DEFAULT_AUTO_LOAD_ROW_LIMIT,
    });
  }

  async onTraceLoad(trace: Trace): Promise<void> {
    const controller = new DuneGraphController(trace);
    // Registers the "Dune graph" timeline track + workspace once, so the
    // graph pane's "Timeline" button is just a switchWorkspace() away.
    controller.installTimeline();

    // Teaches every DataGrid in the UI how to render a reference to one of our
    // nodes: a column typed `JOINID(dune_node.node_id)` shows the same chip
    // (+ ＋/－ toggle) the query tab shows, wherever the grid lives. The
    // registration is global, so it is scoped to this trace's lifetime - see
    // node_cell.ts.
    registerNodeColumnRenderer(trace, controller);

    trace.sidePanel.registerTab({
      uri: SIDE_PANEL_URI,
      title: 'Dune',
      icon: 'landscape',
      render: () => m(DuneGraphPanel, {controller, trace}),
    });
    // The same graph seen as directories rather than as a node selection: a
    // lazily-descended trie of `dune_dir` with each directory's rules and deps
    // at it (see dir_explorer_panel.ts). A second tab rather than a third area
    // of the first one - a directory tree wants the whole height of the panel,
    // and it has nothing to do with what is currently selected.
    trace.sidePanel.registerTab({
      uri: EXPLORER_URI,
      title: 'Explorer',
      icon: 'account_tree',
      render: () => m(DirExplorerPanel, {controller, trace}),
    });

    // Whenever the selected node changes - clicked in the Explorer tree, on the
    // timeline, in the query tab, in the graph pane - bring the tab that
    // explains it forward. Wired here rather than in each of those places
    // because the tab URIs belong to this entry point, and because one rule
    // beats four call sites that would drift apart. The Explorer tab keeps its
    // state while hidden (the side panel gates inactive tabs rather than
    // unmounting them), so switching away costs nothing to come back from.
    controller.revealPanelWhenNodeSelected(() =>
      trace.sidePanel.showTab(SIDE_PANEL_URI),
    );

    // Reveal the graph side panel on load rather than making the user open it.
    trace.sidePanel.showTab(SIDE_PANEL_URI);

    trace.commands.registerCommand({
      id: `${PLUGIN_ID}#ShowNodes`,
      name: 'Dune: show build graph',
      callback: () => trace.sidePanel.showTab(SIDE_PANEL_URI),
    });

    trace.commands.registerCommand({
      id: `${PLUGIN_ID}#ShowExplorer`,
      name: 'Dune: show directory explorer',
      callback: () => trace.sidePanel.showTab(EXPLORER_URI),
    });

    trace.commands.registerCommand({
      id: `${PLUGIN_ID}#Load`,
      name: 'Dune: load build graph',
      callback: () => controller.load(),
    });

    trace.commands.registerCommand({
      id: `${PLUGIN_ID}#Reload`,
      name: 'Dune: reload build graph',
      callback: () => controller.reload(),
    });

    // The edge tier is the expensive half of the mirror, and a load builds it
    // along with everything else. This is the way back when that one step
    // failed on its own, or was dropped and is wanted again - not a prompt.
    // See controller.ts and PERF_PLAN.LOCAL.md.
    trace.commands.registerCommand({
      id: `${PLUGIN_ID}#MaterialiseEdges`,
      name: 'Dune: materialise edge table',
      callback: () => controller.buildEdgeMirror(),
    });

    // The build seen as directories rather than as nodes: hands `dune_dir`
    // (see sql_graph.ts) to the Data Explorer as a ready-made dashboard whose
    // one item is a collapsible tree of the build's directories. Loads the
    // graph first if it isn't loaded, reporting that in the side panel - hence
    // revealing it before the wait. See data_explorer_handoff.ts.
    trace.commands.registerCommand({
      id: `${PLUGIN_ID}#ExploreDirTree`,
      name: 'Dune: explore directory tree in Data Explorer',
      callback: () => {
        void exploreDirTree(trace, controller, () =>
          trace.sidePanel.showTab(SIDE_PANEL_URI),
        );
      },
    });

    // Re-prints the per-phase timing/heap breakdown of the last few loads to
    // the devtools console (each load also prints its own when it finishes).
    // See perf.ts and PERF_PLAN.LOCAL.md.
    trace.commands.registerCommand({
      id: `${PLUGIN_ID}#DumpLoadStats`,
      name: 'Dune: dump load stats',
      callback: () => dumpPerfRuns(),
    });

    // SQL-over-the-graph: a details-drawer tab fed by an omnibox mode (type a
    // query after '@') and an equivalent command that activates that mode. The
    // input reuses the core SQL mode's look (wide black monospace box) via
    // `pf-omnibox--query-mode`, recoloured orange by `pf-dune-query-mode`.
    const queryTab = new DuneQueryTab(trace, controller);
    trace.tabs.registerTab({uri: QUERY_TAB_URI, content: queryTab});

    trace.omnibox.registerMode({
      trigger: QUERY_TRIGGER,
      hint: `'${QUERY_TRIGGER}' for Dune graph SQL`,
      placeholder:
        'SQL over dune_node / dune_edge / dune_rule / dune_dep / ' +
        'dune_string / dune_process / dune_descendants / dune_ancestors / … ' +
        '— add nodes via node / src / dst / slice_id columns',
      className: 'pf-omnibox--query-mode pf-dune-query-mode',
      onSubmit: (query: string) => {
        void queryTab.runQuery(query);
        trace.tabs.showTab(QUERY_TAB_URI);
      },
    });

    trace.commands.registerCommand({
      id: `${PLUGIN_ID}#QueryGraph`,
      name: 'Dune: query graph',
      callback: () => trace.omnibox.activateRegisteredMode(QUERY_TRIGGER),
    });

    // The same SQL, given a whole page: several queries kept side by side, each
    // with its own editor and results, plus the history sidebar and the
    // graph-load state shown before a query is run rather than as an error
    // after it. Alongside the drawer tab above, not instead of it - the '@'
    // mode is the fast one-off lookup next to the timeline you are reading,
    // this is where a session of exploring the graph happens. Built once here
    // and rendered from the route because the page's tabs and their results
    // have to survive navigating away and back (see query_page.ts).
    const queryPage = new DuneQueryPage(trace, controller);
    trace.pages.registerPage({
      route: QUERY_PAGE_ROUTE,
      render: () => queryPage.render(),
    });

    trace.sidebar.addMenuItem({
      section: 'current_trace',
      text: 'Dune Query (SQL)',
      href: `#!${QUERY_PAGE_ROUTE}`,
      icon: 'database',
      // Immediately after the core "Query (SQL)" entry (21), which is the thing
      // it is a variant of, and before "Metrics" (22).
      sortOrder: 21.5,
    });

    trace.commands.registerCommand({
      id: `${PLUGIN_ID}#QueryPage`,
      name: 'Dune: open query page',
      callback: () => trace.navigate(`#!${QUERY_PAGE_ROUTE}`),
    });

    // Deliberately NOT awaited, and deliberately not a load: onTraceLoad is on
    // the critical path of opening the trace, and on a large trace the graph
    // load is minutes of work that would hold up the whole UI (and exhaust the
    // trace processor heap under every other plugin). init() only reads the
    // cheap headline counts, and starts a load by itself only when the trace's
    // estimated edge rows are under the "load without asking below" setting
    // registered in onActivate() - otherwise the side panel offers it as an
    // explicit action. See controller.ts and PERF_PLAN.LOCAL.md.
    void controller.init();
  }
}
