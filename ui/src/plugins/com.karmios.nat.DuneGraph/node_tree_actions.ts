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
import type {NodeId} from './graph';
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
  node: NodeId,
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

// Every distinct node nested under a tree group, generic over any leaf payload
// shaped like `Ref` (selection panel) or `TreeLeafEntry` (query tab) - both
// carry an optional `node` field of the same shape, so no per-caller extractor
// is needed.
export function nodesInGroup<T extends {readonly node?: NodeId}>(
  row: PathTreeGroup<T>,
): NodeId[] {
  const seen = new Set<NodeId>();
  const walk = (r: PathTreeRow<T>) => {
    if (r.kind === 'leaf') {
      const {node} = r.item;
      if (node !== undefined) seen.add(node);
    } else {
      r.rows.forEach(walk);
    }
  };
  row.rows.forEach(walk);
  return [...seen];
}

/**
 * The ＋all / －all pair for a set of nodes the caller can name but may not yet
 * hold: `nodes` is called on click, and may return its list or a promise of it.
 *
 * That indirection is what lets the directory explorer share these buttons. Its
 * tree is lazy, so a directory's members generally aren't loaded when its row is
 * drawn - only the *count* is, off `dune_dir` - and fetching them up front to
 * satisfy a button that may never be pressed would defeat the laziness. So the
 * count comes in separately (it is only ever a label) and the ids are fetched
 * by the click.
 *
 * Both actions are unconditionally enabled regardless of current membership,
 * matching the query tab's "Add all" / "Remove all" Graph-menu pair. Absent
 * when there is nothing to act on.
 *
 * `count` is how many nodes the click will act on, and is only ever a label;
 * `nodes` is called on click and returns the nodes to act on, or a promise of
 * them; `what` names the scope in the button titles ("in this directory").
 */
export function bulkNodeActions(
  controller: DuneGraphController,
  count: number,
  nodes: () => readonly NodeId[] | Promise<readonly NodeId[]>,
  what: string = 'in this directory',
): m.Children {
  if (count === 0) return undefined;
  const act = (apply: (ns: readonly NodeId[]) => void) => {
    const resolved = nodes();
    if (Array.isArray(resolved)) {
      apply(resolved);
      return;
    }
    // Resolved between frames, so the graph's own redraw isn't coming: ask.
    void (resolved as Promise<readonly NodeId[]>).then((ns) => {
      apply(ns);
      controller.requestRedraw();
    });
  };
  return [
    m(Button, {
      icon: 'add',
      title: `Add all ${count} nodes ${what} to the graph`,
      onclick: () => act((ns) => controller.addToGraph(ns)),
    }),
    m(Button, {
      icon: 'remove',
      title: `Remove all ${count} nodes ${what} from the graph`,
      onclick: () => act((ns) => controller.removeFromGraph(ns)),
    }),
  ];
}

// A directory group's bulk actions, for a tree that already holds its nodes -
// the two `PathTreeView` trees, whose rows are built from a resolved list.
export function groupBulkActions(
  controller: DuneGraphController,
  nodes: readonly NodeId[],
): m.Children {
  return bulkNodeActions(controller, nodes.length, () => nodes);
}
