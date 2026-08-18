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
import {makeColorScheme} from '../../components/colorizer';
import {SliceTrack} from '../../components/tracks/slice_track';
import type {TrackRenderer} from '../../public/track';
import type {Trace} from '../../public/trace';
import {SourceDataset} from '../../trace_processor/dataset';
import {LONG, NUM, STR} from '../../trace_processor/query_result';
import {sqlValueToSqliteString} from '../../trace_processor/sql_utils';
import type {DuneGraphController} from './controller';
import type {NodeKind} from './graph';
import {decorateNode} from './node_display';

// URI/name of the single derived track projecting the graph pane's visible
// nodes onto the timeline (see controller.ts's installTimeline()).
export const GRAPH_TRACK_URI = 'com.karmios.nat.DuneGraph#GraphNodes';
export const GRAPH_TRACK_NAME = 'Dune graph';

// Fixed colours for the two node kinds, matching the dep/rule chips and dots
// in styles.scss (--pf-color-accent / --pf-color-warning). Canvas slices
// can't read CSS vars, so the values are duplicated here - keep in sync.
// --pf-color-warning differs slightly between themes; this uses the light
// theme's value since the colour is baked into the track's cached data frame
// and can't react to a theme switch. Keyed by `kind` (not slice name, which is
// now the node's own label, not a fixed track name like "exec-rule").
const KIND_COLORS = new Map<NodeKind, ColorScheme>([
  ['dep', makeColorScheme(new HSLColor('#2667e7'))],
  ['rule', makeColorScheme(new HSLColor('#e89e00'))],
]);

interface Row {
  readonly id: number;
  readonly ts: bigint;
  readonly dur: bigint;
  readonly name: string;
  readonly kind: string;
}

const SCHEMA = {id: NUM, ts: LONG, dur: LONG, name: STR, kind: STR};

// A row-shaped but rowless source, used while the SQL mirror the track reads
// doesn't exist yet. `where 0` rather than a query against `dune_node`, which
// isn't a table at that point.
const EMPTY_SRC =
  "select 0 as id, 0 as ts, 0 as dur, '' as name, '' as kind where 0";

/**
 * Builds the renderer for the "Dune graph" track: a slice track whose content
 * is exactly `controller.visibleNodes` (selection minus hidden-rules, see
 * graph_panel.ts), re-querying whenever that set changes.
 *
 * Reads the SQL mirror (`dune_node`, see sql_graph.ts) rather than `slice`
 * directly - graph spans are zero-width instants on their real tracks, so the
 * projection materializes real intervals from `dur_ns` instead. Row ids are
 * therefore `node_id`s, not slice ids - see controller.ts's `nodeForNodeId`/
 * `goToNode`, which key the derived track differently from a node's real
 * originating track for exactly this reason.
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
      // `dune_node` doesn't exist until the node mirror is built (the graph
      // no longer loads with the trace - see controller.ts), and querying a
      // missing table is an error, not an empty result. Project nothing at
      // all until it's there; the mirror bumps `graphVersion` when it lands,
      // which brings us straight back here.
      if (!controller.nodeMirrorReady) {
        cachedDataset = new SourceDataset({src: EMPTY_SRC, schema: SCHEMA});
        return cachedDataset;
      }
      const nodeIds = controller.visibleNodes;
      // SourceDataset's `filter: {col, in: []}` would emit `node_id IN ()`,
      // which is invalid SQLite - fall back to an always-false predicate
      // instead. `ts is not null` excludes a node whose timing never resolved
      // to a lifecycle instant (see sql_graph.ts's LEFT JOIN) - it has nothing
      // to project onto the timeline. `ifnull(dur_ns, -1)` is Perfetto's
      // "runs to end of trace" convention, exactly right for an unfinished
      // span (a `dur_ns`-less finish - see graph.ts's `SpanTiming`).
      const where =
        nodeIds.length === 0
          ? '0'
          : `ts is not null and node_id in (${sqlValueToSqliteString(nodeIds)})`;
      cachedDataset = new SourceDataset({
        src: `select node_id as id, ts, ifnull(dur_ns, -1) as dur, label as name, kind
              from dune_node where ${where}`,
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
      const node = controller.nodeForNodeId(row.id);
      if (node === undefined) return row.name;
      // Same text as everywhere else, minus the icon a canvas can't draw - and
      // with the kind spelled out for a rule, since there's no chip here.
      const {text} = decorateNode(controller.graph, node);
      return controller.graph.isRule(node) ? `rule ${text}` : text;
    },
    colorizer: (row: Row) =>
      KIND_COLORS.get(row.kind as NodeKind) ?? KIND_COLORS.get('dep')!,
  });
}
