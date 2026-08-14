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
import {nodeKey} from './graph';
import type {PathTreeGroup, PathTreeRow} from './path_tree';

/**
 * Graph-membership interactivity shared by both `PathTreeView` trees - the
 * current-selection panel's Dependants/Dependencies lists
 * (`selection_info_panel.ts`) and the query tab's results tree
 * (`query_tab.ts`). Unlike `node_display.ts` / `path_tree.ts` /
 * `path_tree_view.ts`, this depends on `DuneGraphController` and the `Button`
 * widget, since it's specifically the add/remove wiring glued onto a tree
 * leaf/group rather than generic display or tree structure.
 */

// The ＋/－ toggle for a single node: adds or removes it, reflecting current
// graph membership.
export function nodeToggleButton(
  controller: DuneGraphController,
  node: GraphNode,
): m.Children {
  const inGraph = controller.isInGraph(node);
  return m(Button, {
    icon: inGraph ? 'remove' : 'add',
    compact: true,
    title: inGraph ? 'Remove from graph' : 'Add to graph',
    onclick: () =>
      inGraph
        ? controller.removeFromGraph([node])
        : controller.addToGraph([node]),
  });
}

// Every distinct node nested under a tree group (deduped by node key),
// generic over any leaf payload shaped like `Ref` (selection panel) or
// `TreeLeafEntry` (query tab) - both carry an optional `node` field of the
// same shape, so no per-caller extractor is needed.
export function nodesInGroup<T extends {readonly node?: GraphNode}>(
  row: PathTreeGroup<T>,
): GraphNode[] {
  const seen = new Set<string>();
  const nodes: GraphNode[] = [];
  const walk = (r: PathTreeRow<T>) => {
    if (r.kind === 'leaf') {
      const {node} = r.item;
      if (node === undefined) return;
      const key = nodeKey(node.kind, node.id);
      if (seen.has(key)) return;
      seen.add(key);
      nodes.push(node);
    } else {
      r.rows.forEach(walk);
    }
  };
  row.rows.forEach(walk);
  return nodes;
}

// A directory group's bulk actions: add every node under it to the graph, or
// remove every node under it from the graph. Both are unconditionally
// enabled regardless of current membership (matching the query tab's
// "Add all" / "Remove all" Graph-menu pair, which doesn't gate on membership
// either). Absent when the group has no nodes to act on.
export function groupBulkActions(
  controller: DuneGraphController,
  nodes: readonly GraphNode[],
): m.Children {
  if (nodes.length === 0) return undefined;
  return [
    m(Button, {
      icon: 'add',
      title: `Add all ${nodes.length} nodes in this directory to the graph`,
      onclick: () => controller.addToGraph(nodes),
    }),
    m(Button, {
      icon: 'remove',
      title: `Remove all ${nodes.length} nodes in this directory from the graph`,
      onclick: () => controller.removeFromGraph(nodes),
    }),
  ];
}
