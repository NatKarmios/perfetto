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
import {classNames} from '../../base/classnames';
import {SimpleResizeObserver} from '../../base/resize_observer';
import {Button} from '../../widgets/button';
import {EmptyState} from '../../widgets/empty_state';
import type {DuneGraphController} from './controller';
import type {NodeId} from './graph';
import {inducedEdges, plural} from './graph';
import {decorateNode} from './node_display';
import type {GraphLayout, LayoutEdge, LayoutNode} from './graph_layout';
import {layoutGraph, NODE_HEIGHT, NODE_WIDTH} from './graph_layout';

/**
 * A node set for the panel to draw that is *not* the controller's own graph
 * selection - what the Data Explorer's node graph chart hands it (see
 * node_graph_chart.ts).
 *
 * Only the node set is injected. Everything else the panel reads off the
 * controller stays there, because nothing else genuinely differs between the
 * two surfaces: the edges come from the same graph, "Hide rules" is a property
 * of how a Dune graph is drawn rather than of who asked for it, and clicking a
 * dot means the same thing wherever the dot is. What does differ is that the
 * two toolbar actions that act on the *selection* - "Timeline" and "Clear" -
 * would act on something other than what is on screen, so they are dropped
 * whenever this is present (see {@link GraphPanel.renderToolbar}).
 *
 * `nodes` is never empty: a caller with nothing to draw has a better thing to
 * say about why than "no nodes selected for the graph yet", and says it instead
 * of mounting the panel.
 */
export interface GraphPanelNodes {
  /**
   * The nodes to draw - the "selection" as far as this panel is concerned.
   * Edge contraction walks all of it (so a hidden rule between two deps still
   * joins them up) and the hide-rules filter is applied on top.
   */
  readonly nodes: readonly NodeId[];

  /**
   * How many nodes there were before any cap was applied, so the toolbar can
   * say "400 of 3,912 nodes" rather than claim the capped set is the whole
   * answer. Equal to `nodes.length` when nothing was dropped.
   */
  readonly total: number;

  /**
   * A number that changes whenever `nodes` does: the panel's relayout key, in
   * place of `controller.graphVersion` (which moves for the *selection*, and so
   * is neither necessary nor sufficient here).
   *
   * Monotonic across every producer rather than per-producer, since the panel
   * outlives the thing that fed it: a chart whose query changes builds a fresh
   * source and hands the same mithril component instance its first result, and
   * two sources' "first result" must not carry the same number.
   */
  readonly version: number;
}

interface GraphPanelAttrs {
  readonly controller: DuneGraphController;

  /**
   * The nodes to draw. Omitted by the side panel, which draws the controller's
   * own graph selection - see {@link GraphPanelNodes}.
   */
  readonly nodes?: GraphPanelNodes;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

// Empty margin (layout units) left around the content when fitting to the pane.
const FIT_PADDING = 24;
// Wheel zoom factor per notch (in = magnify).
const ZOOM_IN = 1 / 1.1;
const ZOOM_OUT = 1.1;
// How far `zoom` (layout units per CSS pixel) may range: up to 5x magnified,
// down to 1/20th.
const MIN_ZOOM = 1 / 5;
const MAX_ZOOM = 20;
// Pointer travel (px) past which a drag is a pan, not a click.
const DRAG_THRESHOLD = 3;
// Rendered node dot radius, and the gap left before the arrowhead at the dest.
const DOT_RADIUS = 6;
const ARROW_GAP = 2;

function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

/**
 * Renders the induced subgraph over a set of nodes as a layered SVG diagram:
 * pan by dragging, zoom with the wheel, click a node to jump to its slice. The
 * layout is recomputed only when that set changes; a new one is shown at a
 * fixed 1:1 scale (one layout unit per CSS pixel), centred on the content -
 * pan/zoom then just move the viewport, and resizing the pane reveals more or
 * less of the graph rather than rescaling it. "Fit" is the one explicit way to
 * zoom to the content.
 *
 * The set is the controller's graph selection unless one is handed over in
 * `attrs.nodes`, which is what the Data Explorer's node graph chart does - see
 * {@link GraphPanelNodes} for what does and doesn't change with it.
 */
export class GraphPanel implements m.ClassComponent<GraphPanelAttrs> {
  // The node set's version as of the last layout, so we only relayout/recentre
  // when the set actually changes (not on every pan/zoom redraw):
  // controller.graphVersion for the selection, or the injected set's own
  // version. -1 never matches either, so the first render always lays out.
  private sig = -1;
  // controller.hideRules as of the last layout. Redundant for the selection -
  // toggling it bumps graphVersion, so `sig` already catches it - but not for
  // an injected set, whose version knows nothing about the toggle.
  private sigHideRules = false;
  private layout: GraphLayout = {nodes: [], edges: [], width: 0, height: 0};
  // Layout units per CSS pixel: 1 == 1:1, larger == zoomed out.
  private zoom = 1;
  // Layout-space point held at the centre of the pane.
  private center: Point = {x: 0, y: 0};
  private resizeObs?: Disposable;

