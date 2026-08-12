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
import {EmptyState} from '../../widgets/empty_state';
import {Spinner} from '../../widgets/spinner';
import type {DuneGraphController} from './controller';
import {SelectionInfoPanel} from './selection_info_panel';
import {GraphPanel} from './graph_panel';

interface DuneGraphPanelAttrs {
  readonly controller: DuneGraphController;
}

/**
 * Root of the Dune-graph side panel. Two stacked areas: details for the
 * build-graph node behind the current timeline selection (top), and the set of
 * nodes chosen for the graph (bottom). Loading/error states gate both.
 */
export class DuneGraphPanel implements m.ClassComponent<DuneGraphPanelAttrs> {
  view({attrs}: m.CVnode<DuneGraphPanelAttrs>): m.Children {
    const {controller} = attrs;
    return m(
      '.pf-dune-graph',
      m('.pf-dune-graph__source', `Source: ${controller.sourceDescription}`),
      this.renderAreas(controller),
    );
  }

  private renderAreas(controller: DuneGraphController): m.Children {
    if (controller.loading) {
      return m(
        '.pf-dune-graph__status',
        m(Spinner),
        m('span', 'Loading build graph…'),
      );
    }

    if (controller.error !== undefined) {
      return m(EmptyState, {
        icon: 'error',
        title: `Failed to load graph: ${controller.error}`,
      });
    }

    return [
      m(
        '.pf-dune-graph__area.pf-dune-graph__area--info',
        m('.pf-dune-graph__area-title', 'Selection'),
        m(SelectionInfoPanel, {controller}),
      ),
      m(
        '.pf-dune-graph__area.pf-dune-graph__area--graph',
        m('.pf-dune-graph__area-title', 'Graph'),
        m(GraphPanel, {controller}),
      ),
    ];
  }
}
