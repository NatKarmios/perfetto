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
 * The details panel for a row of one of the four timeline tracks.
 *
 * Two things the stock SliceTrack panel can't do. A process row is projected
 * verbatim from a real slice (see process_sql.ts), and the interesting half of
 * one of those is its `debug.*` args - the program, its argv, the pid, the
 * rusage - so those are read back off the arg set the projection carries
 * across. And because the tracks are deliberately independent, the row's
 * family is not visible from where it is drawn: it is listed here instead, as
 * links, so one click gets from a dep to the processes its rule spawned.
 */

import m from 'mithril';
import {Icons} from '../../../base/semantic_icons';
import {Time} from '../../../base/time';
import {exists} from '../../../base/utils';
import {renderSliceArguments} from '../../../components/details/slice_args';
import type {ArgsDict} from '../../../components/sql_utils/args';
import {getArgs} from '../../../components/sql_utils/args';
import {asArgSetId} from '../../../components/sql_utils/core_types';
import {DurationWidget} from '../../../components/widgets/duration';
import {Timestamp} from '../../../components/widgets/timestamp';
import type {TrackEventDetailsPanel} from '../../../public/details_panel';
import type {Trace} from '../../../public/trace';
import {Anchor} from '../../../widgets/anchor';
import {DetailsShell} from '../../../widgets/details_shell';
import {GridLayout} from '../../../widgets/grid_layout';
import {Section} from '../../../widgets/section';
import {Tree, TreeNode} from '../../../widgets/tree';
import {LONG, NUM, STR, STR_NULL} from '../../../trace_processor/query_result';
import type {DuneGraphController} from '../controller';
import type {NodeId} from '../model/graph';
import type {GraphTrackKind} from './graph_track';
import {basename, decorateNode, formatDurNs} from './node_display';

// The row fields the panel reads. A subset of a track's schema (see
// graph_track.ts), spelled out here so the panel doesn't depend on the shape of
// the projection beyond what it actually shows.
interface GraphTrackRow {
  readonly id: number;
  readonly ts: bigint;
  readonly dur: bigint;
  // Only a process row has one: a node's or an action's span is reconstructed
  // from a *pair* of lifecycle instants, so there is no single arg set for it
  // to inherit.
  readonly arg_set_id?: number | null;
}

// One line of the family list.
interface Member {
  readonly kind: GraphTrackKind;
  readonly rowId: number;
  readonly label: string;
  // The node's untrimmed label, as a tooltip: a dep path's build-root prefix is
  // folded away in `label` (see `decorateDepPath`) and this list has no icon to
  // hold it, so the whole thing goes here instead. Absent for a process, whose
  // label is a program name rather than a node's.
  readonly title?: string;
  // A process's duration, shown because a rule that spawned several is usually
  // being read for which one was slow. Perfetto's -1 (a slice that never
  // finished) is left out rather than formatted as a negative time.
  readonly dur?: number;
}

export class GraphTrackDetailsPanel implements TrackEventDetailsPanel {
  private args?: ArgsDict;
  private members?: readonly Member[];

  constructor(
    private readonly trace: Trace,
    private readonly controller: DuneGraphController,
    private readonly kind: GraphTrackKind,
    private readonly row: GraphTrackRow,
    // The row's display name, resolved the same way the canvas resolves it -
    // the projection's own `name` column is a placeholder for the rows whose
    // label comes from the node behind them (see graph_track.ts).
    private readonly name: string,
  ) {}

  async load(): Promise<void> {
    await Promise.all([this.loadArgs(), this.loadFamily()]);
  }

  private async loadArgs(): Promise<void> {
    const argSetId = this.row.arg_set_id;
    if (!exists(argSetId)) return;
    this.args = await getArgs(this.trace.engine, asArgSetId(argSetId));
  }

