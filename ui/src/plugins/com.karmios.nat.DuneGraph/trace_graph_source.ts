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

import type {Engine} from '../../trace_processor/engine';
import {LONG, LONG_NULL, NUM, STR} from '../../trace_processor/query_result';
import type {
  BuildGraph,
  DepNode,
  ForcedBy,
  GraphNode,
  GraphSource,
  RuleNode,
  SpanTiming,
} from './graph';
import type {BlobChunk, ForcedByTag} from './graph_blob';
import {
  BLOB_TRACK,
  DEPS_SECTION,
  DICT_SECTION,
  RULES_SECTION,
  joinChunks,
  parseGraphBlob,
} from './graph_blob';

// Slice tracks carrying lifecycle instants that resolve to graph nodes. Each
// carries `<track>-start` / `<track>-finish` / `<track>-resolved` instants -
// see `graph_blob.ts`'s file header and `doc/dev/trace-graph-perfetto.md`.
// `gen-rules` / `dynamic-includes` are deliberately excluded: their start and
// finish instants share no join key (see the plugin's reported schema gaps),
// so they can't become nodes.
const RULE_TRACK = 'exec-rule';
const DEP_TRACK = 'build-dep';
const ACTION_TRACK = 'exec-rule-action';
const LIFECYCLE_TRACKS = [RULE_TRACK, DEP_TRACK, ACTION_TRACK];

/**
 * A {@link GraphSource} that reads the v1 graph-blob schema: structure comes
 * from the chunked `dune-graph` blob (`graph_blob.ts`), timing from lifecycle
 * instants on `exec-rule` / `build-dep` / `exec-rule-action`, joined by
 * `rule_id` / `dep_id` - never by slice id or flow, per the schema's contract.
 */
export class TraceGraphSource implements GraphSource {
  constructor(private readonly engine: Engine) {}

  get description(): string {
    return `graph blob • ${BLOB_TRACK}`;
  }

  async load(): Promise<BuildGraph> {
    const blob = await this.loadBlob();
    const lifecycle = await this.loadLifecycle();

    const deps = new Map<string, DepNode>();
    const rules = new Map<string, RuleNode>();
    const bySliceId = new Map<number, GraphNode>();

    for (const rec of blob.rules) {
      if (rules.has(rec.ruleId)) continue; // first occurrence wins.
      const dir = rec.dirId === undefined ? undefined : blob.dict.get(rec.dirId);
      rules.set(rec.ruleId, {
        kind: 'rule',
        id: rec.ruleId,
        staticDepIds: resolveIds(blob.dict, rec.depIds),
        dynamicDepIds: rec.dynDepStages.map((stage) =>
          resolveIds(blob.dict, stage),
        ),
        dir,
        targetFiles: resolveIds(blob.dict, rec.targetFileIds),
        targetDirs: resolveIds(blob.dict, rec.targetDirIds),
        forcedBy: resolveForcedBy(rec.forcedBy, blob.dict),
        outcome: rec.outcome,
      });
    }

    for (const rec of blob.deps) {
      const id = blob.dict.get(rec.depId);
      if (id === undefined || deps.has(id)) continue; // first occurrence wins.
      deps.set(id, {
        kind: 'dep',
        id,
        depId: rec.depId,
        resolvedRuleId:
          rec.resolution.kind === 'rule' ? rec.resolution.ruleId : undefined,
        expandedDepIds:
          rec.resolution.kind === 'expanded'
            ? resolveIds(blob.dict, rec.resolution.depIds)
            : undefined,
        isSource: rec.resolution.kind === 'source',
        unfinished: rec.resolution.kind === 'unfinished',
        forcedBy: resolveForcedBy(rec.forcedBy, blob.dict),
      });
    }

    // Attach timing, and index every lifecycle instant (every occurrence, not
    // just the canonical one) back to its owning node so a click on any of
    // them - including a later watch-mode occurrence - resolves.
    for (const rule of rules.values()) {
      const occ = lifecycle.byRuleId.get(rule.id) ?? [];
      const action = lifecycle.actionByRuleId.get(rule.id) ?? [];
      const withTiming: RuleNode = {
        ...rule,
        timing: timingOf(occ),
        actionTiming: timingOf(action),
      };
      rules.set(rule.id, withTiming);
      for (const o of [...occ, ...action]) {
        indexOccurrence(bySliceId, o, withTiming);
      }
    }
    for (const dep of deps.values()) {
      const occ = lifecycle.byDepId.get(dep.depId) ?? [];
      const withTiming: DepNode = {...dep, timing: timingOf(occ)};
      deps.set(dep.id, withTiming);
      for (const o of occ) indexOccurrence(bySliceId, o, withTiming);
    }

    return {deps, rules, bySliceId};
  }

