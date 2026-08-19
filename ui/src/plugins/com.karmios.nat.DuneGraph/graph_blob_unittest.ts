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
  DepRecord,
  GraphBlobSink,
  RuleRecord,
  SectionChunks,
  StringTable,
} from './graph_blob';
import {
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
  readonly rules: RuleRecord[] = [];
  readonly deps: DepRecord[] = [];

  strings(table: StringTable): void {
    this.dict = table;
  }

  rule(record: RuleRecord): void {
    this.rules.push(record);
  }

  dep(record: DepRecord): void {
    this.deps.push(record);
  }
}

// Most tests pass one chunk per section; passing an array splits the payload at
// a chosen point, which is how the chunk-boundary behaviour is exercised.
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

  it('reassembles a value split across a chunk boundary', async () => {
    const blob = await parse({
      [DICT_SECTION]: ['0\tsome/pa', 'th/here\n1\tb\n'],
    });
    expect(blob.dict.get(0)).toEqual('some/path/here');
    expect(blob.dict.get(1)).toEqual('b');
  });
});

describe('parseGraphBlob - graph-rules', () => {
  it('parses a complete executed-rule line', async () => {
    const blob = await parse({
      [RULES_SECTION]: '412\t6\t7,8\t9\tX\td5\t1,2\t3,4|5\n',
    });
    expect(blob.rules).toEqual([
      {
        ruleId: 412,
        dirId: 6,
        targetFileIds: [7, 8],
        targetDirIds: [9],
        outcome: 'executed',
        forcedBy: {kind: 'DEP', depId: 5},
        depIds: [1, 2],
        depsUnknown: false,
        dynDepStages: [[3, 4], [5]],
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
      depIds: [],
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
    expect(blob.rules.map((r) => [r.depIds, r.depsUnknown])).toEqual([
      [[], true],
      [[], false],
    ]);
  });

  it('parses the deps a failed rule did recover', async () => {
    const blob = await parse({[RULES_SECTION]: '1\t\t\t\tD\t\t4,5\t\n'});
    expect(blob.rules[0].depIds).toEqual([4, 5]);
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

  it('parses a record split across a chunk boundary', async () => {
    // Two rule lines, cut mid-way through the first one's dep list.
    const payload = '412\t6\t7,8\t9\tX\td5\t1,2\t3,4|5\n7\t\t\t\tL\t\t9\t\n';
    const cut = payload.indexOf('1,2') + 1;
    const blob = await parse({
      [RULES_SECTION]: [payload.slice(0, cut), payload.slice(cut)],
    });
    expect(blob.rules.map((r) => r.ruleId)).toEqual([412, 7]);
    expect(blob.rules[0].depIds).toEqual([1, 2]);
    expect(blob.rules[1].depIds).toEqual([9]);
  });

  it('parses a final record with no trailing newline', async () => {
    const blob = await parse({[RULES_SECTION]: '0\t\t\t\tX\t\t\t'});
    expect(blob.rules.map((r) => r.ruleId)).toEqual([0]);
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
    expect(blob.rules).toEqual([]);
    expect(blob.deps).toEqual([]);
  });
});
