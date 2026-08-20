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
 * Five sections, each reassembled from its chunks by `seq` before parsing:
 *
 * - `graph-dict` - the intern table: `<id>\t<string>`, one per line. The only
 *   section whose values are escaped (`\\`, `\t`, `\n`, C-style) - every other
 *   field anywhere in the blob is an id or a short tag, so nothing else needs
 *   unescaping.
 * - `graph-cores` - one line per shared *core* of a dep set:
 *   `<core_id>\t<dep_ids>`. A core is flat - its members are always dict ids,
 *   never another core - which is what keeps a set's expansion one level deep.
 * - `graph-depsets` - one line per *distinct* dep set:
 *   `<set_id>\t<core_id>\t<add_ids>`, the set being its core's members plus its
 *   own adds. Rule dep sets and dynamic-dep stages share this one table and one
 *   id space.
 * - `graph-rules` - one line per exec-rule span occurrence:
 *   `<rule_id>\t<dir_id>\t<target_file_ids>\t<target_dir_ids>\t<outcome>\t
 *   <forced_by>\t<dep_set>\t<dyn_dep_stages>`.
 * - `graph-deps` - one line per build-dep span:
 *   `<dep_id>\t<resolution>\t<forced_by>\t<status>`.
 *
 * **A rule names its deps by set id rather than listing them.** The same dep
 * set repeats across thousands of rules, so the blob factors the sets out into
 * `graph-depsets` (and their common prefixes into `graph-cores`) and a rule
 * carries one integer. Each dynamic-dep stage is likewise one set id. Nothing
 * here expands them - that's `graph_build.ts`, which owns the flat edge store.
 *
 * `<set_id>` and `<core_id>` are allocated **from 0** in first-sight order, so
 * an empty field is emphatically *not* id 0: see {@link DepSetRecord.coreId}
 * and {@link RuleRecord.depSet}, and the `id()` scanner that keeps them apart.
 * Like `rule_id` they are per-process join keys within one blob, never stable
 * identities.
 *
 * A set is stored sorted (as *text*, so `10` precedes `9`) and duplicate-free,
 * and is split across a core and an add list, so **a rule's declaration order
 * for its deps is not recoverable** - anything that displays them sorts by
 * resolved path instead.
 *
 * An unfinished span (crash/interrupt) is flushed at EOF as a line with `?` in
 * place of `<outcome>`/`<resolution>` and empty `<dep_set>`/`<dyn_dep_stages>`.
 *
 * **`?` and "empty" are not the same thing, and `?` is not the failure
 * signal.** Dune reports a build that failed or was torn down through the
 * ordinary fields - a `D`/`A`/`C` `<outcome>`, a `u` `<resolution>`, a
 * non-empty `<status>` - and reserves `?` for a span that genuinely never
 * ended, i.e. a truncated trace. Likewise a `?` in `<dep_ids>` means "dune
 * could not determine this rule's deps", which is not the empty field's "this
 * rule has none" ({@link RuleRecord.depsUnknown} keeps the two apart, since
 * both parse to no set at all).
 *
 * `<status>` is a later addition to `graph-deps` and every line the current
 * exporter writes carries it; a three-field line (an older trace, same blob
 * version) is read as {@link DepRecord.status} `ok`, which is what the schema
 * meant before the field existed.
 *
 * **Sections are parsed as a stream, one chunk at a time** ({@link
 * parseGraphBlob} takes an async iterable of chunk payloads per section, not a
 * reassembled string). On a monorepo-scale trace `graph-rules` alone is ~190 MB
 * of text, and concatenating it before parsing meant holding a second full copy
 * of it - so instead each chunk is parsed as it arrives and the caller is free
 * to drop each chunk as soon as it has been consumed. **A record never spans a
 * chunk**: the exporter splits only on line boundaries, so each chunk is closed
 * off (`LineReader.end`) before the next is pushed, and the dict's chunks are
 * likewise joined on a newline rather than concatenated bare.
 *
 * Closing each chunk off is what makes an exporter that emits `\n`-*separated*
 * rows safe as well as one that emits `\n`-*terminated* rows. Dune has since
 * moved to terminated, but it separated at first, dropping the newline at each
 * split - so a carried partial glued the last record of one chunk to the first
 * of the next and destroyed both, exactly `chunks - 1` per section: 13 dict
 * entries, 3 rules, 2 deps and 6 dep sets on the monorepo trace, presenting as
 * rules with no deps and as phantom dynamic-dep stages holding the next chunk's
 * `rule_id`. Keep the guard: it costs nothing against a terminated blob (the
 * flush finds an empty partial, the join adds a skipped blank line) and it is
 * what lets an already-exported trace still load. The chunk-set validation
 * `joinChunks` used to do up front is unchanged, just factored out into
 * {@link orderedChunks}.
 *
 * **Records are handed to a {@link GraphBlobSink} as they are parsed** rather
 * than collected into arrays. That mattered most when a `graph-rules` record
 * held the rule's whole dep list - an array of them *was* the 28M-reference edge
 * set - and it still holds for the dep sets those references moved into (3.8M
 * ids across `graph-cores` and `graph-depsets`): the sink lets `graph_build.ts`
 * copy each record into its columnar store and drop it. Nothing here keeps a
 * record alive past the call.
 */

