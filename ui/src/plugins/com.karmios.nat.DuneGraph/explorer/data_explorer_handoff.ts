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
 * The JSON they hand over lives in explore_source.ts and its three sources
 * (dir_tree_source.ts, node_source.ts, process_source.ts).
 *
 * This is the only place DuneGraph reaches into another plugin. It goes through
 * the Data Explorer's public `getActiveGraphJson` / `setActiveGraphJson` (the
 * same entry point the Intelletto assistant uses), so nothing here depends on
 * that plugin's internals beyond the documented graph format.
 */

import m from 'mithril';
import {getErrorMessage} from '../../../base/errors';
import type {Trace} from '../../../public/trace';
import {showModal} from '../../../widgets/modal';
import DataExplorerPlugin from '../../dev.perfetto.DataExplorer';
import type {DuneGraphController} from '../controller';
import {DIR_TREE_SOURCE} from './dir_tree_source';
import type {ExploreSource} from './explore_source';
import {appendExploreSourceToGraph} from './explore_source';
import {NODE_SOURCE} from './node_source';
import {PROCESS_SOURCE} from './process_source';

/**
 * The sources the panel offers to add to the current graph, in button order.
 * All three read the node tier of the mirror, so all three are gated the same
 * way.
 */
export const APPENDABLE_SOURCES: ReadonlyArray<ExploreSource> = [
  DIR_TREE_SOURCE,
  NODE_SOURCE,
  PROCESS_SOURCE,
];

// Adds `source` to the active graph as one named group, leaving everything
// already in it alone.
//
// Deliberately no dashboard argument: the dashboards `setActiveGraphJson` takes
// would *replace* the tab's, and there is no public getter to merge into.
//
// The whole graph round-trips through the Data Explorer's validation on every
// call, and `setActiveGraphJson` navigates to `#!/explore` - a no-op here,
// since these buttons only exist while that page is already open.
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
 * Whether the node tier is queryable, building it if it is not. False means the
 * load failed, and the failure is deliberately silent: everything that gets
 * here is on screen next to the side panel, which already reports progress and
 * failure, so a second report would only say it twice.
 *
 * The whole `load` rather than just `buildNodeMirror`, because on a trace big
 * enough not to load by itself this is the *first* load, and stopping at the
 * node tier would leave the edge tier idle with nothing offering to finish it
 * (panel.ts's prompt speaks for a refusal and an error, not for "never
 * started"). A graph past the hard edge cap still goes ahead - `load` skips that
 * tier and the panel explains it, and everything gated on this reads the node
 * tier anyway.
 *
 * Shared with the Data Explorer source nodes (dune_table_source.ts), whose
 * menu entries need the same tier under them before they mean anything.
 */
export async function ensureNodeMirror(
  controller: DuneGraphController,
): Promise<boolean> {
  if (controller.nodeMirrorReady) return true;
  await controller.load();
  return controller.nodeMirrorReady;
}

// The two preconditions of a hand-off: the node tier is built (building it if
// not), and the Data Explorer is actually there. Returns undefined when it
// cannot go ahead, the reason already reported - by the side panel for a failed
// load, by a modal for a missing Data Explorer.
async function ready(
  trace: Trace,
  controller: DuneGraphController,
): Promise<InstanceType<typeof DataExplorerPlugin> | undefined> {
  if (!(await ensureNodeMirror(controller))) return undefined;

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
