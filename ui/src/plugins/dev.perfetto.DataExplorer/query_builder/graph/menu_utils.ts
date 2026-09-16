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
 * The category roots that group *within* a node type section.
 *
 * The add-node menus are sectioned by node type first, so a category root
 * listed here groups the nodes of one section. Any other root belongs to a
 * plugin that wants one group for all of its nodes, which would otherwise
 * appear once per section its nodes span (e.g. both under "Sources" and under
 * "Modifications"), so such a root is hoisted into its own top-level submenu
 * by buildPluginGroupMenuItems() instead.
 *
 * Exported so a unit test can check that no core node drifts out of it.
 */
export const CORE_CATEGORY_ROOTS: ReadonlySet<string> = new Set([
  'Columns',
  'Filter',
  'Time',
  'Advanced',
]);

// Whether a descriptor is shown inside its node type's section, as opposed to
// in a hoisted plugin group. An uncategorized node stays in its section.
function isInTypeSection(descriptor: NodeDescriptor): boolean {
  const root = descriptor.category?.[0];
  return root === undefined || CORE_CATEGORY_ROOTS.has(root);
}

/**
 * Build menu items for a specific node type.
 *
 * Nodes whose category root is a plugin's own are left out: they are hoisted
 * out of the type sections by buildPluginGroupMenuItems().
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
    .filter(([_id, descriptor]) => isInTypeSection(descriptor))
    .filter(
      ([id, _descriptor]) =>
        allowedIds === undefined || allowedIds.includes(id),
    );

  return buildCategorizedMenuItems(nodes, onAddNode);
}

/**
 * Build one top-level submenu per plugin category root, in first-seen order.
 *
 * A plugin group spans every node type, so its sources and its operations end
 * up in the same submenu, nested below it by the usual category path recursion.
 * Returns an empty array when nothing qualifies, so a caller can drop the
 * section the same way it drops an empty type section.
 *
 * @param onAddNode - Callback when a menu item is clicked
 * @param allowedIds - If given, only these registry IDs are included
 * @returns Array of Mithril children representing the submenus
 */
export function buildPluginGroupMenuItems(
  onAddNode: (id: string) => void,
  allowedIds?: ReadonlyArray<string>,
): m.Children[] {
  const nodes = nodeRegistry
    .list()
    .filter(([_id, descriptor]) => !isInTypeSection(descriptor))
    .filter(
      ([id, _descriptor]) =>
        allowedIds === undefined || allowedIds.includes(id),
    );

  // The recursion already turns a shared category root into one submenu, so
  // there is nothing to group by here.
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
