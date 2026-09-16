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

import type m from 'mithril';
import {buildCategorizedMenuItems} from './menu_utils';
import type {NodeDescriptor} from '../node_registry';
import {NodeType} from '../../query_node';
import {MenuItem, type MenuItemAttrs} from '../../../../widgets/menu';

type MenuVnode = m.Vnode<MenuItemAttrs>;

function descriptor(
  name: string,
  category?: readonly string[],
): NodeDescriptor {
  return {
    name,
    description: name,
    icon: 'icon',
    type: 'modification',
    inputs: 'primary',
    category,
    nodeType: NodeType.kFilter,
    factory: () => {
      throw new Error('not used by these tests');
    },
    deserialize: () => {
      throw new Error('not used by these tests');
    },
  };
}

// Builds the menu for the given [id, category] pairs, and returns the items as
// menu vnodes so tests can walk them.
function buildMenu(
  nodes: Array<[string, readonly string[] | undefined]>,
): MenuVnode[] {
  const pairs = nodes.map(([id, category]): [string, NodeDescriptor] => [
    id,
    descriptor(id, category),
  ]);
  return buildCategorizedMenuItems(pairs, () => {}) as MenuVnode[];
}

// The children of a submenu item, which are themselves menu vnodes.
function children(item: MenuVnode): MenuVnode[] {
  return item.children as MenuVnode[];
}

describe('buildCategorizedMenuItems', () => {
  it('should render an uncategorized node as a plain item', () => {
    const items = buildMenu([['plain', undefined]]);

    expect(items.length).toBe(1);
    expect(items[0].tag).toBe(MenuItem);
    expect(items[0].attrs.label).toBe('plain');
    expect(items[0].attrs.onclick).toBeDefined();
  });

  it('should render an empty category path as a plain item', () => {
    const items = buildMenu([['plain', []]]);

    expect(items.length).toBe(1);
    expect(items[0].attrs.label).toBe('plain');
    expect(items[0].attrs.onclick).toBeDefined();
  });

  it('should render a depth-1 path as one submenu holding its node', () => {
    const items = buildMenu([['a', ['Filter']]]);

    expect(items.length).toBe(1);
    expect(items[0].attrs.label).toBe('Filter');
    // A submenu is not clickable itself.
    expect(items[0].attrs.onclick).toBeUndefined();

    const inner = children(items[0]);
    expect(inner.length).toBe(1);
    expect(inner[0].attrs.label).toBe('a');
    expect(inner[0].attrs.onclick).toBeDefined();
  });

  it('should share one submenu between nodes with the same depth-1 path', () => {
    const items = buildMenu([
      ['a', ['Filter']],
      ['b', ['Filter']],
    ]);

    expect(items.length).toBe(1);
    expect(items[0].attrs.label).toBe('Filter');
    expect(children(items[0]).map((i) => i.attrs.label)).toEqual(['a', 'b']);
  });

  it('should nest a depth-2 path inside its outer submenu', () => {
    const items = buildMenu([['macro', ['Dune', 'Macros']]]);

    expect(items.length).toBe(1);
    expect(items[0].attrs.label).toBe('Dune');

    const outer = children(items[0]);
    expect(outer.length).toBe(1);
    expect(outer[0].attrs.label).toBe('Macros');
    expect(outer[0].attrs.onclick).toBeUndefined();

    const inner = children(outer[0]);
    expect(inner.length).toBe(1);
    expect(inner[0].attrs.label).toBe('macro');
    expect(inner[0].attrs.onclick).toBeDefined();
  });

  it('should share a prefix submenu between a shorter and a longer path', () => {
    const items = buildMenu([
      ['target', ['Dune']],
      ['macro', ['Dune', 'Macros']],
    ]);

    expect(items.length).toBe(1);
    expect(items[0].attrs.label).toBe('Dune');

    const outer = children(items[0]);
    expect(outer.length).toBe(2);
    expect(outer[0].attrs.label).toBe('target');
    expect(outer[0].attrs.onclick).toBeDefined();
    expect(outer[1].attrs.label).toBe('Macros');
    expect(children(outer[1]).map((i) => i.attrs.label)).toEqual(['macro']);
  });

  it('should preserve first-seen order when categories interleave', () => {
    const items = buildMenu([
      ['plain1', undefined],
      ['a', ['Filter']],
      ['plain2', undefined],
      ['b', ['Time']],
      ['c', ['Filter']],
    ]);

    // Each group renders where its first member was seen, so 'plain2' joins
    // 'plain1' ahead of the 'Filter' submenu.
    expect(items.map((i) => i.attrs.label)).toEqual([
      'plain1',
      'plain2',
      'Filter',
      'Time',
    ]);
    // 'c' joins the 'Filter' submenu created earlier rather than a new one.
    expect(children(items[2]).map((i) => i.attrs.label)).toEqual(['a', 'c']);
  });

  it('should call the click handler with the node id', () => {
    const clicked: string[] = [];
    const items = buildCategorizedMenuItems(
      [
        ['plain', descriptor('plain')],
        ['nested', descriptor('nested', ['Dune', 'Macros'])],
      ],
      (id) => clicked.push(id),
    ) as MenuVnode[];

    const click = {} as PointerEvent;
    items[0].attrs.onclick?.(click);
    children(children(items[1])[0])[0].attrs.onclick?.(click);

    expect(clicked).toEqual(['plain', 'nested']);
  });
});
