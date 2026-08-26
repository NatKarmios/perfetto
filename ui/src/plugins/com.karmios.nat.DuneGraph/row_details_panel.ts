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
 * The details panel for a row of the derived "Dune graph" track.
 *
 * SliceTrack's stock panel would do for a node or action row - it prints the
 * dataset's own columns and nothing else - but a process row is projected
 * verbatim from a real slice (see process_sql.ts), and the interesting half
 * of one of those is its `debug.*` args: the program, its argv, the pid, the
 * rusage. Those live on the original slice's arg set, so the projection carries
 * the `arg_set_id` across and this reads the args back off it, rendering them
 * with the same widget the core's slice panel uses.
 */

import m from 'mithril';
import {Time} from '../../base/time';
import {exists} from '../../base/utils';
import {renderSliceArguments} from '../../components/details/slice_args';
import type {ArgsDict} from '../../components/sql_utils/args';
import {getArgs} from '../../components/sql_utils/args';
import {asArgSetId} from '../../components/sql_utils/core_types';
import {DurationWidget} from '../../components/widgets/duration';
import {Timestamp} from '../../components/widgets/timestamp';
import type {TrackEventDetailsPanel} from '../../public/details_panel';
import type {Trace} from '../../public/trace';
import {DetailsShell} from '../../widgets/details_shell';
import {GridLayout} from '../../widgets/grid_layout';
import {Section} from '../../widgets/section';
import {Tree, TreeNode} from '../../widgets/tree';

// The row fields the panel reads. A subset of the track's schema (see
// graph_track.ts), spelled out here so the panel doesn't depend on the shape of
// the projection beyond what it actually shows.
export interface GraphTrackRow {
  readonly ts: bigint;
  readonly dur: bigint;
  readonly kind: string;
  readonly arg_set_id: number | null;
}

export class GraphTrackDetailsPanel implements TrackEventDetailsPanel {
  private args?: ArgsDict;

  constructor(
    private readonly trace: Trace,
    private readonly row: GraphTrackRow,
    // The row's display name, resolved the same way the canvas resolves it -
    // the projection's own `name` column is a placeholder for the rows whose
    // label comes from the node behind them (see graph_track.ts).
    private readonly name: string,
  ) {}

  async load(): Promise<void> {
    const argSetId = this.row.arg_set_id;
    // Only a process row has one: a node's or an action's span is
    // reconstructed from a pair of lifecycle instants, not projected from a
    // single slice, so there is no one arg set to inherit.
    if (!exists(argSetId)) return;
    this.args = await getArgs(this.trace.engine, asArgSetId(argSetId));
  }

  render(): m.Children {
    const {ts, dur, kind} = this.row;
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
            m(TreeNode, {left: 'Kind', right: kind}),
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
        this.args !== undefined &&
          m(
            Section,
            {title: 'Arguments'},
            m(Tree, renderSliceArguments(this.trace, this.args)),
          ),
      ),
    );
  }
}
