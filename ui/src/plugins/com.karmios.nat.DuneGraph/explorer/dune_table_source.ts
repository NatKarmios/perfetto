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
 * The mirror's tables as Data Explorer *source nodes*: one entry per table in a
 * "Dune" submenu of the add-node menu's "Sources" section, so a graph can start
 * from `dune_node` the way it starts from `slice`.
 *
 * This is a third offer into that plugin, beside the two chart types and the
 * side panel's hand-off - **ARCHITECTURE.md, "Data Explorer" lists all of
 * them**. The difference from the hand-off (data_explorer_handoff.ts) is who
 * starts it: that one is a button on our panel that pushes a whole chain into
 * the user's graph, this one is an entry in the Data Explorer's own menu that
 * adds a single node the user then builds on.
 *
 * Why not the core `table` source node: it resolves its table through the
 * `SqlModules` stdlib catalogue, and the mirror's tables are created at runtime
 * by sql/sql_graph.ts, so they are not in that catalogue at all. The columns and
 * the documentation come from sql/dune_tables.ts instead - the same hand-written
 * descriptions the query page's "Tables" sidebar shows, which is why they are
 * worth rendering here too.
 *
 * The two tiers are gated differently, and that asymmetry is the point of most
 * of the code below. The node tier is cheap, so picking one of its tables from
 * the menu builds it (`preCreate`). The edge tier takes minutes and can refuse
 * outright past its hard cap, so `dune_edge` is shown greyed out until that tier
 * exists rather than offering to start it from a menu click.
 */

import m from 'mithril';
import markdownit from 'markdown-it';
import type {NodeDescriptor} from '../../dev.perfetto.DataExplorer/query_builder/node_registry';
import {nodeRegistry} from '../../dev.perfetto.DataExplorer/query_builder/node_registry';
import type {
  NodeContext,
  NodeType,
  QueryNode,
} from '../../dev.perfetto.DataExplorer/query_node';
import {nextNodeId} from '../../dev.perfetto.DataExplorer/query_node';
import type {ColumnInfo} from '../../dev.perfetto.DataExplorer/query_builder/column_info';
import {StructuredQueryBuilder} from '../../dev.perfetto.DataExplorer/query_builder/structured_query_builder';
import {setValidationError} from '../../dev.perfetto.DataExplorer/query_builder/node_issues';
import {NodeTitle} from '../../dev.perfetto.DataExplorer/query_builder/node_styling_widgets';
import type {
  NodeDetailsAttrs,
  NodeModifyAttrs,
} from '../../dev.perfetto.DataExplorer/node_types';
import type protos from '../../../protos';
import type {TableListEntry} from '../../../components/query_table/table_list';
import {perfettoSqlTypeToString} from '../../../trace_processor/perfetto_sql_type';
import type {Trace} from '../../../public/trace';
import type {DuneGraphController} from '../controller';
import {DUNE_TABLES} from '../sql/dune_tables';
import {ensureNodeMirror} from './data_explorer_handoff';

/**
 * The tables offered, in menu order, with the label each is offered under.
 * Labels rather than table names because the menu is a list of *things to start
 * from*, and for the same reason the label is what the node is titled and
 * documented under; the table name is left to the SQL it generates.
 *
 * Only the public `dune_*` surface documented in sql/dune_tables.ts is
 * offerable, and only the part of it that can simply be selected from: the
 * relation functions need arguments, and `dune_string` / `dune_process_arg` /
 * `dune_edge_blocked` are joined onto a query rather than started from.
 */
const SOURCE_TABLES: ReadonlyArray<{
  readonly label: string;
  readonly table: string;
}> = [
  {label: 'Nodes', table: 'dune_node'},
  {label: 'Rules', table: 'dune_rule'},
  {label: 'Dependencies', table: 'dune_dep'},
  {label: 'Directories', table: 'dune_dir'},
  {label: 'Processes', table: 'dune_process'},
  {label: 'Rule targets', table: 'dune_rule_target'},
  {label: 'Rule generation', table: 'dune_gen_rules'},
  {label: 'Dynamic includes', table: 'dune_dyn_includes'},
  {label: 'Node edges', table: 'dune_edge'},
];