import type {PerfRun} from './perf';
import {measureSync} from './perf';

export const GRAPH_BLOB_VERSION = 1;
export const BLOB_TRACK = 'dune-graph';

// The five graph-blob event/section names on the `dune-graph` track. A blob
// need not carry all of them: `graph-cores` in particular is absent from any
// build whose dep sets were all too small to be worth a shared core, which is
// normal and not an error (see {@link parseGraphBlob}).
export const DICT_SECTION = 'graph-dict';
export const CORES_SECTION = 'graph-cores';
export const DEPSETS_SECTION = 'graph-depsets';
export const RULES_SECTION = 'graph-rules';
export const DEPS_SECTION = 'graph-deps';

/**
 * How building a rule ended. The three failure states are dune's own
 * distinction, not ours: `failed-deps` failed while resolving what it needed,
 * `failed-action` got as far as running its action and that failed, and
 * `cancelled` was torn down with the rest of the build. `unfinished` is *not*
 * one of them - it means the span never ended at all (see the file header).
 */
export type RuleOutcome =
  | 'executed'
  | 'local-cache-hit'
  | 'shared-cache-hit'
  | 'failed-deps'
  | 'failed-action'
  | 'cancelled'
  | 'unfinished';

/**
 * What a dep resolved to. `unknown` is dune reporting that it could not tell -
 * the dep's own build failed or was cancelled before the resolution became
 * known - and is deliberately distinct from `unfinished`, which means the span
 * was never closed (see the file header).
 */
export type DepResolution =
  | {readonly kind: 'rule'; readonly ruleId: number}
  | {readonly kind: 'source'}
  | {readonly kind: 'expanded'; readonly depIds: readonly number[]}
  | {readonly kind: 'unknown'}
  | {readonly kind: 'unfinished'};

// How building a dep itself ended, orthogonal to what it resolved *to*: an
// empty `<status>` field means it succeeded.
export type DepStatus = 'ok' | 'failed' | 'cancelled';

/**
 * A `forced_by` tag as it appears in the blob: every id is still a trace-side id
 * (a dict id, or a `rule_id`), not yet resolved to a node or a string. An
 * unrecognised tag letter degrades to `UNKNOWN` instead of throwing, so a future
 * dune-side addition doesn't break parsing of everything else in the blob.
 */
export type ForcedByTag =
  | {readonly kind: 'RULE'; readonly ruleId: number}
  // Work the rule forced while *recovering* its deps, after it had already
  // failed - a different thing from the `RULE` above, which is work the rule
  // forced in its normal course.
  | {readonly kind: 'RULE_RECOVERY'; readonly ruleId: number}
  | {readonly kind: 'DEP'; readonly depId: number}
  | {
      readonly kind: 'DYNAMIC_INCLUDES' | 'GEN_RULES' | 'PFORM';
      readonly pathId: number;
    }
  | {readonly kind: 'CONFIGURATOR'}
  | {readonly kind: 'REQUEST'}
  | {readonly kind: 'UNKNOWN'};

