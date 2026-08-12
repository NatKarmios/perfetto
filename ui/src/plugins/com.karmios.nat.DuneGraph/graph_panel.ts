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
import {Button} from '../../widgets/button';
import {EmptyState} from '../../widgets/empty_state';
import type {DuneGraphController} from './controller';
import type {GraphNode} from './graph';
import {inducedEdges, nodeKey, nodeLabel, plural} from './graph';
import {decorateDepPath} from './node_display';
import type {GraphLayout, LayoutEdge, LayoutNode} from './graph_layout';
import {layoutGraph, NODE_HEIGHT, NODE_WIDTH} from './graph_layout';

interface GraphPanelAttrs {
  readonly controller: DuneGraphController;
}

interface ViewBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

// Empty margin (layout units) left around the content when fitting the viewBox.
const FIT_PADDING = 24;
// Wheel zoom factor per notch (in = shrink the viewBox).
const ZOOM_IN = 1 / 1.1;
const ZOOM_OUT = 1.1;
// How far the viewBox may shrink/grow relative to the fitted content width.
const MIN_ZOOM = 1 / 20;
const MAX_ZOOM = 5;
// Pointer travel (px) past which a drag is a pan, not a click.
const DRAG_THRESHOLD = 3;
// Rendered node dot radius, and the gap left before the arrowhead at the dest.
const DOT_RADIUS = 6;
const ARROW_GAP = 2;

/**
 * Renders the induced subgraph over the controller's selected nodes as a
 * layered SVG diagram: pan by dragging, zoom with the wheel, click a node to
 * jump to its slice. The layout is recomputed only when the selected set
 * changes; pan/zoom just move the viewBox.
 */
export class GraphPanel implements m.ClassComponent<GraphPanelAttrs> {
  // Signature of the currently-laid-out node set, so we only relayout/ refit
  // when the selection actually changes (not on every pan/zoom redraw).
  private sig = '';
  private layout: GraphLayout = {nodes: [], edges: [], width: 0, height: 0};
  private viewBox: ViewBox = {x: 0, y: 0, w: 1, h: 1};

  // Whether rule nodes are hidden. Their edges are contracted (see
  // inducedEdges' isHidden param), not deleted: a dep resolving to a hidden
  // rule that in turn depends on another dep is drawn as a direct edge
  // between the two deps.
  private hideRules = false;

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
  private hoveredKey?: string;
  private svgEl?: SVGSVGElement;

  view({attrs}: m.CVnode<GraphPanelAttrs>): m.Children {
    const {controller} = attrs;
    const nodes = controller.selectedNodes;

    if (nodes.length === 0) {
      return m(EmptyState, {
        icon: 'account_tree',
        title: 'No nodes selected for the graph yet',
      });
    }

    // Rules are hidden but not removed from the selection: their edges are
    // contracted through (see inducedEdges' isHidden param) rather than
    // dropped, so a dep resolving to a hidden rule that depends on another dep
    // is drawn as a direct edge between the two deps.
    const visible = this.hideRules
      ? nodes.filter((n) => n.kind !== 'rule')
      : nodes;
    this.ensureLayout(controller, nodes, visible);

    return m(
      '.pf-dune-graph__graph',
      this.renderToolbar(controller, nodes.length, visible.length),
      m(
        '.pf-dune-graph__graph-canvas',
        visible.length === 0
          ? m(EmptyState, {
              icon: 'visibility_off',
              title: 'All nodes hidden',
            })
          : [this.renderSvg(controller), this.renderHoverLabel()],
      ),
    );
  }

  private renderToolbar(
    controller: DuneGraphController,
    total: number,
    visibleCount: number,
  ): m.Children {
    const hiddenCount = total - visibleCount;
    const countLabel =
      hiddenCount > 0
        ? `${plural(total, 'node')} (${hiddenCount} hidden)`
        : plural(total, 'node');
    return m(
      '.pf-dune-graph__graph-toolbar',
      m('span.pf-dune-graph__graph-count', countLabel),
      m(Button, {label: 'Fit', icon: 'fit_screen', onclick: () => this.fit()}),
      m(Button, {
        label: 'Hide rules',
        icon: 'visibility_off',
        active: this.hideRules,
        onclick: () => (this.hideRules = !this.hideRules),
      }),
      m(Button, {
        label: 'Clear',
        icon: 'clear',
        onclick: () => controller.clearGraph(),
      }),
    );
  }