// The one table above that lives in the expensive tier. Everything else is the
// node tier.
const EDGE_TIER_TABLE = 'dune_edge';

// Why `dune_edge` cannot be picked yet. It names the way out, because there is
// no other: nothing on this side starts an edge build, by design. Shared with
// the macro nodes (dune_macro_node.ts), whose eight edge-tier entries are
// blocked on the same build for the same reason.
export const EDGE_TIER_UNAVAILABLE =
  'The Dune edge tier is not built, so the edges and the walk macros over ' +
  'them do not exist yet. ' +
  'Building it can take minutes, so it is started from the Dune side panel ' +
  'rather than from here; do that and this becomes available.';

// Why a node-tier table or macro cannot be used yet. Unlike the edge tier this
// one is worth starting, so the way out is the ordinary load. Also shared with
// dune_macro_node.ts.
export function nodeTierUnavailable(what: string): string {
  return (
    `The Dune graph is not loaded, so ${what} does not exist yet. Load it ` +
    'from the Dune side panel and run this again.'
  );
}

// The node type string a table's source node serialises as. Derived rather than
// listed so the registry entry, the node instance and a deserialised graph
// cannot disagree - a node type is how serialization finds its descriptor
// again, and `NodeType` admits any string, so a typo would be a silently
// unloadable graph rather than a compile error.
export function duneSourceNodeType(table: string): NodeType {
  return `dune_source_${table}`;
}

// The documentation for one of the mirror's tables. Undefined for a name
// sql/dune_tables.ts does not document, which a restored graph can carry after
// a table is renamed.
function duneTableEntry(table: string): TableListEntry | undefined {
  return DUNE_TABLES.find((t) => t.name === table);
}

// The menu label a table is offered under, which is also its node title.
// Undefined for a table not in the list above, for the same reason
// duneTableEntry() can be.
function duneTableLabel(table: string): string | undefined {
  return SOURCE_TABLES.find((t) => t.table === table)?.label;
}

// One renderer for the whole module, as the Data Explorer's own
// query_builder/node_doc_loader.ts does, and with its options: no raw HTML in
// the source, autolinked URLs, smart quotes.
const markdown = markdownit({
  html: false,
  linkify: true,
  typographer: true,
});

/**
 * One `dune_*` entry's own documentation, as markdown: its description, its
 * columns as a list, and its example query as a fenced block. That
 * documentation is the only place these columns are described - the mirror's
 * tables are not in the stdlib catalogue, and trace_processor's wire format
 * carries no column comments (see sql/dune_tables.ts).
 *
 * Markdown rather than hand-built mithril because the core nodes' info panels
 * are markdown files, so this is what makes a Dune panel read like theirs -
 * code spans and fenced SQL in particular, which the descriptions here are
 * already written with. It is not `loadNodeDoc`, though: that fetches from the
 * Data Explorer's shipped assets, and these docs are not shipped there.
 */
function duneEntryMarkdown(label: string, entry: TableListEntry): string {
  const lines = [
    `# ${label}`,
    '',
    // Every entry in sql/dune_tables.ts has a description, but the type allows
    // one without; an empty paragraph renders as nothing rather than as the
    // word "undefined".
    entry.description ?? '',
    '',
    '**Columns:**',
    '',
  ];
  for (const col of entry.columns) {
    lines.push(
      `- \`${col.name}\` (${perfettoSqlTypeToString(col.type)}): ` +
        `${col.description}`,
    );
  }
  if (entry.exampleQuery !== undefined) {
    lines.push(
      '',
      '**Example query:**',
      '',
      '```sql',
      entry.exampleQuery,
      '```',
    );
  }
  return lines.join('\n');
}

