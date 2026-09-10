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

import type {BuildGraph, NodeId} from '../model/graph';
import type {FamilyMembers, GraphTrackKind} from '../model/graph_tracks';

/**
 * What the timeline views need from whatever is driving them.
 *
 * `DuneGraphController` is the only implementation and satisfies this
 * structurally, without importing it. That is the point: the controller
 * registers the tracks, so if the tracks also named the controller the two
 * would import each other, and neither could be read - or tested - alone.
 * The consumer declaring what it needs is what breaks that, and it is why this
 * interface lives beside the views rather than beside the controller.
 *
 * Deliberately the *whole* of what the views touch and nothing more: eleven
 * members out of the controller's surface. Anything added here is a new
 * coupling and should have to justify itself.
 */
export interface GraphHost {
  /** The loaded graph, or the empty one before a load. */
  readonly graph: BuildGraph;

  /**
   * Bumped by every mutation that can change what a track shows. Tracks cache
   * their dataset against it rather than rebuilding per frame.
   */
  readonly graphVersion: number;

  /** Whether rule rows are being hidden, which changes what a track draws. */
  readonly hideRules: boolean;

  /** Whether the SQL mirror is up; until it is, a track has no rows to show. */
  readonly nodeMirrorReady: boolean;

  /** The nodes currently chosen for the graph pane. */
  readonly selectedNodes: readonly NodeId[];

  /** The node whose family is lit up under the cursor, if any. */
  readonly hoveredFamily: NodeId | undefined;

  /** The node a raw track row id names, if it names one. */
  nodeForNodeId(nodeId: number): NodeId | undefined;

  /** The rule a row belongs to, for the hover highlight. */
  familyOfRow(kind: GraphTrackKind, rowId: number): NodeId | undefined;

  /** Everything drawn as one family - the rule, its dep, its processes. */
  familyMembersOf(
    kind: GraphTrackKind,
    rowId: number,
  ): FamilyMembers | undefined;

  /** Light a family up, or clear it when called with no arguments. */
  setHoveredFamily(kind?: GraphTrackKind, rowId?: number): void;

  /** Move the timeline selection to a row on one of our tracks. */
  goToRow(kind: GraphTrackKind, rowId: number): void;
}
