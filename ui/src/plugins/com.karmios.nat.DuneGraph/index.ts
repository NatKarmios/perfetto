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
import {NodeListPanel} from './node_list_panel';
import './styles.scss';

const PLUGIN_ID = 'com.karmios.nat.DuneGraph';
const SIDE_PANEL_URI = `${PLUGIN_ID}#Nodes`;

export default class implements PerfettoPlugin {
  static readonly id = PLUGIN_ID;
  static readonly description =
    'Explore the Dune build graph extracted from the trace.';

  async onTraceLoad(trace: Trace): Promise<void> {
    const controller = new DuneGraphController(trace);

    trace.sidePanel.registerTab({
      uri: SIDE_PANEL_URI,
      title: 'Dune graph',
      icon: 'account_tree',
      render: () => m(NodeListPanel, {trace, controller}),
    });

    trace.commands.registerCommand({
      id: `${PLUGIN_ID}#ShowNodes`,
      name: 'Dune: show build graph',
      callback: () => trace.sidePanel.showTab(SIDE_PANEL_URI),
    });

    trace.commands.registerCommand({
      id: `${PLUGIN_ID}#Reload`,
      name: 'Dune: reload build graph',
      callback: () => controller.reload(),
    });

    // Load the graph before onTraceLoad resolves so the sidebar has data by the
    // time the trace is ready.
    await controller.reload();
  }
}
