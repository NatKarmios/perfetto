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

import type {
  BlobChunk,
  CoreRecord,
  DepRecord,
  DepSetRecord,
  GraphBlobSink,
  RuleRecord,
  SectionChunks,
  StringTable,
} from './graph_blob';
import {
  CORES_SECTION,
  DEPSETS_SECTION,
  DEPS_SECTION,
  DICT_SECTION,
  EMPTY_STRING_TABLE,
  GRAPH_BLOB_VERSION,
  RULES_SECTION,
  joinChunks,
  parseGraphBlob,
} from './graph_blob';

function chunk(
  name: string,
  seq: number,
  total: number,
  data: string,
  version = GRAPH_BLOB_VERSION,
): BlobChunk {
  return {name, version, seq, total, data};
}

// The parser streams into a sink rather than returning the records (see
// graph_blob.ts), so these tests collect them - which is also what a sink is
// allowed to do, since a record isn't reused after the call.
class Collected implements GraphBlobSink {
  dict: StringTable = EMPTY_STRING_TABLE;
  readonly cores: CoreRecord[] = [];
  readonly sets: DepSetRecord[] = [];
  readonly rules: RuleRecord[] = [];
  readonly deps: DepRecord[] = [];
  // Which sink method was called when, deduped - the parser fixes the section
  // order and `graph_build.ts` depends on it (a rule's set must already be in).
  readonly order: string[] = [];

  strings(table: StringTable): void {
    this.note('strings');
    this.dict = table;
  }

  core(record: CoreRecord): void {
    this.note('core');
    this.cores.push(record);
  }

  depSet(record: DepSetRecord): void {
    this.note('depSet');
    this.sets.push(record);
  }

  rule(record: RuleRecord): void {
    this.note('rule');
    this.rules.push(record);
  }

  dep(record: DepRecord): void {
    this.note('dep');
    this.deps.push(record);
  }

  private note(what: string): void {
    if (this.order[this.order.length - 1] !== what) this.order.push(what);
  }
}

// Most tests pass one chunk per section; passing an array yields those chunks in
// order, which is how the chunk-boundary behaviour is exercised. Note the
// exporter splits only on line boundaries and drops the separator there, so a
// realistic multi-chunk payload has whole records per chunk and no trailing
// newline on any but the last.
async function parse(
  sections: Record<string, string | readonly string[]>,
): Promise<Collected> {
  const map = new Map<string, SectionChunks>();
  for (const [name, payload] of Object.entries(sections)) {
    const parts = typeof payload === 'string' ? [payload] : payload;
    map.set(
      name,
      (async function* () {
        for (const part of parts) yield part;
      })(),
    );
  }
  const collected = new Collected();
  await parseGraphBlob(map, collected);
  return collected;
}

describe('joinChunks', () => {
  it('reassembles chunks in seq order regardless of arrival order', () => {
    const chunks = [
      chunk('graph-dict', 2, 3, 'c'),
      chunk('graph-dict', 0, 3, 'a'),
      chunk('graph-dict', 1, 3, 'b'),
    ];
    expect(joinChunks('graph-dict', chunks)).toEqual('abc');
  });

  it('returns an empty string for no chunks', () => {
    expect(joinChunks('graph-dict', [])).toEqual('');
  });

  it('throws on a version mismatch', () => {
    const chunks = [chunk('graph-dict', 0, 1, 'a', 2)];
    expect(() => joinChunks('graph-dict', chunks)).toThrow(/version/);
  });

  it('throws on a missing seq (right count, wrong numbering)', () => {
    // Two chunks (matching `total`), but seq 3 stands in for seq 1 - a
    // distinct failure from a plain dropped chunk (which the chunk-count
    // check above already catches).
    const chunks = [
      chunk('graph-dict', 0, 2, 'a'),
      chunk('graph-dict', 3, 2, 'b'),
    ];
    expect(() => joinChunks('graph-dict', chunks)).toThrow(/missing/i);
  });

  it('throws on a dropped chunk (wrong count)', () => {
    const chunks = [chunk('graph-dict', 0, 2, 'a')];
    expect(() => joinChunks('graph-dict', chunks)).toThrow(
      /expected 2 chunks/i,
    );
  });

  it('throws on a duplicate seq', () => {
    const chunks = [
      chunk('graph-dict', 0, 2, 'a'),
      chunk('graph-dict', 0, 2, 'b'),
    ];
    expect(() => joinChunks('graph-dict', chunks)).toThrow(/duplicate/i);
  });

  it('throws on an inconsistent total across chunks', () => {
    const chunks = [
      chunk('graph-dict', 0, 1, 'a'),
      chunk('graph-dict', 1, 2, 'b'),
    ];
    expect(() => joinChunks('graph-dict', chunks)).toThrow(/total/i);
  });
});

