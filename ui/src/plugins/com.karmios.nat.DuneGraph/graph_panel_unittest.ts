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
 * The graph pane (graph_panel.ts) in both of the modes it now has: over the
 * controller's graph selection, which is what the side panel mounts, and over a
 * node set handed to it, which is what the Data Explorer's node graph chart
 * mounts (see node_graph_chart.ts).
 *
 * The pane grew the second mode rather than being rewritten for it, so what is
 * worth pinning is exactly the seam between them:
 *
 * - the selection mode is unchanged - same dots, same count, same four buttons -
 *   because the side panel is a landed surface and this was meant to be
 *   invisible to it;
 * - an injected set draws *its* nodes and not the selection's, which is the
 *   whole feature;
 * - "Timeline" and "Clear" act on the selection, so they are gone in the
 *   injected mode: offered there they would be about nodes that are not on
 *   screen;
 * - the cap is reported by the toolbar's own count ("2 of 40 nodes"), since
 *   that is the one place a count is already shown;
 * - "Hide rules" still works in both, because it is a property of how a Dune
 *   graph is drawn rather than of who asked for one - and it has to relayout in
 *   the injected mode, where the set's own version knows nothing about it.
 */

import m from 'mithril';
import {beforeEach, describe, expect, test} from 'vitest';
import type {DuneGraphController} from './controller';
import type {NodeId} from './graph';
import {GraphPanel} from './graph_panel';
import type {GraphPanelNodes} from './graph_panel';
import {dep, rule, testGraph} from './graph_test_helper';

// r1 depends on a and b; c hangs off b. Two rules and three deps, which is
// enough for a hide-rules contraction and for an injected set that is a proper
// subset of the selection.
const g = testGraph([
  rule('r1', {staticDeps: ['a', 'b']}),
  dep('a'),
  dep('b', {resolvedRule: 'r2'}),
  rule('r2', {staticDeps: ['c']}),
  dep('c'),
]);

/**
 * Everything the pane reads off the controller. The graph and the hide-rules
 * filter are the real ones (the filter is `visibleIn`, verbatim from
 * controller.ts) so that the two modes are filtered by the same code the
 * timeline track is.
 */
function fakeController(over: {readonly selection?: readonly NodeId[]} = {}) {
  const state = {
    selection: over.selection ?? [],
    hideRules: false,
    graphVersion: 0,
    visited: [] as NodeId[],
    timelines: 0,
    cleared: 0,
  };
  const controller = {
    graph: g.graph,
    get selectedNodes() {
      return state.selection;
    },
    get visibleNodes() {
      return controller.visibleIn(state.selection);
    },
    visibleIn: (nodes: readonly NodeId[]) =>
      state.hideRules ? nodes.filter((id) => !g.graph.isRule(id)) : nodes,
    get hideRules() {
      return state.hideRules;
    },
    get graphVersion() {
      return state.graphVersion;
    },
    toggleHideRules: () => {
      state.hideRules = !state.hideRules;
      state.graphVersion++;
    },
    nodeForSelection: () => undefined,
    goToNode: async (node: NodeId) => {
      state.visited.push(node);
    },
    showTimeline: () => {
      state.timelines++;
    },
    clearGraph: () => {
      state.cleared++;
    },
  };
  return {controller: controller as unknown as DuneGraphController, state};
}

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement('div');
});

function render(attrs: {
  readonly controller: DuneGraphController;
  readonly nodes?: GraphPanelNodes;
}): void {
  m.render(root, m(GraphPanel, attrs));
}

// A circle carries its node id only as mithril's `key`, which never reaches the
// DOM, so what a test can see of a dot is its kind. That is enough to tell the
// fixture's rules from its deps, which is what every assertion below needs.
function dots(): {readonly rules: number; readonly deps: number} {
  return {
    rules: root.querySelectorAll('.pf-dune-graph__dot--rule').length,
    deps: root.querySelectorAll('.pf-dune-graph__dot--dep').length,
  };
}

function dotCount(): number {
  return root.querySelectorAll('circle').length;
}

function edgeCount(): number {
  return root.querySelectorAll('line').length;
}

// Button labels, with the leading icon glyph (an `<i.pf-icon>` whose text is
// the material icon's name) taken back off.
function buttons(): string[] {
  return Array.from(root.querySelectorAll('button')).map(label);
}

