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
 * What belongs with what: the index every cross-track feature reads.
 *
 * The four timeline tracks are deliberately independent (see graph_track.ts),
 * so anything that relates their rows - the arrows between them, the hover
 * shading, the family list in the details panel - needs the same two answers:
 * which rows belong together, and where each one was drawn. A *family* is one
 * rule plus everything around it: the selected dep that resolves to it, its
 * action, and the processes that action spawned. Every family has exactly one
 * rule, so a rule id names a family.
 *
 * The index is rebuilt when the selection set changes; reading it is a map
 * lookup, which is what lets the callers stay synchronous (an overlay and a
 * per-frame colorizer both have to be).
 *
 * **Where the positions come from.** An arrow has to land on the row the track
 * actually drew, and those rows are assigned by the core's `internal_layout`
 * inside the query SliceTrack generates. Rather than reimplement that packing
 * (and drift from it), this runs the core's own `generateRenderQuery` over the
 * very same `SourceDataset` the track was given and reads `id`, `ts` and
 * `depth` straight back out - so the positions are correct by construction.
 */

import {generateRenderQuery} from '../../components/tracks/slice_track';
import type {Engine} from '../../trace_processor/engine';
import {LONG, NUM} from '../../trace_processor/query_result';
import type {BuildGraph, NodeId} from './graph';
import type {GraphTrackKind} from './graph_track';
import {graphTrackDataset} from './graph_track';
import type {DuneGraphController} from './controller';

// Where one row ended up: its start, and the row it was packed onto.
export interface RowPos {
  readonly ts: bigint;
  readonly depth: number;
}

// One track's rows, by the id the track keys them with (a `node_id` on the
// three node-backed tracks, a `slice.id` on the process track).
export type TrackPositions = ReadonlyMap<number, RowPos>;

/**
 * Everything the synchronous readers need: where each row was drawn, and which
 * rows belong together. See `arrowsForSelection` in arrows.ts, the hover
 * shading in graph_track.ts, and the family list in row_details_panel.ts.
 */
export interface FamilyIndex {
  readonly positions: ReadonlyMap<GraphTrackKind, TrackPositions>;
  // Rule node -> the selected dep that resolves to it, and back.
  readonly depByRule: ReadonlyMap<NodeId, NodeId>;
  readonly ruleByDep: ReadonlyMap<NodeId, NodeId>;
  // Rule node -> the process slices its action spawned, and back.
  readonly processesByRule: ReadonlyMap<NodeId, readonly number[]>;
  readonly ruleByProcess: ReadonlyMap<number, NodeId>;
  // Whether the rule tracks were empty when this was built - the arrows have
  // to route around them (a connection to a track that isn't rendered is
  // silently dropped by the visualiser, which would leave processes
  // unattached).
  readonly hideRules: boolean;
}

const EMPTY_FAMILY_INDEX: FamilyIndex = {
  positions: new Map(),
  depByRule: new Map(),
  ruleByDep: new Map(),
  processesByRule: new Map(),
  ruleByProcess: new Map(),
  hideRules: false,
};

export function emptyFamilyIndex(): FamilyIndex {
  return EMPTY_FAMILY_INDEX;
}

/** Builds the index for the current selection set. */
export async function buildFamilyIndex(
  engine: Engine,
  controller: DuneGraphController,
): Promise<FamilyIndex> {
  if (!controller.nodeMirrorReady) return EMPTY_FAMILY_INDEX;
  const graph = controller.graph;
  const hideRules = controller.hideRules;

  const kinds: GraphTrackKind[] = hideRules
    ? ['dep', 'process']
    : ['dep', 'rule', 'action', 'process'];
  const positions = new Map<GraphTrackKind, TrackPositions>();
  for (const kind of kinds) {
    positions.set(kind, await trackPositions(engine, controller, kind));
  }

  const depByRule = resolvingDeps(graph, controller.selectedNodes);
  const ruleByDep = new Map<NodeId, NodeId>();
  for (const [rule, dep] of depByRule) ruleByDep.set(dep, rule);

  const byRuleId = new Map<number, NodeId>();
  for (const node of controller.selectedNodes) {
    if (graph.isRule(node)) byRuleId.set(graph.timingKeyOf(node), node);
  }
  const processesByRule = new Map<NodeId, number[]>();
  const ruleByProcess = new Map<number, NodeId>();
  for (const [sliceId, ruleId] of await processRules(engine, controller)) {
    const rule = byRuleId.get(ruleId);
    if (rule === undefined) continue;
    ruleByProcess.set(sliceId, rule);
    const list = processesByRule.get(rule);
    if (list === undefined) processesByRule.set(rule, [sliceId]);
    else list.push(sliceId);
  }

  return {
    positions,
    depByRule,
    ruleByDep,
    processesByRule,
    ruleByProcess,
    hideRules,
  };
}

