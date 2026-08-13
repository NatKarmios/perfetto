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
import {decorateDepPath} from './node_display';

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
  it('strips a _build/<dir>/ prefix and tooltips the stripped part', () => {
    const {icon, text} = decorateDepPath('_build/default/foo/bar.ml');
    expect(text).toEqual('foo/bar.ml');
    expect(iconTitle(icon)).toEqual('_build/default');
  });

  it('strips a bare _build/<dir> prefix followed directly by @alias', () => {
    const {icon, text} = decorateDepPath('_build/default@default');
    expect(text).toEqual('@default');
    expect(iconTitle(icon)).toEqual('_build/default');
  });

  it('shows an absolute path verbatim with no icon', () => {
    const {icon, text} = decorateDepPath('/abs/path/to/file');
    expect(text).toEqual('/abs/path/to/file');
    expect(icon).toEqual(undefined);
  });

  it('shows anything else verbatim with a "Source" icon', () => {
    const {icon, text} = decorateDepPath('foo.ml');
    expect(text).toEqual('foo.ml');
    expect(iconTitle(icon)).toEqual('Source');
  });
});