  // Pointer/pan state. Capture is deferred until a real drag: capturing on
  // pointerdown swallows the click event, so a plain click never reaches a dot.
  private pointerDown = false;
  private panning = false;
  private startX = 0;
  private startY = 0;
  private lastX = 0;
  private lastY = 0;
  // Set on a drag-release so the ensuing click doesn't navigate.
  private suppressClick = false;

  // Hover overlay: the node under the cursor, plus the live <svg> element used
  // to place the label in screen space.
  private hovered?: NodeId;
  private svgEl?: SVGSVGElement;

  onremove(): void {
    this.resizeObs?.[Symbol.dispose]();
    this.resizeObs = undefined;
  }

  view({attrs}: m.CVnode<GraphPanelAttrs>): m.Children {
    const {controller} = attrs;
    const nodes = attrs.nodes?.nodes ?? controller.selectedNodes;

    if (nodes.length === 0) {
      return m(EmptyState, {
        icon: 'account_tree',
        title: 'No nodes selected for the graph yet',
      });
    }

    // Rules are hidden but not removed from the set: their edges are contracted
    // through (see inducedEdges' isHidden param) rather than dropped, so a dep
    // resolving to a hidden rule that depends on another dep is drawn as a
    // direct edge between the two deps. The filter lives on the controller (so
    // the timeline track sees the same set) rather than here; for the graph
    // selection this is exactly `controller.visibleNodes`.
    const visible = controller.visibleIn(nodes);
    this.ensureLayout(attrs, nodes, visible);

    return m(
      '.pf-dune-graph__graph',
      this.renderToolbar(attrs, nodes.length, visible.length),
      m(
        '.pf-dune-graph__graph-canvas',
        visible.length === 0
          ? m(EmptyState, {
              icon: 'visibility_off',
              title: 'All nodes hidden',
            })
          : [this.renderSvg(controller), this.renderHoverLabel(controller)],
      ),
    );
  }