describe('parseGraphBlob - graph-dict', () => {
  it('round-trips escaped values (\\\\, \\t, \\n)', async () => {
    const blob = await parse({
      [DICT_SECTION]:
        '0\tplain/path\n1\twith\\ttab\n2\twith\\nnewline\n3\tliteral\\\\backslash\n',
    });
    expect(blob.dict.get(0)).toEqual('plain/path');
    expect(blob.dict.get(1)).toEqual('with\ttab');
    expect(blob.dict.get(2)).toEqual('with\nnewline');
    expect(blob.dict.get(3)).toEqual('literal\\backslash');
  });

  it('splits only on the first tab, so an escaped-tab value is not mis-split', async () => {
    const blob = await parse({[DICT_SECTION]: '0\ta\\tb\tc\n'});
    // The line's only *unescaped* tab is the id/value separator; everything
    // after it - including the literal `\t` that decodes to a tab, and the
    // bare `\t` that separates "b" from "c" in the raw csexp string - is the
    // value.
    expect(blob.dict.get(0)).toEqual('a\tb\tc');
  });

  it('skips a line with no tab', async () => {
    const blob = await parse({[DICT_SECTION]: 'garbage\n0\tok\n'});
    expect(blob.dict.size).toEqual(1);
    expect(blob.dict.get(0)).toEqual('ok');
  });

  it('returns undefined for an id the table does not hold', async () => {
    const blob = await parse({[DICT_SECTION]: '0\ta\n2\tc\n'});
    expect(blob.dict.get(1)).toBeUndefined();
    expect(blob.dict.get(3)).toBeUndefined();
    expect(blob.dict.get(-1)).toBeUndefined();
    expect(blob.dict.size).toEqual(2);
  });

  it('indexes a sparse id space (the non-array fallback path)', async () => {
    const blob = await parse({[DICT_SECTION]: `0\ta\n${1e6}\tfar\n`});
    expect(blob.dict.get(0)).toEqual('a');
    expect(blob.dict.get(1e6)).toEqual('far');
    expect(blob.dict.size).toEqual(2);
  });

  it('closes the record when a chunk ends without a newline', async () => {
    // The exporter splits only on line boundaries and drops the separator at
    // the split, so a chunk's last record has no trailing newline and the next
    // chunk opens a fresh record. Carrying the partial across would glue the
    // two together and destroy both.
    const blob = await parse({
      [DICT_SECTION]: ['0\tsome/path/here', '1\tb\n'],
    });
    expect(blob.dict.get(0)).toEqual('some/path/here');
    expect(blob.dict.get(1)).toEqual('b');
    expect(blob.dict.size).toEqual(2);
  });

  it('parses newline-terminated chunks too', async () => {
    // The shape dune emits now: every chunk ends in a newline. Closing each
    // chunk off has to be a no-op here rather than inventing a blank entry.
    const blob = await parse({[DICT_SECTION]: ['0\ta\n', '1\tb\n']});
    expect(blob.dict.get(0)).toEqual('a');
    expect(blob.dict.get(1)).toEqual('b');
    expect(blob.dict.size).toEqual(2);
  });
});

