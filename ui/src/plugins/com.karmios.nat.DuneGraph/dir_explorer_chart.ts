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

// The directory Explorer offered as a Data Explorer *chart type*, so that a
// build's directory tree can sit in a visualisation node or on a dashboard
// next to the charts that summarise it, rather than only in our side panel.
//
// This is the walking skeleton: the chart type is registered, appears in the
// chart picker, and renders the same DirExplorerPanel the side panel tab does.
// It does not yet read the chart's input rows or emit brush filters, so the
// pane still shows the *whole* `dune_dir` tree whatever query it is dropped
// on. Wiring those two up is the next step.

import m from 'mithril';
import type {Trace} from '../../public/trace';
import {registerChartType} from '../dev.perfetto.DataExplorer/query_builder/charts/chart_type_registry';
import type {DuneGraphController} from './controller';
import {DirExplorerPanel} from './dir_explorer_panel';
import {SqlDirExplorerSource} from './dir_explorer_source';

/**
 * The chart type identifier. Dashboards persist this as a bare string and
 * survive being reopened without us (the registry renders a placeholder naming
 * the type), so it is prefixed rather than a bare word like the built-ins:
 * whatever else may come to register a chart type, it will not be this.
 */
const DIR_TREE_CHART_TYPE = 'dune-dir-tree';

/**
 * Registers the directory-tree chart type for as long as `trace` lives.
 *
 * The chart registry is global and outlives a trace, and the pane it renders
 * closes over a controller belonging to *this* trace, so - exactly as with the
 * node column renderer in node_cell.ts - the registration goes in the trace's
 * trash and the next trace load registers afresh. Registering a chart type
 * twice throws by design, so a leaked registration would surface on the next
 * load rather than quietly capturing a dead controller.
 *
 * @param trace The trace the registration's lifetime is tied to.
 * @param controller The controller whose mirror the tree is read from.
 */
export function registerDirExplorerChart(
  trace: Trace,
  controller: DuneGraphController,
): void {
  // The same SQL-mirror source the side panel's copy of the pane reads, and -
  // for now - the whole of why this chart shows the whole tree whatever query
  // it is dropped on. Built once here rather than per render: the pane treats a
  // new source object as new data and drops its caches, so a fresh one each
  // frame would collapse the tree each frame. Replacing this with a source over
  // the chart's own input rows is the next step, and is the only line of this
  // file that has to change to do it.
  const source = new SqlDirExplorerSource(trace.engine, controller);
  trace.trash.use(
    registerChartType({
      type: DIR_TREE_CHART_TYPE,
      label: 'Dune Directories',
      icon: 'account_tree',
      description:
        "Browse the build's directory tree, with each directory's rules " +
        'and dependencies',

      // Nothing to configure: the pane picks its own columns out of the
      // mirror, so none of the pickers the config popup offers for these flags
      // would mean anything here. (The popup's *primary* column picker is
      // unconditional, so that one still shows; the chart ignores what it is
      // set to until the next step gives the chart its input data.)
      supportsAggregation: false,
      supportsBinning: false,
      requiresNumericDimension: false,
      primaryColumnLabel: 'Column',
      supportsYColumn: false,
      supportsGroupColumn: false,
      supportsSizeColumn: false,

      // No SQL loader: the pane issues its own queries against the mirror (see
      // dir_explorer_panel.ts), so there is nothing for the chart host to load
      // on its behalf.
      createLoader: () => {},

      // Mounted exactly as the side panel tab mounts it. The pane needs the
      // whole controller - it hands it on to the node cells and the bulk
      // actions - and a source to read its rows out of. Before the mirror is
      // built the pane renders its own load prompt, so a chart added ahead of a
      // graph load degrades sensibly.
      render: () =>
        m('.pf-dune-dir-chart', m(DirExplorerPanel, {controller, source})),

      // The pane shows the whole tree rather than one column of one query, so
      // there is nothing about the config worth putting in the label.
      defaultLabel: () => 'Dune directory tree',

      // No `preview`: the picker falls back to `icon` for types without an SVG
      // thumbnail, and the tree has no schematic worth drawing.
    }),
  );
}
