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
import {formatBytesSi} from '../../base/bytes_format';
import {Button} from '../../widgets/button';
import {Callout} from '../../widgets/callout';
import {Intent} from '../../widgets/common';
import {EmptyState} from '../../widgets/empty_state';
import {Icon} from '../../widgets/icon';
import {Spinner} from '../../widgets/spinner';
import type {DuneGraphController, LoadStep} from './controller';
import {plural} from './graph';
import {SelectionInfoPanel} from './selection_info_panel';
import {GraphPanel} from './graph_panel';

interface DuneGraphPanelAttrs {
  readonly controller: DuneGraphController;
}

/**
 * Root of the Dune-graph side panel. Two stacked areas: details for the
 * build-graph node behind the current timeline selection (top), and the set of
 * nodes chosen for the graph (bottom).
 *
 * Before either of those, the panel has a job it didn't used to have: the graph
 * no longer loads itself when the trace opens (see controller.ts), so this is
 * where a not-yet-loaded trace is explained. It shows what the graph would cost
 * to load - measured from the trace, not guessed - and offers the load as an
 * explicit action; on a small trace the load has usually already started by
 * itself and the same screen is just a progress report.
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
    if (!controller.graphStep.ready) return this.renderUnloaded(controller);
    return [
      this.renderMirrorWarnings(controller),
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

  // What the panel shows before the graph is up. Reading the trace's headline
  // counts is the one thing the plugin does unprompted, and its failure is how
  // "this trace has no Dune graph in it" surfaces - so while nothing has been
  // asked of the plugin yet, that probe owns the screen. Once a load has been
  // started, the load's own state does.
  private renderUnloaded(controller: DuneGraphController): m.Children {
    const {statsStep, graphStep} = controller;
    if (graphStep.status === 'idle') {
      if (statsStep.error !== undefined) {
        return m(
          EmptyState,
          {icon: 'error', title: 'No Dune build graph in this trace'},
          m('.pf-dune-graph__load-note', statsStep.error),
        );
      }
      if (!statsStep.ready) {
        return m(
          '.pf-dune-graph__status',
          m(Spinner),
          m('span', 'Inspecting trace…'),
        );
      }
    }
    return this.renderLoadPrompt(controller);
  }

  // The pre-load screen: what's in the trace, what loading it would involve,
  // and the button that does it. Doubles as the progress view once a load is
  // running, since the same numbers are the context for the wait.
  private renderLoadPrompt(controller: DuneGraphController): m.Children {
    const {graphStep} = controller;
    const started = graphStep.status !== 'idle';
    return m(
      '.pf-dune-graph__load',
      m(
        '.pf-dune-graph__load-title',
        graphStep.busy ? 'Loading build graph…' : 'Build graph not loaded',
      ),
      this.renderStats(controller),
      graphStep.error !== undefined &&
        m(Callout, {icon: 'error'}, graphStep.error),
      m(Button, {
        label: graphStep.error !== undefined ? 'Retry' : 'Load graph',
        icon: 'play_arrow',
        intent: Intent.Primary,
        disabled: controller.busy,
        onclick: () => void controller.load(),
      }),
      started && this.renderSteps(controller),
    );
  }

  // The trace's headline counts. `estimatedEdges` is the number that decides
  // whether this is a click or a coffee break (see controller.ts's
  // AUTO_LOAD_EDGE_LIMIT), so it's called out rather than listed.
  private renderStats(controller: DuneGraphController): m.Children {
    const stats = controller.stats;
    if (stats === undefined) return undefined;
    // The stats are in by this point, so this is exactly "too big to load
    // unprompted" - the reason the user is looking at this screen at all.
    const overLimit = !controller.autoLoads;
    return [
      m(
        '.pf-dune-graph__load-stats',
        ...stats.sections.map((s) =>
          this.statRow(
            s.name,
            `${formatBytesSi(s.bytes)} in ${plural(s.chunks, 'chunk')}`,
          ),
        ),
        this.statRow('total', formatBytesSi(stats.bytes)),
        this.statRow(
          'lifecycle instants',
          stats.lifecycleInstants.toLocaleString(),
        ),
        this.statRow(
          'edges (estimated)',
          `~${stats.estimatedEdges.toLocaleString()}`,
        ),
      ),
      overLimit &&
        m(
          Callout,
          {icon: 'warning'},
          `This graph is large: roughly ${stats.estimatedEdges.toLocaleString()} ` +
            `edges, past the ${controller.autoLoadEdgeLimit.toLocaleString()} ` +
            'above which it is not loaded automatically. Loading it can take ' +
            'minutes and a lot of memory. The edge tables (dune_edge and the ' +
            'relation functions) are left out at this size and can be built ' +
            'separately afterwards.',
        ),
    ];
  }

  private statRow(label: string, value: string): m.Children {
    return m(
      '.pf-dune-graph__load-stat',
      m('span.pf-dune-graph__load-stat-label', label),
      m('span.pf-dune-graph__load-stat-value', value),
    );
  }

  // Per-step progress: which of the three load steps are done, running, or
  // failed (see controller.ts). Individually reported because they fail
  // individually - a built graph with no edge tables is a usable state.
  private renderSteps(controller: DuneGraphController): m.Children {
    return m(
      '.pf-dune-graph__steps',
      [
        controller.graphStep,
        controller.nodeMirrorStep,
        controller.edgeMirrorStep,
      ].map((step) => this.renderStep(step)),
    );
  }

  private renderStep(step: LoadStep): m.Children {
    return m(
      '.pf-dune-graph__step',
      step.busy ? m(Spinner) : m(Icon, {icon: stepIcon(step)}),
      m('span', step.label),
      step.detail !== undefined &&
        m('span.pf-dune-graph__step-detail', step.detail),
      step.error !== undefined &&
        m('span.pf-dune-graph__step-error', step.error),
    );
  }

  // Once the graph itself is up, a missing or failed SQL tier doesn't hide the
  // panel - it just costs specific features, so say which.
  private renderMirrorWarnings(controller: DuneGraphController): m.Children {
    const {nodeMirrorStep, edgeMirrorStep} = controller;
    if (nodeMirrorStep.busy || edgeMirrorStep.busy) {
      const step = nodeMirrorStep.busy ? nodeMirrorStep : edgeMirrorStep;
      return m(
        '.pf-dune-graph__status',
        m(Spinner),
        m(
          'span',
          nodeMirrorStep.busy
            ? 'Building node tables…'
            : 'Building edge tables…',
        ),
        step.detail !== undefined &&
          m('span.pf-dune-graph__step-detail', step.detail),
      );
    }
    if (nodeMirrorStep.error !== undefined) {
      return m(
        Callout,
        {icon: 'warning'},
        `Node tables unavailable (${nodeMirrorStep.error}). The timeline ` +
          'projection and SQL queries over the graph need them.',
      );
    }
    if (edgeMirrorStep.error !== undefined) {
      return m(
        Callout,
        {icon: 'warning'},
        `Edge tables unavailable (${edgeMirrorStep.error}). Queries over ` +
          'dune_edge and the relation functions need them.',
      );
    }
    return this.renderEdgeTierPrompt(controller);
  }

  /**
   * The edge tier, when the load deliberately left it out: it is one SQL row
   * per dependency edge, so past a few million of them it is minutes of work
   * and gigabytes of engine memory, and the load doesn't do it unasked (see
   * controller.ts). Everything except `dune_edge` and the relation functions
   * works without it, so this is an offer rather than a warning - unless the
   * graph is past the hard limit, where the answer is no and the reason is the
   * number.
   */
  private renderEdgeTierPrompt(controller: DuneGraphController): m.Children {
    const {edgeMirrorStep} = controller;
    if (edgeMirrorStep.ready) {
      // Built, but on a graph too big to index the reverse direction - the two
      // bounded reverse walks still work, they just scan.
      if (controller.reverseWalksIndexed) return undefined;
      return m(
        Callout,
        {icon: 'info'},
        `Edge tables built without a reverse index (${controller.edgeCount.toLocaleString()} ` +
          'edges). dune_ancestors / dune_parents will scan the edge table per ' +
          'hop; prefer dune_all_ancestors, or the Dependants list here, which ' +
          'is answered in memory either way.',
      );
    }
    if (edgeMirrorStep.status !== 'idle') return undefined;
    const edges = controller.edgeCount.toLocaleString();
    if (controller.edgeTierRefused) {
      return m(
        Callout,
        {icon: 'warning'},
        `This graph's ${edges} edges are past the ` +
          `${controller.edgeHardLimit.toLocaleString()} the edge tables can ` +
          'be built for - materializing them would exhaust the trace ' +
          'processor. dune_edge and the relation functions are unavailable on ' +
          'this trace; everything else here works.',
      );
    }
    return m(
      Callout,
      {icon: 'info'},
      `Edge tables not built: ${edges} edges is enough that mirroring them ` +
        'into SQL takes minutes and a lot of trace-processor memory, so it ' +
        'is not part of a load. Only dune_edge and the relation functions ' +
        'need them.',
      m(Button, {
        label: 'Build edge tables',
        icon: 'play_arrow',
        disabled: controller.busy,
        onclick: () => void controller.buildEdgeMirror(),
      }),
    );
  }
}

function stepIcon(step: LoadStep): string {
  switch (step.status) {
    case 'ready':
      return 'check_circle';
    case 'error':
      return 'error';
    case 'loading':
    case 'idle':
      return 'radio_button_unchecked';
  }
}
