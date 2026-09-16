// Copyright (C) 2025 The Android Open Source Project
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
import {MenuItem} from '../../../../widgets/menu';
import {type NodeDescriptor, nodeRegistry} from '../node_registry';
import {Keycap} from '../../../../widgets/hotkey_glyphs';

/**
 * Build menu items for a specific node type.
 *
 * @param nodeType - Type of nodes to include
 * @param onAddNode - Callback when a menu item is clicked
 * @returns Array of Mithril children representing the menu items
 */
export function buildMenuItems(
  nodeType: 'source' | 'multisource' | 'modification' | 'export',
  onAddNode: (id: string) => void,
  allowedIds?: ReadonlyArray<string>,
): m.Children[] {
  const nodes = nodeRegistry
    .list()
    .filter(([_id, descriptor]) => descriptor.type === nodeType)
    .filter(
      ([id, _descriptor]) =>
        allowedIds === undefined || allowedIds.includes(id),
    );

  return buildCategorizedMenuItems(nodes, onAddNode);
}

/**
 * Generate label with optional hotkey for a node descriptor.
 *
 * @param descriptor - Node descriptor
 * @returns Mithril children for the label with hotkey if available
 */
function getLabelWithHotkey(descriptor: NodeDescriptor): m.Children {
  const hotkey =
    descriptor.hotkey && typeof descriptor.hotkey === 'string'
      ? descriptor.hotkey.toUpperCase()
      : undefined;

  if (hotkey) {
    return m('.pf-exp-menu-label-with-hotkey', [
      m('span', descriptor.name),
      m(Keycap, hotkey),
    ]);
  }

  return descriptor.name;
}

/**
 * Build categorized menu items from a list of node descriptors.
 *
 * A node's `category` is a path from the outermost group inwards, so nodes
 * sharing a path end up in the same submenu, and nodes sharing only a prefix
 * of it share the submenus that prefix names. Uncategorized nodes (no
 * `category`, or an empty one) are shown directly.
 *
 * @param nodes - Array of [id, descriptor] pairs
 * @param onClickHandler - Callback when a menu item is clicked, receives the node id
 * @returns Array of Mithril children representing the menu items
 */
export function buildCategorizedMenuItems(
  nodes: Array<[string, NodeDescriptor]>,
  onClickHandler: (id: string) => void,
): m.Children[] {
  return buildMenuLevel(nodes, 0, onClickHandler);
}

/**
 * Build the menu items for one level of the category paths.
 *
 * @param nodes - Array of [id, descriptor] pairs that reached this level
 * @param depth - Index into each descriptor's category path
 * @param onClickHandler - Callback when a menu item is clicked
 * @returns Array of Mithril children representing the menu items
 */
function buildMenuLevel(
  nodes: Array<[string, NodeDescriptor]>,
  depth: number,
  onClickHandler: (id: string) => void,
): m.Child[] {
  // Group nodes by their category segment at this depth. A node whose path has
  // run out belongs at this level rather than in a submenu, and groups under
  // the `undefined` key.
  const grouped = new Map<
    string | undefined,
    Array<[string, NodeDescriptor]>
  >();
  for (const node of nodes) {
    const segment = node[1].category?.[depth];
    let group = grouped.get(segment);
    if (group === undefined) {
      group = [];
      grouped.set(segment, group);
    }
    group.push(node);
  }

  const menuItems: m.Child[] = [];

  // A Map iterates in insertion order, so this renders in first-seen order,
  // interleaving the nodes at this level with the submenus below it based on
  // registration order.
  for (const [segment, groupNodes] of grouped) {
    if (segment === undefined) {
      // Nodes that stop here - render directly
      for (const [id, descriptor] of groupNodes) {
        menuItems.push(
          m(MenuItem, {
            label: getLabelWithHotkey(descriptor),
            onclick: () => onClickHandler(id),
          }),
        );
      }
    } else {
      // Nodes that go deeper - render as a submenu holding the next level
      menuItems.push(
        m(
          MenuItem,
          {
            label: segment,
          },
          buildMenuLevel(groupNodes, depth + 1, onClickHandler),
        ),
      );
    }
  }

  return menuItems;
}