function label(button: Element): string {
  const icon = button.querySelector('.pf-icon')?.textContent ?? '';
  return (button.textContent ?? '').slice(icon.length);
}

function count(): string {
  return root.querySelector('.pf-dune-graph__graph-count')?.textContent ?? '';
}

/**
 * A `pointer*` event the pane's handlers accept. jsdom 25 has no
 * `PointerEvent`, so this is a `MouseEvent` of the right type with `pointerId`
 * bolted on - mithril dispatches on the type alone, and `pointerId` is only
 * ever handed straight to the capture calls (see {@link svg}).
 */
function pointerEvent(type: string, x: number, y: number): Event {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  }) as MouseEvent & {pointerId: number};
  e.pointerId = 1;
  return e;
}

// The pane's <svg>, with jsdom's missing pointer-capture methods stubbed in -
// the pane captures the pointer once a drag passes the threshold, and calling
// through to `undefined` would throw before the pan ever happened.
function svg(): SVGSVGElement {
  const el = root.querySelector('svg') as SVGSVGElement;
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  return el;
}

function injected(
  nodes: readonly NodeId[],
  over: Partial<GraphPanelNodes> = {},
): GraphPanelNodes {
  return {nodes, total: nodes.length, version: 1, ...over};
}

describe('the graph pane over the graph selection', () => {
  test('says so when nothing is selected', () => {
    const {controller} = fakeController();
    render({controller});

    expect(root.textContent).toContain('No nodes selected for the graph yet');
  });

  test('draws the selection and counts it', () => {
    const {controller} = fakeController({
      selection: [g.id('r1'), g.id('a'), g.id('b')],
    });
    render({controller});

    expect(dotCount()).toBe(3);
    expect(count()).toBe('3 nodes');
    // r1 -> a and r1 -> b, induced over the selection.
    expect(edgeCount()).toBe(2);
  });

  test('offers the four toolbar actions it always did', () => {
    const {controller} = fakeController({selection: [g.id('a')]});
    render({controller});

    expect(buttons()).toEqual(['Fit', 'Hide rules', 'Timeline', 'Clear']);
  });

  test('acts on the selection through the last two of them', () => {
    const {controller, state} = fakeController({selection: [g.id('a')]});
    render({controller});
    const found = (want: string) =>
      Array.from(root.querySelectorAll('button')).find(
        (b) => label(b) === want,
      );
    found('Timeline')?.click();
    found('Clear')?.click();

    expect(state.timelines).toBe(1);
    expect(state.cleared).toBe(1);
  });

  test('hides rules and contracts their edges through', () => {
    // b resolves to r2, which depends on c. Hiding r2 must leave b -> c rather
    // than dropping the pair of edges.
    const {controller, state} = fakeController({
      selection: [g.id('b'), g.id('r2'), g.id('c')],
    });
    render({controller});
    expect(dotCount()).toBe(3);

    state.hideRules = true;
    state.graphVersion++;
    render({controller});

    expect(dotCount()).toBe(2);
    expect(count()).toBe('3 nodes (1 hidden)');
    expect(edgeCount()).toBe(1);
  });
});

describe('the graph pane over an injected node set', () => {
  test('draws the set it was given, not the selection', () => {
    // The selection is one rule; the injected set is two deps. Nothing of the
    // selection may appear.
    const {controller} = fakeController({selection: [g.id('r1')]});
    render({controller, nodes: injected([g.id('a'), g.id('b')])});

    expect(dots()).toEqual({rules: 0, deps: 2});
  });

  test('drops the two actions that are about the selection', () => {
    const {controller} = fakeController({selection: [g.id('r1')]});
    render({controller, nodes: injected([g.id('a')])});

    expect(buttons()).toEqual(['Fit', 'Hide rules']);
  });

  test('says how many of how many when the set was capped', () => {
    const {controller} = fakeController();
    render({
      controller,
      nodes: injected([g.id('a'), g.id('b')], {total: 40}),
    });

    expect(count()).toBe('2 of 40 nodes');
  });

  test('still counts plainly when nothing was dropped', () => {
    const {controller} = fakeController();
    render({controller, nodes: injected([g.id('a'), g.id('b')])});

    expect(count()).toBe('2 nodes');
  });

  test('relays out when the set changes but the selection does not', () => {
    const {controller} = fakeController();
    render({controller, nodes: injected([g.id('a'), g.id('b')])});
    expect(dotCount()).toBe(2);

    // A new load: same controller, same graphVersion, different nodes.
    render({controller, nodes: injected([g.id('a')], {version: 2})});

    expect(dotCount()).toBe(1);
  });

  test('relays out when rules are hidden under it', () => {
    // The injected version does not move for a toggle, so the pane has to watch
    // the toggle itself - otherwise the hidden rule stays on screen.
    const {controller, state} = fakeController();
    const nodes = injected([g.id('b'), g.id('r2'), g.id('c')]);
    render({controller, nodes});
    expect(dotCount()).toBe(3);

    state.hideRules = true;
    state.graphVersion++;
    render({controller, nodes});

    expect(dots()).toEqual({rules: 0, deps: 2});
    expect(count()).toBe('3 nodes (1 hidden)');
  });

  test('jumps to a node when its dot is clicked', () => {
    const {controller, state} = fakeController();
    render({controller, nodes: injected([g.id('a')])});
    root
      .querySelector('circle')
      ?.dispatchEvent(new MouseEvent('click', {bubbles: true}));

    expect(state.visited).toEqual([g.id('a')]);
  });
});