/**
 * One `graph-rules` line. Ids are the blob's own: `ruleId` is the rule's
 * `rule_id` (a per-process integer, printed as decimal in the blob and carried
 * as an INTEGER arg on the lifecycle instants), everything else is a dict id.
 * An id the blob wrote unparseably arrives as `NaN` and is dropped by the
 * consumer (see graph_build.ts) rather than being silently read as 0.
 */
export interface RuleRecord {
  readonly ruleId: number;
  readonly dirId?: number;
  readonly targetFileIds: readonly number[];
  readonly targetDirIds: readonly number[];
  readonly outcome: RuleOutcome;
  readonly forcedBy?: ForcedByTag;
  /**
   * The `graph-depsets` set holding this rule's static deps, or **undefined**
   * when the field was empty (the rule has none) or `?` (see
   * {@link RuleRecord.depsUnknown}).
   *
   * Undefined is not set 0: set ids are allocated from 0, so a dep-free rule
   * whose empty field was coerced to a number would silently inherit set 0's
   * deps. See {@link id}, which yields `NaN` rather than 0 for an empty field.
   */
  readonly depSet?: number;
  /**
   * Whether the blob wrote `?` for `<dep_set>`: dune could not determine this
   * rule's deps at all (a failed rule it couldn't recover them for, or a
   * cancelled one it was never asked to). `depSet` is undefined either way, so
   * without this flag "unknown" is indistinguishable from a rule that genuinely
   * has no deps - which matters anywhere the plugin counts dependency edges.
   */
  readonly depsUnknown: boolean;
  /**
   * One set id per dynamic-dep stage, in stage order. A stage with no deps is
   * `undefined` and **keeps its slot**: the stages are numbered by position, so
   * dropping an empty one would renumber every stage after it.
   */
  readonly dynDepStages: readonly (number | undefined)[];
}

/**
 * One `graph-cores` line: a set of dict ids shared by several dep sets as their
 * common prefix. `depIds` is never empty, and never names another core - a core
 * is flat, which is what makes expanding a set a one-level operation.
 */
export interface CoreRecord {
  readonly coreId: number;
  readonly depIds: readonly number[];
}

/**
 * One `graph-depsets` line: a distinct dep set, as its (optional) core plus the
 * dict ids it adds on top. Membership is `core ∪ adds`, and `adds` is the set
 * difference `S \ core` - so the two are disjoint by construction and a
 * consumer can concatenate them without deduplicating (`graph_build.ts` counts
 * violations rather than paying for a `Set` on 3.8M ids).
 */
export interface DepSetRecord {
  readonly setId: number;
  /**
   * The set's core, or **undefined** when it has none - which is the common
   * case (~158k of 205k sets on a monorepo trace), and is *not* core 0: cores
   * are allocated from 0 upward, so id 0 is a real core.
   */
  readonly coreId?: number;
  // The ids the set adds on top of its core, or its entire membership when it
  // has no core. Empty is well-formed but never emitted (a core is always a
  // strict subset of its set).
  readonly addIds: readonly number[];
}

// One `graph-deps` line; `depId` is the dep's dict id, which is also its join
// key against a `build-dep` instant's `dep_id` arg. `status` is how building
// the dep itself ended, which is independent of what it resolved *to*: a failed
// dep can still have a known resolution, and a successful one never has an
// `unknown` resolution.
export interface DepRecord {
  readonly depId: number;
  readonly resolution: DepResolution;
  readonly forcedBy?: ForcedByTag;
  readonly status: DepStatus;
}

/**
 * Where {@link parseGraphBlob} puts what it parses. `strings` is called once,
 * before any record; `core`, `depSet`, `rule` and `dep` once per record of
 * their section, in blob order - and the sections themselves in the order they
 * are listed here, so a rule's `depSet` always names a set the sink has already
 * been handed (see {@link parseGraphBlob}).
 *
 * Records are handed over as they are parsed and are not retained by the parser,
 * so a sink that wants to keep one must copy it - see the file header for why
 * the parser doesn't hand back arrays.
 */
export interface GraphBlobSink {
  strings(table: StringTable): void;
  core(record: CoreRecord): void;
  depSet(record: DepSetRecord): void;
  rule(record: RuleRecord): void;
  dep(record: DepRecord): void;
}