/**
 * A family, as the rows that are actually on the tracks: the rule it is named
 * for, the dep filed under it (when one is selected), whether the rule ran an
 * action, and every process that action spawned.
 *
 * Membership is checked against `positions` rather than assumed, so this lists
 * only rows that exist: a cache-hit rule ran no action, a node whose timing
 * never resolved projects nothing, and the rule tracks are empty while rules
 * are hidden.
 */
export interface FamilyMembers {
  readonly rule: NodeId;
  readonly hasRule: boolean;
  readonly dep?: NodeId;
  readonly hasAction: boolean;
  readonly processes: readonly number[];
}

/** The family the given row belongs to, or undefined if it is in none. */
export function familyMembers(
  index: FamilyIndex,
  kind: GraphTrackKind,
  rowId: number,
): FamilyMembers | undefined {
  const rule = ruleOfRow(index, kind, rowId);
  if (rule === undefined) return undefined;
  const dep = index.depByRule.get(rule);
  return {
    rule,
    hasRule: index.positions.get('rule')?.has(rule) ?? false,
    dep:
      dep !== undefined && index.positions.get('dep')?.has(dep)
        ? dep
        : undefined,
    hasAction: index.positions.get('action')?.has(rule) ?? false,
    processes: index.processesByRule.get(rule) ?? [],
  };
}

// The rule whose family a row belongs to. The two rule tracks are keyed by the
// rule itself; a dep and a process each name one indirectly.
export function ruleOfRow(
  index: FamilyIndex,
  kind: GraphTrackKind,
  eventId: number,
): NodeId | undefined {
  switch (kind) {
    case 'dep':
      return index.ruleByDep.get(eventId);
    case 'rule':
    case 'action':
      return eventId;
    case 'process':
      return index.ruleByProcess.get(eventId);
  }
}

/**
 * Which selected dep resolves to each selected rule. First dep wins: a rule can
 * be resolved to by several deps (the same output reached by more than one
 * path), and one link per rule is enough to show where it came from.
 */
export function resolvingDeps(
  graph: BuildGraph,
  selected: readonly NodeId[],
): ReadonlyMap<NodeId, NodeId> {
  const inSelection = new Set(selected);
  const byRule = new Map<NodeId, NodeId>();
  for (const dep of selected) {
    if (graph.isRule(dep)) continue;
    const rule = graph.resolvedRuleOf(dep);
    if (rule === undefined || !inSelection.has(rule) || byRule.has(rule)) {
      continue;
    }
    byRule.set(rule, dep);
  }
  return byRule;
}

// One track's laid-out rows, read back through the core's own render query so
// the depths match what was drawn (see the file header).
async function trackPositions(
  engine: Engine,
  controller: DuneGraphController,
  kind: GraphTrackKind,
): Promise<TrackPositions> {
  const dataset = graphTrackDataset(controller, kind);
  const rows = await engine.query(`
    select id, ts, depth from (${generateRenderQuery(dataset)})
  `);
  const positions = new Map<number, RowPos>();
  const it = rows.iter({id: NUM, ts: LONG, depth: NUM});
  for (; it.valid(); it.next()) {
    positions.set(it.id, {ts: it.ts, depth: it.depth});
  }
  return positions;
}

// Each projected process slice and the rule that forced it, straight off the
// process track's own rows so the two can't disagree about which processes are
// on screen.
async function processRules(
  engine: Engine,
  controller: DuneGraphController,
): Promise<ReadonlyMap<number, number>> {
  const dataset = graphTrackDataset(controller, 'process');
  const rows = await engine.query(`
    select id, rule_id from (${dataset.query()})
  `);
  const bySlice = new Map<number, number>();
  const it = rows.iter({id: NUM, rule_id: NUM});
  for (; it.valid(); it.next()) bySlice.set(it.id, it.rule_id);
  return bySlice;
}
