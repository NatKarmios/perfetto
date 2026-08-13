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

// Matches a leading `_build/<dir>` prefix, capturing `_build/<dir>` so it can be
// folded away into the icon tooltip. The trailing `/` is optional: a path can
// end at the context dir (rare) or continue straight into an `@alias` rather
// than a `/`.
const BUILD_PREFIX = /^(_build\/[^/@]+)\/?/;

/**
 * How a dep path is shown: a leading icon that encodes where the path lives, plus
 * the (possibly trimmed) display text.
 *
 * - A `_build/<dir>` path (optionally followed by `/…` or `@alias`) drops the
 *   `_build/<dir>/` prefix and gets a `build` icon whose tooltip is the
 *   stripped prefix.
 * - An absolute path (`/…`) is shown verbatim with no icon.
 * - Anything else is shown verbatim with a `code` icon tooltipped "Source".
 *
 * @returns the rendered leading `icon` (or `undefined`) and the display `text`.
 */
export function decorateDepPath(path: string): {
  icon: m.Children;
  text: string;
} {
  const build = BUILD_PREFIX.exec(path);
  if (build !== null) {
    return {
      icon: m(Icon, {
        icon: 'build',
        title: build[1],
        className: 'pf-dune-graph__path-icon',
      }),
      text: path.slice(build[0].length),
    };
  }
  if (path.startsWith('/')) {
    return {icon: undefined, text: path};
  }
  return {
    icon: m(Icon, {
      icon: 'code',
      title: 'Source',
      className: 'pf-dune-graph__path-icon',
    }),
    text: path,
  };
}