/**
 * The blob's intern table: dict id -> string. Deliberately *not* a
 * `Map<number, string>`: on a monorepo-scale trace the table has ~660k entries
 * and 57 MB of text, and a live map of decoded strings costs roughly twice its
 * payload in map slots and per-string headers. See {@link buildStringTable} for
 * the implementation, which keeps the raw payload plus an offset index and
 * slices on demand.
 *
 * `get`/`size` keep the shape a `ReadonlyMap` had, so call sites (and tests)
 * read the same either way.
 */
export interface StringTable {
  // The string interned under `id`, or undefined if the table has no such id.
  get(id: number): string | undefined;

  // How many strings the table holds.
  readonly size: number;

  /**
   * Every interned pair, in ascending id order. Only the SQL mirror walks the
   * whole table - it copies it into `dune_string` so the mirror can store a
   * dict id wherever it used to repeat a path (see sql_graph.ts) - so this is
   * deliberately a one-shot iteration rather than a materialized list.
   *
   * @yields each `[id, string]` pair.
   */
  entries(): Iterable<readonly [number, string]>;
}

export const EMPTY_STRING_TABLE: StringTable = {
  get: () => undefined,
  size: 0,
  entries: () => [],
};

// One `dune-graph` instant's chunk *without* its payload: what the blob query's
// cheap metadata pass reads (see `trace_graph_source.ts`), and everything
// {@link orderedChunks} needs to validate the set. `name` is one of the five
// section names above.
export interface BlobChunkMeta {
  readonly name: string;
  readonly version: number;
  readonly seq: number;
  readonly total: number;
}

// A chunk with its payload, as `joinChunks` and the unit tests use it.
export interface BlobChunk extends BlobChunkMeta {
  readonly data: string;
}

/**
 * Validates one section's chunk set and returns it in `seq` order, regardless
 * of the order it arrived in. Throws (rather than silently truncating) on a
 * version mismatch, a missing/duplicate `seq`, or a chunk count that doesn't
 * match the section's own `total` - a corrupt or partially-written blob should
 * fail loudly, not produce a plausible-looking partial graph.
 *
 * Generic over the chunk type so it can validate payload-less metadata (which
 * is how the streaming read uses it - the payloads are fetched one at a time,
 * afterwards) as well as whole chunks.
 */
export function orderedChunks<T extends BlobChunkMeta>(
  name: string,
  chunks: readonly T[],
): readonly T[] {
  if (chunks.length === 0) return [];
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
    throw new Error(`${name}: expected ${total} chunks, got ${chunks.length}`);
  }
  const bySeq = new Map<number, T>();
  for (const c of chunks) {
    if (bySeq.has(c.seq)) {
      throw new Error(`${name}: duplicate chunk seq ${c.seq}`);
    }
    bySeq.set(c.seq, c);
  }
  const ordered: T[] = [];
  for (let i = 0; i < total; i++) {
    const chunk = bySeq.get(i);
    if (chunk === undefined) {
      throw new Error(`${name}: missing chunk seq ${i} of ${total}`);
    }
    ordered.push(chunk);
  }
  return ordered;
}

// Reassembles one section's chunks into its full payload string. Only used
// where the whole payload genuinely has to exist at once (the intern table,
// which {@link StringTable} slices on demand) - the record sections are parsed
// a chunk at a time instead, see {@link parseGraphBlob}.
export function joinChunks(name: string, chunks: readonly BlobChunk[]): string {
  return orderedChunks(name, chunks)
    .map((c) => c.data)
    .join('');
}

/**
 * Splits a stream of chunk payloads into lines, carrying a partial line across
 * the chunk boundary - a chunk boundary falls wherever the exporter's buffer
 * filled up, so it lands mid-record about as often as not.
 *
 * Empty lines are skipped, so a trailing newline doesn't produce a spurious
 * final record (the same rule the whole-payload split enforced).
 */
class LineReader {
  private partial = '';

  constructor(private readonly onLine: (line: string) => void) {}

