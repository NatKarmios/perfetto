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
import type {ForcedBy, GraphNode} from './graph';
import {isForcedEdge, nodeKey, nodeLabel} from './graph';
import {decorateDepPath} from './node_display';

interface SelectionInfoPanelAttrs {
  readonly controller: DuneGraphController;
}

// One entry in the dependencies / dependants lists: a referenced node (or a
// dangling id), the kind it stands for (so the kind chip renders even when the
// node is dangling), its display label, an optional chip marking a special edge
// kind (dynamic dep, expanded dep, rule target), and whether the edge is forced.
interface Ref {
  readonly kind: GraphNode['kind'];
  readonly label: string;
  readonly node?: GraphNode;
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
  view({attrs}: m.CVnode<SelectionInfoPanelAttrs>): m.Children {
    const {controller} = attrs;
    const node = controller.nodeForSelection();
    if (node === undefined) {
      return m(EmptyState, {
        icon: 'info',
        title: 'Select a build-dep or exec-rule slice',
      });
    }
    const dependants = this.dependants(controller, node);
    return m(
      '.pf-dune-graph__info',
      this.renderHeader(controller, node),
      this.renderForcedBy(controller, node, dependants),
      m(
        Accordion,
        {multi: true},
        this.renderRefs(controller, 'Dependants', dependants),
        this.renderRefs(
          controller,
          'Dependencies',
          this.dependencies(controller, node),
        ),
      ),
    );
  }

  private renderHeader(
    controller: DuneGraphController,
    node: GraphNode,
  ): m.Children {
    const nodeId = controller.nodeIdOf(node);
    // A dep's path gets the leading build/code icon (its `_build/<dir>/` prefix
    // folded into the icon tooltip); a rule shows its bare id. The full,
    // undecorated id stays available on the title's hover tooltip.
    const {icon, text} =
      node.kind === 'dep'
        ? decorateDepPath(node.id)
        : {icon: undefined, text: nodeLabel(node)};
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
          {title: node.id},
          m('span.pf-dune-graph__info-title-text', text),
        ),
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
        this.renderAddMenu(controller, node),
      ),
    );
  }

  // Dropdown to add the node - or its dependents (parents / ancestors) - to the
  // graph selection. "Parents" are the nodes that directly depend on this one;
  // "ancestors" are all nodes that transitively depend on it.
  private renderAddMenu(
    controller: DuneGraphController,
    node: GraphNode,
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
      m(MenuItem, {
        label: 'This node',
        icon: 'add',
        onclick: () => controller.addToGraph([node]),
      }),
      m(MenuItem, {
        label: 'Parents',
        icon: 'arrow_upward',
        onclick: () => controller.addToGraph(controller.parentsOf(node)),
      }),
      m(MenuItem, {
        label: 'Ancestors',
        icon: 'keyboard_double_arrow_up',
        onclick: () => controller.addToGraph(controller.ancestorsOf(node)),
      }),
    );
  }

  // The node's `dune.forced_by`, as a muted line under the header. The RULE /
  // DEP forcers link to that node's slice (like other referenced ids) when it's
  // in the graph; the rest are descriptive text.
  //
  // A RULE/DEP forcer is itself a dependant (the forced edge points from it into
  // this node), so it already appears - marked as forced - in the Dependants
  // list; we only surface this explicit line when the forcer isn't in that list
  // (a non-node kind, or an edge that didn't resolve).
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

  private forcedByContent(
    controller: DuneGraphController,
    fb: ForcedBy,
  ): m.Children {
    switch (fb.kind) {
      case 'RULE':
        return nodeLink(
          controller,
          controller.graph.rules.get(fb.rule),
          `rule ${fb.rule}`,
        );
      case 'DEP':
        return nodeLink(controller, controller.graph.deps.get(fb.dep), fb.dep);
      case 'DYNAMIC_INCLUDES':
        return `dynamic_includes (${fb.dynamicIncludes})`;
      case 'GEN_RULES':
        return `rule generation (${fb.genRules})`;
      case 'PFORM':
        return `variable expansion (${fb.pform})`;
      case 'CONFIGURATOR':
        return 'the initial dune configuration';
      case 'REQUEST':
        return 'the top-level build request';
      case 'UNKNOWN':
        return 'an unknown source';
    }
  }

  private renderRefs(
    controller: DuneGraphController,
    title: string,
    refs: readonly Ref[],
  ): m.Children {
    return m(
      AccordionSection,
      {summary: `${title} (${refs.length})`, defaultOpen: true},
      refs.length === 0
        ? m('.pf-dune-graph__refs-empty', 'None')
        : m(
            '.pf-dune-graph__refs',
            refs.map((ref) => this.renderRef(controller, ref)),
          ),
    );
  }

  private renderRef(controller: DuneGraphController, ref: Ref): m.Children {
    // A dep label is a path, decorated with a leading build/code icon; a rule
    // label is its bare id.
    const {icon, text} =
      ref.kind === 'dep'
        ? decorateDepPath(ref.label)
        : {icon: undefined, text: ref.label};
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
        icon,
        nodeLink(controller, ref.node, text),
      ),
    );
  }

  // Nodes this one depends on (its outgoing edges): a rule's static + dynamic
  // deps, a dep's resolved rule + expanded deps. All derive from the node's own
  // args; unresolved ids show as dangling (non-linked) entries.
  private dependencies(
    controller: DuneGraphController,
    node: GraphNode,
  ): Ref[] {
    const {deps, rules} = controller.graph;
    const refs: Ref[] = [];
    if (node.kind === 'rule') {
      for (const id of node.staticDepIds ?? []) {
        refs.push(depRef(node, id, deps.get(id)));
      }
      for (const group of node.dynamicDepIds ?? []) {
        for (const id of group) {
          refs.push(depRef(node, id, deps.get(id), 'DYN'));
        }
      }
    } else {
      if (node.resolvedRuleId !== undefined) {
        const rule = rules.get(node.resolvedRuleId);
        refs.push({
          kind: 'rule',
          label: node.resolvedRuleId,
          node: rule,
          forced: rule !== undefined && isForcedEdge(node, rule),
        });
      }
      for (const id of node.expandedDepIds ?? []) {
        refs.push(depRef(node, id, deps.get(id)));
      }
    }
    return refs;
  }

  // Nodes that depend on this one (its incoming edges): the graph's reverse
  // edges, unioned with a rule's declared targets (which depend on the rule to
  // be produced). A target with no reverse edge yet is still listed (dangling if
  // it isn't a known node).
  private dependants(controller: DuneGraphController, node: GraphNode): Ref[] {
    const refs: Ref[] = [];
    const seen = new Set<string>();
    for (const parent of controller.parentsOf(node)) {
      seen.add(nodeKey(parent.kind, parent.id));
      refs.push({
        kind: parent.kind,
        label: nodeLabel(parent),
        node: parent,
        forced: isForcedEdge(parent, node),
      });
    }
    if (node.kind === 'rule') {
      for (const id of node.targetIds ?? []) {
        if (seen.has(nodeKey('dep', id))) continue;
        seen.add(nodeKey('dep', id));
        const dep = controller.graph.deps.get(id);
        refs.push({
          kind: 'dep',
          label: id,
          node: dep,
          forced: dep !== undefined && isForcedEdge(dep, node),
        });
      }
    }
    return refs;
  }
}

