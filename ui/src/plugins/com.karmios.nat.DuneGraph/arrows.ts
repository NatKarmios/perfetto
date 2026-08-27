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
 * affordable; showing one chain instead is both legible and free. The lookups
 * come out of the shared family index (see family.ts), so this stays
 * synchronous, which the overlay requires.
 */

import type {ArrowConnection} from '../../components/related_events/arrow_visualiser';
import {Time} from '../../base/time';
import type {FamilyIndex} from './family';
import {ruleOfRow} from './family';
import type {GraphTrackKind} from './graph_track';
import {graphTrackUri} from './graph_track';

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
  index: FamilyIndex,
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