  push(text: string): void {
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      if (nl < 0) break;
      const line =
        this.partial.length === 0
          ? text.slice(start, nl)
          : this.partial + text.slice(start, nl);
      this.partial = '';
      if (line.length > 0) this.onLine(line);
      start = nl + 1;
    }
    if (start < text.length) this.partial += text.slice(start);
  }

  // Flushes a line with no trailing newline. Idempotent, and called at every
  // chunk boundary rather than only at the end of the section - a record never
  // spans a chunk, so a partial there is a whole record from a separator-style
  // blob. See the header comment.
  end(): void {
    const last = this.partial;
    this.partial = '';
    if (last.length > 0) this.onLine(last);
  }
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

// An id whose offset index would be this much bigger than the number of entries
// is treated as sparse and sent down the plain-`Map` path instead: dict ids are
// intern-table indices, so they are dense `[0, N)` in every blob the exporter
// produces, but a hostile or future blob shouldn't be able to make us allocate
// an arbitrarily large array.
const MAX_INDEX_SLACK = 8;

/**
 * Indexes the `graph-dict` payload (its chunks, joined here - see
 * {@link StringTable} for why this section keeps its text) as `id -> string`.
 *
 * `chunks` is consumed: it's emptied as the payload is joined, so the caller's
 * per-chunk strings become collectable as soon as this returns.
 *
 * The index is two `Int32Array`s of payload offsets, keyed by id, so a lookup is
 * an array read plus a `slice` and the decoded strings are never all live at
 * once. Values are unescaped on read (only this section escapes anything, and
 * only a small minority of entries actually contain an escape).
 */
export function buildStringTable(chunks: string[]): StringTable {
  // Joined on '\n', not '': a section splits only on line boundaries, and a
  // separator-style exporter drops the newline at the split, so concatenating
  // bare would glue each chunk's last entry to the next chunk's first and lose
  // both (13 entries on the monorepo trace, one per boundary). Against a
  // terminated blob this just adds a blank line, which the scan below skips.
  const payload = chunks.join('\n');
  chunks.length = 0;
  // Scanned without materialising a string per line: only the (short) id text
  // is sliced, and each value stays as a pair of offsets.
  const ids: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let maxId = -1;
  let pos = 0;
  while (pos < payload.length) {
    let nl = payload.indexOf('\n', pos);
    if (nl < 0) nl = payload.length;
    // Split on the *first* tab only - the value's own tabs arrive escaped, so
    // an unescaped tab can only be the id/value separator.
    const tab = payload.indexOf('\t', pos);
    if (tab >= pos && tab < nl) {
      const id = Number(payload.slice(pos, tab));
      if (Number.isSafeInteger(id) && id >= 0) {
        ids.push(id);
        starts.push(tab + 1);
        ends.push(nl);
        if (id > maxId) maxId = id;
      }
    }
    pos = nl + 1;
  }

  // Only this section's values carry escapes, and only a small minority of them
  // do, so the scan for a backslash is worth it to skip the decode entirely.
  const value = (start: number, end: number) => {
    const raw = payload.slice(start, end);
    return raw.includes('\\') ? unescape(raw) : raw;
  };

  if (maxId >= 0 && maxId + 1 <= MAX_INDEX_SLACK * ids.length + 1024) {
    const startAt = new Int32Array(maxId + 1).fill(-1);
    const endAt = new Int32Array(maxId + 1);
    for (let i = 0; i < ids.length; i++) {
      startAt[ids[i]] = starts[i];
      endAt[ids[i]] = ends[i];
    }
    return {
      size: ids.length,
      get(id: number): string | undefined {
        if (!Number.isInteger(id) || id < 0 || id >= startAt.length) {
          return undefined;
        }
        const start = startAt[id];
        return start < 0 ? undefined : value(start, endAt[id]);
      },
      *entries(): Iterable<readonly [number, string]> {
        for (let id = 0; id < startAt.length; id++) {
          const start = startAt[id];
          if (start >= 0) yield [id, value(start, endAt[id])];
        }
      },
    };
  }

  // Sparse (or empty) ids: fall back to a plain decoded map. Never taken by a
  // real blob - see MAX_INDEX_SLACK.
  const map = new Map<number, string>();
  for (let i = 0; i < ids.length; i++) {
    map.set(ids[i], value(starts[i], ends[i]));
  }
  return {
    size: map.size,
    get: (id: number) => map.get(id),
    entries: () => [...map.entries()].sort((a, b) => a[0] - b[0]),
  };
}