/**
 * The seam between panning and clicking, which share the same press. A drag
 * has to swallow the click its release produces - otherwise every pan would
 * navigate to whatever dot happened to be under the cursor - without swallowing
 * anything else, and the release need not be over a dot at all.
 *
 * The browser's ordering, which the pane relies on: `pointerdown` ->
 * `pointermove` -> `pointerup` -> `click`, with the click going to whatever the
 * release landed on (the `<svg>` itself, for empty canvas).
 *
 * The interesting case is the last of those: nothing consumes the suppression
 * flag when the click reaches no dot. That it does not then eat the *next*
 * click on a node is pinned below, and holds for two independent reasons -
 * `onPointerUp` reassigns the flag on every release and `onPointerDown` clears
 * it - so these pass with either one alone. They are here to keep it that way.
 */
describe('the graph pane between a pan and a click', () => {
  // A press well past DRAG_THRESHOLD, released over `over` - the <svg> for a
  // release on empty canvas, a dot for one on a node.
  function pan(over: Element): void {
    const el = svg();
    el.dispatchEvent(pointerEvent('pointerdown', 0, 0));
    el.dispatchEvent(pointerEvent('pointermove', 40, 40));
    over.dispatchEvent(pointerEvent('pointerup', 40, 40));
  }

  // The bare `click` a release produces. It has no press of its own in front of
  // it, because it belongs to the gesture that just ended.
  function releaseClick(over: Element): void {
    over.dispatchEvent(new MouseEvent('click', {bubbles: true}));
  }

  // A fresh, complete press on a dot, in the order a browser sends it. The
  // leading `pointerdown` is the whole point: a click never arrives without
  // one, and it is where the pane drops a stale suppression. No pointer capture
  // is involved, since a press that doesn't move is never a pan.
  function clickDot(): void {
    const dot = root.querySelector('circle')!;
    dot.dispatchEvent(pointerEvent('pointerdown', 40, 40));
    dot.dispatchEvent(pointerEvent('pointerup', 40, 40));
    releaseClick(dot);
  }

  test('swallows the click a pan released over a dot produces', () => {
    const {controller, state} = fakeController({selection: [g.id('a')]});
    render({controller});
    const dot = root.querySelector('circle')!;
    pan(dot);
    releaseClick(dot);

    expect(state.visited).toEqual([]);
  });

  test('lets the press after such a pan through', () => {
    const {controller, state} = fakeController({selection: [g.id('a')]});
    render({controller});
    const dot = root.querySelector('circle')!;
    pan(dot);
    releaseClick(dot);
    clickDot();

    expect(state.visited).toEqual([g.id('a')]);
  });

  test('does not eat the next click after a pan onto empty canvas', () => {
    // The release lands on the <svg>, so the click it produces reaches no dot
    // and `onNodeClick` never runs - the flag is still set when the next press
    // begins. That press must navigate all the same, or a pan that happened to
    // end between two dots would cost the user their next click.
    const {controller, state} = fakeController({selection: [g.id('a')]});
    render({controller});
    const el = svg();
    pan(el);
    releaseClick(el);
    clickDot();

    expect(state.visited).toEqual([g.id('a')]);
  });
});
