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
import {buildCategorizedMenuItems, buildMenuItems} from './menu_utils';
import {nodeRegistry, type NodeDescriptor} from '../node_registry';
import {NodeType} from '../../query_node';
import {MenuItem, type MenuItemAttrs} from '../../../../widgets/menu';

type MenuVnode = m.Vnode<MenuItemAttrs>;

function descriptor(
  name: string,
  category?: string,
  available?: () => string | undefined,
): NodeDescriptor {
  return {
    name,
    description: name,
    icon: 'icon',
    type: 'modification',
    inputs: 'primary',
    category,
    available,
    nodeType: NodeType.kFilter,
    factory: () => {
      throw new Error('not used by these tests');
    },
    deserialize: () => {
      throw new Error('not used by these tests');
    },
  };
}

// Registers a test descriptor, returning a disposable that unregisters it
// again so the global registry does not leak between tests. `register()` throws
// on a duplicate, so the id doubles as the (otherwise unused) node type.
function registerTestNode(
  id: string,
  type: NodeDescriptor['type'],
  category?: string,
  available?: () => string | undefined,
): Disposable {
  return nodeRegistry.register(id, {
    ...descriptor(id, category, available),
    type,
    nodeType: id,
  });
}

// Builds the menu for the given [id, category] pairs, and returns the items as
// menu vnodes so tests can walk them.
function buildMenu(nodes: Array<[string, string | undefined]>): MenuVnode[] {
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

  it('should render a category as one submenu holding its node', () => {
    const items = buildMenu([['a', 'Filter']]);

    expect(items.length).toBe(1);
    expect(items[0].attrs.label).toBe('Filter');
    // A submenu is not clickable itself.
    expect(items[0].attrs.onclick).toBeUndefined();

    const inner = children(items[0]);
    expect(inner.length).toBe(1);
    expect(inner[0].attrs.label).toBe('a');
    expect(inner[0].attrs.onclick).toBeDefined();
  });

  it('should share one submenu between nodes with the same category', () => {
    const items = buildMenu([
      ['a', 'Filter'],
      ['b', 'Filter'],
    ]);

    expect(items.length).toBe(1);
    expect(items[0].attrs.label).toBe('Filter');
    expect(children(items[0]).map((i) => i.attrs.label)).toEqual(['a', 'b']);
  });

  it('should preserve first-seen order when categories interleave', () => {
    const items = buildMenu([
      ['plain1', undefined],
      ['a', 'Filter'],
      ['plain2', undefined],
      ['b', 'Time'],
      ['c', 'Filter'],
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
        ['grouped', descriptor('grouped', 'Dune')],
      ],
      (id) => clicked.push(id),
    ) as MenuVnode[];

    const click = {} as PointerEvent;
    items[0].attrs.onclick?.(click);
    children(items[1])[0].attrs.onclick?.(click);

    expect(clicked).toEqual(['plain', 'grouped']);
  });

  it('should grey out a node whose available() gives a reason', () => {
    const items = buildCategorizedMenuItems(
      [['gated', descriptor('gated', undefined, () => 'needs a build first')]],
      () => {},
    ) as MenuVnode[];

    expect(items.length).toBe(1);
    expect(items[0].attrs.label).toBe('gated');
    expect(items[0].attrs.disabled).toBe(true);
    expect(items[0].attrs.title).toBe('needs a build first');
  });

  it('should grey out a node inside a category', () => {
    const items = buildCategorizedMenuItems(
      [['gated', descriptor('gated', 'Dune', () => 'no graph yet')]],
      () => {},
    ) as MenuVnode[];

    const gated = children(items[0])[0];
    expect(gated.attrs.label).toBe('gated');
    expect(gated.attrs.disabled).toBe(true);
    expect(gated.attrs.title).toBe('no graph yet');
  });

  it('should leave a node enabled when available() gives no reason', () => {
    const items = buildCategorizedMenuItems(
      [['ready', descriptor('ready', undefined, () => undefined)]],
      () => {},
    ) as MenuVnode[];

    expect(items[0].attrs.label).toBe('ready');
    expect(items[0].attrs.disabled).toBe(false);
    expect(items[0].attrs.title).toBeUndefined();
  });

  it('should leave a node without available() enabled', () => {
    const items = buildMenu([['plain', undefined]]);

    expect(items[0].attrs.disabled).toBe(false);
    expect(items[0].attrs.title).toBeUndefined();
  });
});

describe('buildMenuItems', () => {
  // Registrations made by the test under way, undone afterwards so the global
  // registry is back to just the core nodes for the next one.
  let registrations: Disposable[] = [];

  afterEach(() => {
    for (const registration of registrations) {
      registration[Symbol.dispose]();
    }
    registrations = [];
  });

  it('should ask available() again on the next render', () => {
    let reason: string | undefined = 'still building';
    registrations.push(
      registerTestNode('test_gated', 'modification', undefined, () => reason),
    );

    const item = () =>
      (
        buildMenuItems('modification', () => {}, ['test_gated']) as MenuVnode[]
      )[0];

    expect(item().attrs.disabled).toBe(true);
    expect(item().attrs.title).toBe('still building');

    // Nothing re-registers; the next render simply asks again.
    reason = undefined;

    expect(item().attrs.disabled).toBe(false);
    expect(item().attrs.title).toBeUndefined();
  });
});
