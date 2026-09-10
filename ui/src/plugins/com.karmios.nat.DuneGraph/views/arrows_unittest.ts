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

import {describe, expect, test} from 'vitest';
import {arrowsForSelection} from './arrows';
import type {FamilyIndex} from './family';
import {graphTrackUri} from './graph_track';

// Which arrows a given row lights up. The positions are stubbed - what matters
// here is which pairs get linked, not where they land; the depths come from the
// core's own layout query and are verified against a real trace instead.
describe('arrowsForSelection', () => {
  const DEP = 10;
  const RULE = 20;
  const PROC_A = 30;
  const PROC_B = 31;

  // Every row exists at a distinct timestamp, so an arrow's endpoints identify
  // themselves in the assertions below.
  const pos = (id: number) => [id, {ts: BigInt(id), depth: 0}] as const;
  const index = (hideRules: boolean): FamilyIndex => ({
    positions: new Map([
      ['dep', new Map([pos(DEP)])],
      ['rule', new Map([pos(RULE)])],
      ['action', new Map([pos(RULE)])],
      ['process', new Map([pos(PROC_A), pos(PROC_B)])],
    ]),
    depByRule: new Map([[RULE, DEP]]),
    ruleByDep: new Map([[DEP, RULE]]),
    processesByRule: new Map([[RULE, [PROC_A, PROC_B]]]),
    ruleByProcess: new Map([
      [PROC_A, RULE],
      [PROC_B, RULE],
    ]),
    hideRules,
  });

  // An arrow as `fromTrack:fromTs -> toTrack:toTs`.
  const hops = (arrows: ReturnType<typeof arrowsForSelection>) =>
    arrows.map(
      (a) =>
        `${name(a.start.trackUri)}:${a.start.ts} -> ` +
        `${name(a.end.trackUri)}:${a.end.ts}`,
    );
  const name = (uri: string) =>
    (['dep', 'rule', 'action', 'process'] as const).find(
      (k) => graphTrackUri(k) === uri,
    );

  // The whole chain, from whichever end you click.
  const CHAIN = [
    `dep:${DEP} -> rule:${RULE}`,
    `rule:${RULE} -> action:${RULE}`,
    `action:${RULE} -> process:${PROC_A}`,
    `action:${RULE} -> process:${PROC_B}`,
  ];

  test('lights the whole chain from the dep', () => {
    expect(hops(arrowsForSelection(index(false), 'dep', DEP))).toEqual(CHAIN);
  });

  test('lights the whole chain from the rule', () => {
    expect(hops(arrowsForSelection(index(false), 'rule', RULE))).toEqual(CHAIN);
  });

  test('lights the whole chain from the action', () => {
    expect(hops(arrowsForSelection(index(false), 'action', RULE))).toEqual(
      CHAIN,
    );
  });

  test('lights the whole chain from one process, siblings included', () => {
    // Selecting one process still shows what else that action spawned - the
    // chain is the unit, not the hop.
    expect(hops(arrowsForSelection(index(false), 'process', PROC_A))).toEqual(
      CHAIN,
    );
  });

  test('hiding rules shortens the chain to dep -> process', () => {
    // The rule tracks are empty, and a connection to a track that is not
    // rendered would be silently dropped - leaving the processes unattached.
    const shortened = [
      `dep:${DEP} -> process:${PROC_A}`,
      `dep:${DEP} -> process:${PROC_B}`,
    ];
    expect(hops(arrowsForSelection(index(true), 'dep', DEP))).toEqual(
      shortened,
    );
    expect(hops(arrowsForSelection(index(true), 'process', PROC_B))).toEqual(
      shortened,
    );
  });

  test('draws nothing for a row that is in no chain', () => {
    // A dep that resolves to no selected rule, and a slice that isn't one of
    // the projected processes.
    const bare: FamilyIndex = {...index(false), ruleByDep: new Map()};
    expect(arrowsForSelection(bare, 'dep', DEP)).toEqual([]);
    expect(arrowsForSelection(index(false), 'process', 999)).toEqual([]);
  });
});