/**
 * That markdown as the info panel itself. `.pf-node-info` is the Data
 * Explorer's own class for a node's documentation - these nodes render inside
 * its panel, so wearing it is what gets them its typography rather than
 * unstyled HTML.
 *
 * Shared with the macro nodes (dune_macro_node.ts), which document themselves
 * from the same catalogue.
 */
export function duneTableEntryInfo(
  label: string,
  entry: TableListEntry,
): m.Children {
  return m(
    '.pf-node-info',
    m.trust(markdown.render(duneEntryMarkdown(label, entry))),
  );
}

// Serializable node configuration. The table *name* rather than an index into
// the list above: a graph restored after the list is reordered has to still
// point at the same table.
export interface DuneTableSourceNodeAttrs {
  table: string;
}

/**
 * A source node over one of the mirror's tables. Shared by all nine registry
 * entries - they differ only in which table they name, so there is one class
 * and nine descriptors rather than nine classes.
 *
 * Holds the controller because `validate()` has to answer "is this table's tier
 * built" at the moment the query is assembled, not at the moment the node was
 * created: a graph reloaded from JSON comes back with no tiers at all, and the
 * point of the check is that such a graph fails legibly instead of failing on
 * raw SQL naming a table that does not exist.
 */
export class DuneTableSourceNode implements QueryNode {
  readonly nodeId: string;
  readonly type: NodeType;
  readonly attrs: DuneTableSourceNodeAttrs;
  readonly context: NodeContext;
  // Mutable in place, because the column checkboxes below edit it. Not
  // serialized: `attrs` is the whole of this node's persisted state, so a
  // reloaded graph comes back with every column checked.
  readonly finalCols: ColumnInfo[];
  nextNodes: QueryNode[];

  private readonly controller: DuneGraphController;
  private readonly entry?: TableListEntry;

  constructor(
    attrs: DuneTableSourceNodeAttrs,
    context: NodeContext,
    controller: DuneGraphController,
  ) {
    this.nodeId = nextNodeId();
    this.type = duneSourceNodeType(attrs.table);
    this.attrs = {...attrs};
    this.context = context;
    this.controller = controller;
    this.entry = duneTableEntry(attrs.table);
    this.finalCols = (this.entry?.columns ?? []).map((col) => ({
      name: col.name,
      type: col.type,
      description: col.description,
      checked: true,
    }));
    this.nextNodes = [];
  }

  // Whether the tier holding this node's table is queryable right now.
  private get tierReady(): boolean {
    return this.attrs.table === EDGE_TIER_TABLE
      ? this.controller.edgeMirrorReady
      : this.controller.nodeMirrorReady;
  }

  validate(): boolean {
    this.context.issues?.clear();

    if (this.entry === undefined) {
      setValidationError(
        this.context,
        `${this.attrs.table} is not one of the Dune graph's tables.`,
      );
      return false;
    }

    if (!this.tierReady) {
      setValidationError(
        this.context,
        this.attrs.table === EDGE_TIER_TABLE
          ? EDGE_TIER_UNAVAILABLE
          : nodeTierUnavailable(this.attrs.table),
      );
      return false;
    }

    return true;
  }

  // The menu label, not the table name: this is what is drawn on the node's
  // box in the graph. The table name falls through for a table the list no
  // longer offers, which is the same case `entry` is undefined in.
  getTitle(): string {
    return duneTableLabel(this.attrs.table) ?? this.attrs.table;
  }

  nodeDetails(): NodeDetailsAttrs {
    return {content: NodeTitle(this.getTitle())};
  }

  // No configuration at all, as the core `TableSourceNode` has none: the table
  // is fixed by the descriptor, and the node's own panel is its documentation.
  // `finalCols` is still the projection a downstream node narrows, it just has
  // no control of its own here.
  nodeSpecificModify(): NodeModifyAttrs {
    return {
      info: `Every row of ${this.attrs.table}, from the Dune build graph.`,
    };
  }

