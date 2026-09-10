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
 * Which timeline tracks exist and what their uris are - the vocabulary, with
 * none of the rendering.
 *
 * Separate from graph_track.ts because three layers need to *name* a track
 * while only one draws it: the controller registers and seats them, the
 * details panel says which track a row came from, and the renderer itself is
 * the only thing that needs canvas. Keeping the names here is what stops the
 * panel and the renderer importing each other, and what lets the controller
 * reach the uris without reaching into views/.
 */

import type {NodeId} from './graph';

/** Which of the four tracks a row belongs to. */
export type GraphTrackKind = 'dep' | 'rule' | 'action' | 'process';

export interface GraphTrackSpec {
  readonly kind: GraphTrackKind;
  readonly uri: string;
  readonly name: string;
}

const URI_PREFIX = 'com.karmios.nat.DuneGraph#';

/**
 * The four tracks, in the order they are stacked - which is also the order the
 * arrows run in, so a chain reads downwards.
 *
 * `dep`'s uri is the one the old single track used, so a permalink or a saved
 * workspace that names it still resolves to something sensible.
 */
export const GRAPH_TRACKS: readonly GraphTrackSpec[] = [
  {kind: 'dep', uri: `${URI_PREFIX}GraphNodes`, name: 'dep'},
  {kind: 'rule', uri: `${URI_PREFIX}Rules`, name: 'rule'},
  {kind: 'action', uri: `${URI_PREFIX}Actions`, name: 'rule-action'},
  {kind: 'process', uri: `${URI_PREFIX}Processes`, name: 'process'},
];

const BY_KIND = new Map(GRAPH_TRACKS.map((t) => [t.kind, t]));
const BY_URI = new Map(GRAPH_TRACKS.map((t) => [t.uri, t]));

export function graphTrackUri(kind: GraphTrackKind): string {
  return graphTrackSpec(kind).uri;
}

// The whole spec, for the renderer, which needs the name as well as the uri.
export function graphTrackSpec(kind: GraphTrackKind): GraphTrackSpec {
  return BY_KIND.get(kind)!;
}

// The kind a track uri names, or undefined if it isn't one of ours. The test
// every navigation path needs, since a selection can land on any of the four
// (see controller.ts).
export function graphTrackKind(uri: string): GraphTrackKind | undefined {
  return BY_URI.get(uri)?.kind;
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