  private renderSvg(controller: DuneGraphController): m.Children {
    const selectedKey = keyOfSelection(controller);
    const {x, y, w, h} = this.viewBox;
    return m(
      'svg.pf-dune-graph__svg',
      {
        viewBox: `${x} ${y} ${w} ${h}`,
        preserveAspectRatio: 'xMidYMid meet',
        oncreate: (vnode: m.VnodeDOM) => {
          if (vnode.dom instanceof SVGSVGElement) this.svgEl = vnode.dom;
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
        this.layout.edges.map((e) => edgeLine(e)),
      ),
      m(
        'g.pf-dune-graph__nodes',
        this.layout.nodes.map((n) => this.nodeDot(controller, n, selectedKey)),
      ),
    );
  }

  private nodeDot(
    controller: DuneGraphController,
    ln: LayoutNode,
    selectedKey: string | undefined,
  ): m.Children {
    const {node} = ln;
    const key = nodeKey(node.kind, node.id);
    return m('circle', {
      key,
      cx: ln.x + ln.width / 2,
      cy: ln.y + ln.height / 2,
      r: DOT_RADIUS,
      class: classNames(
        'pf-dune-graph__dot',
        `pf-dune-graph__dot--${node.kind}`,
        key === selectedKey && 'pf-dune-graph__dot--selected',
      ),
      onclick: () => this.onNodeClick(controller, node),
      onmouseenter: () => (this.hoveredKey = key),
      onmouseleave: () => {
        if (this.hoveredKey === key) this.hoveredKey = undefined;
      },
    });
  }

  private onNodeClick(controller: DuneGraphController, node: GraphNode): void {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    void controller.goToNode(node);
  }

  // Relayout + refit only when the visible node set (or the hide-rules
  // toggle) changes.
  private ensureLayout(
    controller: DuneGraphController,
    nodes: readonly GraphNode[],
    visible: readonly GraphNode[],
  ): void {
    const sig = `${this.hideRules}|${visible
      .map((n) => nodeKey(n.kind, n.id))
      .join('|')}`;
    if (sig === this.sig) return;
    this.sig = sig;
    // inducedEdges walks the full selection so it can traverse through hidden
    // rules; layoutGraph only ever sees the visible nodes.
    const isHiddenRule = this.hideRules
      ? (n: GraphNode) => n.kind === 'rule'
      : undefined;
    this.layout = layoutGraph(
      visible,
      inducedEdges(controller.graph, nodes, isHiddenRule),
    );
    this.fit();
  }

  private fit(): void {
    const w = Math.max(this.layout.width, NODE_WIDTH) + 2 * FIT_PADDING;
    const h = Math.max(this.layout.height, NODE_HEIGHT) + 2 * FIT_PADDING;
    this.viewBox = {x: -FIT_PADDING, y: -FIT_PADDING, w, h};
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const svg = asSvg(e.currentTarget);
    const ctm = svg?.getScreenCTM();
    if (svg === undefined || ctm === null || ctm === undefined) return;
    // The exact layout-space point under the cursor, via the real (letterbox-
    // aware) transform. Mapping by raw viewBox fraction would drift whenever the
    // viewBox aspect differs from the element's.
    const cursor = new DOMPoint(e.clientX, e.clientY).matrixTransform(
      ctm.inverse(),
    );

    const vb = this.viewBox;
    const base = this.layout.width + 2 * FIT_PADDING || 1;
    let w = vb.w * (e.deltaY < 0 ? ZOOM_IN : ZOOM_OUT);
    w = Math.max(base * MIN_ZOOM, Math.min(base * MAX_ZOOM, w));
    const scale = w / vb.w;

    // Zoom scales w and h together, so the viewBox aspect (and thus the
    // letterbox) is unchanged; holding the cursor point at the same viewBox
    // fraction therefore keeps it fixed under the cursor on screen.
    this.viewBox = {
      x: cursor.x - (cursor.x - vb.x) * scale,
      y: cursor.y - (cursor.y - vb.y) * scale,
      w,
      h: vb.h * scale,
    };
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
    const rect = svgRect(e);
    if (rect === undefined) return;
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
    const vb = this.viewBox;
    // preserveAspectRatio="meet" scales BOTH axes by the same factor (the larger
    // viewBox/element ratio) and letterboxes the rest, so pixels -> units must
    // use that one scale on both axes - otherwise x and y pan at different
    // speeds whenever the viewBox aspect differs from the element's.
    const unitsPerPx = Math.max(vb.w / rect.width, vb.h / rect.height);
    this.viewBox = {
      ...vb,
      x: vb.x - dx * unitsPerPx,
      y: vb.y - dy * unitsPerPx,
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
  private renderHoverLabel(): m.Children {
    if (this.hoveredKey === undefined || this.pointerDown) return undefined;
    const ln = this.layout.nodes.find(
      (n) => nodeKey(n.node.kind, n.node.id) === this.hoveredKey,
    );
    if (ln === undefined) return undefined;
    const pos = this.dotScreenPos(ln);
    if (pos === undefined) return undefined;
    const {node} = ln;
    // A dep's path gets the leading build/code icon (prefix folded into its
    // tooltip); a rule shows its bare id.
    const {icon, text} =
      node.kind === 'dep'
        ? decorateDepPath(node.id)
        : {icon: undefined, text: nodeLabel(node)};
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

// The graph node behind the current timeline selection, as a node key.
function keyOfSelection(controller: DuneGraphController): string | undefined {
  const node = controller.nodeForSelection();
  return node === undefined ? undefined : nodeKey(node.kind, node.id);
}

// A straight line between two node dots (source depends on dest), trimmed to the
// dot boundaries so it starts/ends at the circles' edges with an arrowhead.
// Forced edges are drawn red (line + arrowhead via a separate marker).
function edgeLine(e: LayoutEdge): m.Children {
  const sx = e.source.x + e.source.width / 2;
  const sy = e.source.y + e.source.height / 2;
  const dx = e.dest.x + e.dest.width / 2;
  const dy = e.dest.y + e.dest.height / 2;
  const len = Math.hypot(dx - sx, dy - sy) || 1;
  const ux = (dx - sx) / len;
  const uy = (dy - sy) / len;
  return m('line', {
    'class': classNames(
      'pf-dune-graph__edge',
      e.forced && 'pf-dune-graph__edge--forced',
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

function svgRect(e: Event): DOMRect | undefined {
  const svg = asSvg(e.currentTarget);
  if (svg === undefined) return undefined;
  const rect = svg.getBoundingClientRect();
  return rect.width === 0 || rect.height === 0 ? undefined : rect;
}
