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
import {Button} from '../../widgets/button';
import type {DuneGraphController} from './controller';
import type {GraphNode} from './graph';
import {nodeLabel} from './graph';
import type {Distances} from './sql_graph';

interface DistancePanelAttrs {
  readonly controller: DuneGraphController;
}

// One endpoint's outcome. `undefined` while unset; a query in flight, an
// unreachable target, or a computed result once both endpoints are set.
type Result = Distances | 'loading' | 'unreachable' | undefined;

/**
 * Lets the user pick two nodes (seeded from the current timeline selection) and
 * shows the directed dependency distance between them, broken down by node
 * kind. Distances are computed in SQL via {@link DuneGraphController.distances}.
 */
export class DistancePanel implements m.ClassComponent<DistancePanelAttrs> {
  private from?: GraphNode;
  private to?: GraphNode;
  private result: Result;
  // Guards against a slow query overwriting a newer selection's result.
  private token = 0;

  view({attrs}: m.CVnode<DistancePanelAttrs>): m.Children {
    const {controller} = attrs;
    return m(
      '.pf-dune-graph__distance',
      m(
        '.pf-dune-graph__distance-row',
        m(Button, {
          label: 'Set from ▸ selection',
          icon: 'my_location',
          onclick: () => this.setEndpoint(controller, 'from'),
        }),
        m('span.pf-dune-graph__distance-node', this.endpointLabel(this.from)),
      ),
      m(
        '.pf-dune-graph__distance-row',
        m(Button, {
          label: 'Set to ▸ selection',
          icon: 'flag',
          onclick: () => this.setEndpoint(controller, 'to'),
        }),
        m('span.pf-dune-graph__distance-node', this.endpointLabel(this.to)),
      ),
      this.renderResult(),
    );
  }

  private endpointLabel(node: GraphNode | undefined): string {
    return node === undefined ? '(none)' : nodeLabel(node);
  }

  private renderResult(): m.Children {
    const {result} = this;
    if (this.from === undefined || this.to === undefined) {
      return m(
        '.pf-dune-graph__distance-result',
        'Select a build-dep or exec-rule slice, then set both endpoints.',
      );
    }
    if (result === 'loading' || result === undefined) {
      return m('.pf-dune-graph__distance-result', 'Computing…');
    }
    if (result === 'unreachable') {
      return m(
        '.pf-dune-graph__distance-result',
        'Unreachable (no dependency path in this direction).',
      );
    }
    return m(
      '.pf-dune-graph__distance-result',
      `Distance: ${result.total} (${result.dep} dep, ${result.rule} rule)`,
    );
  }

  private setEndpoint(
    controller: DuneGraphController,
    which: 'from' | 'to',
  ): void {
    const node = controller.nodeForSelection();
    if (node === undefined) return;
    this[which] = node;
    this.recompute(controller);
  }

  private recompute(controller: DuneGraphController): void {
    const {from, to} = this;
    if (from === undefined || to === undefined) {
      this.result = undefined;
      return;
    }
    this.result = 'loading';
    const token = ++this.token;
    void controller.distances(from, to).then((distances) => {
      if (token !== this.token) return; // A newer request superseded this one.
      this.result = distances ?? 'unreachable';
      m.redraw();
    });
  }
}