const CH_ZERO = 0x30;
const CH_NINE = 0x39;
const CH_COMMA = 0x2c;

/**
 * A `,`-separated list of decimal ids; empty input yields an empty list (not
 * `[NaN]`).
 *
 * Scans digits straight out of the field rather than `split(',').map(Number)`:
 * the `<dep_ids>` field alone holds ~28M ids on a monorepo-scale trace, and
 * splitting allocates a string per id - by far the largest allocation the parse
 * used to make. An entry that isn't a plain run of digits yields `NaN`, matching
 * what `Number()` did for it, and the graph builder drops those.
 */
function idList(field: string): number[] {
  const ids: number[] = [];
  if (field === '') return ids;
  let value = 0;
  let digits = 0;
  let malformed = false;
  for (let i = 0; i < field.length; i++) {
    const c = field.charCodeAt(i);
    if (c === CH_COMMA) {
      ids.push(digits > 0 && !malformed ? value : NaN);
      value = 0;
      digits = 0;
      malformed = false;
    } else if (c >= CH_ZERO && c <= CH_NINE) {
      value = value * 10 + (c - CH_ZERO);
      digits++;
    } else {
      malformed = true;
    }
  }
  ids.push(digits > 0 && !malformed ? value : NaN);
  return ids;
}

// A single decimal id field: the same digits-only rule as {@link idList}, so an
// empty or malformed field is `NaN` rather than 0.
function id(field: string): number {
  let value = 0;
  for (let i = 0; i < field.length; i++) {
    const c = field.charCodeAt(i);
    if (c < CH_ZERO || c > CH_NINE) return NaN;
    value = value * 10 + (c - CH_ZERO);
  }
  return field.length === 0 ? NaN : value;
}

// A single decimal id field that the blob is allowed to leave empty, as
// `undefined` rather than as a number. Reads through {@link id}, so an empty
// field can never come back as 0 - which matters for every id space the blob
// allocates from 0 (`<dir_id>`, `<core_id>`, `<dep_set>`, a dyn-dep stage).
// A field that isn't a plain run of digits is `undefined` too: an unusable id
// is dropped here rather than becoming a reference to whatever it truncates to.
function optionalId(field: string): number | undefined {
  const value = id(field);
  return Number.isNaN(value) ? undefined : value;
}

// `dyn_dep_stages`: `|`-separated stages, each **one** set id; empty input
// yields no stages. An empty stage between two `|` is well-formed and keeps its
// slot as `undefined` - stages are numbered by position (see
// `RuleRecord.dynDepStages`). A comma inside a stage is malformed input, not a
// list, and reads as no set at all.
function dynDepStages(field: string): readonly (number | undefined)[] {
  if (field === '') return [];
  return field.split('|').map(optionalId);
}

// A `<forced_by>` tag: a one-letter prefix, optionally followed by an id.
function parseForcedByTag(field: string): ForcedByTag | undefined {
  if (field === '') return undefined;
  const tag = field[0];
  const rest = field.slice(1);
  switch (tag) {
    case 'r':
      return {kind: 'RULE', ruleId: id(rest)};
    case 'v':
      return {kind: 'RULE_RECOVERY', ruleId: id(rest)};
    case 'd':
      return {kind: 'DEP', depId: id(rest)};
    case 'i':
      return {kind: 'DYNAMIC_INCLUDES', pathId: id(rest)};
    case 'g':
      return {kind: 'GEN_RULES', pathId: id(rest)};
    case 'p':
      return {kind: 'PFORM', pathId: id(rest)};
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
    case 'D':
      return 'failed-deps';
    case 'A':
      return 'failed-action';
    case 'C':
      return 'cancelled';
    default:
      return 'unfinished'; // '?', or anything unrecognised.
  }
}

// The `<status>` field of a `graph-deps` line. Empty is the success case (and
// also what a pre-`<status>` three-field line reads as - see the file header);
// anything unrecognised is treated as a failure rather than quietly as success,
// since a status dune bothered to write is never "fine".
function parseDepStatus(field: string): DepStatus {
  switch (field) {
    case '':
      return 'ok';
    case 'c':
      return 'cancelled';
    default:
      return 'failed'; // 'f', or anything unrecognised.
  }
}

