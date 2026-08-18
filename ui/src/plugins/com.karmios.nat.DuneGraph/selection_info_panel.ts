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
import {Icons} from '../../base/semantic_icons';
import {Anchor} from '../../widgets/anchor';
import {Button} from '../../widgets/button';
import {Icon} from '../../widgets/icon';
import {EmptyState} from '../../widgets/empty_state';
import {MenuItem, PopupMenu} from '../../widgets/menu';
import {Accordion, AccordionSection} from '../../widgets/accordion';
import type {DuneGraphController} from './controller';
import type {
  ForcedBy,
  GraphNode,
  NodeId,
  NodeKind,
  NodeTiming,
  OutRef,
} from './graph';
import {
  decorateDepPath,
  decorateNode,
  depResolutionLabel,
  forcedByText,
  formatDurNs,
  nodePathParts,
  outcomeLabel,
} from './node_display';
import {
  groupBulkActions,
  nodesInGroup,
  nodeToggleButton,
} from './node_tree_actions';
import type {PathTreeItem, PathTreeLeaf} from './path_tree';
import {buildPathTree} from './path_tree';
import {PathTreeView} from './path_tree_view';

interface SelectionInfoPanelAttrs {
  readonly controller: DuneGraphController;
}

// One entry in the dependencies / dependants lists: a referenced node (absent
// for a reference the blob never recorded a node for), the kind it stands for (so
// the kind chip renders even then), its display label, the directory it files
// under in the path tree (a rule's `dir`; a dep's label is itself a path), an
// optional chip marking a special edge kind (dynamic dep), and whether the edge
// is forced. `OutRef` (see graph.ts) is this shape plus the edge kind it was
// derived from.
interface Ref {
  readonly kind: NodeKind;
  readonly label: string;
  readonly dir?: string;
  readonly node?: NodeId;
  readonly chip?: string;
  readonly forced: boolean;
}

/**
 * Details for the build-graph node behind the current timeline selection, or an
 * empty state when the selection isn't a build-dep / exec-rule slice. Reads the
 * selection off the controller each render (selection is poll-based).
 *
 * The body is two lists - `dependencies` (nodes this one depends on) and
 * `dependants` (nodes that depend on this one) - each a union of the node's own
 * referenced ids and the graph's accrued edges, with forced edges marked by a
 * leading icon.
 */
export class SelectionInfoPanel implements m.ClassComponent<SelectionInfoPanelAttrs> {
  // Collapse state for the dependants/dependencies path-tree groups, keyed by
  // `${title}:${group.path}` so the same directory in each list folds
  // independently. Reset whenever the selection changes (the panel is
  // re-rendered on a selection poll rather than remounted, so this can't just
  // live in the constructor).
  private collapsed = new Set<string>();
  private selectionKey?: string;
  // The selected node's timing, which lives in SQL rather than on the node
  // (see lifecycle_sql.ts) and so has to be fetched. Keyed by the node *and*
  // whether the mirror that answers the query exists yet, so a selection made
  // mid-load picks its timing up as soon as the mirror lands.
  private timingKey?: string;
  private timing?: NodeTiming;

  view({attrs}: m.CVnode<SelectionInfoPanelAttrs>): m.Children {
    const {controller} = attrs;
    const selected = controller.nodeForSelection();
    if (selected === undefined) {
      this.collapsed.clear();
      this.selectionKey = undefined;
      return m(EmptyState, {
        icon: 'info',
        title: 'Select a build-dep or exec-rule slice',
      });
    }
    const selectionKey = String(selected);
    if (selectionKey !== this.selectionKey) {
      this.collapsed.clear();
      this.selectionKey = selectionKey;
    }
    this.fetchTiming(controller, selected, selectionKey);
    // The one place a node view is materialised: the header and its muted
    // lines below want every scalar the node has, and there is exactly one of
    // them on screen (see graph.ts's GraphNode).
    const node = controller.graph.node(selected);
    const dependants = this.dependants(controller, selected);
    return m(
      '.pf-dune-graph__info',
      this.renderHeader(controller, node),
      this.renderDir(node),
      this.renderAction(node),
      this.renderForcedBy(controller, node, dependants),
      m(
        Accordion,
        {multi: true},
        this.renderRefs(controller, 'Dependants', dependants),
        this.renderRefs(
          controller,
          'Dependencies',
          this.dependencies(controller, selected),
        ),
      ),
    );
  }