describe('parseGraphBlob - graph-rules', () => {
  it('parses a complete executed-rule line', async () => {
    const blob = await parse({
      [RULES_SECTION]: '412\t6\t7,8\t9\tX\td5\t84\t12|13\n',
    });
    expect(blob.rules).toEqual([
      {
        ruleId: 412,
        dirId: 6,
        targetFileIds: [7, 8],
        targetDirIds: [9],
        outcome: 'executed',
        forcedBy: {kind: 'DEP', depId: 5},
        // One set id, not a dep list; likewise one set id per dyn stage.
        depSet: 84,
        depsUnknown: false,
        dynDepStages: [12, 13],
      },
    ]);
  });

  it.each([
    ['X', 'executed'],
    ['L', 'local-cache-hit'],
    ['S', 'shared-cache-hit'],
    ['D', 'failed-deps'],
    ['A', 'failed-action'],
    ['C', 'cancelled'],
    ['?', 'unfinished'],
  ] as const)('maps outcome %s to %s', async (code, expected) => {
    const blob = await parse({[RULES_SECTION]: `0\t\t\t\t${code}\t\t\t\n`});
    expect(blob.rules[0].outcome).toEqual(expected);
  });

  it('parses an unfinished rule line (crash/interrupt flush)', async () => {
    const blob = await parse({[RULES_SECTION]: '281\t6\t7\t\t?\td5\t\t\n'});
    expect(blob.rules[0]).toEqual({
      ruleId: 281,
      dirId: 6,
      targetFileIds: [7],
      targetDirIds: [],
      outcome: 'unfinished',
      forcedBy: {kind: 'DEP', depId: 5},
      // An unfinished span carries an *empty* `<dep_set>`, not `?`: dune never
      // got as far as knowing, but it isn't claiming it couldn't tell either.
      depSet: undefined,
      depsUnknown: false,
      dynDepStages: [],
    });
  });

  // `?` and empty both yield no dep ids, so the flag is the only thing that
  // tells "dune couldn't determine them" apart from "there are none".
  it('distinguishes unknown deps from no deps', async () => {
    const blob = await parse({
      [RULES_SECTION]: '1\t\t\t\tD\t\t?\t\n2\t\t\t\tX\t\t\t\n',
    });
    expect(blob.rules.map((r) => [r.depSet, r.depsUnknown])).toEqual([
      [undefined, true],
      [undefined, false],
    ]);
  });

  it('parses the deps a failed rule did recover', async () => {
    const blob = await parse({[RULES_SECTION]: '1\t\t\t\tD\t\t45\t\n'});
    expect(blob.rules[0].depSet).toBe(45);
    expect(blob.rules[0].depsUnknown).toBe(false);
  });

  // The trap this whole field walks past: set ids are allocated from 0, so an
  // empty `<dep_set>` coerced to a number would hand every dep-free rule set
  // 0's dependencies.
  it('reads an empty dep_set as no set, never as set 0', async () => {
    const blob = await parse({
      [RULES_SECTION]: '1\t\t\t\tX\t\t\t\n2\t\t\t\tX\t\t0\t\n',
    });
    expect(blob.rules[0].depSet).toBeUndefined();
    expect(blob.rules[0].depsUnknown).toBe(false);
    // ...and set 0 itself is a real set, not the absent one.
    expect(blob.rules[1].depSet).toBe(0);
  });

  // Whether the set exists is the builder's business; the parser reports what
  // the line said.
  it('passes a dep_set through without checking that the set exists', async () => {
    const blob = await parse({
      [DEPSETS_SECTION]: '0\t\t7\n',
      [RULES_SECTION]: '1\t\t\t\tX\t\t9\t\n',
    });
    expect(blob.rules[0].depSet).toBe(9);
  });

  it('reads a malformed dep_set as no set rather than as a truncation', async () => {
    // A comma is what the field used to hold; it is malformed input now.
    const blob = await parse({[RULES_SECTION]: '1\t\t\t\tX\t\t4,5\t\n'});
    expect(blob.rules[0].depSet).toBeUndefined();
    expect(blob.rules[0].depsUnknown).toBe(false);
  });

  it('parses a forced-by tag naming a rule recovering its deps', async () => {
    const blob = await parse({[RULES_SECTION]: '1\t\t\t\tX\tv77\t\t\n'});
    expect(blob.rules[0].forcedBy).toEqual({
      kind: 'RULE_RECOVERY',
      ruleId: 77,
    });
  });

  it('parses an empty dyn_dep_stages field as no stages', async () => {
    const blob = await parse({[RULES_SECTION]: '0\t1\t2\t\tX\t\t\t\n'});
    expect(blob.rules[0].dynDepStages).toEqual([]);
  });

  // Stages are numbered by position, so an empty one has to keep its slot -
  // dropping it would renumber every stage after it.
  it('keeps an empty dyn_dep stage as a slot with no set', async () => {
    const blob = await parse({[RULES_SECTION]: '0\t\t\t\tX\t\t\t3||5\n'});
    expect(blob.rules[0].dynDepStages).toEqual([3, undefined, 5]);
  });

  it('reads stage 0 as a set id, not as an empty stage', async () => {
    const blob = await parse({[RULES_SECTION]: '0\t\t\t\tX\t\t\t0|1\n'});
    expect(blob.rules[0].dynDepStages).toEqual([0, 1]);
  });

  it('reads a comma inside a stage as malformed, not as a list', async () => {
    const blob = await parse({[RULES_SECTION]: '0\t\t\t\tX\t\t\t3,4|5\n'});
    expect(blob.rules[0].dynDepStages).toEqual([undefined, 5]);
  });

  it('leaves dirId undefined when the field is empty', async () => {
    const blob = await parse({[RULES_SECTION]: '0\t\t\t\tX\t\t\t\n'});
    expect(blob.rules[0].dirId).toBeUndefined();
  });

  it.each([
    ['r99', {kind: 'RULE', ruleId: 99}],
    ['d7', {kind: 'DEP', depId: 7}],
    ['i3', {kind: 'DYNAMIC_INCLUDES', pathId: 3}],
    ['g4', {kind: 'GEN_RULES', pathId: 4}],
    ['p5', {kind: 'PFORM', pathId: 5}],
    ['c', {kind: 'CONFIGURATOR'}],
    ['q', {kind: 'REQUEST'}],
  ] as const)('parses forced_by tag %s', async (tag, expected) => {
    const blob = await parse({[RULES_SECTION]: `0\t\t\t\tX\t${tag}\t\t\n`});
    expect(blob.rules[0].forcedBy).toEqual(expected);
  });

  it('degrades an unrecognised forced_by tag to UNKNOWN rather than throwing', async () => {
    const blob = await parse({[RULES_SECTION]: '0\t\t\t\tX\tz123\t\t\n'});
    expect(blob.rules[0].forcedBy).toEqual({kind: 'UNKNOWN'});
  });

  it('leaves forced_by undefined when the field is empty', async () => {
    const blob = await parse({[RULES_SECTION]: '0\t\t\t\tX\t\t\t\n'});
    expect(blob.rules[0].forcedBy).toBeUndefined();
  });

  it('closes the record when a chunk ends without a newline', async () => {
    // Split between the two lines, with the separator dropped - the shape the
    // exporter actually emits. Both rules must survive, and in particular the
    // first must keep its own set id rather than absorbing the second line.
    const blob = await parse({
      [RULES_SECTION]: [
        '412\t6\t7,8\t9\tX\td5\t184\t12|13',
        '7\t\t\t\tL\t\t9\t\n',
      ],
    });
    expect(blob.rules.map((r) => r.ruleId)).toEqual([412, 7]);
    expect(blob.rules[0].depSet).toBe(184);
    expect(blob.rules[1].depSet).toBe(9);
  });

  it('parses newline-terminated chunks too', async () => {
    const blob = await parse({
      [RULES_SECTION]: [
        '412\t6\t7,8\t9\tX\td5\t184\t12|13\n',
        '7\t\t\t\tL\t\t9\t\n',
      ],
    });
    expect(blob.rules.map((r) => r.ruleId)).toEqual([412, 7]);
    expect(blob.rules[0].depSet).toBe(184);
    expect(blob.rules[1].depSet).toBe(9);
  });

  it('parses a final record with no trailing newline', async () => {
    const blob = await parse({[RULES_SECTION]: '0\t\t\t\tX\t\t\t'});
    expect(blob.rules.map((r) => r.ruleId)).toEqual([0]);
  });
});

