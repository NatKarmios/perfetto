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
import {classNames} from '../../base/classnames';
import {Duration} from '../../base/time';
import {Icon} from '../../widgets/icon';
import type {PathSeg} from './path_tree';
import {splitEntry, splitPath} from './path_tree';
import type {
  BuildGraph,
  DepResolutionKind,
  DepStatus,
  NodeId,
  NodeKind,
  RuleOutcome,
} from './graph';

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
  kind: NodeKind,
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
    // Same forcer shape as RULE, but the rule had already failed and was
    // recovering its deps - worth saying, since the work it forced is not part
    // of the rule's normal course.
    case 'RULE_RECOVERY':
      return target === undefined
        ? 'a rule recovering its deps'
        : `rule ${target} (recovering its deps)`;
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

// Human-readable label for a rule's outcome (see `RuleOutcome` in graph.ts),
// shared by the current-selection panel's header chip and the query tab's
// `dune_rule.outcome` column formatting.
export function outcomeLabel(outcome: RuleOutcome): string {
  switch (outcome) {
    case 'executed':
      return 'executed';
    case 'local-cache-hit':
      return 'local cache hit';
    case 'shared-cache-hit':
      return 'shared cache hit';
    case 'failed-deps':
      return 'failed (resolving deps)';
    case 'failed-action':
      return 'failed (action)';
    case 'cancelled':
      return 'cancelled';
    case 'unfinished':
      return 'unfinished';
  }
}

// A dep's resolution label, as stored in `dune_dep.resolution` (see
// `DepResolutionKind` in graph.ts) - `rule` / `source` / `expanded` /
// `unknown` / `unfinished` - rendered for a human. Used by the
// current-selection panel's header chip for a dep node.
export function depResolutionLabel(resolution: DepResolutionKind): string {
  switch (resolution) {
    case 'rule':
      return 'built';
    case 'source':
      return 'source';
    case 'expanded':
      return 'expanded';
    case 'unknown':
      return 'unknown';
    case 'unfinished':
      return 'unfinished';
  }
}

// A dep's `status` (`dune_dep.status`) as a human-readable suffix for the
// resolution label, or undefined for the `ok` case - which is the overwhelming
// majority of deps and says nothing worth showing.
export function depStatusLabel(status: DepStatus): string | undefined {
  switch (status) {
    case 'ok':
      return undefined;
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

// A `dur_ns` value (nanoseconds, as stored throughout the SQL mirror and the
// node model's `SpanTiming`) as a human-readable duration, e.g. "88ms".
export function formatDurNs(durNs: number): string {
  return Duration.humanise(BigInt(Math.round(durNs)));
}

/**
 * A node's kind as a small coloured chip - the one visual marker that says
 * "dep" or "rule" wherever a node is listed: the current-selection panel's
 * header and dependency lists, the query tab's cells and tree leaves, and any
 * DataGrid showing a node-id column (see node_cell.ts).
 *
 * Takes the kind rather than a node, since a dependency *reference* has a kind
 * even when the graph never recorded a node for it.
 */
export function kindChip(kind: NodeKind): m.Children {
  return m(
    'span',
    {
      class: classNames('pf-dune-graph__chip', `pf-dune-graph__chip--${kind}`),
    },
    kind,
  );
}

/**
 * How a node is shown wherever it appears as a labelled row or chip: a dep's
 * interned path with its leading build/code icon (see {@link decorateDepPath}),
 * a rule's bare id with no icon (its kind is conveyed by a chip alongside).
 *
 * The one place that kind branch lives - the selection panel, the query tab, the
 * graph pane and the derived timeline track all render a node identically, and
 * all of them have only its node id, so all of them need the graph to resolve
 * its label.
 */
export function decorateNode(
  graph: BuildGraph,
  node: NodeId,
): {icon: m.Children; text: string} {
  const label = graph.labelOf(node);
  return graph.isRule(node)
    ? {icon: undefined, text: label}
    : decorateDepPath(label);
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