  nodeInfo(): m.Children {
    if (this.entry === undefined) return undefined;
    return duneTableEntryInfo(this.getTitle(), this.entry);
  }

  clone(): QueryNode {
    return new DuneTableSourceNode(this.attrs, this.context, this.controller);
  }

  getStructuredQuery(): protos.PerfettoSqlStructuredQuery | undefined {
    if (!this.validate()) return undefined;

    const sq = StructuredQueryBuilder.fromTable(
      this.attrs.table,
      // No `INCLUDE PERFETTO MODULE`: the mirror creates its tables in the
      // trace processor instance directly, so they are simply in scope.
      undefined,
      this.finalCols.filter((c) => c.checked).map((c) => c.name),
      this.nodeId,
    );
    StructuredQueryBuilder.applyNodeColumnSelection(sq, this);
    return sq;
  }
}

/**
 * The registry entry for one table. Exported for the tests, which need to reach
 * `available()` and the factory without going through the global registry.
 *
 * `hue` and `category` are what put all nine in one "Dune" submenu drawn in one
 * colour, inside the add-node menu's "Sources" section. The hue is the core
 * nodes' orange (`#ffe0b2`, see the Data Explorer's
 * query_builder/graph/node_config.ts). `showOnLandingPage` is
 * off because the landing page is for the handful of core starting points, and
 * nine of these would swamp it.
 */
export function duneTableSourceDescriptor(
  controller: DuneGraphController,
  label: string,
  table: string,
): NodeDescriptor {
  const entry = duneTableEntry(table);
  const isEdgeTier = table === EDGE_TIER_TABLE;
  return {
    name: label,
    description: entry?.description ?? table,
    icon: 'table_chart',
    type: 'source',
    inputs: 'none',
    category: 'Dune',
    hue: 30,
    showOnLandingPage: false,
    nodeType: duneSourceNodeType(table),

    // The edge tier is never started from here, so this entry is greyed out
    // with its reason until something else has built it. Read live rather than
    // captured: this is called on every menu render, so the entry recovers by
    // itself once the tier is there.
    available: isEdgeTier
      ? () => (controller.edgeMirrorReady ? undefined : EDGE_TIER_UNAVAILABLE)
      : undefined,

    // The node tier is cheap and picking the menu item is clear enough intent,
    // so this one builds it. The state is empty because the table is fixed by
    // this descriptor; `preCreate` is here only as the gate, and returning null
    // aborts the creation when the load failed (the side panel says why).
    preCreate: isEdgeTier
      ? undefined
      : async () => ((await ensureNodeMirror(controller)) ? {} : null),

    factory: (_attrs, factoryCtx) =>
      new DuneTableSourceNode({table}, factoryCtx?.context ?? {}, controller),
    // The serialized state is not read: the descriptor a graph's node type
    // resolves to is the one for its table, so the table is already known, and
    // taking it from here keeps one source of truth for it.
    deserialize: (_state, trace, sqlModules) =>
      new DuneTableSourceNode({table}, {trace, sqlModules}, controller),

    // No `allowedChildren`, so the core operations can be added below these
    // through the registry's default.
  };
}

// Registered for as long as `trace` lives: the node registry is global and
// outlives a trace, while every descriptor closes over *this* trace's
// controller. Registering a node id or a node type twice throws by design, so a
// leaked registration surfaces on the next trace load rather than quietly
// capturing a dead controller.
export function registerDuneSourceNodes(
  trace: Trace,
  controller: DuneGraphController,
): void {
  for (const {label, table} of SOURCE_TABLES) {
    trace.trash.use(
      nodeRegistry.register(
        `dune_source_${table}`,
        duneTableSourceDescriptor(controller, label, table),
      ),
    );
  }
}