describe('parseGraphBlob - graph-cores', () => {
  it('parses a core and its members', async () => {
    const blob = await parse({[CORES_SECTION]: '0\t1,2,3\n1\t4,5\n'});
    expect(blob.cores).toEqual([
      {coreId: 0, depIds: [1, 2, 3]},
      {coreId: 1, depIds: [4, 5]},
    ]);
  });

  it('parses a single-member core, and a chunk ending without a newline', async () => {
    const blob = await parse({[CORES_SECTION]: ['0\t7', '1\t123,9\n']});
    expect(blob.cores).toEqual([
      {coreId: 0, depIds: [7]},
      {coreId: 1, depIds: [123, 9]},
    ]);
  });

  it('skips a line with no member field, or no usable core id', async () => {
    const blob = await parse({[CORES_SECTION]: 'garbage\nx\t1\n2\t1\n'});
    expect(blob.cores).toEqual([{coreId: 2, depIds: [1]}]);
  });
});

describe('parseGraphBlob - graph-depsets', () => {
  it('parses a cored set and an uncored one', async () => {
    const blob = await parse({[DEPSETS_SECTION]: '0\t\t1,2\n1\t3\t4\n'});
    expect(blob.sets).toEqual([
      // An empty `<core_id>` means no core - the set is exactly its adds.
      {setId: 0, coreId: undefined, addIds: [1, 2]},
      {setId: 1, coreId: 3, addIds: [4]},
    ]);
  });

  // Cores are allocated from 0 up, so `0` in this field is a real core and an
  // empty field is not it.
  it('keeps core 0 apart from no core at all', async () => {
    const blob = await parse({[DEPSETS_SECTION]: '0\t0\t1\n1\t\t2\n'});
    expect(blob.sets.map((s) => s.coreId)).toEqual([0, undefined]);
  });

  it('parses an empty add list without falling over', async () => {
    // The encoder never writes this (a core is a strict subset of its set), but
    // it must not take the line - or the section - down.
    const blob = await parse({[DEPSETS_SECTION]: '0\t2\t\n1\t\t5\n'});
    expect(blob.sets).toEqual([
      {setId: 0, coreId: 2, addIds: []},
      {setId: 1, coreId: undefined, addIds: [5]},
    ]);
  });

  it('skips a line with too few fields, or no usable set id', async () => {
    const blob = await parse({
      [DEPSETS_SECTION]: '0\t1\nx\t\t1\n3\t\t1\n',
    });
    expect(blob.sets).toEqual([{setId: 3, coreId: undefined, addIds: [1]}]);
  });

  it('closes the record when a chunk ends without a newline', async () => {
    const blob = await parse({[DEPSETS_SECTION]: ['0\t\t1,23', '1\t4\t5\n']});
    expect(blob.sets).toEqual([
      {setId: 0, coreId: undefined, addIds: [1, 23]},
      {setId: 1, coreId: 4, addIds: [5]},
    ]);
  });
});

