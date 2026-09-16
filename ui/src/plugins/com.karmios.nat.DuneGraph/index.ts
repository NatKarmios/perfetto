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
import SqlModulesPlugin from '../dev.perfetto.SqlModules';
import {
  AUTO_LOAD_ROW_LIMIT_SETTING,
  DEFAULT_AUTO_LOAD_ROW_LIMIT,
  DuneGraphController,
} from './controller';
import {registerIdColumnRenderers} from './views/node_cell';
import {registerDirExplorerChart} from './explorer/dir_explorer_chart';
import {registerDuneMacroNodes} from './explorer/dune_macro_node';
import {registerDuneSourceNodes} from './explorer/dune_table_source';
import {registerNodeGraphChart} from './explorer/node_graph_chart';
import {DirExplorerPanel} from './views/dir_explorer_panel';
import {SqlDirExplorerSource} from './views/dir_explorer_source';
import {DuneGraphPanel} from './views/panel';
import {DuneQueryPage, QUERY_TAB_PERSISTENCE_SETTING} from './views/query_page';
import {DuneQueryTab} from './views/query_tab';
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
  // DataExplorerPlugin is for the hand-off (data_explorer_handoff.ts), which
  // calls into that plugin's public API, and for the chart types registered
  // below; SqlModulesPlugin is for the query page's "Tables" sidebar, which
  // lists the trace's stdlib alongside our own `dune_*` surface. Declaring
  // either orders its onTraceLoad before ours but does *not* enable it, so
  // both call sites still check that it is enabled before reaching for it.
  static readonly dependencies = [DataExplorerPlugin, SqlModulesPlugin];

  // The two settings, here rather than in `onTraceLoad` for two reasons:
  // `init()` and the query page both read a value while the trace is loading,
  // and a trace-scoped registration lives in the trace's `DisposableStack`, so
  // a setting would vanish off the settings page whenever no trace was open -
  // exactly when someone would go looking for it after being made to wait.
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

    // And the one toggle: whether the full-page query surface brings back the
    // tabs that were open last time (see QUERY_TAB_PERSISTENCE_SETTING). Off
    // by default, because the stored blob is a convenience the plugin makes no
    // promise to keep readable - which is what "experimental" is warning
    // about. Here rather than in `onTraceLoad` for the reasons above, plus one
    // of its own: the page reads the setting while being constructed, which
    // happens as the trace opens.
    app.settings.register({
      id: QUERY_TAB_PERSISTENCE_SETTING,
      name: 'Dune graph: remember query page tabs (experimental)',
      description:
        'Keep the editor tabs on the Dune query page - their names and their ' +
        'SQL, never their results - in browser storage, so they come back the ' +
        'next time the UI is loaded. Restored queries are never run: the ' +
        'dune_* tables they name may not exist yet. Experimental: stored ' +
        'queries can be lost across version upgrades. Off, the page opens on ' +
        'one empty tab and stores nothing.',
      schema: z.boolean(),
      defaultValue: false,
    });
  }

  async onTraceLoad(trace: Trace): Promise<void> {
    const controller = new DuneGraphController(trace);
    // Registers the "Dune graph" timeline track + workspace once, so the
    // graph pane's "Timeline" button is just a switchWorkspace() away.
    controller.installTimeline();

    // Teaches every DataGrid in the UI how to render a reference to one of our
    // nodes or directories: a column typed `JOINID(dune_node.node_id)` shows
    // the same chip (+ ＋/－ toggle) the query tab shows, and a
    // `JOINID(dune_dir.dir_id)` the same directory chip, wherever the grid
    // lives. The registrations are global, so they are scoped to this trace's
    // lifetime - see node_cell.ts.
    registerIdColumnRenderers(trace, controller);

    // Offers the directory Explorer below as a Data Explorer chart type, so it
    // can be dropped into a visualisation node or a dashboard alongside the
    // charts summarising the same build. Registered per-trace and scoped to
    // this trace's lifetime for the same reason as the renderer above - see
    // dir_explorer_chart.ts.
    registerDirExplorerChart(trace, controller);

    // And the graph pane below as a second one, over the nodes a query names
    // rather than over the ones clicked into the side panel's selection. Same
    // registration lifetime, for the same reason - see node_graph_chart.ts.
    registerNodeGraphChart(trace, controller);

    // Offers the mirror's tables as Data Explorer source nodes, so a graph can
    // start from `dune_node` without hand-written SQL. Nine menu entries in one
    // "Dune" submenu of that menu's "Sources" section; same registration
    // lifetime as the charts above, and for the same reason - see
    // dune_table_source.ts.
    registerDuneSourceNodes(trace, controller);

    // And the macros as nodes that go under one of those, so a walk is an
    // added node rather than hand-written SQL. Ten more entries, in a "Dune"
    // submenu of the "Modifications" section; the eight edge-tier ones stay
    // greyed out until that tier exists - see dune_macro_node.ts.
    registerDuneMacroNodes(trace, controller);

    trace.sidePanel.registerTab({
      uri: SIDE_PANEL_URI,
      title: 'Dune',
      icon: 'landscape',
      render: () => m(DuneGraphPanel, {controller, trace}),
    });
    // The same graph seen as directories rather than as a node selection (see
    // dir_explorer_panel.ts). A second tab rather than a third area of the
    // first: a directory tree wants the whole panel height, and has nothing to
    // do with what is selected.
    //
    // The source is built once rather than per render: the pane treats a new
    // source object as new data and drops everything it has cached, so handing
    // it a fresh one each frame would collapse the tree every frame.
    const dirSource = new SqlDirExplorerSource(trace.engine, controller);
    trace.sidePanel.registerTab({
      uri: EXPLORER_URI,
      title: 'Explorer',
      icon: 'account_tree',
      render: () => m(DirExplorerPanel, {controller, source: dirSource}),
    });

    // Whenever the selected node changes - clicked in the Explorer tree, on the
    // timeline, in the query tab, in the graph pane - bring the tab that
    // explains it forward. Wired here rather than in each of those places
    // because the tab URIs belong to this entry point, and because one rule
    // beats four call sites that would drift apart. The Explorer tab keeps its
    // state while hidden (the side panel gates inactive tabs rather than
    // unmounting them), so switching away costs nothing to come back from.
    controller.revealPanelWhenSelected(() =>
      trace.sidePanel.showTab(SIDE_PANEL_URI),
    );

    // And the other direction: the directory panel's "show in Explorer" brings
    // that tab forward, for the same reason the URIs are wired here rather
    // than in the panels - neither tab holds the other.
    controller.revealExplorerWhenAsked(() =>
      trace.sidePanel.showTab(EXPLORER_URI),
    );

    // Reveal the graph side panel on load rather than making the user open it.
    trace.sidePanel.showTab(SIDE_PANEL_URI);

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

    // The full-page query surface (see ARCHITECTURE.md, "The surfaces, in code"). Built
    // once here and rendered from the route, because the page's tabs and their
    // results have to survive navigating away and back; and built *before* the
    // drawer tab, so that tab's "Open in page" can hand it a query.
    const queryPage = new DuneQueryPage(trace, controller);

    // The drawer half of the same surface, fed by the '@' omnibox mode. The
    // input reuses the core SQL mode's look via `pf-omnibox--query-mode`,
    // recoloured orange by `pf-dune-query-mode`.
    //
    // "Open in page" escapes to the page above: a fresh page tab holding the
    // same SQL, run on arrival so it isn't an empty results pane, then the
    // navigation - which lives here because the route is this file's to know.
    const queryTab = new DuneQueryTab(trace, controller, (sql) => {
      queryPage.addTab(undefined, sql, true);
      trace.navigate(`#!${QUERY_PAGE_ROUTE}`);
    });
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

    // The page object itself is built above, before the drawer tab that sends
    // queries to it; the route only renders it.
    trace.pages.registerPage({
      route: QUERY_PAGE_ROUTE,
      render: () => queryPage.render(),
    });

    // A reload comes back on the page's own URL, but the core navigates to the
    // trace's landing page - the timeline - once every plugin's onTraceLoad has
    // run (see getInitialRoute() in core/load_trace.ts), which would bounce the
    // reader off the page they reloaded. Suggesting the route we came in on
    // keeps a reload where it was. Priority 10 is the "generic alternative
    // landing page" tier, below the format-specific pages that have a real
    // claim on what the trace is.
    if (trace.getCurrentRoute().page === QUERY_PAGE_ROUTE) {
      trace.initialPage.suggest(QUERY_PAGE_ROUTE, 10);
    }

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