// A dependency ref for a dep id referenced by `source`, resolving `dep` and
// computing whether the `source -> dep` edge is forced.
function depRef(
  source: GraphNode,
  id: string,
  dep: GraphNode | undefined,
  chip?: string,
): Ref {
  return {
    kind: 'dep',
    label: id,
    node: dep,
    chip,
    forced: dep !== undefined && isForcedEdge(source, dep),
  };
}

// Human-readable tooltip for a ref chip (only DYN - dynamic deps - today).
function chipTitle(chip: string): string {
  return chip === 'DYN' ? 'Dynamic dependency' : chip;
}

// Whether a RULE/DEP forcer is already represented as a node in the dependants
// list. Non-node forcer kinds (paths / REQUEST / CONFIGURATOR / UNKNOWN) never
// are.
function forcerInList(fb: ForcedBy, dependants: readonly Ref[]): boolean {
  if (fb.kind === 'RULE') {
    return dependants.some(
      (r) => r.node?.kind === 'rule' && r.node.id === fb.rule,
    );
  }
  if (fb.kind === 'DEP') {
    return dependants.some(
      (r) => r.node?.kind === 'dep' && r.node.id === fb.dep,
    );
  }
  return false;
}

// Render `label` as a link that navigates to `node`'s slice, or as plain text
// when `node` is undefined (the referenced id isn't a known graph node, i.e. a
// dangling reference).
function nodeLink(
  controller: DuneGraphController,
  node: GraphNode | undefined,
  label: string,
): m.Children {
  if (node === undefined) return label;
  return m(Anchor, {onclick: () => void controller.goToNode(node)}, label);
}
