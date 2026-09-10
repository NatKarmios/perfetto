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
import type {NodeHealth} from '../model/graph';
import {decorateDepPath, forcedByText, kindChip} from './node_display';

// The icon is an mithril vnode; tests only care about its `title` attr (the
// tooltip), which is where the stripped `_build/<dir>` prefix ends up.
function iconTitle(icon: m.Children): string | undefined {
  if (icon === undefined || icon === null || typeof icon !== 'object') {
    return undefined;
  }
  const vnode = icon as m.Vnode<{title?: string}>;
  return vnode.attrs?.title;
}

describe('decorateDepPath', () => {
  // The roots a real trace derives (see BuildGraph.buildRoots), plus the two
  // shapes this trace happens not to have: the install tree, and a build dir
  // renamed by `--build-dir`.
  const ROOTS = [
    '_build/default',
    '_build/.actions/default',
    '_build/install/default',
    'out/default',
  ];
  const decorate = (path: string) => decorateDepPath(path, ROOTS);

  it('strips a build root and tooltips the stripped part', () => {
    const {icon, text} = decorate('_build/default/foo/bar.ml');
    expect(text).toEqual('foo/bar.ml');
    expect(iconTitle(icon)).toEqual('_build/default');
  });

  it('strips a bare build root followed directly by @alias', () => {
    const {icon, text} = decorate('_build/default@default');
    expect(text).toEqual('@default');
    expect(iconTitle(icon)).toEqual('_build/default');
  });

  // The bug this parameter exists for: stripping one segment after `_build`
  // left `default/src/dag`, indistinguishable from a source-relative path.
  it('strips a role-prefixed root whole, not just its first segment', () => {
    const {icon, text} = decorate('_build/.actions/default/src/dag');
    expect(text).toEqual('src/dag');
    expect(iconTitle(icon)).toEqual('_build/.actions/default');
    expect(iconTitle(decorate('_build/install/default/lib/x').icon)).toEqual(
      '_build/install/default',
    );
  });

  it('strips a build root that is not named _build', () => {
    const {icon, text} = decorate('out/default/foo/bar.ml');
    expect(text).toEqual('foo/bar.ml');
    expect(iconTitle(icon)).toEqual('out/default');
  });

  // A path in the build tree that no derived root covers keeps its full text:
  // shown in full it is never wrong, only wider.
  it('shows a path matching no root verbatim', () => {
    const {icon, text} = decorate('_build/.db/foo');
    expect(text).toEqual('_build/.db/foo');
    expect(iconTitle(icon)).toEqual('Source');
  });

  // Prefix-matching a root is not enough - `_build/defaults` is a sibling of
  // `_build/default`, not something inside it.
  it('does not strip a longer sibling of a root', () => {
    expect(decorate('_build/defaults/foo').text).toEqual('_build/defaults/foo');
  });

  it('shows an absolute path verbatim with no icon', () => {
    const {icon, text} = decorate('/abs/path/to/file');
    expect(text).toEqual('/abs/path/to/file');
    expect(icon).toEqual(undefined);
  });

  it('shows anything else verbatim with a "Source" icon', () => {
    const {icon, text} = decorate('foo.ml');
    expect(text).toEqual('foo.ml');
    expect(iconTitle(icon)).toEqual('Source');
  });
});

describe('kindChip', () => {
  // `kindChip` returns [chip, marker]; the marker is absent for a healthy node.
  // Mithril normalises the `class` attr to `className` on the way in.
  function parts(kind: 'dep' | 'rule', health?: NodeHealth) {
    const [chip, marker] = kindChip(kind, health) as m.Children[];
    return {chip: chip as m.Vnode<{className?: string}>, marker};
  }

  // The default is what a dependency *reference* gets: the blob never recorded
  // a node for it, so there is no health to report and nothing to mark.
  it('shows no state marker by default', () => {
    const {chip, marker} = parts('dep');
    expect(chip.attrs?.className).toContain('pf-dune-graph__chip--dep');
    expect(marker).toEqual(undefined);
    expect(parts('rule', 'ok').marker).toEqual(undefined);
  });

  it('tooltips each unhealthy state on its own marker', () => {
    expect(iconTitle(parts('rule', 'failed').marker)).toEqual('failed');
    expect(iconTitle(parts('dep', 'cancelled').marker)).toEqual('cancelled');
    // Not a build state dune reported - say so rather than echoing the enum.
    expect(iconTitle(parts('dep', 'unfinished').marker)).toContain(
      'truncated trace',
    );
  });
});

describe('forcedByText', () => {
  it('phrases RULE and DEP with their target', () => {
    expect(forcedByText('RULE', '2')).toEqual('rule 2');
    expect(forcedByText('DEP', 'a/b')).toEqual('a/b');
  });

  it('phrases the parenthesised kinds with their target', () => {
    expect(forcedByText('DYNAMIC_INCLUDES', 'dune')).toEqual(
      'dynamic_includes (dune)',
    );
    expect(forcedByText('GEN_RULES', 'dune')).toEqual('rule generation (dune)');
    expect(forcedByText('PFORM', '%{foo}')).toEqual(
      'variable expansion (%{foo})',
    );
  });

  it('phrases the payload-less kinds regardless of target', () => {
    expect(forcedByText('CONFIGURATOR')).toEqual(
      'the initial dune configuration',
    );
    expect(forcedByText('REQUEST')).toEqual('the top-level build request');
    expect(forcedByText('UNKNOWN')).toEqual('an unknown source');
  });

  it('degrades RULE/DEP to a generic phrase when the target is missing', () => {
    expect(forcedByText('RULE')).toEqual('a rule');
    expect(forcedByText('DEP')).toEqual('a dep');
  });

  it('returns undefined for a kind it does not recognise', () => {
    expect(forcedByText('SOMETHING_ELSE', 'x')).toBeUndefined();
  });
});