  // Starts a timing fetch when the panel is showing a node whose timing it
  // hasn't got, and asks for a redraw once it lands. Called from `view`, so it
  // must be a no-op for a node already fetched.
  private fetchTiming(
    controller: DuneGraphController,
    node: NodeId,
    selectionKey: string,
  ): void {
    const key = `${selectionKey}|${controller.nodeMirrorReady}`;
    if (this.timingKey === key) return;
    this.timingKey = key;
    this.timing = undefined;
    void controller.timingFor(node).then((timing) => {
      if (this.timingKey !== key) return; // selection moved on meanwhile
      this.timing = timing;
      controller.requestRedraw();
    });
  }

  private renderHeader(
    controller: DuneGraphController,
    node: GraphNode,
  ): m.Children {
    // The node id is always known, but it's only useful as a cross-reference
    // once the tables the `dune_*` functions read exist.
    const nodeId = controller.nodeMirrorReady ? node.nodeId : undefined;
    // A dep's path gets the leading build/code icon (its `_build/<dir>/` prefix
    // folded into the icon tooltip); a rule shows its bare id. The full,
    // undecorated label stays available on the title's hover tooltip.
    const label = node.label;
    const {icon, text} = decorateNode(controller.graph, node.nodeId);
    return m(
      '.pf-dune-graph__info-header',
      m(
        'span.pf-dune-graph__info-main',
        m(
          'span',
          {
            class: classNames(
              'pf-dune-graph__chip',
              `pf-dune-graph__chip--${node.kind}`,
            ),
          },
          node.kind,
        ),
        icon,
        m(
          'span.pf-dune-graph__info-title',
          {title: label},
          m(
            'span.pf-dune-graph__info-title-text',
            m('span.pf-dune-graph__info-title-bidi', text),
          ),
        ),
        this.renderStatus(node),
      ),
      m(
        'span.pf-dune-graph__info-actions',
        // The dense SQL node_id, unintrusive - a cross-reference for the
        // dune_* relation functions in the query tab.
        nodeId !== undefined &&
          m(
            'span.pf-dune-graph__info-nodeid',
            {
              title:
                'node_id — pass to dune_descendants() / dune_ancestors() / ' +
                'dune_children() / dune_parents() / dune_forcers() / ' +
                'dune_forced()',
            },
            `#${nodeId}`,
          ),
        this.renderAddMenu(controller, node.nodeId),
      ),
    );
  }

  // Dropdown to add the node - or one of its relations - to the graph
  // selection. "Parents"/"ancestors" are nodes that directly/transitively
  // depend on this one; "children"/"descendants" are nodes it directly/
  // transitively depends on; "forcers" is the chain of nodes that transitively
  // forced this one into the build. Every option adds the current node itself
  // alongside the relation, so the added nodes stay connected to something
  // already visible.
  private renderAddMenu(
    controller: DuneGraphController,
    node: NodeId,
  ): m.Children {
    return m(
      PopupMenu,
      {
        trigger: m(Button, {
          label: 'Add to graph',
          icon: 'account_tree',
          rightIcon: Icons.ContextMenu,
        }),
      },
      this.addMenuItem(controller, node, 'This node', 'add', () => []),
      this.addMenuItem(controller, node, 'Parents', 'arrow_upward', () =>
        controller.parentsOf(node),
      ),
      this.addMenuItem(controller, node, 'Children', 'arrow_downward', () =>
        controller.childrenOf(node),
      ),
      this.addMenuItem(
        controller,
        node,
        'Ancestors',
        'keyboard_double_arrow_up',
        () => controller.ancestorsOf(node),
      ),
      this.addMenuItem(
        controller,
        node,
        'Descendants',
        'keyboard_double_arrow_down',
        () => controller.descendantsOf(node),
      ),
      this.addMenuItem(controller, node, 'Forcers', 'priority_high', () =>
        controller.forcersOf(node),
      ),
    );
  }

  // One "Add to graph" menu item: adds `node` plus whatever `related` returns.
  // `related` is only called on click, since some relations (e.g. descendants
  // of a hot node) can be expensive to walk.
  private addMenuItem(
    controller: DuneGraphController,
    node: NodeId,
    label: string,
    icon: string,
    related: () => readonly NodeId[],
  ): m.Children {
    return m(MenuItem, {
      label,
      icon,
      onclick: () => controller.addToGraph([node, ...related()]),
    });
  }

  // A rule's context directory (`dune.dir`), as a muted line under the header.
  // Absent for deps and for rules that didn't record one.
  private renderDir(node: GraphNode): m.Children {
    if (node.kind !== 'rule') return undefined;
    const dir = node.dir;
    if (dir === undefined) return undefined;
    const {icon, text} = decorateDepPath(dir);
    return m(
      '.pf-dune-graph__dir',
      {title: dir},
      m('span.pf-dune-graph__dir-label', 'dir'),
      icon,
      text,
    );
  }

