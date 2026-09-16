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
 * Build the menu item that adds one node.
 *
 * @param id - The node's registry ID
 * @param descriptor - Node descriptor
 * @param onClickHandler - Callback when the item is clicked
 * @returns The Mithril child representing the menu item
 */
function buildNodeMenuItem(
  id: string,
  descriptor: NodeDescriptor,
  onClickHandler: (id: string) => void,
): m.Child {
  // A node type that cannot be used yet is greyed out with its reason as the
  // tooltip, rather than hidden: the entry stays discoverable, and since
  // available() is asked again on every render it comes back on its own once
  // whatever it needs exists.
  const unavailableReason = descriptor.available?.();
  return m(MenuItem, {
    label: getLabelWithHotkey(descriptor),
    onclick: () => onClickHandler(id),
    disabled: unavailableReason !== undefined,
    title: unavailableReason,
  });
}

/**
 * Build categorized menu items from a list of node descriptors.
 *
 * Nodes with the same `category` will be grouped into a submenu.
 * Uncategorized nodes (category === undefined) will be shown directly.
 *
 * @param nodes - Array of [id, descriptor] pairs
 * @param onClickHandler - Callback when a menu item is clicked, receives the node id
 * @returns Array of Mithril children representing the menu items
 */
export function buildCategorizedMenuItems(
  nodes: Array<[string, NodeDescriptor]>,
  onClickHandler: (id: string) => void,
): m.Children[] {
  // Group nodes by category, preserving first-seen order for interleaving.
  const grouped = new Map<
    string | undefined,
    Array<[string, NodeDescriptor]>
  >();
  const categoryOrder: Array<string | undefined> = [];
  for (const [id, descriptor] of nodes) {
    const category = descriptor.category;
    if (!grouped.has(category)) {
      grouped.set(category, []);
      categoryOrder.push(category);
    }
    grouped.get(category)?.push([id, descriptor]);
  }

  const menuItems: m.Child[] = [];

  // Render in first-seen order, so uncategorized and categorized items
  // are interleaved based on registration order.
  for (const category of categoryOrder) {
    const catNodes = grouped.get(category);
    if (catNodes === undefined) continue;
    if (category === undefined) {
      // Uncategorized nodes - render directly
      for (const [id, descriptor] of catNodes) {
        menuItems.push(buildNodeMenuItem(id, descriptor, onClickHandler));
      }
    } else {
      // Categorized nodes - render as submenu
      menuItems.push(
        m(
          MenuItem,
          {
            label: category,
          },
          catNodes.map(([id, descriptor]) =>
            buildNodeMenuItem(id, descriptor, onClickHandler),
          ),
        ),
      );
    }
  }

  return menuItems;
}
