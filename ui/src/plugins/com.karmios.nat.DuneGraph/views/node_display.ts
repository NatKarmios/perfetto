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
import {classNames} from '../../../base/classnames';
import {Duration} from '../../../base/time';
import {Icon} from '../../../widgets/icon';
import type {PathSeg} from '../model/path_tree';
import {splitEntry, splitPath} from '../model/path_tree';
import type {
  BuildGraph,
  DepResolutionKind,
  DepStatus,
  NodeHealth,
  NodeId,
  NodeKind,
  RuleOutcome,
} from '../model/graph';

// Where a node files into a `path_tree.ts` tree: a dep's id is itself a path,
// split into its dir and leaf; a rule files under its own `dir` with its bare
// id as the leaf, since rule ids are not paths and contribute no nesting past
// `dir`. Shared so the selection panel and the query tab group identically.
//
// Splits the node's *raw* id, not `decorateDepPath`'s trimmed display text - a
// `_build/<dir>` prefix becomes a real tree group here rather than an icon.
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

// The phrasing table behind a node's `dune.forced_by`. Shared by the selection
// panel's "Forced by" line and the query tab's tree extras, which reads the SQL
// columns directly - hence `kind` as a bare string rather than the typed union.
//
// `target` is the forcing rule id / dep id / dune-file path, absent for the
// payload-less kinds and, degenerately, for a RULE/DEP forcer whose target
// column was not selected - which falls back to "a rule" / "a dep" rather than
// a dangling "rule ". Undefined for an unrecognised kind, so a caller can show
// the raw columns instead of a bogus phrase.
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

// The marker for each non-`ok` {@link NodeHealth}. `ok` has no entry: it is the
// overwhelming majority of nodes (on a monorepo trace, ~99.8% of deps), so the
// unmarked chip is the common case and the marker the exception.
//
// `unfinished` deliberately gets neither a failure colour nor a "pending"-style
// icon: the span simply never ended, which is missing information (a truncated
// trace) rather than a build state dune reported - unlike `cancelled`, which
// is dune's own report that the node was torn down with the build.
const HEALTH_MARKERS: Record<
  Exclude<NodeHealth, 'ok'>,
  {readonly icon: string; readonly title: string}
> = {
  failed: {icon: 'error', title: 'failed'},
  cancelled: {icon: 'cancel', title: 'cancelled'},
  unfinished: {
    icon: 'question_mark',
    title: "unfinished — the node's span never ended (truncated trace)",
  },
};

// The state marker shown beside a kind chip, or nothing at all for a healthy
// node. See {@link HEALTH_MARKERS}.
function healthMarker(health: NodeHealth): m.Children {
  if (health === 'ok') return undefined;
  const {icon, title} = HEALTH_MARKERS[health];
  return m(Icon, {
    icon,
    title,
    className: classNames(
      'pf-dune-graph__health-icon',
      `pf-dune-graph__health-icon--${health}`,
    ),
  });
}

// A node's kind as a small coloured chip plus a marker for how it ended - the
// one visual marker saying "dep" or "rule" wherever a node is listed.
//
// The chip's colour stays the *kind* encoding: health rides alongside as a
// separate icon (and dims the chip for the two "did not really finish" states)
// rather than recolouring it, which would cost the reader the dep/rule
// distinction on exactly the rows needing the most careful reading.
//
// Takes the kind rather than a node, since a dependency *reference* has a kind
// even when the graph recorded no node for it - and no health, which is what
// the `ok` default means for such a caller.
export function kindChip(
  kind: NodeKind,
  health: NodeHealth = 'ok',
): m.Children {
  return [
    m(
      'span',
      {
        class: classNames(
          'pf-dune-graph__chip',
          `pf-dune-graph__chip--${kind}`,
          (health === 'cancelled' || health === 'unfinished') &&
            'pf-dune-graph__chip--muted',
        ),
      },
      kind,
    ),
    healthMarker(health),
  ];
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
    : decorateDepPath(label, graph.buildRoots);
}

// How a dep path is shown: a leading icon encoding where it lives, plus the
// possibly-trimmed display text.
//
// - Under one of `buildRoots`: the prefix is dropped and a `build` icon carries
//   it as a tooltip. The rest may start with `/…`, run straight into an
//   `@alias`, or be empty for a path that *is* a root.
// - Absolute (`/…`): verbatim, no icon.
// - Anything else: verbatim with a `code` icon tooltipped "Source".
//
// A path matching no root keeps its full text rather than having a plausible
// prefix guessed off it: shown in full it is never wrong, only wider.
export function decorateDepPath(
  path: string,
  buildRoots: readonly string[],
): {
  icon: m.Children;
  text: string;
} {
  for (const root of buildRoots) {
    if (!path.startsWith(root)) continue;
    const rest = path.slice(root.length);
    // The next character has to be a boundary, or this is a longer sibling of
    // the root rather than something inside it.
    if (rest !== '' && !rest.startsWith('/') && !rest.startsWith('@')) {
      continue;
    }
    return {
      icon: m(Icon, {
        icon: 'build',
        title: root,
        className: 'pf-dune-graph__path-icon',
      }),
      text: rest.startsWith('/') ? rest.slice(1) : rest,
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

/**
 * The last path component of a program path, so a process reads `ocamlc.opt`
 * rather than `/nix/store/…/bin/ocamlc.opt`.
 *
 * Undefined in, undefined out - every caller has a fallback for a process slice
 * whose `debug.prog` arg is missing (see row_details_panel.ts,
 * selection_info_panel.ts).
 */
export function basename(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}
