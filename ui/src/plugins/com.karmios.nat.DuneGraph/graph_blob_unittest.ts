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

import type {BlobChunk} from './graph_blob';
import {
  DEPS_SECTION,
  DICT_SECTION,
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
    const chunks = [chunk('graph-dict', 0, 2, 'a'), chunk('graph-dict', 3, 2, 'b')];
    expect(() => joinChunks('graph-dict', chunks)).toThrow(/missing/i);
  });

  it('throws on a dropped chunk (wrong count)', () => {
    const chunks = [chunk('graph-dict', 0, 2, 'a')];
    expect(() => joinChunks('graph-dict', chunks)).toThrow(/expected 2 chunks/i);
  });

  it('throws on a duplicate seq', () => {
    const chunks = [
      chunk('graph-dict', 0, 2, 'a'),
      chunk('graph-dict', 0, 2, 'b'),
    ];
    expect(() => joinChunks('graph-dict', chunks)).toThrow(/duplicate/i);
  });

  it('throws on an inconsistent total across chunks', () => {
    const chunks = [chunk('graph-dict', 0, 1, 'a'), chunk('graph-dict', 1, 2, 'b')];
    expect(() => joinChunks('graph-dict', chunks)).toThrow(/total/i);
  });
});

describe('parseGraphBlob - graph-dict', () => {
  it('round-trips escaped values (\\\\, \\t, \\n)', () => {
    const blob = parseGraphBlob(
      new Map([[DICT_SECTION, '0\tplain/path\n1\twith\\ttab\n2\twith\\nnewline\n3\tliteral\\\\backslash\n']]),
    );
    expect(blob.dict.get(0)).toEqual('plain/path');
    expect(blob.dict.get(1)).toEqual('with\ttab');
    expect(blob.dict.get(2)).toEqual('with\nnewline');
    expect(blob.dict.get(3)).toEqual('literal\\backslash');
  });

  it('splits only on the first tab, so an escaped-tab value is not mis-split', () => {
    const blob = parseGraphBlob(new Map([[DICT_SECTION, '0\ta\\tb\tc\n']]));
    // The line's only *unescaped* tab is the id/value separator; everything
    // after it - including the literal `\t` that decodes to a tab, and the
    // bare `\t` that separates "b" from "c" in the raw csexp string - is the
    // value.
    expect(blob.dict.get(0)).toEqual('a\tb\tc');
  });

  it('skips a line with no tab', () => {
    const blob = parseGraphBlob(new Map([[DICT_SECTION, 'garbage\n0\tok\n']]));
    expect(blob.dict.size).toEqual(1);
    expect(blob.dict.get(0)).toEqual('ok');
  });
});