  // The header's status chip: how the node resolved (a rule's outcome, or a
  // dep's resolution) plus its span duration, and a `×N` hint when the span
  // was seen more than once (watch mode, or a dep built more than once - see
  // `SpanTiming.occurrenceCount`). The duration/`×N` half appears once the
  // timing query lands (and not at all for a node no lifecycle instant
  // resolved to); the resolution half comes off the node and is always there.
  private renderStatus(node: GraphNode): m.Children {
    const label =
      node.kind === 'rule'
        ? outcomeLabel(node.outcome)
        : depResolutionLabel(node.resolution);
    const durNs = this.timing?.timing?.durNs;
    const occurrences = this.timing?.timing?.occurrenceCount;
    return m(
      'span.pf-dune-graph__status',
      m('span.pf-dune-graph__status-label', label),
      durNs !== undefined &&
        m('span.pf-dune-graph__status-dur', formatDurNs(durNs)),
      occurrences !== undefined &&
        occurrences > 1 &&
        m(
          'span.pf-dune-graph__status-occ',
          {
            title: `Seen ${occurrences} times, e.g. across watch-mode iterations`,
          },
          `×${occurrences}`,
        ),
    );
  }

  // An executed rule's action interval, as a muted line under `dir` - "action
  // in flight" per the dune doc, not worker occupancy: it includes scheduler
  // queue wait and isn't bounded by `-j` (see `RuleNode.actionTiming` in
  // graph.ts). Absent for a cache hit (no action ran) or one that never
  // resolved a duration.
  private renderAction(node: GraphNode): m.Children {
    if (node.kind !== 'rule') return undefined;
    const durNs = this.timing?.actionTiming?.durNs;
    if (durNs === undefined) return undefined;
    return m(
      '.pf-dune-graph__action',
      {
        title:
          'Time the action was in flight, including scheduler queue wait - ' +
          'not bounded by -j, so not the same as worker occupancy.',
      },
      m('span.pf-dune-graph__dir-label', 'action'),
      formatDurNs(durNs),
    );
  }

  // The node's `dune.forced_by`, as a muted line under the header. The RULE /
  // DEP forcers link to that node's slice (like other referenced ids) when it's
  // in the graph; the rest are descriptive text.
  //
  // A RULE/DEP forcer is itself a dependant (the forced edge points from it into
  // this node), so it already appears - marked as forced - in the Dependants
  // list; we only surface this explicit line when the forcer isn't in that list
  // (a non-node kind, or a reference the blob never recorded a node for).
  private renderForcedBy(
    controller: DuneGraphController,
    node: GraphNode,
    dependants: readonly Ref[],
  ): m.Children {
    const fb = node.forcedBy;
    if (fb === undefined || forcerInList(fb, dependants)) return undefined;
    return m(
      '.pf-dune-graph__forced-by',
      'Forced by ',
      this.forcedByContent(controller, fb),
    );
  }

  // Phrasing comes from `forcedByText` (shared with the query tab's tree
  // extras); only RULE/DEP additionally get linked to their node here, since
  // the query tab has no node to link to for a plain SQL column.
  private forcedByContent(
    controller: DuneGraphController,
    fb: ForcedBy,
  ): m.Children {
    const text = forcedByText(fb.kind, fb.target) ?? 'an unknown source';
    return nodeLink(controller, fb.node, text);
  }

  // Groups `refs` into a path tree (deps by their id, rules by their `dir`)
  // and renders it inside the accordion section; nesting only appears where a
  // directory actually holds two or more rows.
  private renderRefs(
    controller: DuneGraphController,
    title: string,
    refs: readonly Ref[],
  ): m.Children {
    const tree = buildPathTree(refs.map(refPathItem));
    return m(
      AccordionSection,
      {summary: `${title} (${refs.length})`, defaultOpen: true},
      refs.length === 0
        ? m('.pf-dune-graph__refs-empty', 'None')
        : m(PathTreeView<Ref>, {
            rows: tree,
            // Namespaced per-list so the same directory in Dependants and
            // Dependencies folds independently.
            keyPrefix: title,
            collapsed: this.collapsed,
            onToggleGroup: (key) => {
              if (this.collapsed.has(key)) this.collapsed.delete(key);
              else this.collapsed.add(key);
            },
            renderLeaf: (row) => this.renderRef(controller, row),
            groupActions: (row) =>
              groupBulkActions(controller, nodesInGroup(row)),
          }),
    );
  }