  private renderToolbar(
    attrs: GraphPanelAttrs,
    drawn: number,
    visibleCount: number,
  ): m.Children {
    const {controller} = attrs;
    const hiddenCount = drawn - visibleCount;
    // What was asked for, against what is being drawn. The two differ only for
    // an injected set that was capped, so the side panel's label is unchanged:
    // `total === drawn` collapses this back to "N nodes".
    const total = attrs.nodes?.total ?? drawn;
    const countLabel =
      total > drawn
        ? `${drawn} of ${plural(total, 'node')}`
        : plural(drawn, 'node');
    return m(
      '.pf-dune-graph__graph-toolbar',
      m(
        'span.pf-dune-graph__graph-count',
        hiddenCount > 0 ? `${countLabel} (${hiddenCount} hidden)` : countLabel,
      ),
      m(Button, {label: 'Fit', icon: 'fit_screen', onclick: () => this.fit()}),
      m(Button, {
        label: 'Hide rules',
        icon: 'visibility_off',
        active: controller.hideRules,
        onclick: () => controller.toggleHideRules(),
      }),
      // Both of these act on the graph *selection*, which is what is on screen
      // only when nothing was injected. Offered against an injected set they
      // would silently be about some other set of nodes - "Timeline" would show
      // the side panel's, and "Clear" would empty it from a card that is not
      // drawing it - so they are simply not there.
      attrs.nodes === undefined &&
        m(Button, {
          label: 'Timeline',
          icon: 'timeline',
          onclick: () => controller.showTimeline(),
        }),
      attrs.nodes === undefined &&
        m(Button, {
          label: 'Clear',
          icon: 'clear',
          onclick: () => controller.clearGraph(),
        }),
    );
  }

  private renderSvg(controller: DuneGraphController): m.Children {
    const selected = controller.nodeForSelection();
    // The viewBox is derived from the pane's live pixel size every render, so
    // it always has exactly the element's aspect ratio - `meet` then degenerates
    // to a plain 1/zoom scale with no letterboxing, and node spacing stays a
    // constant number of pixels regardless of how the pane is sized.
    const rect = this.svgEl?.getBoundingClientRect();
    const w =
      (rect === undefined || rect.width === 0 ? 1 : rect.width) * this.zoom;
    const h =
      (rect === undefined || rect.height === 0 ? 1 : rect.height) * this.zoom;
    const x = this.center.x - w / 2;
    const y = this.center.y - h / 2;
    return m(
      'svg.pf-dune-graph__svg',
      {
        viewBox: `${x} ${y} ${w} ${h}`,
        preserveAspectRatio: 'xMidYMid meet',
        oncreate: (vnode: m.VnodeDOM) => {
          if (vnode.dom instanceof SVGSVGElement) this.svgEl = vnode.dom;
          // The first paint above used a fallback 1x1 rect (the element didn't
          // exist yet to measure); redraw now that it does.
          m.redraw();
          this.resizeObs = new SimpleResizeObserver(vnode.dom, () =>
            m.redraw(),
          );
        },
        onwheel: (e: WheelEvent) => this.onWheel(e),
        onpointerdown: (e: PointerEvent) => this.onPointerDown(e),
        onpointermove: (e: PointerEvent) => this.onPointerMove(e),
        onpointerup: (e: PointerEvent) => this.onPointerUp(e),
        onpointercancel: (e: PointerEvent) => this.onPointerUp(e),
      },
      arrowMarker(),
      m(
        'g.pf-dune-graph__edges',
        this.layout.edges.map((e) => edgeLine(e, this.hovered)),
      ),
      m(
        'g.pf-dune-graph__nodes',
        this.layout.nodes.map((n) => this.nodeDot(controller, n, selected)),
      ),
    );
  }

  private nodeDot(
    controller: DuneGraphController,
    ln: LayoutNode,
    selected: NodeId | undefined,
  ): m.Children {
    const {node} = ln;
    return m('circle', {
      key: node,
      cx: ln.x + ln.width / 2,
      cy: ln.y + ln.height / 2,
      r: DOT_RADIUS,
      class: classNames(
        'pf-dune-graph__dot',
        `pf-dune-graph__dot--${controller.graph.kindOf(node)}`,
        node === selected && 'pf-dune-graph__dot--selected',
      ),
      onclick: () => this.onNodeClick(controller, node),
      onmouseenter: () => (this.hovered = node),
      onmouseleave: () => {
        if (this.hovered === node) this.hovered = undefined;
      },
    });
  }

  private onNodeClick(controller: DuneGraphController, node: NodeId): void {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    void controller.goToNode(node);
  }