describe('parseGraphBlob - graph-rules', () => {
  it('parses a complete executed-rule line', () => {
    const blob = parseGraphBlob(
      new Map([[RULES_SECTION, '412\t6\t7,8\t9\tX\td5\t1,2\t3,4|5\n']]),
    );
    expect(blob.rules).toEqual([
      {
        ruleId: '412',
        dirId: 6,
        targetFileIds: [7, 8],
        targetDirIds: [9],
        outcome: 'executed',
        forcedBy: {kind: 'DEP', depId: 5},
        depIds: [1, 2],
        dynDepStages: [[3, 4], [5]],
      },
    ]);
  });

  it.each([
    ['X', 'executed'],
    ['L', 'local-cache-hit'],
    ['S', 'shared-cache-hit'],
    ['?', 'unfinished'],
  ] as const)('maps outcome %s to %s', (code, expected) => {
    const blob = parseGraphBlob(
      new Map([[RULES_SECTION, `0\t\t\t\t${code}\t\t\t\n`]]),
    );
    expect(blob.rules[0].outcome).toEqual(expected);
  });

  it('parses an unfinished rule line (crash/interrupt flush)', () => {
    const blob = parseGraphBlob(
      new Map([[RULES_SECTION, '281\t6\t7\t\t?\td5\t\t\n']]),
    );
    expect(blob.rules[0]).toEqual({
      ruleId: '281',
      dirId: 6,
      targetFileIds: [7],
      targetDirIds: [],
      outcome: 'unfinished',
      forcedBy: {kind: 'DEP', depId: 5},
      depIds: [],
      dynDepStages: [],
    });
  });

  it('parses an empty dyn_dep_stages field as no stages', () => {
    const blob = parseGraphBlob(
      new Map([[RULES_SECTION, '0\t1\t2\t\tX\t\t\t\n']]),
    );
    expect(blob.rules[0].dynDepStages).toEqual([]);
  });

  it('leaves dirId undefined when the field is empty', () => {
    const blob = parseGraphBlob(
      new Map([[RULES_SECTION, '0\t\t\t\tX\t\t\t\n']]),
    );
    expect(blob.rules[0].dirId).toBeUndefined();
  });

  it.each([
    ['r99', {kind: 'RULE', ruleId: '99'}],
    ['d7', {kind: 'DEP', depId: 7}],
    ['i3', {kind: 'DYNAMIC_INCLUDES', pathId: 3}],
    ['g4', {kind: 'GEN_RULES', pathId: 4}],
    ['p5', {kind: 'PFORM', pathId: 5}],
    ['c', {kind: 'CONFIGURATOR'}],
    ['q', {kind: 'REQUEST'}],
  ] as const)('parses forced_by tag %s', (tag, expected) => {
    const blob = parseGraphBlob(
      new Map([[RULES_SECTION, `0\t\t\t\tX\t${tag}\t\t\n`]]),
    );
    expect(blob.rules[0].forcedBy).toEqual(expected);
  });

  it('degrades an unrecognised forced_by tag to UNKNOWN rather than throwing', () => {
    const blob = parseGraphBlob(
      new Map([[RULES_SECTION, '0\t\t\t\tX\tz123\t\t\n']]),
    );
    expect(blob.rules[0].forcedBy).toEqual({kind: 'UNKNOWN'});
  });

  it('leaves forced_by undefined when the field is empty', () => {
    const blob = parseGraphBlob(
      new Map([[RULES_SECTION, '0\t\t\t\tX\t\t\t\n']]),
    );
    expect(blob.rules[0].forcedBy).toBeUndefined();
  });
});

describe('parseGraphBlob - graph-deps', () => {
  it('parses a source dep forced by a rule', () => {
    const blob = parseGraphBlob(new Map([[DEPS_SECTION, '9\ts\tr281\n']]));
    expect(blob.deps).toEqual([
      {depId: 9, resolution: {kind: 'source'}, forcedBy: {kind: 'RULE', ruleId: '281'}},
    ]);
  });

  it('parses a dep resolved to a rule', () => {
    const blob = parseGraphBlob(new Map([[DEPS_SECTION, '11\tr314\tr281\n']]));
    expect(blob.deps[0].resolution).toEqual({kind: 'rule', ruleId: '314'});
  });

  it('parses a dep resolved to an expansion list', () => {
    const blob = parseGraphBlob(new Map([[DEPS_SECTION, '3\tx1,2,3\tc\n']]));
    expect(blob.deps[0].resolution).toEqual({kind: 'expanded', depIds: [1, 2, 3]});
  });

  it('parses an unfinished dep line', () => {
    const blob = parseGraphBlob(new Map([[DEPS_SECTION, '5\t?\td2\n']]));
    expect(blob.deps[0].resolution).toEqual({kind: 'unfinished'});
  });
});

describe('parseGraphBlob - missing sections', () => {
  it('treats an absent section as empty rather than throwing', () => {
    const blob = parseGraphBlob(new Map([[DICT_SECTION, '0\ta\n']]));
    expect(blob.rules).toEqual([]);
    expect(blob.deps).toEqual([]);
  });
});
