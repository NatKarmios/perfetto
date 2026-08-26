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
 * The arrows that put the four tracks back together.
 *
 * The tracks are deliberately independent (see graph_track.ts), so the
 * relationship between their rows - a dep is built by a rule, a rule runs an
 * action, an action spawns processes - is drawn rather than encoded as nesting.
 * This is the same mechanism the Android plugins use for causally-related
 * events: `RelatedEventsOverlay` renders a list of {@link ArrowConnection}s,
 * each a pair of `{trackUri, ts, depth}` points.
 *
 * **Only the selected row's chain is drawn.** Drawing every chain at once
 * turned the timeline into a thicket and needed an arbitrary cap to stay
 * affordable; showing one chain instead is both legible and free.
 * So this is split in two: an {@link ArrowIndex} of where every row was laid
 * out, rebuilt when the *selection set* changes, and {@link arrowsForSelection},
 * which reads a handful of entries out of it on whatever row is selected right
 * now - cheap enough to run per frame, and synchronous, which the overlay
 * requires.
 *
 * **Where the depths come from.** An arrow has to land on the row the track
 * actually drew it on, and those rows are assigned by the core's
 * `internal_layout` inside the query SliceTrack generates. Rather than
 * reimplement that packing (and drift from it), the index runs the core's own
 * `generateRenderQuery` over the very same `SourceDataset` the track was given
 * and reads `id`, `ts` and `depth` straight back out - so the positions are
 * correct by construction. Omitting a depth is not a good fallback: the
 * visualiser then aims at the vertical centre of the whole track, which on a
 * track several rows deep points at nothing.
 */

import type {ArrowConnection} from '../../components/related_events/arrow_visualiser';
import {generateRenderQuery} from '../../components/tracks/slice_track';
import {Time} from '../../base/time';
import type {Engine} from '../../trace_processor/engine';
import {LONG, NUM} from '../../trace_processor/query_result';
import type {BuildGraph, NodeId} from './graph';
import type {GraphTrackKind} from './graph_track';
import {graphTrackDataset, graphTrackUri} from './graph_track';
import type {DuneGraphController} from './controller';

// Where one row ended up: its start, and the row it was packed onto.
interface RowPos {
  readonly ts: bigint;
  readonly depth: number;
}

// One track's rows, by the id the track keys them with (a `node_id` on the
// three node-backed tracks, a `slice.id` on the process track).
type TrackPositions = ReadonlyMap<number, RowPos>;

/**
 * Everything {@link arrowsForSelection} needs to answer synchronously: where
 * each row was drawn, and which rows belong together.
 */
export interface ArrowIndex {
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

const EMPTY_INDEX: ArrowIndex = {
  positions: new Map(),
  depByRule: new Map(),
  ruleByDep: new Map(),
  processesByRule: new Map(),
  ruleByProcess: new Map(),
  hideRules: false,
};

export function emptyArrowIndex(): ArrowIndex {
  return EMPTY_INDEX;
}

/** Builds the index for the current selection set. */
export async function buildArrowIndex(
  engine: Engine,
  controller: DuneGraphController,
): Promise<ArrowIndex> {
  if (!controller.nodeMirrorReady) return EMPTY_INDEX;
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
 * The whole chain the selected row belongs to: the dep that wanted the rule,
 * the rule, the action it ran and every process that action spawned. Selecting
 * any link lights all of them, so one click answers "what did building this
 * actually do" from either end.
 *
 * Every chain is built around exactly one rule, so this is really "find the
 * rule this row belongs to, then draw its chain". A dep that resolves to no
 * selected rule is in no chain and draws nothing.
 *
 * `eventId` is the row's id on its own track - a `node_id` on the three
 * node-backed tracks (a rule's action is filed under the rule), a `slice.id` on
 * the process track.
 */
export function arrowsForSelection(
  index: ArrowIndex,
  kind: GraphTrackKind,
  eventId: number,
): ArrowConnection[] {
  const rule = ruleOfRow(index, kind, eventId);
  if (rule === undefined) return [];

  const arrows: ArrowConnection[] = [];
  const link = (
    from: GraphTrackKind,
    fromId: number,
    to: GraphTrackKind,
    toId: number,
  ) => {
    const start = index.positions.get(from)?.get(fromId);
    const end = index.positions.get(to)?.get(toId);
    // A row can be missing legitimately: a node whose timing never resolved
    // projects no row at all (see graph_track.ts's `ts is not null`), and the
    // rule tracks project nothing while rules are hidden.
    if (start === undefined || end === undefined) return;
    arrows.push({
      start: {
        trackUri: graphTrackUri(from),
        ts: Time.fromRaw(start.ts),
        depth: start.depth,
      },
      end: {
        trackUri: graphTrackUri(to),
        ts: Time.fromRaw(end.ts),
        depth: end.depth,
      },
    });
  };

  const dep = index.depByRule.get(rule);
  const processes = index.processesByRule.get(rule) ?? [];
  if (index.hideRules) {
    // Both rule tracks are empty, and a connection to a track that isn't
    // rendered is silently dropped - so the chain shortens to dep -> process
    // rather than losing its middle and leaving the processes unattached.
    if (dep !== undefined) {
      for (const sliceId of processes) link('dep', dep, 'process', sliceId);
    }
    return arrows;
  }
  if (dep !== undefined) link('dep', dep, 'rule', rule);
  link('rule', rule, 'action', rule);
  for (const sliceId of processes) link('action', rule, 'process', sliceId);
  return arrows;
}

// The rule whose chain a row belongs to. The two rule tracks are keyed by the
// rule itself; a dep and a process each name one indirectly.
function ruleOfRow(
  index: ArrowIndex,
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
 * path), and one arrow per rule is enough to show where it came from.
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
