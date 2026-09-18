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
import {describe, expect, it, vi} from 'vitest';

// `addToGraphConfirmed` goes through the global modal, which needs a DOM to
// mount into; the tests only care whether it was reached and what its buttons
// do, so stub it.
// (`vi.hoisted`, since `vi.mock`'s factory runs before module-level consts.)
const shownModals = vi.hoisted(() => [] as ModalAttrs[]);
vi.mock('../../../widgets/modal', () => ({
  showModal: (attrs: ModalAttrs) => {
    shownModals.push(attrs);
    return Promise.resolve();
  },
}));
import type {MenuItemAttrs} from '../../../widgets/menu';
import type {ModalAttrs} from '../../../widgets/modal';
import type {DuneGraphController} from '../controller';
import type {NodeId} from '../model/graph';
import {
  addToGraphConfirmed,
  addToGraphMenuItems,
  nodesInGroup,
} from './node_tree_actions';
import type {
  PathTreeGroup,
  PathTreeLeaf,
  PathTreeRow,
} from '../model/path_tree';

// A minimal leaf payload shape - deliberately distinct from both `Ref`
// (selection panel) and `TreeLeafEntry` (query tab) - to prove `nodesInGroup`
// only relies on the structural `node?: NodeId` field, not either caller's
// concrete type.
interface Entry {
  readonly node?: NodeId;
  readonly label: string;
}

function leaf(label: string, node?: NodeId): PathTreeLeaf<Entry> {
  return {kind: 'leaf', prefix: '', label, item: {node, label}};
}

function group(
  label: string,
  path: string,
  rows: readonly PathTreeRow<Entry>[],
): PathTreeGroup<Entry> {
  return {kind: 'group', path, label, rows};
}

describe('nodesInGroup', () => {
  it('collects distinct nodes across nested groups, deduped by node id', () => {
    const [a, b] = [1, 2];
    const tree = group('root', 'root', [
      leaf('a', a),
      group('nested', 'root/nested', [leaf('b', b), leaf('a-again', a)]),
    ]);
    expect(nodesInGroup(tree)).toEqual([a, b]);
  });

  it('skips leaves with no node (dangling entries)', () => {
    const a = 1;
    const tree = group('root', 'root', [leaf('a', a), leaf('dangling')]);
    expect(nodesInGroup(tree)).toEqual([a]);
  });

  it('returns [] for a group with no resolvable nodes', () => {
    const tree = group('root', 'root', [leaf('x'), leaf('y')]);
    expect(nodesInGroup(tree)).toEqual([]);
  });
});

/**
 * Everything `addToGraphMenuItems` touches, recording both what it added and
 * which relation walks were asked for - the latter is what the laziness test
 * below is about. Each relation answers with one distinct node so the
 * assertions can tell them apart.
 */
function fakeController() {
  const added: NodeId[][] = [];
  const asked: string[] = [];
  shownModals.length = 0;
  const relation = (name: string, answer: NodeId) => () => {
    asked.push(name);
    return [answer];
  };
  const controller = {
    addToGraph: (nodes: Iterable<NodeId>) => added.push([...nodes]),
    isInGraph: () => false,
    requestRedraw: () => {},
    parentsOf: relation('parents', 10),
    childrenOf: relation('children', 20),
    ancestorsOf: relation('ancestors', 30),
    descendantsOf: relation('descendants', 40),
    forcersOf: relation('forcers', 50),
  };
  return {
    controller: controller as unknown as DuneGraphController,
    added,
    asked,
  };
}

const NODE: NodeId = 1;

function items(controller: DuneGraphController) {
  return addToGraphMenuItems(controller, NODE) as m.Vnode<MenuItemAttrs>[];
}

function click(controller: DuneGraphController, label: string): void {
  const item = items(controller).find((i) => i.attrs.label === label);
  expect(item, `no "${label}" item`).toBeDefined();
  (item!.attrs.onclick as () => void)();
}

describe('addToGraphMenuItems', () => {
  it('offers the six relations, in order', () => {
    const {controller} = fakeController();
    expect(items(controller).map((i) => i.attrs.label)).toEqual([
      'This node',
      'Parents',
      'Children',
      'Ancestors',
      'Descendants',
      'Forcers',
    ]);
  });

  it('adds the node itself alongside the relation', () => {
    // Every item does, so the added nodes stay connected to something visible.
    const {controller, added} = fakeController();
    click(controller, 'This node');
    click(controller, 'Parents');
    click(controller, 'Descendants');

    expect(added).toEqual([[NODE], [NODE, 10], [NODE, 40]]);
  });

  it('does not walk a relation until its item is clicked', () => {
    // The documented laziness: some walks (descendants of a hot node) are
    // expensive, so building the menu must not perform any of them.
    const {controller, asked} = fakeController();
    items(controller);
    expect(asked).toEqual([]);

    click(controller, 'Forcers');
    expect(asked).toEqual(['forcers']);
  });
});

describe('addToGraphConfirmed', () => {
  const nodes = (n: number) =>
    Array.from({length: n}, (_, i) => (i + 1) as NodeId);

  it('adds straight away when the add is small', () => {
    const {controller, added} = fakeController();
    addToGraphConfirmed(controller, nodes(100));
    expect(added).toEqual([nodes(100)]);
    expect(shownModals).toHaveLength(0);
  });

  it('asks first when the add is big, and adds only once confirmed', () => {
    const {controller, added} = fakeController();
    addToGraphConfirmed(controller, nodes(101));
    expect(added).toEqual([]);
    expect(shownModals).toHaveLength(1);
    expect(JSON.stringify(shownModals[0].content)).toContain(
      'This will add 101 nodes',
    );

    const buttons = shownModals[0].buttons!;
    expect(buttons.map((b) => b.text)).toEqual(['Continue', 'Cancel']);
    buttons[0].action!();
    expect(added).toEqual([nodes(101)]);
  });

  it('does nothing when cancelled', () => {
    const {controller, added} = fakeController();
    addToGraphConfirmed(controller, nodes(500));
    shownModals[0].buttons!.find((b) => b.text === 'Cancel')!.action?.();
    expect(added).toEqual([]);
  });

  it('counts only nodes not already in the graph', () => {
    // A re-add of an already-visible set changes nothing, so it must not ask.
    const {controller, added} = fakeController();
    (controller as unknown as {isInGraph: () => boolean}).isInGraph = () =>
      true;
    addToGraphConfirmed(controller, nodes(5000));
    expect(shownModals).toHaveLength(0);
    expect(added).toEqual([nodes(5000)]);
  });
});
