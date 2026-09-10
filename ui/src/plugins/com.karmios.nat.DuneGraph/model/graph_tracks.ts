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
 * The timeline tracks' vocabulary - kinds, uris, names - with none of the
 * rendering, which is graph_track.ts. See README.md, *Layout*, for why the two
 * are separate files.
 */

import type {NodeId} from './graph';

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
 * These uris are a compatibility surface: a permalink or a saved workspace can
 * name one, so renaming one silently breaks it.
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

export function graphTrackSpec(kind: GraphTrackKind): GraphTrackSpec {
  return BY_KIND.get(kind)!;
}

// Undefined for a uri that isn't one of ours. The test every navigation path
// needs, since a selection can land on any of the four (see controller.ts).
export function graphTrackKind(uri: string): GraphTrackKind | undefined {
  return BY_URI.get(uri)?.kind;
}

/**
 * A family, as the rows that are actually *on* the tracks.
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
