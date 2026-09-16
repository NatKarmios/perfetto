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
 * The mirror's macros as Data Explorer *modification nodes*: ten entries in a
 * "Macros" submenu under the same "Dune" group the source nodes sit in
 * (dune_table_source.ts), so the walks can be reached by adding a node under a
 * query instead of by hand-writing SQL.
 *
 * This is the fourth offer into that plugin - **ARCHITECTURE.md, "Data
 * Explorer" lists all of them**. It is the source nodes' natural other half:
 * every one of these macros takes a *table* of starting rows, which is exactly
 * what the node above it in the graph already is.
 *
 * How the table gets passed is the one mechanism worth knowing. A `!` macro
 * argument is a `TableOrSubquery`, and `StructuredQueryBuilder.fromSql` takes
 * named dependencies which trace_processor's generator rewrites into the nested
 * query's table name, so `dune_children!($starts)` expands to
 * `dune_children!(some_generated_table)` - a parenthesised identifier, which is
 * what `dune_blocked!(dune_edge)` already relies on being legal.
 *
 * The macro bodies hardcode which column they read off that table (`s.node_id`,
 * `s.slice_id`, `e.src`/`e.dst`), so a user whose input calls it something else
 * cannot pass that as an argument; the dependency is wrapped in a renaming
 * subquery instead. When the names already match, the unwrapped form is emitted
 * - it is the SQL a person would write, and for `dune_blocked!`, which returns
 * `e.*`, a wrap would also narrow the columns passed through to just the two it
 * names.
 *
 * The tier gate is the same asymmetry dune_table_source.ts explains at length:
 * the two table-shaped macros are node tier and so are built by picking them,
 * while the eight walks need the edge tier and are therefore shown greyed out
 * until something else has built it.
 */

import m from 'mithril';
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
  NodeModifySection,
} from '../../dev.perfetto.DataExplorer/node_types';
import type protos from '../../../protos';
import type {TableListEntry} from '../../../components/query_table/table_list';
import {ensureExists} from '../../../base/assert';
import {Select} from '../../../widgets/select';
import {TextInput} from '../../../widgets/text_input';
import type {Trace} from '../../../public/trace';
import type {DuneGraphController} from '../controller';
import {DUNE_MACROS} from '../sql/dune_tables';
import {ensureNodeMirror} from './data_explorer_handoff';
import {
  EDGE_TIER_UNAVAILABLE,
  duneTableEntryInfo,
  nodeTierUnavailable,
} from './dune_table_source';

/**
 * The eight relation walks, in menu order: the label each is offered under and
 * the macro it wraps. They differ in nothing else - all eight take a `node_id`
 * and all eight return the same relation shape - so the rest of their spec is
 * filled in below rather than written out eight times.
 */
const WALK_MACROS: ReadonlyArray<readonly [string, string]> = [
  ['Children', 'dune_children'],
  ['Parents', 'dune_parents'],
  ['Descendants', 'dune_descendants'],
  ['Ancestors', 'dune_ancestors'],
  ['All descendants', 'dune_all_descendants'],
  ['All ancestors', 'dune_all_ancestors'],
  ['Forcers', 'dune_forcers'],
  ['Forced', 'dune_forced'],
];

// What one entry needs beyond its documentation.
interface DuneMacroSpec {
  readonly label: string;
  // The macro's name without the `!`.
  readonly macro: string;
  // The columns the macro's body reads off the table it is passed, under the
  // names it reads them by. Hardcoded in the macro (sql/sql_graph.ts,
  // sql/process_sql.ts), which is why an input naming them differently has to
  // be wrapped rather than argued with.
  readonly keyCols: readonly string[];
  // Whether the macro's own columns replace the input's or are added to them.
  // `dune_blocked!` is the only one that adds: it returns `e.*, blocked_ns`,
  // where the others select their own shape explicitly.
  readonly columns: 'replace' | 'add';
  // Which tier of the mirror defines the macro.
  readonly tier: 'node' | 'edge';
}

const MACRO_SPECS: ReadonlyArray<DuneMacroSpec> = [
  ...WALK_MACROS.map(([label, macro]) => ({
    label,
    macro,
    keyCols: ['node_id'],
    columns: 'replace' as const,
    // createRelationFunctions() runs inside the edge build (sql/sql_graph.ts),
    // so all eight of these exist only once that tier does.
    tier: 'edge' as const,
  })),
  {
    label: 'Process commands',
    macro: 'dune_process_cmd',
    keyCols: ['slice_id'],
    columns: 'replace',
    tier: 'node',
  },
  {
    label: 'Blocked time',
    macro: 'dune_blocked',
    keyCols: ['src', 'dst'],
    columns: 'add',
    tier: 'node',
  },
];