describe('parseGraphBlob - section order', () => {
  // `graph_build.ts` expands a rule's dep set as the rule arrives, so every
  // core and set has to be in by then. The parser owns this order.
  it('hands over the dict, then cores, then sets, then rules, then deps', async () => {
    const blob = await parse({
      [DEPS_SECTION]: '1\ts\t\t\n',
      [RULES_SECTION]: '1\t\t\t\tX\t\t0\t\n',
      [DEPSETS_SECTION]: '0\t0\t2\n',
      [CORES_SECTION]: '0\t1\n',
      [DICT_SECTION]: '0\ta\n',
    });
    expect(blob.order).toEqual(['strings', 'core', 'depSet', 'rule', 'dep']);
  });
});

describe('parseGraphBlob - graph-deps', () => {
  it('parses a source dep forced by a rule', async () => {
    const blob = await parse({[DEPS_SECTION]: '9\ts\tr281\t\n'});
    expect(blob.deps).toEqual([
      {
        depId: 9,
        resolution: {kind: 'source'},
        forcedBy: {kind: 'RULE', ruleId: 281},
        status: 'ok',
      },
    ]);
  });

  it('parses a dep resolved to a rule', async () => {
    const blob = await parse({[DEPS_SECTION]: '11\tr314\tr281\t\n'});
    expect(blob.deps[0].resolution).toEqual({kind: 'rule', ruleId: 314});
  });

  it('parses a dep resolved to an expansion list', async () => {
    const blob = await parse({[DEPS_SECTION]: '3\tx1,2,3\tc\t\n'});
    expect(blob.deps[0].resolution).toEqual({
      kind: 'expanded',
      depIds: [1, 2, 3],
    });
  });

  it('parses an unfinished dep line', async () => {
    const blob = await parse({[DEPS_SECTION]: '5\t?\td2\t\n'});
    expect(blob.deps[0].resolution).toEqual({kind: 'unfinished'});
  });

  it.each([
    ['', 'ok'],
    ['f', 'failed'],
    ['c', 'cancelled'],
  ] as const)('maps status "%s" to %s', async (code, expected) => {
    const blob = await parse({[DEPS_SECTION]: `5\ts\t\t${code}\n`});
    expect(blob.deps[0].status).toEqual(expected);
  });

  // `u` is dune saying it couldn't tell; `?` is the span never having ended.
  // The two mean different things, so they must not collapse together.
  it('distinguishes an unknown resolution from an unfinished one', async () => {
    const blob = await parse({[DEPS_SECTION]: '5\tu\t\tf\n6\t?\t\t\n'});
    expect(blob.deps.map((d) => [d.resolution.kind, d.status])).toEqual([
      ['unknown', 'failed'],
      ['unfinished', 'ok'],
    ]);
  });

  it('parses a failed dep that still resolved to a rule', async () => {
    const blob = await parse({[DEPS_SECTION]: '5\tr9\t\tf\n'});
    expect(blob.deps[0].resolution).toEqual({kind: 'rule', ruleId: 9});
    expect(blob.deps[0].status).toEqual('failed');
  });

  it('parses a forced-by tag naming a rule recovering its deps', async () => {
    const blob = await parse({[DEPS_SECTION]: '5\ts\tv77\t\n'});
    expect(blob.deps[0].forcedBy).toEqual({kind: 'RULE_RECOVERY', ruleId: 77});
  });

  // A trace written before `<status>` existed carries three fields at the same
  // blob version, and its deps all succeeded as far as the schema could say.
  it('reads a three-field line as a successful dep', async () => {
    const blob = await parse({[DEPS_SECTION]: '9\ts\tr281\n'});
    expect(blob.deps[0].status).toEqual('ok');
    expect(blob.deps[0].resolution).toEqual({kind: 'source'});
  });
});

describe('parseGraphBlob - missing sections', () => {
  it('treats an absent section as empty rather than throwing', async () => {
    const blob = await parse({[DICT_SECTION]: '0\ta\n'});
    expect(blob.cores).toEqual([]);
    expect(blob.sets).toEqual([]);
    expect(blob.rules).toEqual([]);
    expect(blob.deps).toEqual([]);
  });

  // A build whose dep sets were all too small to be worth a shared core emits
  // no `graph-cores` instants at all. That is the normal shape for a small
  // project, not a truncated trace, and must never become an error.
  it('parses a blob with no graph-cores section at all', async () => {
    const blob = await parse({
      [DICT_SECTION]: '0\ta\n1\tb\n',
      [DEPSETS_SECTION]: '0\t\t0,1\n',
      [RULES_SECTION]: '7\t\t\t\tX\t\t0\t\n',
    });
    expect(blob.cores).toEqual([]);
    expect(blob.sets).toEqual([{setId: 0, coreId: undefined, addIds: [0, 1]}]);
    expect(blob.rules[0].depSet).toBe(0);
  });
});
