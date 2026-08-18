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
import type {PerfettoPlugin} from '../../public/plugin';
import type {Trace} from '../../public/trace';
import {DuneGraphController} from './controller';
import {DuneGraphPanel} from './panel';
import {DuneQueryTab} from './query_tab';
import {dumpPerfRuns} from './perf';
import './styles.scss';

const PLUGIN_ID = 'com.karmios.nat.DuneGraph';
const SIDE_PANEL_URI = `${PLUGIN_ID}#Nodes`;
const QUERY_TAB_URI = `${PLUGIN_ID}#Query`;
// Omnibox trigger for the Dune-graph SQL mode (':' and '>' are already taken).
const QUERY_TRIGGER = '@';

export default class implements PerfettoPlugin {
  static readonly id = PLUGIN_ID;
  static readonly description =
    'Explore the Dune build graph extracted from the trace.';

  async onTraceLoad(trace: Trace): Promise<void> {
    const controller = new DuneGraphController(trace);
    // Registers the "Dune graph" timeline track + workspace once, so the
    // graph pane's "Timeline" button is just a switchWorkspace() away.
    controller.installTimeline();

    trace.sidePanel.registerTab({
      uri: SIDE_PANEL_URI,
      title: 'Dune',
      icon: 'landscape',
      render: () => m(DuneGraphPanel, {controller}),
    });
    // Reveal the graph side panel on load rather than making the user open it.
    trace.sidePanel.showTab(SIDE_PANEL_URI);

    trace.commands.registerCommand({
      id: `${PLUGIN_ID}#ShowNodes`,
      name: 'Dune: show build graph',
      callback: () => trace.sidePanel.showTab(SIDE_PANEL_URI),
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

    // The edge tier is one SQL row per dependency edge - tens of millions on a
    // monorepo-scale trace - so a plain load leaves it out above a few million
    // and it has to be asked for. See controller.ts and PERF_PLAN.LOCAL.md.
    trace.commands.registerCommand({
      id: `${PLUGIN_ID}#MaterialiseEdges`,
      name: 'Dune: materialise edge table',
      callback: () => controller.buildEdgeMirror(),
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
        'dune_string / dune_descendants / dune_ancestors / … — add nodes via ' +
        'node / src / dst / slice_id columns',
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

    // Deliberately NOT awaited, and deliberately not a load: onTraceLoad is on
    // the critical path of opening the trace, and on a large trace the graph
    // load is minutes of work that would hold up the whole UI (and exhaust the
    // trace processor heap under every other plugin). init() only reads the
    // cheap headline counts, and starts a load by itself only when the trace is
    // small enough to be worth loading unprompted - otherwise the side panel
    // offers it as an explicit action. See controller.ts and
    // PERF_PLAN.LOCAL.md.
    void controller.init();
  }
}