// `step_kind`'s entire domain. The literal is rendered by matching against this
// list rather than by quoting whatever `attrs` holds, so no value carried by a
// saved graph can reach the SQL as anything but one of these two.
const STEP_KINDS: ReadonlyArray<string> = ['rule', 'dep'];

/**
 * One entry, with the parts taken from sql/dune_tables.ts: the documentation to
 * show, and the argument names read off the macro's signature.
 *
 * The signature is parsed rather than restated because those entries are named
 * as *calls* - `dune_descendants!(starts, max_steps, step_kind)` - so the name
 * already holds both the table parameter this node passes its input as and the
 * scalar arguments it renders as SQL literals.
 */
export type DuneMacro = DuneMacroSpec & {
  readonly entry: TableListEntry;
  readonly param: string;
  readonly extraArgs: readonly string[];
};

// Resolved once at module load, so a renamed or dropped catalogue entry fails
// immediately and in every test rather than on the menu render that needs it.
export const DUNE_MACRO_NODES: ReadonlyArray<DuneMacro> = MACRO_SPECS.map(
  (spec) => {
    const prefix = `${spec.macro}!(`;
    const entry = ensureExists(
      DUNE_MACROS.find((e) => e.name.startsWith(prefix)),
      `sql/dune_tables.ts documents no ${prefix}...) macro`,
    );
    const args = entry.name.slice(prefix.length, -1).split(', ');
    return {...spec, entry, param: args[0], extraArgs: args.slice(1)};
  },
);

// The node type string a macro's node serialises as. Derived, for the reason
// duneSourceNodeType() gives: `NodeType` admits any string, so a typo here
// would be an unloadable graph rather than a compile error.
export function duneMacroNodeType(macro: string): NodeType {
  return `dune_macro_${macro}`;
}

// Serializable node configuration - and, `attrs` being the whole of it, the
// only place a macro argument survives a reload.
export interface DuneMacroNodeAttrs {
  // The macro this node calls, without the `!`. Fixed by the registry entry
  // that created the node; carried here because one class serves all ten.
  macro: string;
  // Which input column supplies each of the macro's key columns, keyed by the
  // name the macro's body reads it under. A missing or equal entry means no
  // renaming is needed, which is the common case and the unwrapped query.
  cols?: Record<string, string>;
  // `dune_descendants!` and `dune_ancestors!` only; undefined renders as NULL,
  // which is what those macros take as "unbounded" and "either kind".
  maxSteps?: number;
  stepKind?: string;
}

/**
 * A node calling one of the mirror's macros on the query above it. Shared by
 * all ten registry entries, which differ only in which macro they name.
 *
 * Holds the controller for the same reason the source nodes do: `validate()`
 * has to answer "is this macro's tier built" when the query is assembled, so
 * that a graph restored after a reload - which comes back with no tiers at all
 * - fails legibly rather than on SQL naming a macro that does not exist.
 */
export class DuneMacroNode implements QueryNode {
  readonly nodeId: string;
  readonly type: NodeType;
  readonly attrs: DuneMacroNodeAttrs;
  readonly context: NodeContext;
  primaryInput?: QueryNode;
  nextNodes: QueryNode[];

  private readonly controller: DuneGraphController;
  private readonly macro: DuneMacro;

  constructor(
    attrs: DuneMacroNodeAttrs,
    context: NodeContext,
    controller: DuneGraphController,
  ) {
    this.nodeId = nextNodeId();
    this.type = duneMacroNodeType(attrs.macro);
    this.attrs = {...attrs};
    this.context = context;
    this.controller = controller;
    // Throwing rather than degrading, unlike the source nodes' unknown-table
    // case: the macro name comes from the descriptor on both the creation and
    // the deserialization path, so a name that is not in the list above cannot
    // reach here from a saved graph - only from a caller with a typo.
    this.macro = ensureExists(
      DUNE_MACRO_NODES.find((macro) => macro.macro === attrs.macro),
      `${attrs.macro} is not one of the Dune graph's macros`,
    );
    this.nextNodes = [];
  }

  onPrevNodesUpdated(): void {
    this.context.onchange?.();
  }

  // The columns the dependency actually emits: the input's, minus the ones it
  // has unchecked, since its own projection has already dropped those.
  get sourceCols(): ColumnInfo[] {
    return (this.primaryInput?.finalCols ?? []).filter(
      (c) => c.checked !== false,
    );
  }