  private renderRef(
    controller: DuneGraphController,
    row: PathTreeLeaf<Ref>,
  ): m.Children {
    const {item: ref, prefix, label} = row;
    return m(
      '.pf-dune-graph__ref',
      // Forced edges lead with an icon (in place of the old bold text).
      ref.forced &&
        m(Icon, {
          icon: 'priority_high',
          title: 'Forced edge',
          className: 'pf-dune-graph__forced-icon',
        }),
      m(
        'span',
        {
          class: classNames(
            'pf-dune-graph__chip',
            `pf-dune-graph__chip--${ref.kind}`,
          ),
        },
        ref.kind,
      ),
      ref.chip !== undefined &&
        m(
          'span.pf-dune-graph__ref-chip',
          {title: chipTitle(ref.chip)},
          ref.chip,
        ),
      m(
        'span.pf-dune-graph__ref-label',
        prefix !== '' && m('span.pf-dune-graph__ref-prefix', prefix),
        nodeLink(controller, ref.node, label),
      ),
      ref.node !== undefined && nodeToggleButton(controller, ref.node),
    );
  }

  // Nodes this one depends on (its outgoing edges): a rule's static + dynamic
  // deps, a dep's resolved rule + expanded deps. All of them are the node's own
  // out-edges, dynamic ones chipped `DYN`; a reference the blob never recorded a
  // node for shows as a plain unlinked entry.
  private dependencies(controller: DuneGraphController, node: NodeId): Ref[] {
    return [...controller.graph.outRefs(node)].map(refOf);
  }

  // Nodes that depend on this one (its incoming edges): the graph's reverse
  // edges, unioned with a rule's declared targets (which depend on the rule to
  // be produced). A target with no reverse edge yet is still listed (unlinked if
  // it isn't a known node).
  private dependants(controller: DuneGraphController, node: NodeId): Ref[] {
    const graph = controller.graph;
    const refs: Ref[] = [];
    for (const parent of controller.parentsOf(node)) {
      refs.push({
        kind: graph.kindOf(parent),
        label: graph.labelOf(parent),
        dir: graph.dirOf(parent),
        node: parent,
        forced: graph.forcerOf(node) === parent,
      });
    }
    if (graph.isRule(node)) {
      // A rule's declared targets depend on it to be produced, so they belong
      // in this list - but a target is a *path* (its `dir` joined onto a
      // relative name), not a dict id, so it can't be resolved back to a dep
      // node by id. Dedup against the dep dependants' paths and list what's
      // left as a plain unlinked row. In practice a target that is a known dep
      // node is already a dependant: that dep resolves to this rule, which is
      // exactly a reverse edge into it.
      const paths = new Set(
        refs.filter((r) => r.kind === 'dep').map((r) => r.label),
      );
      for (const {path} of graph.ruleTargets(node)) {
        if (paths.has(path)) continue;
        paths.add(path);
        refs.push({kind: 'dep', label: path, forced: false});
      }
    }
    return refs;
  }
}

// A dependency row for one of a node's out-edges: the same fields, plus the
// `DYN` chip a dynamic dep gets (an expanded dep gets none - the parent dep's
// own status chip already says it expanded).
function refOf(ref: OutRef): Ref {
  return {
    kind: ref.kind,
    label: ref.label,
    dir: ref.dir,
    node: ref.node,
    chip: ref.edgeKind === 'dynamic' ? 'DYN' : undefined,
    forced: ref.forced,
  };
}

// Human-readable tooltip for a ref chip (only DYN - dynamic deps - today).
function chipTitle(chip: string): string {
  return chip === 'DYN' ? 'Dynamic dependency' : chip;
}

// Whether a forcer is already represented as a node in the dependants list.
// Only the RULE/DEP kinds name a node at all, and only when the blob recorded
// one, so anything else is never in the list.
function forcerInList(fb: ForcedBy, dependants: readonly Ref[]): boolean {
  return fb.node !== undefined && dependants.some((r) => r.node === fb.node);
}

// Render `label` as a link that navigates to `node`'s slice, or as plain text
// when `node` is undefined (the referenced id isn't a known graph node - see
// `dangling` in graph.ts).
function nodeLink(
  controller: DuneGraphController,
  node: NodeId | undefined,
  label: string,
): m.Children {
  if (node === undefined) return label;
  return m(Anchor, {onclick: () => void controller.goToNode(node)}, label);
}

// Where a ref files into the path tree: a dep ref's label is itself a path; a
// rule ref files under its node's `dir` field (top-level when unrecorded or
// unset). See `nodePathParts`.
function refPathItem(ref: Ref): PathTreeItem<Ref> {
  const {dir: dirSegs, leaf} = nodePathParts(ref.kind, ref.label, ref.dir);
  return {dir: dirSegs, leaf, item: ref};
}