  // Reassembles and parses the structural graph. Throws (surfaced by
  // `controller.reload()` as the panel's error state) rather than returning an
  // empty graph when the `dune-graph` track is absent - a trace that predates
  // the v1 schema, or one recorded without `DUNE_TRACE=+graph`, should fail
  // loudly rather than silently show nothing.
  private async loadBlob() {
    const result = await this.engine.query(`
      select s.name as section,
        extract_arg(s.arg_set_id, 'debug.dune.version') as version,
        extract_arg(s.arg_set_id, 'debug.dune.seq') as seq,
        extract_arg(s.arg_set_id, 'debug.dune.total') as total,
        extract_arg(s.arg_set_id, 'debug.dune.data') as data
      from slice s join track t on s.track_id = t.id
      where t.name = '${BLOB_TRACK}'
      order by s.name, seq
    `);
    const it = result.iter({
      section: STR,
      version: LONG,
      seq: LONG,
      total: LONG,
      data: STR,
    });
    const chunksBySection = new Map<string, BlobChunk[]>();
    let rowCount = 0;
    for (; it.valid(); it.next()) {
      rowCount++;
      const list = chunksBySection.get(it.section) ?? [];
      list.push({
        name: it.section,
        version: Number(it.version),
        seq: Number(it.seq),
        total: Number(it.total),
        data: it.data,
      });
      chunksBySection.set(it.section, list);
    }
    if (rowCount === 0) {
      throw new Error(
        `No '${BLOB_TRACK}' track found in this trace. Either it predates ` +
          "the v1 Dune graph schema, or it was recorded without " +
          "DUNE_TRACE=+graph (or the equivalent 'graph' category).",
      );
    }
    const sections = new Map<string, string>();
    for (const name of [DICT_SECTION, RULES_SECTION, DEPS_SECTION]) {
      sections.set(name, joinChunks(name, chunksBySection.get(name) ?? []));
    }
    return parseGraphBlob(sections);
  }

  // Reads every lifecycle instant off the tracks in {@link LIFECYCLE_TRACKS}
  // and pairs them per (track, key) into {@link Occurrence}s.
  private async loadLifecycle(): Promise<{
    byRuleId: Map<string, Occurrence[]>;
    byDepId: Map<number, Occurrence[]>;
    actionByRuleId: Map<string, Occurrence[]>;
  }> {
    const tracks = LIFECYCLE_TRACKS.map((t) => `'${t}'`).join(', ');
    const result = await this.engine.query(`
      select s.id as sliceId, s.ts as ts, s.name as name, t.name as track,
        extract_arg(s.arg_set_id, 'debug.dune.rule_id') as ruleId,
        extract_arg(s.arg_set_id, 'debug.dune.dep_id') as depId,
        extract_arg(s.arg_set_id, 'debug.dune.dur_ns') as durNs
      from slice s join track t on s.track_id = t.id
      where t.name in (${tracks})
      order by s.ts
    `);
    const it = result.iter({
      sliceId: NUM,
      ts: LONG,
      name: STR,
      track: STR,
      ruleId: LONG_NULL,
      depId: LONG_NULL,
      durNs: LONG_NULL,
    });
    const ruleRows: LifecycleRow[] = [];
    const depRows: LifecycleRow[] = [];
    const actionRows: LifecycleRow[] = [];
    for (; it.valid(); it.next()) {
      const row: LifecycleRow = {
        sliceId: it.sliceId,
        ts: it.ts,
        name: it.name,
        ruleId: it.ruleId === null ? undefined : it.ruleId.toString(),
        depId: it.depId === null ? undefined : Number(it.depId),
        durNs: it.durNs === null ? undefined : Number(it.durNs),
      };
      if (it.track === RULE_TRACK) ruleRows.push(row);
      else if (it.track === DEP_TRACK) depRows.push(row);
      else if (it.track === ACTION_TRACK) actionRows.push(row);
    }
    return {
      byRuleId: occurrencesByKey(ruleRows, (r) => r.ruleId),
      byDepId: occurrencesByKey(depRows, (r) => r.depId),
      actionByRuleId: occurrencesByKey(actionRows, (r) => r.ruleId),
    };
  }
}

// One lifecycle instant as read off the trace, with its (already-typed) join
// key columns - only one of `ruleId`/`depId` is meaningful per track.
interface LifecycleRow {
  readonly sliceId: number;
  readonly ts: bigint;
  readonly name: string;
  readonly ruleId?: string;
  readonly depId?: number;
  readonly durNs?: number;
}

// A single resolved span occurrence: a `-start`/`-finish` pair (or a solo
// `-resolved` instant, where start and finish coincide). `durNs`/`finishSliceId`
// are absent for a span that never got a finish (flushed at EOF).
interface Occurrence {
  readonly ts: bigint;
  readonly startSliceId?: number;
  readonly finishSliceId?: number;
  readonly durNs?: number;
}