  // The input column supplying one of the macro's key columns.
  private colFor(key: string): string {
    return this.attrs.cols?.[key] ?? key;
  }

  // Whether the dependency needs the renaming wrap. See the file comment for
  // why the unwrapped form is preferred when it will do.
  private get wrapped(): boolean {
    return this.macro.keyCols.some((key) => this.colFor(key) !== key);
  }

  get finalCols(): ColumnInfo[] {
    if (this.primaryInput === undefined) return [];
    const own: ColumnInfo[] = this.macro.entry.columns.map((col) => ({
      name: col.name,
      type: col.type,
      description: col.description,
      checked: true,
    }));
    if (this.macro.columns === 'replace') return own;
    // The wrap selects only the key columns, so it is also what narrows what
    // `dune_blocked!`'s `e.*` can pass through.
    const through = this.wrapped
      ? this.macro.keyCols.map((key) => ({name: key, checked: true}))
      : this.sourceCols;
    return [...through, ...own];
  }

  private get tierReady(): boolean {
    return this.macro.tier === 'edge'
      ? this.controller.edgeMirrorReady
      : this.controller.nodeMirrorReady;
  }

  validate(): boolean {
    this.context.issues?.clear();

    if (this.primaryInput === undefined) {
      setValidationError(this.context, 'No input node connected');
      return false;
    }

    if (!this.primaryInput.validate()) {
      setValidationError(this.context, 'Previous node is invalid');
      return false;
    }

    if (!this.tierReady) {
      setValidationError(
        this.context,
        this.macro.tier === 'edge'
          ? EDGE_TIER_UNAVAILABLE
          : nodeTierUnavailable(`${this.macro.macro}!`),
      );
      return false;
    }

    const have = new Set(this.sourceCols.map((c) => c.name));
    const missing = this.macro.keyCols
      .map((key) => this.colFor(key))
      .filter((name) => !have.has(name));
    if (missing.length > 0) {
      setValidationError(
        this.context,
        `${this.getTitle()} needs a ${missing.join(' and a ')} column, ` +
          'which the input does not have. Pick another column below, or add ' +
          'it upstream.',
      );
      return false;
    }

    return true;
  }

  getTitle(): string {
    return `${this.macro.macro}!`;
  }

  nodeDetails(): NodeDetailsAttrs {
    return {content: NodeTitle(this.getTitle())};
  }

  nodeSpecificModify(): NodeModifyAttrs {
    const sections: NodeModifySection[] = [
      {
        title: 'Input columns',
        content: this.macro.keyCols.map((key) => this.columnPicker(key)),
      },
    ];
    // Only the two bounded walks have these, and the signature in the
    // catalogue is what says so.
    if (this.macro.extraArgs.length > 0) {
      sections.push({title: 'Walk bounds', content: this.boundsFields()});
    }
    return {info: this.macro.entry.description, sections};
  }

  // Which input column stands in for one the macro's body names. A choice
  // among the input's own columns rather than free text, so it cannot be spelt
  // wrong; the current value is kept in the list even if the input no longer
  // offers it, so reconnecting shows what the node is still configured for.
  private columnPicker(key: string): m.Children {
    const current = this.colFor(key);
    const names = this.sourceCols.map((c) => c.name);
    if (!names.includes(current)) names.unshift(current);
    return m(
      'label',
      `${key}: `,
      m(
        Select,
        {
          onchange: (e: Event) => {
            this.attrs.cols = {
              ...this.attrs.cols,
              [key]: (e.target as HTMLSelectElement).value,
            };
            this.context.onchange?.();
          },
        },
        names.map((name) =>
          m('option', {value: name, selected: name === current}, name),
        ),
      ),
    );
  }

  private boundsFields(): m.Children {
    return [
      m(
        'label',
        'max_steps: ',
        m(TextInput, {
          type: 'number',
          min: 0,
          placeholder: 'unbounded',
          value: this.attrs.maxSteps ?? '',
          onInput: (value: string) => {
            const steps = Number.parseInt(value, 10);
            this.attrs.maxSteps =
              Number.isInteger(steps) && steps >= 0 ? steps : undefined;
            this.context.onchange?.();
          },
        }),
      ),
      m(
        'label',
        'step_kind: ',
        m(
          Select,
          {
            onchange: (e: Event) => {
              const kind = (e.target as HTMLSelectElement).value;
              this.attrs.stepKind = kind === '' ? undefined : kind;
              this.context.onchange?.();
            },
          },
          ['', ...STEP_KINDS].map((kind) =>
            m(
              'option',
              {value: kind, selected: kind === (this.attrs.stepKind ?? '')},
              kind === '' ? 'either' : kind,
            ),
          ),
        ),
      ),
    ];
  }