function parseResolution(field: string): DepResolution {
  if (field === 's') return {kind: 'source'};
  if (field === 'u') return {kind: 'unknown'};
  if (field === '?' || field === '') return {kind: 'unfinished'};
  const tag = field[0];
  const rest = field.slice(1);
  if (tag === 'r') return {kind: 'rule', ruleId: id(rest)};
  if (tag === 'x') return {kind: 'expanded', depIds: idList(rest)};
  // An unrecognised tag is a resolution we can't read rather than a span that
  // never ended, so it reads as `unknown` - the same bucket as dune's own "I
  // couldn't tell".
  return {kind: 'unknown'};
}

// A rule line, or undefined for a line that isn't one: too few fields, or a
// `rule_id` that isn't an integer (the same rule `parseDepLine` applies to
// `dep_id` - a record with no usable identity can't become a node).
function parseRuleLine(line: string): RuleRecord | undefined {
  const f = line.split('\t');
  if (f.length < 8) return undefined;
  const [
    ruleIdStr,
    dirIdStr,
    targetFileIds,
    targetDirIds,
    outcome,
    forcedBy,
    depSet,
    stages,
  ] = f;
  const ruleId = id(ruleIdStr);
  if (Number.isNaN(ruleId)) return undefined;
  // `?` deps are *unknown*, not none - see `RuleRecord.depsUnknown`. There is
  // no set either way (`optionalId('?')` is undefined), so the flag is the only
  // thing that distinguishes them.
  const depsUnknown = depSet === '?';
  return {
    ruleId,
    dirId: optionalId(dirIdStr),
    targetFileIds: idList(targetFileIds),
    targetDirIds: idList(targetDirIds),
    outcome: parseOutcome(outcome),
    forcedBy: parseForcedByTag(forcedBy),
    depSet: depsUnknown ? undefined : optionalId(depSet),
    depsUnknown,
    dynDepStages: dynDepStages(stages),
  };
}

// A `graph-cores` line, or undefined for one with no usable `core_id`. Members
// are ids only, so nothing here needs unescaping.
function parseCoreLine(line: string): CoreRecord | undefined {
  const tab = line.indexOf('\t');
  if (tab < 0) return undefined;
  const coreId = id(line.slice(0, tab));
  if (Number.isNaN(coreId)) return undefined;
  return {coreId, depIds: idList(line.slice(tab + 1))};
}

// A `graph-depsets` line, or undefined for one with no usable `set_id` or too
// few fields. Unlike `graph-deps` there is no older short form of this section
// to tolerate, so a line missing `<add_ids>` entirely is malformed - an *empty*
// `<add_ids>` (the third field present and blank) is fine, and is the one shape
// the guide asks us to parse without falling over.
function parseDepSetLine(line: string): DepSetRecord | undefined {
  const f = line.split('\t');
  if (f.length < 3) return undefined;
  const [setIdStr, coreIdStr, addIds] = f;
  const setId = id(setIdStr);
  if (Number.isNaN(setId)) return undefined;
  return {setId, coreId: optionalId(coreIdStr), addIds: idList(addIds)};
}

// A dep line. `<status>` is read positionally when present and defaults to `ok`
// for a three-field line, which is how the section looked before the field was
// added (see the file header) - the guard stays at three so an older trace
// still parses rather than losing every dep node.
function parseDepLine(line: string): DepRecord | undefined {
  const f = line.split('\t');
  if (f.length < 3) return undefined;
  const [depIdStr, resolution, forcedBy, status] = f;
  const depId = id(depIdStr);
  if (Number.isNaN(depId)) return undefined;
  return {
    depId,
    resolution: parseResolution(resolution),
    forcedBy: parseForcedByTag(forcedBy),
    status: parseDepStatus(status ?? ''),
  };
}

/**
 * One section's payload as a stream of chunks, in `seq` order - what
 * {@link parseGraphBlob} consumes. The source fetches each chunk as the parser
 * asks for it (see `trace_graph_source.ts`), so only one chunk of a section's
 * text is live at a time.
 */
