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
import type {PathSeg} from './path_tree';
import {splitEntry, splitPath} from './path_tree';
import type {GraphNode} from './graph';

// Matches a leading `_build/<dir>` prefix, capturing `_build/<dir>` so it can be
// folded away into the icon tooltip. The trailing `/` is optional: a path can
// end at the context dir (rare) or continue straight into an `@alias` rather
// than a `/`.
const BUILD_PREFIX = /^(_build\/[^/@]+)\/?/;

/**
 * Where a node files into a `path_tree.ts` tree: a dep's id is itself a path,
 * split into the dir it lives under and its own leaf segment; a rule files
 * under its own `dir` (top-level when unset), with its bare id as the leaf -
 * rule ids aren't paths themselves, so they never contribute further nesting
 * beyond `dir`. Shared by the current-selection panel and the query tab's
 * tree view so both group nodes identically.
 *
 * Note this splits the node's *raw* id, not `decorateDepPath`'s trimmed
 * display text - a `_build/<dir>` prefix becomes a real tree group here,
 * rather than being folded into a leading icon.
 */
export function nodePathParts(
  kind: GraphNode['kind'],
  id: string,
  dir?: string,
): {dir: PathSeg[]; leaf: PathSeg} {
  if (kind === 'dep') {
    return splitEntry(id);
  }
  return {
    dir: dir === undefined ? [] : splitPath(dir),
    leaf: {sep: '/', name: id},
  };
}

// The phrasing table behind a node's `dune.forced_by` (see `ForcedBy` in
// graph.ts): shared by the current-selection panel's "Forced by" line (which
// links `target` to its node when RULE/DEP resolve) and the query tab's tree
// extras (plain text only, straight off the SQL `forced_by_kind` /
// `forced_by_target` columns - hence taking `kind` as a bare string rather
// than the typed union).
//
// `target` is the forcing rule id / dep id / dune-file path
// (`forcedByTarget(fb)` in graph.ts), absent for the payload-less kinds and,
// degenerately, for a RULE/DEP forcer whose target column wasn't selected -
// that falls back to a generic "a rule" / "a dep" rather than a dangling
// "rule ". Returns undefined for a kind this table doesn't recognise, so a
// caller can fall back to showing the raw column(s) instead of a bogus
// phrase.
export function forcedByText(
  kind: string,
  target?: string,
): string | undefined {
  switch (kind) {
    case 'RULE':
      return target === undefined ? 'a rule' : `rule ${target}`;
    case 'DEP':
      return target === undefined ? 'a dep' : target;
    case 'DYNAMIC_INCLUDES':
      return target === undefined
        ? 'dynamic_includes'
        : `dynamic_includes (${target})`;
    case 'GEN_RULES':
      return target === undefined
        ? 'rule generation'
        : `rule generation (${target})`;
    case 'PFORM':
      return target === undefined
        ? 'variable expansion'
        : `variable expansion (${target})`;
    case 'CONFIGURATOR':
      return 'the initial dune configuration';
    case 'REQUEST':
      return 'the top-level build request';
    case 'UNKNOWN':
      return 'an unknown source';
    default:
      return undefined;
  }
}

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