  // Relayout + refit only when the visible node set (or the hide-rules
  // toggle) changes. For the graph selection controller.graphVersion is bumped
  // by every mutation that can change either, so it's a cheaper and more
  // complete invalidation key than re-joining the node set every render; an
  // injected set brings its own version, which says nothing about the toggle,
  // so that is compared separately. (For the selection the toggle check is
  // redundant - toggling bumps graphVersion - which is why this stays exactly
  // as sensitive as it was for the side panel.)
  private ensureLayout(
    attrs: GraphPanelAttrs,
    nodes: readonly NodeId[],
    visible: readonly NodeId[],
  ): void {
    const {controller} = attrs;
    const version = attrs.nodes?.version ?? controller.graphVersion;
    if (version === this.sig && controller.hideRules === this.sigHideRules) {
      return;
    }
    this.sig = version;
    this.sigHideRules = controller.hideRules;
    // inducedEdges walks the full selection so it can traverse through hidden
    // rules; layoutGraph only ever sees the visible nodes.
    const isHiddenRule = controller.hideRules
      ? (n: NodeId) => controller.graph.isRule(n)
      : undefined;
    this.layout = layoutGraph(
      visible,
      inducedEdges(controller.graph, nodes, isHiddenRule),
    );
    this.centerContent();
  }

  // Shows a freshly-selected graph at a fixed 1:1 scale, centred on its content.
  private centerContent(): void {
    this.zoom = 1;
    this.center = {x: this.layout.width / 2, y: this.layout.height / 2};
  }

  // Explicit zoom-to-fit: the only way the scale changes other than the wheel.
  private fit(): void {
    const rect = this.svgEl?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0 || rect.height === 0) return;
    const w = Math.max(this.layout.width, NODE_WIDTH) + 2 * FIT_PADDING;
    const h = Math.max(this.layout.height, NODE_HEIGHT) + 2 * FIT_PADDING;
    this.zoom = clampZoom(Math.max(w / rect.width, h / rect.height));
    this.center = {x: this.layout.width / 2, y: this.layout.height / 2};
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const svg = asSvg(e.currentTarget);
    const ctm = svg?.getScreenCTM();
    if (svg === undefined || ctm === null || ctm === undefined) return;
    // The exact layout-space point under the cursor, via the real transform -
    // more honest than deriving it from the viewBox fraction.
    const cursor = new DOMPoint(e.clientX, e.clientY).matrixTransform(
      ctm.inverse(),
    );

    const next = clampZoom(this.zoom * (e.deltaY < 0 ? ZOOM_IN : ZOOM_OUT));
    const scale = next / this.zoom;
    // Scaling the centre about the cursor point (by the same factor the
    // viewport is scaling by) keeps that point fixed under the cursor.
    this.center = {
      x: cursor.x + (this.center.x - cursor.x) * scale,
      y: cursor.y + (this.center.y - cursor.y) * scale,
    };
    this.zoom = next;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.pointerDown = true;
    this.panning = false;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.pointerDown) return;
    // Begin panning (and capture the pointer, so the drag survives leaving the
    // svg) only once past the threshold - before that a press is still a click.
    if (!this.panning) {
      const moved =
        Math.abs(e.clientX - this.startX) + Math.abs(e.clientY - this.startY);
      if (moved <= DRAG_THRESHOLD) return;
      this.panning = true;
      asSvg(e.currentTarget)?.setPointerCapture(e.pointerId);
    }
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    // The viewBox always matches the element's aspect ratio (see renderSvg), so
    // `zoom` is the one true units-per-pixel scale on both axes.
    this.center = {
      x: this.center.x - dx * this.zoom,
      y: this.center.y - dy * this.zoom,
    };
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.pointerDown) return;
    if (this.panning) {
      asSvg(e.currentTarget)?.releasePointerCapture(e.pointerId);
    }
    // A real drag just happened -> swallow the click that follows the release.
    this.suppressClick = this.panning;
    this.pointerDown = false;
    this.panning = false;
  }

  // Floating label for the hovered dot, positioned over the canvas. Hidden
  // during a drag so it doesn't chase the cursor while panning.
  private renderHoverLabel(controller: DuneGraphController): m.Children {
    if (this.hovered === undefined || this.pointerDown) return undefined;
    const ln = this.layout.nodes.find((n) => n.node === this.hovered);
    if (ln === undefined) return undefined;
    const pos = this.dotScreenPos(ln);
    if (pos === undefined) return undefined;
    // A dep's path gets the leading build/code icon (prefix folded into its
    // tooltip); a rule shows its bare id.
    const {icon, text} = decorateNode(controller.graph, ln.node);
    return m(
      '.pf-dune-graph__hover-label',
      {style: `left: ${pos.x}px; top: ${pos.y}px`},
      icon,
      text,
    );
  }

  // A dot's centre in coordinates relative to the graph canvas, mapping layout
  // units through the live SVG transform so it tracks pan/zoom.
  private dotScreenPos(ln: LayoutNode): {x: number; y: number} | undefined {
    const svg = this.svgEl;
    if (svg === undefined) return undefined;
    const canvas = svg.parentElement;
    const ctm = svg.getScreenCTM();
    if (canvas === null || ctm === null) return undefined;
    const p = new DOMPoint(
      ln.x + ln.width / 2,
      ln.y + ln.height / 2,
    ).matrixTransform(ctm);
    const rect = canvas.getBoundingClientRect();
    return {x: p.x - rect.left, y: p.y - rect.top};
  }
}

