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
 * Hand-off to the Data Explorer: {@link appendExploreSource} *adds* one of the
 * mirror's tables to the graph the user is already working in, as a named
 * group, and nothing else - no dashboard, no export, no navigation anywhere.
 * These are the panel's buttons, which only exist while the Data Explorer is
 * the open page (see panel.ts).
 *
 * The JSON they hand over lives in explore_source.ts and its two sources
 * (dir_tree_graph.ts, node_source.ts).
 *
 * This is the only place DuneGraph reaches into another plugin. It goes through
 * the Data Explorer's public `getActiveGraphJson` / `setActiveGraphJson` (the
 * same entry point the Intelletto assistant uses), so nothing here depends on
 * that plugin's internals beyond the documented graph format.
 */

import m from 'mithril';
import {getErrorMessage} from '../../base/errors';
import type {Trace} from '../../public/trace';
import {showModal} from '../../widgets/modal';
import DataExplorerPlugin from '../dev.perfetto.DataExplorer';
import type {DuneGraphController} from './controller';
import {DIR_TREE_SOURCE} from './dir_tree_graph';
import type {ExploreSource} from './explore_source';
import {appendExploreSourceToGraph} from './explore_source';
import {NODE_SOURCE} from './node_source';

/**
 * The sources the panel offers to add to the current graph, in button order.
 * Both read the node tier of the mirror, so both are gated the same way.
 */
export const APPENDABLE_SOURCES: ReadonlyArray<ExploreSource> = [
  DIR_TREE_SOURCE,
  NODE_SOURCE,
];

/**
 * Adds `source` to the active graph as one named group, leaving everything
 * already in it - nodes, layouts, dashboards and all - alone.
 *
 * Deliberately no dashboard argument: the dashboards `setActiveGraphJson` takes
 * would *replace* the tab's, and there is no public getter for them to merge
 * into (see DATA_EXPLORER_PLAN.LOCAL.md, phase 5). And deliberately no export
 * node either (see explore_source.ts): this stops at putting the query in the
 * user's graph, and they decide whether it is published to a dashboard - which
 * is the natural hand-off point anyway, since only they know what they are
 * building.
 *
 * The whole graph round-trips through the Data Explorer's validation and
 * deserialization on every call, and `setActiveGraphJson` navigates to
 * `#!/explore` - a no-op here, since these buttons only exist while that is
 * already the open page.
 */
export async function appendExploreSource(
  trace: Trace,
  controller: DuneGraphController,
  source: ExploreSource,
): Promise<void> {
  const plugin = await ready(trace, controller);
  if (plugin === undefined) return;
  try {
    const {json} = appendExploreSourceToGraph(
      // undefined when the tab's graph is empty, which appends to nothing.
      plugin.getActiveGraphJson(),
      source,
    );
    plugin.setActiveGraphJson(trace, json);
  } catch (e) {
    await failed(`add ${source.exportName}`, getErrorMessage(e));
  }
}

/**
 * The two preconditions of a hand-off: the node tier of the mirror is built
 * (building it if not), and the Data Explorer is actually there.
 *
 * The tables the sources read only exist once that tier has been built (the
 * graph no longer loads with the trace - see controller.ts), so a load is part
 * of the action rather than a precondition to complain about: this runs the
 * controller's own `buildNodeMirror` step, whose progress and failure the side
 * panel already reports - and the panel is on screen, since its buttons are the
 * only way here. A failure of the load is therefore silent. The two ways the
 * hand-off itself can fail - the Data Explorer disabled, or its SQL modules not
 * ready - are modal, because nothing else in the UI is in a position to say so.
 *
 * @returns The Data Explorer plugin, or undefined if the hand-off cannot go
 *     ahead - in which case the reason has already been reported, by the side
 *     panel for a failed load and by a modal for a missing Data Explorer.
 */
async function ready(
  trace: Trace,
  controller: DuneGraphController,
): Promise<InstanceType<typeof DataExplorerPlugin> | undefined> {
  if (!controller.nodeMirrorReady) {
    await controller.buildNodeMirror();
    // Still not there: the load failed, and the panel shows why.
    if (!controller.nodeMirrorReady) return undefined;
  }

  // Declared as a dependency (see index.ts), which orders the plugins but does
  // not enable them - a user who has switched the Data Explorer off gets a
  // throw from getPlugin, not a broken page.
  if (!trace.plugins.isPluginEnabled(DataExplorerPlugin.id)) {
    await failed(
      'reach the Data Explorer',
      `The ${DataExplorerPlugin.id} plugin is disabled, so there is nowhere ` +
        'to show the build graph. Enable it in the plugin settings and try ' +
        'again.',
    );
    return undefined;
  }
  return trace.plugins.getPlugin(DataExplorerPlugin);
}

function failed(what: string, message: string): Promise<void> {
  return showModal({
    title: `Cannot ${what}`,
    icon: 'warning',
    content: m('p', message),
    buttons: [{text: 'OK', primary: true}],
  });
}