export type SectionChunks = AsyncIterable<string>;

/**
 * Parses the five sections into `sink`, streaming each one chunk by chunk. A
 * missing section is treated as empty rather than an error, so a trace with e.g.
 * no build-dep spans at all still parses - and so does one with no
 * `graph-cores`, which is the normal shape for a build whose dep sets were all
 * too small to factor. **Nothing here may start treating an absent section as a
 * failure.**
 *
 * The order is the blob's own: dict, cores, depsets, rules, deps. A sink can
 * rely on it, and `graph_build.ts` does - it expands each rule's dep set as the
 * rule arrives, which only works because every set is already in. The order is
 * this function's to choose (the caller hands over a section *per name*, and
 * fetches its chunks on demand), so it does not depend on the blob's own
 * emission order.
 *
 * `perf`, when given, records one phase per section (see perf.ts) - measuring
 * only the synchronous parse of each chunk, so it never overlaps (and so never
 * double-counts) whatever phase the caller's iterable uses for the fetch. Note
 * the sink's own work is inside those phases, since it runs per record. The
 * parser itself stays pure either way: it never touches the engine.
 */
export async function parseGraphBlob(
  sections: ReadonlyMap<string, SectionChunks>,
  sink: GraphBlobSink,
  perf?: PerfRun,
): Promise<void> {
  // The intern table is the one section whose text is kept (see
  // {@link StringTable}), so its chunks are accumulated rather than discarded.
  const dictChunks: string[] = [];
  await eachChunk(sections.get(DICT_SECTION), (text) =>
    measureSync(perf, `blob: parse ${DICT_SECTION}`, (p) => {
      dictChunks.push(text);
      p.bytes(text.length);
    }),
  );
  measureSync(perf, `blob: index ${DICT_SECTION}`, (p) => {
    const table = buildStringTable(dictChunks);
    p.rows(table.size);
    sink.strings(table);
  });

  let cores = 0;
  await parseLines(
    sections.get(CORES_SECTION),
    CORES_SECTION,
    perf,
    (line) => {
      const record = parseCoreLine(line);
      if (record === undefined) return;
      cores++;
      sink.core(record);
    },
    () => cores,
  );

  let sets = 0;
  await parseLines(
    sections.get(DEPSETS_SECTION),
    DEPSETS_SECTION,
    perf,
    (line) => {
      const record = parseDepSetLine(line);
      if (record === undefined) return;
      sets++;
      sink.depSet(record);
    },
    () => sets,
  );

  let rules = 0;
  await parseLines(
    sections.get(RULES_SECTION),
    RULES_SECTION,
    perf,
    (line) => {
      const record = parseRuleLine(line);
      if (record === undefined) return;
      rules++;
      sink.rule(record);
    },
    () => rules,
  );

  let deps = 0;
  await parseLines(
    sections.get(DEPS_SECTION),
    DEPS_SECTION,
    perf,
    (line) => {
      const record = parseDepLine(line);
      if (record === undefined) return;
      deps++;
      sink.dep(record);
    },
    () => deps,
  );
}

// Feeds each of a section's chunks to `onChunk`, tolerating an absent section.
async function eachChunk(
  chunks: SectionChunks | undefined,
  onChunk: (text: string) => void,
): Promise<void> {
  if (chunks === undefined) return;
  for await (const text of chunks) onChunk(text);
}

// Streams one record section through `onLine`, one chunk at a time, and
// accounts the parse under a single per-section phase. The chunk count lands in
// the phase's note, since the phase's own `n` also covers the flush below.
async function parseLines(
  chunks: SectionChunks | undefined,
  name: string,
  perf: PerfRun | undefined,
  onLine: (line: string) => void,
  count: () => number,
): Promise<void> {
  const reader = new LineReader(onLine);
  let read = 0;
  await eachChunk(chunks, (text) =>
    measureSync(perf, `blob: parse ${name}`, (p) => {
      reader.push(text);
      reader.end();
      read++;
      p.bytes(text.length);
    }),
  );
  measureSync(perf, `blob: parse ${name}`, (p) => {
    reader.end();
    p.rows(count());
    p.note(`${read} chunks`);
  });
}
