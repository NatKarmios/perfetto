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

import {HSLColor} from '../../base/color';
import type {ColorScheme} from '../../base/color_scheme';
import {getColorForSlice, makeColorScheme} from '../../components/colorizer';
import {SliceTrack} from '../../components/tracks/slice_track';
import type {TrackRenderer} from '../../public/track';
import type {Trace} from '../../public/trace';
import {SourceDataset} from '../../trace_processor/dataset';
import {LONG, NUM, STR} from '../../trace_processor/query_result';
import {sqlValueToSqliteString} from '../../trace_processor/sql_utils';
import type {DuneGraphController} from './controller';
import {nodeLabel} from './graph';
import {decorateDepPath} from './node_display';
import {DEP_SLICE, RULE_SLICE} from './slice_args_graph_source';

// URI/name of the single derived track projecting the graph pane's visible
// nodes onto the timeline (see controller.ts's installTimeline()).
export const GRAPH_TRACK_URI = 'com.karmios.nat.DuneGraph#GraphNodes';
export const GRAPH_TRACK_NAME = 'Dune graph';

// Fixed colours for the two node kinds, matching the dep/rule chips and dots
// in styles.scss (--pf-color-accent / --pf-color-warning). Canvas slices
// can't read CSS vars, so the values are duplicated here - keep in sync.
// --pf-color-warning differs slightly between themes; this uses the light
// theme's value since the colour is baked into the track's cached data frame
// and can't react to a theme switch.
const SLICE_COLORS = new Map<string, ColorScheme>([
  [DEP_SLICE, makeColorScheme(new HSLColor('#2667e7'))],
  [RULE_SLICE, makeColorScheme(new HSLColor('#e89e00'))],
]);

interface Row {
  readonly id: number;
  readonly ts: bigint;
  readonly dur: bigint;
  readonly name: string;
}

const SCHEMA = {id: NUM, ts: LONG, dur: LONG, name: STR};

/**
 * Builds the renderer for the "Dune graph" track: a slice track whose content
 * is exactly `controller.visibleNodes` (selection minus hidden-rules, see
 * graph_panel.ts), re-querying whenever that set changes.
 *
 * The dataset is a closure memoized on `controller.graphVersion` - the version
 * is bumped by every mutation that can change the visible set (see
 * controller.ts), so this only rebuilds the SQL when it actually needs to,
 * even though SliceTrack calls the dataset getter every frame.
 */
export function createGraphTrackRenderer(
  trace: Trace,
  controller: DuneGraphController,
): TrackRenderer {
  let cachedVersion = -1;
  let cachedDataset: SourceDataset<typeof SCHEMA>;

  const dataset = (): SourceDataset<typeof SCHEMA> => {
    if (controller.graphVersion !== cachedVersion) {
      cachedVersion = controller.graphVersion;
      const sliceIds = controller.visibleNodes.map((n) => n.sliceId);
      // SourceDataset's `filter: {col, in: []}` would emit `id IN ()`, which is
      // invalid SQLite - fall back to an always-false predicate instead.
      const where =
        sliceIds.length === 0
          ? '0'
          : `id IN (${sqlValueToSqliteString(sliceIds)})`;
      cachedDataset = new SourceDataset({
        src: `select id, ts, dur, name from slice where ${where}`,
        schema: SCHEMA,
      });
    }
    return cachedDataset;
  };

  return SliceTrack.create<typeof SCHEMA>({
    trace,
    uri: GRAPH_TRACK_URI,
    dataset,
    // Deliberately no rootTableName: resolveSqlEvents() would then also match
    // this track for plain "slice" ids, racing with the node's original track
    // (see controller.ts's goToNode()).
    sliceName: (row: Row) => {
      const node = controller.nodeForSliceId(row.id);
      if (node === undefined) return row.name;
      return node.kind === 'dep'
        ? decorateDepPath(node.id).text
        : `rule ${nodeLabel(node)}`;
    },
    colorizer: (row: Row) =>
      SLICE_COLORS.get(row.name) ?? getColorForSlice(row.name),
  });
}
