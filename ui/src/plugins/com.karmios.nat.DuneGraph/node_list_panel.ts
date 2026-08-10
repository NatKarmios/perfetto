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
import type {Trace} from '../../public/trace';
import {EmptyState} from '../../widgets/empty_state';
import {Spinner} from '../../widgets/spinner';
import {TextInput} from '../../widgets/text_input';
import type {DuneGraphController} from './controller';
import type {GraphNode} from './graph';

interface NodeListPanelAttrs {
  readonly trace: Trace;
  readonly controller: DuneGraphController;
}

export class NodeListPanel implements m.ClassComponent<NodeListPanelAttrs> {
  private filter = '';

  view({attrs}: m.CVnode<NodeListPanelAttrs>): m.Children {
    const {controller} = attrs;
    return m(
      '.pf-dune-graph',
      m(
        '.pf-dune-graph__toolbar',
        m(TextInput, {
          leftIcon: 'search',
          placeholder: 'Filter deps and rules…',
          value: this.filter,
          onInput: (value: string) => (this.filter = value),
        }),
      ),
      m('.pf-dune-graph__source', `Source: ${controller.sourceDescription}`),
      this.renderBody(attrs),
    );
  }

  private renderBody(attrs: NodeListPanelAttrs): m.Children {
    const {controller} = attrs;

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

    const allNodes = [
      ...controller.graph.deps.values(),
      ...controller.graph.rules.values(),
    ];
    const nodes = this.applyFilter(allNodes);

    if (nodes.length === 0) {
      return m(EmptyState, {
        icon: 'account_tree',
        title:
          allNodes.length === 0
            ? 'No build-graph nodes found in this trace'
            : 'No nodes match the filter',
      });
    }

    const selected = controller.nodeForSelection();
    return m(
      '.pf-dune-graph__list',
      nodes.map((node) => this.renderRow(attrs, node, node === selected)),
    );
  }

  private renderRow(
    attrs: NodeListPanelAttrs,
    node: GraphNode,
    isSelected: boolean,
  ): m.Children {
    const summary = edgeSummary(node);
    return m(
      '.pf-dune-graph__row',
      {
        key: `${node.kind}:${node.id}`,
        class: classNames(isSelected && 'pf-dune-graph__row--selected'),
        // Selecting the slice on click is the node -> slice half of the
        // bidirectional highlight.
        onclick: () => this.selectSlice(attrs.trace, node.sliceId),
      },
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
      m('span.pf-dune-graph__row-label', {title: node.id}, nodeLabel(node)),
      summary !== undefined && m('span.pf-dune-graph__row-summary', summary),
    );
  }

  // Select the slice a node was extracted from and scroll it into view.
  //
  // We resolve the track and reveal its ancestor groups *before* selecting so
  // that the track's DOM element exists by the time the selection's scroll
  // runs. Otherwise scrollToSelection's vertical scroll silently no-ops when
  // the track sits in a collapsed group (the horizontal/time scroll still works
  // as it doesn't depend on the track being in the DOM).
  private async selectSlice(trace: Trace, sliceId: number): Promise<void> {
    const match = (
      await trace.selection.resolveSqlEvents('slice', [sliceId])
    )[0];
    if (match === undefined) return;
    trace.currentWorkspace.getTrackByUri(match.trackUri)?.reveal();
    trace.selection.selectTrackEvent(match.trackUri, match.eventId, {
      scrollToSelection: true,
    });
  }

  private applyFilter(nodes: readonly GraphNode[]): readonly GraphNode[] {
    const needle = this.filter.trim().toLowerCase();
    if (needle === '') return nodes;
    return nodes.filter((n) => searchText(n).includes(needle));
  }
}

function nodeLabel(node: GraphNode): string {
  return node.kind === 'rule' ? `rule ${node.id}` : node.id;
}

function searchText(node: GraphNode): string {
  const parts: string[] = [node.kind, nodeLabel(node), node.id];
  if (node.kind === 'dep' && node.resolvedRuleId !== undefined) {
    parts.push(node.resolvedRuleId);
  }
  return parts.join(' ').toLowerCase();
}

// A short one-line summary of a node's outgoing edges.
function edgeSummary(node: GraphNode): string | undefined {
  if (node.kind === 'dep') {
    if (node.resolvedRuleId !== undefined) {
      return `→ rule ${node.resolvedRuleId}`;
    }
    if (node.expandedDepIds !== undefined) {
      return `→ ${plural(node.expandedDepIds.length, 'dep')}`;
    }
    return undefined;
  }

  const parts: string[] = [];
  if (node.staticDepIds !== undefined) {
    parts.push(plural(node.staticDepIds.length, 'dep'));
  }
  if (node.dynamicDepIds !== undefined) {
    const total = node.dynamicDepIds.reduce((n, g) => n + g.length, 0);
    parts.push(plural(total, 'dyn-dep'));
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
