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

/**
 * Parses the Dune graph blob: the structural build graph, chunked onto
 * instants on the `dune-graph` track (see
 * `doc/dev/trace-graph-perfetto.md`'s "Graph blob" section in the dune repo).
 * Pure - no engine access - so every corner of the grammar is unit-testable in
 * isolation; `trace_graph_source.ts` is the only caller.
 *
 * Three sections, each reassembled from its chunks by `seq` before parsing:
 *
 * - `graph-dict` - the intern table: `<id>\t<string>`, one per line. The only
 *   section whose values are escaped (`\\`, `\t`, `\n`, C-style) - every other
 *   field anywhere in the blob is an id or a short tag, so nothing else needs
 *   unescaping.
 * - `graph-rules` - one line per exec-rule span occurrence:
 *   `<rule_id>\t<dir_id>\t<target_file_ids>\t<target_dir_ids>\t<outcome>\t
 *   <forced_by>\t<dep_ids>\t<dyn_dep_stages>`.
 * - `graph-deps` - one line per build-dep span:
 *   `<dep_id>\t<resolution>\t<forced_by>`.
 *
 * An unfinished span (crash/interrupt) is flushed at EOF as a line with `?` in
 * place of `<outcome>`/`<resolution>` and empty `<dep_ids>`/`<dyn_dep_stages>`.
 */

import type {PerfRun} from './perf';
import {measureSync} from './perf';

export const GRAPH_BLOB_VERSION = 1;
export const BLOB_TRACK = 'dune-graph';

// The three graph-blob event/section names on the `dune-graph` track.
export const DICT_SECTION = 'graph-dict';
export const RULES_SECTION = 'graph-rules';
export const DEPS_SECTION = 'graph-deps';

export type RuleOutcome =
  | 'executed'
  | 'local-cache-hit'
  | 'shared-cache-hit'
  | 'unfinished';

export type DepResolution =
  | {readonly kind: 'rule'; readonly ruleId: string}
  | {readonly kind: 'source'}
  | {readonly kind: 'expanded'; readonly depIds: readonly number[]}
  | {readonly kind: 'unfinished'};

// A `forced_by` tag as it appears in the blob: ids are still intern ids (not
// yet resolved through the dict) and a rule forcer's id is the bare rule id
// string (rule ids aren't interned). An unrecognised tag letter degrades to
// `UNKNOWN` instead of throwing, so a future dune-side addition doesn't break
// parsing of everything else in the blob.
export type ForcedByTag =
  | {readonly kind: 'RULE'; readonly ruleId: string}
  | {readonly kind: 'DEP'; readonly depId: number}
  | {
      readonly kind: 'DYNAMIC_INCLUDES' | 'GEN_RULES' | 'PFORM';
      readonly pathId: number;
    }
  | {readonly kind: 'CONFIGURATOR'}
  | {readonly kind: 'REQUEST'}
  | {readonly kind: 'UNKNOWN'};

export interface RuleRecord {
  readonly ruleId: string;
  readonly dirId?: number;
  readonly targetFileIds: readonly number[];
  readonly targetDirIds: readonly number[];
  readonly outcome: RuleOutcome;
  readonly forcedBy?: ForcedByTag;
  readonly depIds: readonly number[];
  readonly dynDepStages: readonly (readonly number[])[];
}

export interface DepRecord {
  readonly depId: number;
  readonly resolution: DepResolution;
  readonly forcedBy?: ForcedByTag;
}

export interface GraphBlob {
  readonly dict: ReadonlyMap<number, string>;
  readonly rules: readonly RuleRecord[];
  readonly deps: readonly DepRecord[];
}

// One `dune-graph` instant's args, as read off the trace (see
// `trace_graph_source.ts`'s blob query). `name` is one of `DICT_SECTION` /
// `RULES_SECTION` / `DEPS_SECTION`.
export interface BlobChunk {
  readonly name: string;
  readonly version: number;
  readonly seq: number;
  readonly total: number;
  readonly data: string;
}

// Reassembles one section's chunks into its full payload string, in `seq`
// order regardless of the order `chunks` arrives in. Throws (rather than
// silently truncating) on a version mismatch, a missing/duplicate `seq`, or a
// chunk count that doesn't match the section's own `total` - a corrupt or
// partially-written blob should fail loudly, not produce a plausible-looking
// partial graph.
export function joinChunks(name: string, chunks: readonly BlobChunk[]): string {
  if (chunks.length === 0) return '';
  const total = chunks[0].total;
  for (const c of chunks) {
    if (c.version !== GRAPH_BLOB_VERSION) {
      throw new Error(
        `${name}: unsupported graph blob version ${c.version} ` +
          `(expected ${GRAPH_BLOB_VERSION})`,
      );
    }
    if (c.total !== total) {
      throw new Error(
        `${name}: inconsistent chunk total (${c.total} vs ${total})`,
      );
    }
  }
  if (chunks.length !== total) {
    throw new Error(
      `${name}: expected ${total} chunks, got ${chunks.length}`,
    );
  }
  const bySeq = new Map<number, string>();
  for (const c of chunks) {
    if (bySeq.has(c.seq)) {
      throw new Error(`${name}: duplicate chunk seq ${c.seq}`);
    }
    bySeq.set(c.seq, c.data);
  }
  const parts: string[] = [];
  for (let i = 0; i < total; i++) {
    const part = bySeq.get(i);
    if (part === undefined) {
      throw new Error(`${name}: missing chunk seq ${i} of ${total}`);
    }
    parts.push(part);
  }
  return parts.join('');
}

// Splits a payload into non-empty lines (a trailing newline shouldn't produce
// a spurious empty final record).
function lines(payload: string): string[] {
  return payload.split('\n').filter((l) => l.length > 0);
}

