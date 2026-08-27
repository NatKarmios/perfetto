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
 * The timeline projection of the graph selection: four tracks, one per kind of
 * row.
 *
 * `dep` and `rule` carry the selected nodes' own spans, `rule-action` each
 * selected rule's `exec-rule-action` span, and `process` every process slice
 * those actions spawned (see process_sql.ts). Every one is packed by the core's
 * `internal_layout` - none of them declares a `depth` column - so each behaves
 * like an ordinary slice track.
 *
 * **Why four fixed tracks rather than one track per selected thing.** A
 * Perfetto track is a stable container: a thread, a CPU, a job slot. Deriving
 * tracks from the selection instead made them churn on every add and remove,
 * needed a registration lifecycle, a cap on how many could exist and somewhere
 * to put whatever didn't fit. These four are registered once and live for the
 * trace; only their *contents* follow the selection, which is what a dataset
 * closure is for.
 *
 * What that gives up is the nesting - dep over its rule over its action over
 * its processes - which is real (all three containments are verified on
 * merlin's trace) but cannot be expressed by four independent tracks. That
 * relationship is drawn instead, as arrows, by the same overlay machinery the
 * Android plugins use for causally-related events: see arrows.ts.
 *
 * Row ids are per track, since they only have to be unique within one: a node's
 * `node_id` on the `dep`/`rule`/`rule-action` tracks (a rule's action is filed
 * under the rule), and a real `slice.id` on the `process` track.
 */

import {HSLColor} from '../../base/color';
import type {ColorScheme} from '../../base/color_scheme';
import {makeColorScheme} from '../../components/colorizer';
import {ColorVariant, SliceTrack} from '../../components/tracks/slice_track';
import type {TrackRenderer} from '../../public/track';
import type {Trace} from '../../public/trace';
import {SourceDataset} from '../../trace_processor/dataset';
import {LONG, NUM, NUM_NULL, STR} from '../../trace_processor/query_result';
import {sqlValueToSqliteString} from '../../trace_processor/sql_utils';
import type {DuneGraphController} from './controller';
import type {BuildGraph, NodeId} from './graph';
import {decorateNode} from './node_display';
import {PROCESS_TABLE} from './process_sql';
import {GraphTrackDetailsPanel} from './row_details_panel';

/** Which of the four tracks a row belongs to. */
export type GraphTrackKind = 'dep' | 'rule' | 'action' | 'process';

interface GraphTrackSpec {
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
  return BY_KIND.get(kind)!.uri;
}

// The kind a track uri names, or undefined if it isn't one of ours. The test
// every navigation path needs, since a selection can land on any of the four
// (see controller.ts).
export function graphTrackKind(uri: string): GraphTrackKind | undefined {
  return BY_URI.get(uri)?.kind;
}

// Fixed colours per track. The node kinds match the dep/rule chips and dots in
// styles.scss (--pf-color-accent / --pf-color-warning); canvas slices can't
// read CSS vars, so the values are duplicated here - keep in sync.
// --pf-color-warning differs slightly between themes; this uses the light
// theme's value since the colour is baked into the track's cached data frame
// and can't react to a theme switch. The action/process colours have no
// counterpart in the graph pane (neither is a node) and are picked here only to
// read as distinct from both node kinds.
const KIND_COLORS = new Map<GraphTrackKind, ColorScheme>([
  ['dep', makeColorScheme(new HSLColor('#2667e7'))],
  ['rule', makeColorScheme(new HSLColor('#e89e00'))],
  ['action', makeColorScheme(new HSLColor('#8b5cf6'))],
  ['process', makeColorScheme(new HSLColor('#6b7280'))],
]);

interface Row {
  readonly id: number;
  readonly ts: bigint;
  readonly dur: bigint;
  readonly name: string;
  // Only the process track has one: its rows are projected verbatim from a real
  // slice, so they inherit its args (see row_details_panel.ts). A node's or an
  // action's span is reconstructed from a *pair* of lifecycle instants, so
  // there is no single arg set for it to inherit.
  readonly arg_set_id?: number | null;
}

const NODE_SCHEMA = {id: NUM, ts: LONG, dur: LONG, name: STR};
// The process track additionally carries the arg set it inherits and the rule
// that forced it - the latter is what arrows.ts pairs a process row with its
// action (see buildArrows).
const PROCESS_SCHEMA = {...NODE_SCHEMA, arg_set_id: NUM_NULL, rule_id: NUM};

// A row-shaped but rowless source, used while the SQL mirror the tracks read
// doesn't exist yet. `where 0` rather than a query against `dune_node`, which
// isn't a table at that point.
const EMPTY_SRC =
  "select 0 as id, 0 as ts, 0 as dur, '' as name, " +
  '0 as arg_set_id, 0 as rule_id where 0';

/**
 * The rows one of the four tracks projects, as SQL - or undefined when it has
 * nothing to show.
 *
 * Exported because arrows.ts needs the very same rows to find out where each
 * one was laid out: it runs the core's own `generateRenderQuery` over this
 * dataset, so the depths it reads are by construction the depths the track drew
 * (see buildArrows).
 */
export function graphTrackDataset(
  controller: DuneGraphController,
  kind: GraphTrackKind,
): SourceDataset<typeof PROCESS_SCHEMA> | SourceDataset<typeof NODE_SCHEMA> {
  const src = controller.nodeMirrorReady
    ? trackSrc(controller, kind)
    : undefined;
  const schema = kind === 'process' ? PROCESS_SCHEMA : NODE_SCHEMA;
  return new SourceDataset({src: src ?? EMPTY_SRC, schema});
}

/**
 * Builds one of the four track renderers. Registered once each, for the
 * lifetime of the trace; the dataset closure is memoized on
 * `controller.graphVersion`, which every mutation that can change the selection
 * bumps, so the SQL is rebuilt only when it needs to be even though SliceTrack
 * calls the getter every frame.
 */
export function createGraphTrackRenderer(
  trace: Trace,
  controller: DuneGraphController,
  kind: GraphTrackKind,
): TrackRenderer {
  const spec = BY_KIND.get(kind)!;
  let cachedVersion = -1;
  let cached: SourceDataset<typeof NODE_SCHEMA>;

  const dataset = () => {
    if (controller.graphVersion !== cachedVersion) {
      cachedVersion = controller.graphVersion;
      cached = graphTrackDataset(controller, kind);
    }
    return cached;
  };

  return SliceTrack.create<typeof NODE_SCHEMA>({
    trace,
    uri: spec.uri,
    dataset,
    // Deliberately no rootTableName: resolveSqlEvents() would then also match
    // these tracks for plain "slice" ids, racing with a node's original track
    // (see controller.ts's goToNode()).
    sliceName: (row: Row) => sliceName(controller, kind, row),
    colorizer: () => KIND_COLORS.get(kind)!,
    // Hovering any row shades its whole family, across all four tracks. The
    // default (`highlightHoveredAndSameTitle`) would shade by *title*, which
    // happens to catch a rule and its action - they carry the same label - but
    // catches nothing else of the family and does catch unrelated slices that
    // share a name. Same shape as dev.perfetto.Sched's cpu_slice_track, which
    // shades by hovered thread/process.
    onUpdatedSlices: (slices) => {
      const rule = controller.hoveredFamily;
      const variants = new Array<ColorVariant>(slices.length);
      if (rule === undefined) return variants.fill(ColorVariant.BASE);
      for (let i = 0; i < slices.length; i++) {
        variants[i] =
          controller.familyOfRow(kind, slices[i].id) === rule
            ? ColorVariant.VARIANT
            : ColorVariant.BASE;
      }
      return variants;
    },
    onSliceOver: ({slice}) => controller.setHoveredFamily(kind, slice.id),
    onSliceOut: () => controller.setHoveredFamily(undefined, undefined),
    // Stock SliceTrack details plus the process track's inherited args (see
    // row_details_panel.ts). The name is resolved here rather than in the panel
    // so the two read identically to the label on the canvas.
    detailsPanel: (row: Row) =>
      new GraphTrackDetailsPanel(
        trace,
        controller,
        kind,
        row,
        sliceName(controller, kind, row),
      ),
  });
}

// ---------------------------------------------------------------------------
// What each track projects.
// ---------------------------------------------------------------------------

function trackSrc(
  controller: DuneGraphController,
  kind: GraphTrackKind,
): string {
  const graph = controller.graph;
  const selected = controller.selectedNodes;
  const deps = selected.filter((id) => !graph.isRule(id));
  const rules = selected.filter((id) => graph.isRule(id));
  switch (kind) {
    case 'dep':
      return depArm(deps);
    // "Hide rules" empties the two rule tracks but deliberately not the process
    // track: the processes a rule spawned are build activity in their own
    // right, and hiding the rule shouldn't take them with it.
    case 'rule':
      return depArm(controller.hideRules ? [] : rules);
    case 'action':
      return actionArm(controller.hideRules ? [] : rules);
    case 'process':
      return processArm(graph, rules);
  }
}

// `SourceDataset`'s `filter: {col, in: []}` would emit `col IN ()`, which is
// invalid SQLite - hence an explicit always-false predicate for an empty set
// rather than the structured filter.
function inList(col: string, ids: readonly number[]): string {
  return ids.length === 0 ? '0' : `${col} in (${sqlValueToSqliteString(ids)})`;
}

// Graph nodes' own spans - the `dep` and `rule` tracks, which differ only in
// which nodes they are given. `ts is not null` excludes a node whose timing
// never resolved to a lifecycle instant (see sql_graph.ts's LEFT JOIN) - it has
// nothing to project onto a timeline. `ifnull(dur_ns, -1)` is Perfetto's "runs
// to end of trace" convention, exactly right for an unfinished span (a
// `dur_ns`-less finish - see graph.ts's `SpanTiming`).
function depArm(nodes: readonly NodeId[]): string {
  return `
    select node_id as id, ts, ifnull(dur_ns, -1) as dur, label as name,
      null as arg_set_id, 0 as rule_id
    from dune_node
    where ts is not null and ${inList('node_id', nodes)}`;
}

// A rule's action span, filed under the rule's own `node_id` - the action is
// not a node, so it has no id of its own, and one rule has at most one action.
// A rule that ran no action at all (a cache hit) simply contributes no row.
// `name` is a placeholder: sliceName() labels the row from the rule behind it.
function actionArm(rules: readonly NodeId[]): string {
  return `
    select node_id as id, action_ts as ts,
      ifnull(action_dur_ns, -1) as dur, 'action' as name,
      null as arg_set_id, 0 as rule_id
    from dune_rule
    where action_ts is not null and ${inList('node_id', rules)}`;
}

// Verbatim: a process slice's own id, ts, dur, name and arg set, straight off
// `slice`. The join is on `slice.id`, i.e. a primary-key probe per row.
function processArm(graph: BuildGraph, rules: readonly NodeId[]): string {
  const ruleIds = rules.map((id) => graph.timingKeyOf(id));
  return `
    select p.slice_id as id, s.ts as ts, s.dur as dur, s.name as name,
      s.arg_set_id as arg_set_id, p.rule_id as rule_id
    from ${PROCESS_TABLE} p join slice s on s.id = p.slice_id
    where ${inList('p.rule_id', ruleIds)}`;
}

// A row's label. The three node-backed tracks name their rows after the node
// behind them, so they read the same as everywhere else in the plugin; a
// process row keeps the slice's own name, since it is projected verbatim.
function sliceName(
  controller: DuneGraphController,
  kind: GraphTrackKind,
  row: Row,
): string {
  if (kind === 'process') return row.name;
  const node = controller.nodeForNodeId(row.id);
  if (node === undefined) return row.name;
  // Same text as everywhere else, minus the icon a canvas can't draw.
  return decorateNode(controller.graph, node).text;
}