  nodeInfo(): m.Children {
    return duneTableEntryInfo(this.macro.entry);
  }

  clone(): QueryNode {
    return new DuneMacroNode({...this.attrs}, this.context, this.controller);
  }

  // One of the macro's trailing scalar arguments, as the SQL literal the macro
  // takes (its parameters are `Expr`, so they are substituted textually).
  private argLiteral(arg: string): string {
    if (arg === 'max_steps') {
      // Rejecting anything that is not an integer rather than trusting
      // `attrs`, which a hand-edited saved graph can carry anything in.
      return Number.isInteger(this.attrs.maxSteps)
        ? `${this.attrs.maxSteps}`
        : 'NULL';
    }
    const kind = STEP_KINDS.find((k) => k === this.attrs.stepKind);
    return kind === undefined ? 'NULL' : `'${kind}'`;
  }

  getStructuredQuery(): protos.PerfettoSqlStructuredQuery | undefined {
    if (!this.validate()) return undefined;
    const input = this.primaryInput?.getStructuredQuery();
    if (input === undefined) return undefined;

    const param = `$${this.macro.param}`;
    const table = this.wrapped
      ? `(SELECT ${this.macro.keyCols
          .map((key) => `${this.colFor(key)} AS ${key}`)
          .join(', ')} FROM ${param})`
      : param;
    const args = [
      table,
      ...this.macro.extraArgs.map((a) => this.argLiteral(a)),
    ];

    const sq = StructuredQueryBuilder.fromSql(
      `SELECT * FROM ${this.macro.macro}!(${args.join(', ')})`,
      [{alias: this.macro.param, query: input}],
      this.finalCols.map((c) => c.name),
      this.nodeId,
    );
    StructuredQueryBuilder.applyNodeColumnSelection(sq, this);
    return sq;
  }
}

/**
 * The registry entry for one macro. Exported for the tests, which need
 * `available()` and the factory without going through the global registry.
 *
 * `category` puts all ten in a "Macros" submenu of the same "Dune" group the
 * source nodes are in, and `hue` gives them that group's colour.
 */
export function duneMacroDescriptor(
  controller: DuneGraphController,
  macro: DuneMacro,
): NodeDescriptor {
  const edgeTier = macro.tier === 'edge';
  return {
    name: macro.label,
    description: macro.entry.description ?? macro.label,
    icon: 'account_tree',
    type: 'modification',
    inputs: 'primary',
    category: ['Dune', 'Macros'],
    hue: 310,
    nodeType: duneMacroNodeType(macro.macro),

    // Greyed out with its reason until something else builds the edge tier.
    // Read live, since this is called on every menu render.
    available: edgeTier
      ? () => (controller.edgeMirrorReady ? undefined : EDGE_TIER_UNAVAILABLE)
      : undefined,

    // The node tier is cheap enough that picking the menu item is intent
    // enough to build it; returning null aborts the creation when that load
    // failed, which the side panel has already reported.
    preCreate: edgeTier
      ? undefined
      : async () => ((await ensureNodeMirror(controller)) ? {} : null),

    factory: (_attrs, factoryCtx) =>
      new DuneMacroNode(
        {macro: macro.macro},
        factoryCtx?.context ?? {},
        controller,
      ),
    // Unlike the source nodes, the serialized state *is* read: it carries the
    // key columns and the walk bounds. Only the macro name is taken from the
    // descriptor instead, so that it stays the one source of truth for it.
    deserialize: (state, trace, sqlModules) =>
      new DuneMacroNode(
        {...(state as DuneMacroNodeAttrs), macro: macro.macro},
        {trace, sqlModules},
        controller,
      ),
  };
}

// Registered for as long as `trace` lives, for the reason
// registerDuneSourceNodes() gives: the registry is global and outlives a trace,
// while every descriptor closes over *this* trace's controller.
export function registerDuneMacroNodes(
  trace: Trace,
  controller: DuneGraphController,
): void {
  for (const macro of DUNE_MACRO_NODES) {
    const id = duneMacroNodeType(macro.macro);
    trace.trash.use(
      nodeRegistry.register(id, duneMacroDescriptor(controller, macro)),
    );
    // These are the first nodes registered from outside the Data Explorer that
    // go *under* another node, and without this they could not: the "+" menu
    // lists the default allowed children and isConnectionAllowed() rejects
    // anything not in it. Unregistering above drops the id from that list
    // again, so there is nothing else to undo.
    nodeRegistry.addDefaultAllowedChild(id);
  }
}