// Groups `rows` by `keyOf` and pairs each group's `-start`/`-finish`/
// `-resolved` instants into {@link Occurrence}s, sorted by begin timestamp.
// `-start` and `-finish` are paired in arrival order (both arrive already
// ts-ordered, per the query) - a heuristic, since instants carry no
// occurrence index to pair by (see the plugin's reported schema gaps). A
// `-start` with no matching `-finish` yields an occurrence with no `durNs`
// (an unfinished span, or one whose finish hasn't landed yet).
function occurrencesByKey<K extends string | number>(
  rows: readonly LifecycleRow[],
  keyOf: (row: LifecycleRow) => K | undefined,
): Map<K, Occurrence[]> {
  const starts = new Map<K, LifecycleRow[]>();
  const finishes = new Map<K, LifecycleRow[]>();
  const resolved = new Map<K, LifecycleRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === undefined) continue;
    if (row.name.endsWith('-start')) pushTo(starts, key, row);
    else if (row.name.endsWith('-finish')) pushTo(finishes, key, row);
    else if (row.name.endsWith('-resolved')) pushTo(resolved, key, row);
  }
  const keys = new Set([...starts.keys(), ...finishes.keys(), ...resolved.keys()]);
  const result = new Map<K, Occurrence[]>();
  for (const key of keys) {
    const occ: Occurrence[] = [];
    const opens = starts.get(key) ?? [];
    const fin = finishes.get(key) ?? [];
    for (let i = 0; i < opens.length; i++) {
      const start = opens[i];
      const finish = fin[i];
      occ.push({
        ts: start.ts,
        startSliceId: start.sliceId,
        finishSliceId: finish?.sliceId,
        durNs: finish?.durNs,
      });
    }
    for (const r of resolved.get(key) ?? []) {
      occ.push({
        ts: r.ts,
        startSliceId: r.sliceId,
        finishSliceId: r.sliceId,
        durNs: r.durNs,
      });
    }
    occ.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    result.set(key, occ);
  }
  return result;
}

function pushTo<K>(map: Map<K, LifecycleRow[]>, key: K, row: LifecycleRow): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [row]);
  else list.push(row);
}

// The node's canonical timing: the earliest occurrence, with `occurrenceCount`
// carrying how many were seen in total (watch mode, or a dep built more than
// once).
function timingOf(occurrences: readonly Occurrence[]): SpanTiming | undefined {
  if (occurrences.length === 0) return undefined;
  const first = occurrences[0];
  return {
    startSliceId: first.startSliceId,
    finishSliceId: first.finishSliceId,
    durNs: first.durNs,
    occurrenceCount: occurrences.length,
  };
}

// Maps every slice id in `occ` back to `node` - not just the canonical
// (first) occurrence's - so clicking any instant, including a later
// occurrence, resolves to the node.
function indexOccurrence(
  bySliceId: Map<number, GraphNode>,
  occ: Occurrence,
  node: GraphNode,
): void {
  if (occ.startSliceId !== undefined) bySliceId.set(occ.startSliceId, node);
  if (occ.finishSliceId !== undefined) bySliceId.set(occ.finishSliceId, node);
}

function resolveIds(
  dict: ReadonlyMap<number, string>,
  ids: readonly number[],
): readonly string[] {
  const out: string[] = [];
  for (const id of ids) {
    const s = dict.get(id);
    if (s !== undefined) out.push(s);
  }
  return out;
}

// Resolves a blob {@link ForcedByTag} (ids still un-resolved) into the node-
// facing {@link ForcedBy} union (paths/rule-id resolved). A path id that
// isn't in the dict degrades to `UNKNOWN` rather than a dangling reference -
// consistent with `parseForcedByTag`'s own "unrecognised -> UNKNOWN" fallback.
function resolveForcedBy(
  tag: ForcedByTag | undefined,
  dict: ReadonlyMap<number, string>,
): ForcedBy | undefined {
  if (tag === undefined) return undefined;
  switch (tag.kind) {
    case 'RULE':
      return {kind: 'RULE', rule: tag.ruleId};
    case 'DEP': {
      const dep = dict.get(tag.depId);
      return dep === undefined ? {kind: 'UNKNOWN'} : {kind: 'DEP', dep};
    }
    case 'DYNAMIC_INCLUDES': {
      const path = dict.get(tag.pathId);
      return path === undefined
        ? {kind: 'UNKNOWN'}
        : {kind: 'DYNAMIC_INCLUDES', dynamicIncludes: path};
    }
    case 'GEN_RULES': {
      const path = dict.get(tag.pathId);
      return path === undefined
        ? {kind: 'UNKNOWN'}
        : {kind: 'GEN_RULES', genRules: path};
    }
    case 'PFORM': {
      const path = dict.get(tag.pathId);
      return path === undefined
        ? {kind: 'UNKNOWN'}
        : {kind: 'PFORM', pform: path};
    }
    case 'CONFIGURATOR':
      return {kind: 'CONFIGURATOR'};
    case 'REQUEST':
      return {kind: 'REQUEST'};
    case 'UNKNOWN':
      return {kind: 'UNKNOWN'};
  }
}
