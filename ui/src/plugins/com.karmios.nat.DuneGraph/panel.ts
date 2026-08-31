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
import type {Trace} from '../../public/trace';
import type {DuneGraphController, LoadStep} from './controller';
import {APPENDABLE_SOURCES, appendExploreSource} from './data_explorer_handoff';
import {plural} from './graph';
import {SelectionInfoPanel} from './selection_info_panel';
import {GraphPanel} from './graph_panel';

// The Data Explorer's route (`DataExplorerPlugin`'s registered page), which is
// the only place the "add to the current graph" section makes sense.
const EXPLORE_PAGE = '/explore';

// The prefix the shell puts in front of every route in the URL fragment.
const ROUTE_PREFIX = '#!';

/**
 * Whether the Data Explorer's page is the one currently open.
 *
 * The shell's own `Router` is core-private - plugins can navigate (`app.navigate`)
 * but can't ask what the current route is - so this reads the fragment itself.
 * It only needs the page, i.e. the first path component of `#!/page/subpage`,
 * so it stops short of the subpage/args parsing `Router.parseUrl` does.
 */
function isExplorePageOpen(): boolean {
  const hash = window.location.hash;
  if (!hash.startsWith(ROUTE_PREFIX)) return false;
  const path = hash.substring(ROUTE_PREFIX.length).split(/[?#]/)[0];
  return path === EXPLORE_PAGE || path.startsWith(`${EXPLORE_PAGE}/`);
}

interface DuneGraphPanelAttrs {
  readonly controller: DuneGraphController;
  // Only needed for the Data Explorer hand-off, which is a plugin-level action
  // rather than a graph one - everything else here goes through the controller.
  readonly trace: Trace;
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
      this.renderAreas(attrs),
    );
  }

  private renderAreas(attrs: DuneGraphPanelAttrs): m.Children {
    const {controller} = attrs;
    if (!controller.graphStep.ready) return this.renderUnloaded(controller);
    return [
      this.renderExplore(attrs),
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

  /**
   * The one area here that isn't about the selected nodes: the mirror's tables,
   * offered to the Data Explorer as data sources to add to the graph the user is
   * building there (see data_explorer_handoff.ts). It lives at the top of the
   * panel, above the two node-shaped areas, because it is about the whole build
   * and not about anything selected - and only once the graph is up, so the
   * pre-load screen keeps its single call to action.
   *
   * Only while the Data Explorer is the open page, though: "add to the current
   * graph" means nothing anywhere else, and the buttons would be an invitation
   * to a page the user isn't on. The way *in* is the omnibox command, which
   * opens the directory tree by replacing the graph and navigating. So: command
   * = open, these = add in place.
   *
   * The route is read straight off the URL rather than watched, which is all
   * that's needed - the shell redraws on `hashchange`, so the section appears
   * and disappears with the navigation that caused it.
   *
   * No `onLoadNeeded` callback: this panel *is* where a load reports itself, and
   * clicking one of these means it is already on screen.
   */
  private renderExplore(attrs: DuneGraphPanelAttrs): m.Children {
    if (!isExplorePageOpen()) {
      return undefined;
    }
    const {controller, trace} = attrs;
    return m(
      '.pf-dune-graph__toolbar',
      m('.pf-dune-graph__area-title', 'Data Explorer'),
      m(
        '.pf-dune-graph__toolbar-buttons',
        APPENDABLE_SOURCES.map((source) =>
          m(Button, {
            label: source.label,
            icon: source.icon,
            title: source.title,
            disabled: controller.busy,
            onclick: () => void appendExploreSource(trace, controller, source),
          }),
        ),
      ),
    );
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

  // The trace's headline counts. `estimatedEdgeRows` is the number that decides
  // whether this is a click or a coffee break - it is what the one load gate is
  // measured against (see controller.ts's AUTO_LOAD_ROW_LIMIT_SETTING) - so
  // it's called out rather than listed.
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
          'edge rows (estimated)',
          `~${stats.estimatedEdgeRows.toLocaleString()}`,
        ),
      ),
      overLimit &&
        m(
          Callout,
          {icon: 'warning'},
          `This graph is large: roughly ` +
            `${stats.estimatedEdgeRows.toLocaleString()} dependency rows to ` +
            `store, past the ` +
            `${controller.autoLoadEdgeRowLimit.toLocaleString()} above which ` +
            'it is not loaded automatically. Loading builds all of it - the ' +
            'graph, the node tables and the edge tables (dune_edge and the ' +
            'relation functions) - which at this size is minutes of work and ' +
            'a gigabyte or more of trace-processor memory. This is the only ' +
            'time you are asked. The threshold is a setting: "Dune graph: ' +
            'load without asking below (edge rows)".',
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
      // The only way back from a failed edge tier: the "Load graph" button is
      // off screen once the graph itself is up (see renderAreas), and the offer
      // callout that used to carry a build button is gone with the second
      // prompt. A retry after a failure isn't a prompt - the cost was agreed to
      // when the load was started.
      return m(
        Callout,
        {icon: 'warning'},
        `Edge tables unavailable (${edgeMirrorStep.error}). Queries over ` +
          'dune_edge and the relation functions need them.',
        m(Button, {
          label: 'Retry',
          icon: 'play_arrow',
          disabled: controller.busy,
          onclick: () => void controller.buildEdgeMirror(),
        }),
      );
    }
    return this.renderEdgeTierPrompt(controller);
  }

  /**
   * What is left to say about the edge tier once a load has been through it:
   * either it was built without its reverse index, or it wasn't built at all
   * because the graph is past the hard limit.
   *
   * Not an offer. The tier is part of every load, bought by the one question
   * asked before the graph is parsed (see controller.ts), so there is no
   * "build it separately" left to prompt for. Past the hard limit the answer is
   * no and the reason is the number - materializing it would take the trace
   * processor down - so that reads as a callout rather than an error, because
   * everything except `dune_edge` and the relation functions still works.
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
    if (controller.edgeTierRefused) {
      return m(
        Callout,
        {icon: 'warning'},
        `This graph's ${controller.edgeCount.toLocaleString()} edges are past ` +
          `the ${controller.edgeHardLimit.toLocaleString()} the edge tables ` +
          'can be built for - materializing them would exhaust the trace ' +
          'processor. dune_edge and the relation functions are unavailable on ' +
          'this trace; everything else here works.',
      );
    }
    return undefined;
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