// Unescapes `\\`, `\t`, `\n` - the only field in the whole blob that carries
// literal escapes (every other field is an id or a short tag).
function unescape(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === '\\') {
        out += '\\';
        i++;
      } else if (next === 't') {
        out += '\t';
        i++;
      } else if (next === 'n') {
        out += '\n';
        i++;
      } else {
        out += ch;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

function parseDict(payload: string): Map<number, string> {
  const dict = new Map<number, string>();
  for (const line of lines(payload)) {
    // Split on the *first* tab only - the value's own tabs arrive escaped, so
    // an unescaped tab can only be the id/value separator.
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const id = Number(line.slice(0, tab));
    if (!Number.isFinite(id)) continue;
    dict.set(id, unescape(line.slice(tab + 1)));
  }
  return dict;
}

// A `,`-separated int list; empty input yields an empty list (not `[NaN]`).
function idList(field: string): readonly number[] {
  if (field === '') return [];
  return field.split(',').map(Number);
}

// `dyn_dep_stages`: `|`-separated stages, each a `,`-separated id list; empty
// input yields no stages.
function dynDepStages(field: string): readonly (readonly number[])[] {
  if (field === '') return [];
  return field.split('|').map(idList);
}

// A `<forced_by>` tag: a one-letter prefix, optionally followed by an id.
function parseForcedByTag(field: string): ForcedByTag | undefined {
  if (field === '') return undefined;
  const tag = field[0];
  const rest = field.slice(1);
  switch (tag) {
    case 'r':
      return {kind: 'RULE', ruleId: rest};
    case 'd':
      return {kind: 'DEP', depId: Number(rest)};
    case 'i':
      return {kind: 'DYNAMIC_INCLUDES', pathId: Number(rest)};
    case 'g':
      return {kind: 'GEN_RULES', pathId: Number(rest)};
    case 'p':
      return {kind: 'PFORM', pathId: Number(rest)};
    case 'c':
      return {kind: 'CONFIGURATOR'};
    case 'q':
      return {kind: 'REQUEST'};
    default:
      return {kind: 'UNKNOWN'};
  }
}

function parseOutcome(field: string): RuleOutcome {
  switch (field) {
    case 'X':
      return 'executed';
    case 'L':
      return 'local-cache-hit';
    case 'S':
      return 'shared-cache-hit';
    default:
      return 'unfinished'; // '?', or anything unrecognised.
  }
}

function parseResolution(field: string): DepResolution {
  if (field === 's') return {kind: 'source'};
  if (field === '?' || field === '') return {kind: 'unfinished'};
  const tag = field[0];
  const rest = field.slice(1);
  if (tag === 'r') return {kind: 'rule', ruleId: rest};
  if (tag === 'x') return {kind: 'expanded', depIds: idList(rest)};
  return {kind: 'unfinished'};
}

function parseRuleLine(line: string): RuleRecord | undefined {
  const f = line.split('\t');
  if (f.length < 8) return undefined;
  const [
    ruleId,
    dirIdStr,
    targetFileIds,
    targetDirIds,
    outcome,
    forcedBy,
    depIds,
    stages,
  ] = f;
  const dirId = dirIdStr === '' ? undefined : Number(dirIdStr);
  return {
    ruleId,
    dirId,
    targetFileIds: idList(targetFileIds),
    targetDirIds: idList(targetDirIds),
    outcome: parseOutcome(outcome),
    forcedBy: parseForcedByTag(forcedBy),
    depIds: idList(depIds),
    dynDepStages: dynDepStages(stages),
  };
}

function parseDepLine(line: string): DepRecord | undefined {
  const f = line.split('\t');
  if (f.length < 3) return undefined;
  const [depIdStr, resolution, forcedBy] = f;
  const depId = Number(depIdStr);
  if (!Number.isFinite(depId)) return undefined;
  return {
    depId,
    resolution: parseResolution(resolution),
    forcedBy: parseForcedByTag(forcedBy),
  };
}

// Parses the three reassembled section payloads into a {@link GraphBlob}.
// `sections` maps section name to its already-joined payload (see
// {@link joinChunks}); a missing section is treated as empty rather than an
// error, so a trace with e.g. no build-dep spans at all still parses.
// `perf`, when given, records one phase per section (see perf.ts); the parser
// itself stays pure either way.
export function parseGraphBlob(
  sections: ReadonlyMap<string, string>,
  perf?: PerfRun,
): GraphBlob {
  const dictPayload = sections.get(DICT_SECTION) ?? '';
  const dict = measureSync(perf, `blob: parse ${DICT_SECTION}`, (p) => {
    const parsed = parseDict(dictPayload);
    p.rows(parsed.size);
    p.bytes(dictPayload.length);
    return parsed;
  });
  const rulesPayload = sections.get(RULES_SECTION) ?? '';
  const rules = measureSync(perf, `blob: parse ${RULES_SECTION}`, (p) => {
    const parsed: RuleRecord[] = [];
    for (const line of lines(rulesPayload)) {
      const r = parseRuleLine(line);
      if (r !== undefined) parsed.push(r);
    }
    p.rows(parsed.length);
    p.bytes(rulesPayload.length);
    return parsed;
  });
  const depsPayload = sections.get(DEPS_SECTION) ?? '';
  const deps = measureSync(perf, `blob: parse ${DEPS_SECTION}`, (p) => {
    const parsed: DepRecord[] = [];
    for (const line of lines(depsPayload)) {
      const d = parseDepLine(line);
      if (d !== undefined) parsed.push(d);
    }
    p.rows(parsed.length);
    p.bytes(depsPayload.length);
    return parsed;
  });
  return {dict, rules, deps};
}
