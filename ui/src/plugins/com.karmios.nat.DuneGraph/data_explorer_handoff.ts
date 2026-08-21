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
 * Hand-off to the Data Explorer: one action that leaves the user in front of
 * the build's directory tree, with no graph to build and no dashboard item to
 * configure. The JSON it hands over lives in dir_tree_graph.ts.
 *
 * This is the only place DuneGraph reaches into another plugin. It goes through
 * the Data Explorer's public `setActiveGraphJson` (the same entry point the
 * Intelletto assistant uses), so nothing here depends on that plugin's
 * internals beyond the documented graph/dashboard formats.
 */

import m from 'mithril';
import {getErrorMessage} from '../../base/errors';
import type {Trace} from '../../public/trace';
import {showModal} from '../../widgets/modal';
import DataExplorerPlugin from '../dev.perfetto.DataExplorer';
import type {DuneGraphController} from './controller';
import {dirTreeDashboards, dirTreeGraphJson} from './dir_tree_graph';

/**
 * Builds the dir-tree graph and dashboard and navigates to the Data Explorer.
 *
 * `dune_dir` only exists once the node tier of the SQL mirror has been built
 * (the graph no longer loads with the trace - see controller.ts), so a load is
 * part of the action rather than a precondition to complain about: this runs
 * the controller's own `buildNodeMirror` step, whose progress and failure the
 * side panel already reports. `onLoadNeeded` is called just before that wait,
 * for callers that have to reveal the panel first to make that reporting
 * visible - the panel's own button doesn't need it.
 *
 * A failure of the load is therefore silent here (the panel is saying it). The
 * two ways the hand-off itself can fail - the Data Explorer disabled, or its
 * SQL modules not ready - are modal, because nothing else in the UI is in a
 * position to say so.
 */
export async function exploreDirTree(
  trace: Trace,
  controller: DuneGraphController,
  onLoadNeeded?: () => void,
): Promise<void> {
  if (!controller.nodeMirrorReady) {
    onLoadNeeded?.();
    await controller.buildNodeMirror();
    // Still not there: the load failed, and the panel shows why.
    if (!controller.nodeMirrorReady) return;
  }

  // Declared as a dependency (see index.ts), which orders the plugins but does
  // not enable them - a user who has switched the Data Explorer off gets a
  // throw from getPlugin, not a broken page.
  if (!trace.plugins.isPluginEnabled(DataExplorerPlugin.id)) {
    await failed(
      `The ${DataExplorerPlugin.id} plugin is disabled, so there is nowhere ` +
        'to show the directory tree. Enable it in the plugin settings and ' +
        'try again.',
    );
    return;
  }

  try {
    trace.plugins
      .getPlugin(DataExplorerPlugin)
      // Seeds the graph *and* the dashboard, and navigates to #!/explore.
      .setActiveGraphJson(trace, dirTreeGraphJson(), dirTreeDashboards());
  } catch (e) {
    // setActiveGraphJson throws on a graph the Data Explorer won't accept
    // (which the unit test exists to prevent) and while its SQL modules are
    // still loading (which retrying fixes).
    await failed(getErrorMessage(e));
  }
}

function failed(message: string): Promise<void> {
  return showModal({
    title: 'Cannot open the directory tree',
    icon: 'warning',
    content: m('p', message),
    buttons: [{text: 'OK', primary: true}],
  });
}