  // The family's rows, as the list of links. Only the process members need a
  // query: a node's label is in the graph already, while a process is a real
  // slice whose name (and the program behind it) live in the trace.
  private async loadFamily(): Promise<void> {
    const family = this.controller.familyMembersOf(this.kind, this.row.id);
    if (family === undefined) return;
    const {graph} = this.controller;
    // A node member's row id *is* its node id for all three kinds, so a member
    // is entirely determined by the kind it stands for and the node behind it.
    const nodeMember = (kind: GraphTrackKind, node: NodeId): Member => ({
      kind,
      rowId: node,
      label: decorateNode(graph, node).text,
      title: graph.labelOf(node),
    });
    const members: Member[] = [];
    if (family.dep !== undefined) {
      members.push(nodeMember('dep', family.dep));
    }
    if (family.hasRule) {
      members.push(nodeMember('rule', family.rule));
    }
    if (family.hasAction) {
      members.push(nodeMember('action', family.rule));
    }
    for (const p of await this.processLabels(family.processes)) {
      members.push(p);
    }
    this.members = members;
  }

  // A process row's label: the program it ran, which is what distinguishes one
  // of a rule's processes from another - every one of them is named `process`.
  private async processLabels(sliceIds: readonly number[]): Promise<Member[]> {
    if (sliceIds.length === 0) return [];
    const result = await this.trace.engine.query(`
      SELECT s.id AS id, s.name AS name, s.dur AS dur,
        extract_arg(s.arg_set_id, 'debug.prog') AS prog
      FROM slice s WHERE s.id IN (${sliceIds.join(', ')})
      ORDER BY s.ts
    `);
    const members: Member[] = [];
    const it = result.iter({id: NUM, name: STR, dur: LONG, prog: STR_NULL});
    for (; it.valid(); it.next()) {
      members.push({
        kind: 'process',
        rowId: it.id,
        label: basename(it.prog ?? undefined) ?? it.name,
        dur: it.dur >= 0n ? Number(it.dur) : undefined,
      });
    }
    return members;
  }

  render(): m.Children {
    const {ts, dur} = this.row;
    return m(
      DetailsShell,
      {title: 'Dune graph'},
      m(
        GridLayout,
        m(
          Section,
          {title: 'Details'},
          m(Tree, [
            m(TreeNode, {left: 'Name', right: this.name}),
            m(TreeNode, {left: 'Kind', right: this.kind}),
            m(TreeNode, {
              left: 'Start time',
              right: m(Timestamp, {trace: this.trace, ts: Time.fromRaw(ts)}),
            }),
            m(TreeNode, {
              left: 'Duration',
              right: m(DurationWidget, {trace: this.trace, dur}),
            }),
          ]),
        ),
        this.renderFamily(),
        this.args !== undefined &&
          m(
            Section,
            {title: 'Arguments'},
            m(Tree, renderSliceArguments(this.trace, this.args)),
          ),
      ),
    );
  }

  // The rest of the family, as links. The row you are looking at is listed too,
  // plainly rather than as a link, so the list reads as a whole and shows where
  // in it you are.
  private renderFamily(): m.Children {
    const members = this.members;
    if (members === undefined || members.length === 0) return undefined;
    return m(
      Section,
      {title: 'Family'},
      m(
        Tree,
        members.map((member) => {
          const current =
            member.kind === this.kind && member.rowId === this.row.id;
          // The label's own tooltip sits on an inner span, so it wins over the
          // link's "Select on the timeline" when the text itself is hovered.
          const label = m('span', {title: member.title}, member.label);
          return m(TreeNode, {
            left: member.kind,
            right: [
              current
                ? label
                : m(
                    Anchor,
                    {
                      icon: Icons.UpdateSelection,
                      title: 'Select on the timeline',
                      onclick: () =>
                        this.controller.goToRow(member.kind, member.rowId),
                    },
                    label,
                  ),
              member.dur !== undefined &&
                m('span.pf-dune-graph__status-dur', formatDurNs(member.dur)),
            ],
          });
        }),
      ),
    );
  }
}
