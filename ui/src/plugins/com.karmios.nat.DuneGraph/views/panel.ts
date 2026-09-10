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
import {formatBytesSi} from '../../../base/bytes_format';
import {Button} from '../../../widgets/button';
import {Callout} from '../../../widgets/callout';
import {Intent} from '../../../widgets/common';
import {EmptyState} from '../../../widgets/empty_state';
import {Icon} from '../../../widgets/icon';
import {Spinner} from '../../../widgets/spinner';
import type {Trace} from '../../../public/trace';
import type {DuneGraphController, LoadStatus, LoadStep} from '../controller';
import {
  APPENDABLE_SOURCES,
  appendExploreSource,
} from '../explorer/data_explorer_handoff';
import {plural} from '../model/graph';
import {SelectionInfoPanel} from './selection_info_panel';
import {GraphPanel} from './graph_panel';
import type {MirrorPhase} from '../sql/sql_graph';

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
  // Which phase we last scrolled to, so the running one is revealed once per
  // phase rather than once per redraw. See `revealPhase`.
  private scrolledPhase?: string;

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
    // The load owns the whole tab while it runs, not just before the first one.
    // A build is minutes long and reports itself as a ~30-row list of the
    // tables it is making (see renderStep); that doesn't fit above the other
    // panes, and the panes themselves are answering about a graph that is still
    // being assembled underneath them. A `buildEdgeMirror()` retry from a
    // loaded state takes the tab over too, which is consistent: it is where the
    // progress is.
    if (controller.busy || !controller.graphStep.ready) {
      return this.renderUnloaded(controller);
    }
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
   * to a page the user isn't on. These buttons are the only way in, so the
   * hand-off can assume this panel is on screen to report a load in - which is
   * where a load reports itself anyway.
   *
   * The route is read straight off the URL rather than watched, which is all
   * that's needed - the shell redraws on `hashchange`, so the section appears
   * and disappears with the navigation that caused it.
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
        // `controller.busy` rather than `graphStep.busy`: this screen now stays
        // up for the two SQL tiers as well, and the graph being parsed is only
        // the first of the three things a load does.
        controller.busy ? 'Loading build graph…' : 'Build graph not loaded',
      ),
      this.renderStats(controller, started),
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
  private renderStats(
    controller: DuneGraphController,
    started: boolean,
  ): m.Children {
    const stats = controller.stats;
    if (stats === undefined) return undefined;
    // The stats are in by this point, so this is exactly "too big to load
    // unprompted" - the reason the user is looking at this screen at all.
    // Only until the load starts, though: the callout is the answer to a
    // question that has been answered, and this screen stays up for the whole
    // build now, where six lines of warning would just push the phase list out
    // of a narrow panel.
    const overLimit = !started && !controller.autoLoads;
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
    // Between loads there is nothing to keep on screen, and forgetting where we
    // scrolled to means the next load reveals its first phase instead of
    // deciding it is already there (see `revealPhase`).
    if (!controller.busy) this.scrolledPhase = undefined;
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
    return [
      m(
        '.pf-dune-graph__step',
        step.busy ? m(Spinner) : m(Icon, {icon: statusIcon(step.status)}),
        m('span', step.label),
        step.error !== undefined &&
          m('span.pf-dune-graph__step-error', step.error),
      ),
      this.renderPhases(step),
    ];
  }

  /**
   * Everything a step is going to build, listed in full from the moment it
   * starts.
   *
   * The whole point of the list is that it shows what is left as well as what
   * is now: a tier is minutes of work and naming only the current table said
   * nothing about how much of it remained. So all of a started step's phases
   * render, each with its own state, rather than only the active one.
   *
   * Not before it starts, though - a step that hasn't begun stays a single row,
   * or the panel would open on thirty greyed-out table names - and not for the
   * graph step, whose `phases` is empty (see controller.ts).
   */
  private renderPhases(step: LoadStep): m.Children {
    if (step.status === 'idle' || step.phases.length === 0) return undefined;
    return m(
      '.pf-dune-graph__phases',
      step.phases.map((phase) => this.renderPhase(step, phase)),
    );
  }

  private renderPhase(step: LoadStep, phase: MirrorPhase): m.Children {
    const done = step.done.has(phase.id);
    const active = !done && step.activePhase === phase.id;
    // Mapped onto the step vocabulary so the ticks and circles down the list
    // mean the same thing at both levels; the active row gets the spinner a
    // running step gets.
    const status: LoadStatus = done ? 'ready' : active ? 'loading' : 'idle';
    const modifier = done ? 'done' : active ? 'active' : 'pending';
    return m(
      `.pf-dune-graph__phase.pf-dune-graph__phase--${modifier}`,
      {
        oncreate: active
          ? (v: m.VnodeDOM) => this.revealPhase(v.dom, phase.id)
          : undefined,
        onupdate: active
          ? (v: m.VnodeDOM) => this.revealPhase(v.dom, phase.id)
          : undefined,
      },
      active ? m(Spinner) : m(Icon, {icon: statusIcon(status)}),
      m('span', phase.label),
      // Only the active row carries a row count; a finished phase's last count
      // is just its total, and keeping it would make the list a wall of digits.
      active &&
        step.phaseDetail !== undefined &&
        m('span.pf-dune-graph__phase-detail', step.phaseDetail),
    );
  }

  /**
   * Keeps the running phase on screen.
   *
   * The two tiers declare 29 phases between them, which is taller than the
   * panel, so the spinner otherwise walks off the bottom partway through the
   * node tier and the list stops being a progress report - you would have to
   * hunt for the row that is moving.
   *
   * Once per phase, not once per redraw, which is what `scrolledPhase` is for:
   * the active row redraws on every row report (one per 50k inserted rows), and
   * re-scrolling on each of those would fight a panel the user had deliberately
   * scrolled elsewhere and re-run layout for no change. Scrolling only when the
   * phase itself changes means a scroll-away survives until the build moves on.
   *
   * `block: 'nearest'` both keeps the movement minimal and makes an already
   * visible row a no-op, so a panel tall enough to show the whole list never
   * scrolls at all.
   */
  private revealPhase(dom: Element, phaseId: string): void {
    if (this.scrolledPhase === phaseId) return;
    this.scrolledPhase = phaseId;
    dom.scrollIntoView({block: 'nearest'});
  }

  // Once the graph itself is up, a missing or failed SQL tier doesn't hide the
  // panel - it just costs specific features, so say which.
  private renderMirrorWarnings(controller: DuneGraphController): m.Children {
    const {nodeMirrorStep, edgeMirrorStep} = controller;
    // Nothing here reports a *running* tier any more: a load owns the tab (see
    // renderAreas) and reports itself phase by phase there, so a spinner above
    // the panes would be a second, poorer account of the same work.
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

// One icon vocabulary for both levels of the list: a step and one of its phases
// say "done", "failed" and "not yet" the same way. Takes the status rather than
// the step because a phase has no `LoadStep` of its own - see `renderPhase`,
// which maps its three states onto these.
function statusIcon(status: LoadStatus): string {
  switch (status) {
    case 'ready':
      return 'check_circle';
    case 'error':
      return 'error';
    case 'loading':
    case 'idle':
      return 'radio_button_unchecked';
  }
}
