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
import type {DuneGraphController} from './controller';
import {dep, rule, testGraph} from './graph_test_helper';
import type {GraphTrackKind} from './graph_track';
import {
  GRAPH_TRACKS,
  graphTrackDataset,
  graphTrackKind,
  graphTrackUri,
} from './graph_track';

// Every navigation path resolves a selection by asking which of our tracks it
// is on, so the uri <-> kind mapping has to be total and exclusive.
describe('graphTrackKind', () => {
  test('round-trips every track', () => {
    for (const spec of GRAPH_TRACKS) {
      expect(graphTrackKind(graphTrackUri(spec.kind))).toBe(spec.kind);
    }
  });

  test('matches nothing else', () => {
    expect(graphTrackKind('dev.perfetto.Sched#cpu0')).toBeUndefined();
    expect(graphTrackKind('')).toBeUndefined();
  });

  test('keeps the four tracks in causal order', () => {
    // The arrows run down this order, so a chain reads top to bottom.
    expect(GRAPH_TRACKS.map((t) => t.kind)).toEqual([
      'dep',
      'rule',
      'action',
      'process',
    ]);
  });
});

// What each track puts in front of the query engine. Asserted on the generated
// SQL rather than on rows, since a unit test has no trace processor - what is
// interesting here is which nodes each track claims, and what "hide rules"
// does to that.
describe('graphTrackDataset', () => {
  const fixture = testGraph([
    dep('a/x.cmi', {resolvedRule: 'r1'}),
    dep('a/y.ml', {isSource: true}),
    rule('r1', {dir: 'a', targetFiles: ['x.cmi']}),
  ]);
  const {graph} = fixture;
  const id = (name: string) => fixture.id(name);
  const selected = () => [id('a/x.cmi'), id('a/y.ml'), id('r1')];

  const src = (kind: GraphTrackKind, hideRules = false, ready = true) => {
    const controller = {
      graph,
      graphVersion: 1,
      nodeMirrorReady: ready,
      hideRules,
      selectedNodes: selected(),
    } as unknown as DuneGraphController;
    // `src` is what the track hands the engine; the dataset wraps it.
    return (graphTrackDataset(controller, kind) as {src: string}).src;
  };

  test('the dep track claims the selected deps and no rules', () => {
    expect(src('dep')).toContain(
      `node_id in (${id('a/x.cmi')}, ${id('a/y.ml')})`,
    );
  });

  test('the rule track claims the selected rules', () => {
    expect(src('rule')).toContain(`node_id in (${id('r1')})`);
  });

  test('the action track reads the rules table, keyed by the rule', () => {
    const sql = src('action');
    expect(sql).toContain('from dune_rule');
    expect(sql).toContain('action_ts');
    expect(sql).toContain(`node_id in (${id('r1')})`);
  });

  test('the process track is keyed by the trace-side rule id', () => {
    // `_dune_process` knows nothing about the graph, so it joins on `rule_id`
    // rather than `node_id` (see process_sql.ts).
    expect(src('process')).toContain(
      `p.rule_id in (${graph.timingKeyOf(id('r1'))})`,
    );
  });

  test('hiding rules empties both rule tracks', () => {
    // `0` is the always-false predicate an empty id list compiles to - `IN ()`
    // is not valid SQLite.
    expect(src('rule', true)).toContain('and 0');
    expect(src('action', true)).toContain('and 0');
  });

  test('hiding rules leaves the deps and the processes alone', () => {
    // The whole point: a rule's processes are build activity in their own
    // right and do not go away with the rule.
    expect(src('process', true)).toContain(
      `p.rule_id in (${graph.timingKeyOf(id('r1'))})`,
    );
    expect(src('dep', true)).toContain(`node_id in (${id('a/x.cmi')}`);
  });

  test('projects nothing at all before the SQL mirror exists', () => {
    // `dune_node` isn't a table yet, and querying a missing one is an error
    // rather than an empty result.
    for (const spec of GRAPH_TRACKS) {
      expect(src(spec.kind, false, false)).not.toContain('dune_node');
    }
  });
});
