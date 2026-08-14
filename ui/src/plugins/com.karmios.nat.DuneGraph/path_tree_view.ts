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
import {Icon} from '../../widgets/icon';
import type {PathTreeGroup, PathTreeLeaf, PathTreeRow} from './path_tree';
import {countLeaves, groupKey} from './path_tree';

export interface PathTreeViewAttrs<T> {
  readonly rows: readonly PathTreeRow<T>[];
  // Renders a leaf's own row content (chip, label, actions, ...).
  readonly renderLeaf: (row: PathTreeLeaf<T>) => m.Children;
  // Collapse state, keyed by `groupKey(row.path, keyPrefix)`; owned by the
  // caller so it can survive a re-render and drive expand-all/collapse-all
  // (see `collectGroupKeys` in path_tree.ts).
  readonly collapsed: ReadonlySet<string>;
  readonly onToggleGroup: (key: string) => void;
  // Namespaces collapse keys - pass a distinct prefix per independent tree
  // (e.g. per list) so the same directory folds independently in each.
  readonly keyPrefix?: string;
  // Optional trailing content on a group's header row (e.g. a bulk "add all
  // in this dir" button).
  readonly groupActions?: (row: PathTreeGroup<T>) => m.Children;
}

/**
 * Generic renderer for a `PathTreeRow<T>[]` (see path_tree.ts): a directory
 * becomes a collapsible header (caret, label, leaf count, optional actions);
 * a leaf is rendered by the caller's `renderLeaf`. Shared by the
 * current-selection panel's Dependants/Dependencies lists and the query tab's
 * tree view, so both group identically.
 */
export class PathTreeView<T> implements m.ClassComponent<PathTreeViewAttrs<T>> {
  view({attrs}: m.CVnode<PathTreeViewAttrs<T>>): m.Children {
    return m(
      '.pf-dune-tree',
      attrs.rows.map((row) => this.renderRow(attrs, row)),
    );
  }

  private renderRow(
    attrs: PathTreeViewAttrs<T>,
    row: PathTreeRow<T>,
  ): m.Children {
    if (row.kind === 'leaf') {
      return attrs.renderLeaf(row);
    }
    const key = groupKey(row.path, attrs.keyPrefix);
    const collapsed = attrs.collapsed.has(key);
    return m(
      '.pf-dune-tree__group',
      m(
        '.pf-dune-tree__group-header',
        {onclick: () => attrs.onToggleGroup(key)},
        m(Icon, {
          icon: collapsed ? 'chevron_right' : 'expand_more',
          className: 'pf-dune-tree__group-caret',
        }),
        `${row.label}/`,
        m('span.pf-dune-tree__group-count', `(${countLeaves(row)})`),
        attrs.groupActions !== undefined &&
          m(
            'span.pf-dune-tree__group-actions',
            {onclick: (e: Event) => e.stopPropagation()},
            attrs.groupActions(row),
          ),
      ),
      !collapsed &&
        m(
          '.pf-dune-tree__children',
          row.rows.map((child) => this.renderRow(attrs, child)),
        ),
    );
  }
}