// A straight line between two node dots (source depends on dest), trimmed to the
// dot boundaries so it starts/ends at the circles' edges with an arrowhead.
// Forced edges are drawn red (line + arrowhead via a separate marker). Edges
// recede to half-opacity until one of their endpoints is the hovered node.
function edgeLine(e: LayoutEdge, hovered: NodeId | undefined): m.Children {
  const sx = e.source.x + e.source.width / 2;
  const sy = e.source.y + e.source.height / 2;
  const dx = e.dest.x + e.dest.width / 2;
  const dy = e.dest.y + e.dest.height / 2;
  const len = Math.hypot(dx - sx, dy - sy) || 1;
  const ux = (dx - sx) / len;
  const uy = (dy - sy) / len;
  const active =
    hovered !== undefined &&
    (e.source.node === hovered || e.dest.node === hovered);
  return m('line', {
    'class': classNames(
      'pf-dune-graph__edge',
      e.forced && 'pf-dune-graph__edge--forced',
      active && 'pf-dune-graph__edge--active',
    ),
    'x1': sx + ux * DOT_RADIUS,
    'y1': sy + uy * DOT_RADIUS,
    'x2': dx - ux * (DOT_RADIUS + ARROW_GAP),
    'y2': dy - uy * (DOT_RADIUS + ARROW_GAP),
    'marker-end': e.forced ? 'url(#dune-arrow-forced)' : 'url(#dune-arrow)',
  });
}

function arrowMarker(): m.Children {
  // Two markers sharing a shape: the default (muted) arrowhead and a red one for
  // forced edges (SVG markers don't inherit the referencing line's stroke).
  const marker = (id: string, cls: string) =>
    m(
      'marker',
      {
        id,
        viewBox: '0 0 8 8',
        refX: 7,
        refY: 4,
        markerWidth: 6,
        markerHeight: 6,
        orient: 'auto-start-reverse',
        markerUnits: 'userSpaceOnUse',
      },
      m('path', {class: cls, d: 'M0,0 L8,4 L0,8 Z'}),
    );
  return m(
    'defs',
    marker('dune-arrow', 'pf-dune-graph__arrow'),
    marker(
      'dune-arrow-forced',
      'pf-dune-graph__arrow pf-dune-graph__arrow--forced',
    ),
  );
}

function asSvg(target: EventTarget | null): SVGSVGElement | undefined {
  return target instanceof SVGSVGElement ? target : undefined;
}
