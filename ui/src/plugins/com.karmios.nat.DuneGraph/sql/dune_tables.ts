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
 * Documentation for the `dune_*` SQL surface, for the query page's "Tables"
 * sidebar.
 *
 * Why this is hand-written rather than derived: the mirror's tables are created
 * at runtime by sql_graph.ts, so they are not in the `SqlModules` stdlib
 * catalogue that the core query page's table list reads, and trace_processor's
 * wire format carries no column comments even for the ones declared as typed
 * `CREATE PERFETTO VIEW`s. The column *names* are duplicated from sql_graph.ts
 * either way, so `dune_tables_unittest.ts` parses that file's `CREATE` strings
 * and fails if the two ever disagree - which is what stops this file rotting
 * silently as the mirror changes.
 *
 * The public/internal split is the mirror's own naming convention, not a
 * judgement call made here: `dune_*` is the surface meant to be queried,
 * `_dune_*` is storage backing it (see sql_graph.ts's header). The internal
 * section exists so that a `SELECT * FROM _dune_...` seen in a profile or a
 * stack trace can be looked up; it is deliberately documented one line deep.
 */

import type {
  TableListEntry,
  TableListSection,
} from '../../../components/query_table/table_list';
import type {PerfettoSqlType} from '../../../trace_processor/perfetto_sql_type';

const INT: PerfettoSqlType = {kind: 'int'};
const STR: PerfettoSqlType = {kind: 'string'};
const TS: PerfettoSqlType = {kind: 'timestamp'};
const DUR: PerfettoSqlType = {kind: 'duration'};
const BOOL: PerfettoSqlType = {kind: 'boolean'};
const SLICE_ID: PerfettoSqlType = {
  kind: 'joinid',
  source: {table: 'slice', column: 'id'},
};

// `node_id` and the `src`/`dst` endpoints: the mirror's own dense node id, and
// the one column the UI renders as a clickable node chip.
const NODE_ID_DESC =
  "The mirror's own dense node id - the value every src/dst and every " +
  'relation function speaks in, and the only one the results table renders ' +
  'as a node chip. Rules take the low ids, deps the rest.';

const RELATION_ARGS_DESC =
  '`max_steps` bounds the walk (NULL for unbounded); `step_kind` restricts ' +
  "which node kinds a step may pass through ('rule', 'dep', or NULL for " +
  'either).';

// Every relation function returns this same shape, so it is written once.
const RELATION_COLUMNS: ReadonlyArray<{
  readonly name: string;
  readonly description: string;
  readonly type: PerfettoSqlType;
}> = [
  {name: 'src', description: 'The walk’s near end.', type: INT},
  {name: 'src_kind', description: "'rule' or 'dep'.", type: STR},
  {
    name: 'src_id',
    description: "`src`'s label: a rule id, or a dep's path.",
    type: STR,
  },
  {name: 'dst', description: 'The reached node.', type: INT},
  {name: 'dst_kind', description: "'rule' or 'dep'.", type: STR},
  {
    name: 'dst_id',
    description: "`dst`'s label: a rule id, or a dep's path.",
    type: STR,
  },
  {
    name: 'distance',
    description:
      'Path nodes traversed away from the anchor, excluding the anchor ' +
      'itself; equals `rule_distance + dep_distance`.',
    type: INT,
  },
  {
    name: 'rule_distance',
    description: 'How much of `distance` was spent stepping through rules.',
    type: INT,
  },
  {
    name: 'dep_distance',
    description: 'How much of `distance` was spent stepping through deps.',
    type: INT,
  },
];

/**
 * The tables and views meant to be queried directly. Order is the order they
 * are shown in, which is roughly "most useful first" rather than alphabetical:
 * a node, its two detail tables, then the edge set, then the odds and ends.
 */
export const DUNE_TABLES: ReadonlyArray<TableListEntry> = [
  {
    name: 'dune_node',
    description:
      'One row per node in the build graph - every rule and every dep - with ' +
      'its label, its lifecycle timing, and what forced it. The table to ' +
      'start from: a `node_id` here joins to dune_rule / dune_dep for ' +
      'per-kind detail, and to dune_edge for structure.',
    columns: [
      {name: 'node_id', description: NODE_ID_DESC, type: INT},
      {
        name: 'kind',
        description: "'rule' or 'dep'.",
        type: STR,
      },
      {
        name: 'orig_id',
        description:
          "The id Dune itself used: a rule id, or a dep's interned path id.",
        type: INT,
      },
      {
        name: 'slice_id',
        description:
          "The node's primary lifecycle slice, or NULL when its timing never " +
          'resolved. Several slices can share one node, so this is timing ' +
          'rather than identity - do not join on it as a key.',
        type: SLICE_ID,
      },
      {
        name: 'label',
        description: 'The rule id or dep path, resolved through dune_string.',
        type: STR,
      },
      {
        name: 'forced_by_kind',
        description:
          'What caused this node to be built, when known: RULE, DEP, ' +
          'DYNAMIC_INCLUDES, GEN_RULES, PFORM, CONFIGURATOR, REQUEST, ' +
          'RULE_RECOVERY or UNKNOWN. NULL when nothing was recorded.',
        type: STR,
      },
      {
        name: 'forced_by_target',
        description:
          'What the forcer named: a rule id for a RULE forcer, otherwise a ' +
          'path. NULL when the forcer names nothing.',
        type: STR,
      },
      {
        name: 'dir_id',
        description: 'dune_dir.id of the directory this node is filed under.',
        type: INT,
      },
      {
        name: 'ts',
        description: "Start of the node's lifecycle slice.",
        type: TS,
      },
      {
        name: 'dur_ns',
        description:
          "The node's lifecycle duration in nanoseconds. Named `dur_ns` " +
          'rather than `dur` so the results table formats it as a duration.',
        type: DUR,
      },
      {
        name: 'n_occurrences',
        description: 'How many lifecycle instants collapsed into this node.',
        type: INT,
      },
    ],
  },
  {
    name: 'dune_rule',
    description:
      'Per-rule detail, one row per rule node: where it lives, how it ' +
      'finished, and what its action cost. Join to dune_node on `node_id`.',
    columns: [
      {
        name: 'node_id',
        description: 'The dune_node this row details.',
        type: INT,
      },
      {name: 'rule_id', description: "Dune's own rule id.", type: INT},
      {
        name: 'dir',
        description: "The rule's directory, as a path string.",
        type: STR,
      },
      {
        name: 'outcome',
        description:
          "How the rule finished: 'executed', 'local-cache-hit', " +
          "'shared-cache-hit', 'unfinished', 'failed-deps', 'failed-action' " +
          "or 'cancelled'.",
        type: STR,
      },
      {
        name: 'action_slice_id',
        description:
          "The slice of the rule's action, or NULL for a cache hit (which " +
          'ran no action at all).',
        type: SLICE_ID,
      },
      {name: 'action_ts', description: 'Start of that action.', type: TS},
      {
        name: 'action_dur_ns',
        description: 'Duration of that action, in nanoseconds.',
        type: DUR,
      },
      {
        name: 'n_targets',
        description: 'How many paths the rule produces (see dune_rule_target).',
        type: INT,
      },
      {
        name: 'n_static_deps',
        description: 'Dependencies known before the rule ran.',
        type: INT,
      },
      {
        name: 'n_dyn_stages',
        description:
          'How many rounds of dynamic dependencies the rule went through.',
        type: INT,
      },
      {
        name: 'deps_unknown',
        description:
          "Set when the rule's dependency set could not be fully recovered, " +
          'so its edges are incomplete.',
        type: BOOL,
      },
    ],
  },
  {
    name: 'dune_dep',
    description:
      'Per-dep detail, one row per dep node: its path, how it was resolved ' +
      'and whether it succeeded. Join to dune_node on `node_id`.',
    columns: [
      {
        name: 'node_id',
        description: 'The dune_node this row details.',
        type: INT,
      },
      {
        name: 'dep_id',
        description: "Dune's own id for the dep - its interned path id.",
        type: INT,
      },
      {name: 'path', description: 'The path depended on.', type: STR},
      {
        name: 'resolution',
        description:
          "How the dep was satisfied: 'rule' (built by one), 'source' (a " +
          "checked-in file), 'expanded', 'unfinished' or 'unknown'.",
        type: STR,
      },
      {
        name: 'status',
        description: "'ok', 'failed' or 'cancelled'.",
        type: STR,
      },
      {
        name: 'resolved_rule_node_id',
        description:
          'The rule node that produces this path, when the resolution was ' +
          "'rule'. NULL otherwise.",
        type: INT,
      },
      {
        name: 'is_source',
        description: "Shorthand for `resolution = 'source'`.",
        type: BOOL,
      },
    ],
  },
  {
    name: 'dune_edge',
    description:
      'The graph’s edges: one row per "src depends on dst", covering both ' +
      "a rule's static dependencies and each round of its dynamic ones. Both " +
      'endpoints are node ids, so both render as chips.',
    columns: [
      {
        name: 'src',
        description: 'The depending node.',
        type: INT,
      },
      {name: 'dst', description: 'The node depended on.', type: INT},
      {
        name: 'forced',
        description:
          'Whether this particular edge is why `dst` was built. For ' +
          'transitive forcing, join dune_forced / dune_forcers instead.',
        type: BOOL,
      },
      {
        name: 'edge_kind',
        description:
          "'static' for a dependency known up front, 'dynamic' for one " +
          'discovered while the rule ran.',
        type: STR,
      },
      {
        name: 'dyn_deps_stage',
        description:
          'Which round of dynamic dependencies produced this edge; NULL for ' +
          'a static edge.',
        type: INT,
      },
    ],
  },
  {
    name: 'dune_edge_blocked',
    description:
      'dune_edge with a `blocked_ns` column: how long `src` sat waiting on ' +
      'this particular `dst`. The table for "what was actually on the ' +
      'critical path" questions; more expensive than dune_edge, so prefer ' +
      'that one when you do not need the wait.',
    columns: [
      {name: 'src', description: 'The depending node.', type: INT},
      {name: 'dst', description: 'The node depended on.', type: INT},
      {name: 'forced', description: 'As dune_edge.forced.', type: BOOL},
      {name: 'edge_kind', description: 'As dune_edge.edge_kind.', type: STR},
      {
        name: 'dyn_deps_stage',
        description: 'As dune_edge.dyn_deps_stage.',
        type: INT,
      },
      {
        name: 'blocked_ns',
        description:
          'Nanoseconds `src` was blocked on `dst` - the overlap between ' +
          '`dst` still running and `src` waiting to start.',
        type: DUR,
      },
    ],
  },
  {
    name: 'dune_rule_target',
    description:
      'The paths each rule produces, one row per target. Indexed on `path`, ' +
      'so joining it onto dune_dep.path is the way to ask "which rule built ' +
      'this dependency".',
    columns: [
      {name: 'node_id', description: 'The producing rule node.', type: INT},
      {name: 'path', description: 'A path the rule produces.', type: STR},
      {
        name: 'is_dir',
        description: 'Whether the target is a directory rather than a file.',
        type: BOOL,
      },
    ],
  },
  {
    name: 'dune_process',
    description:
      'The processes the build spawned, joined to the rule that forced each ' +
      'one. `node_id` is NULL when the forcing rule is not in the graph.',
    columns: [
      {
        name: 'slice_id',
        description: "The process's slice on the timeline.",
        type: SLICE_ID,
      },
      {name: 'ts', description: 'When the process started.', type: TS},
      {
        name: 'dur_ns',
        description: 'How long it ran, in nanoseconds.',
        type: DUR,
      },
      {
        name: 'rule_id',
        description: "Dune's rule id for the rule that spawned it.",
        type: INT,
      },
      {
        name: 'node_id',
        description:
          'That rule as a dune_node, or NULL if the graph has no such rule.',
        type: INT,
      },
    ],
  },
  {
    name: 'dune_dir',
    description:
      'The build seen as a directory tree: one row per directory, with its ' +
      'parent, its direct membership and its rolled-up duration. Shaped for ' +
      "a DataGrid's id/parent_id tree.",
    columns: [
      {name: 'id', description: 'The directory’s id.', type: INT},
      {
        name: 'parent_id',
        description: 'Its parent directory; NULL at the root.',
        type: INT,
      },
      {name: 'name', description: 'The last path segment.', type: STR},
      {name: 'path', description: 'The full path.', type: STR},
      {name: 'depth', description: 'Distance from the root.', type: INT},
      {
        name: 'n_rules',
        description: 'Rules whose `dir` is this directory.',
        type: INT,
      },
      {
        name: 'n_deps',
        description: 'Deps whose path lives in this directory.',
        type: INT,
      },
      {name: 'n_failed', description: 'Of those, how many failed.', type: INT},
      {
        name: 't_rules',
        description: 'n_rules, rolled up over the whole subtree.',
        type: INT,
      },
      {
        name: 't_deps',
        description: 'n_deps, rolled up over the whole subtree.',
        type: INT,
      },
      {
        name: 't_failed',
        description: 'n_failed, rolled up over the whole subtree.',
        type: INT,
      },
      {
        name: 'self_dur_ns',
        description: "Action time of this directory's own rules.",
        type: DUR,
      },
      {
        name: 'total_dur_ns',
        description: 'self_dur_ns, rolled up over the whole subtree.',
        type: DUR,
      },
    ],
  },
  {
    name: 'dune_string',
    description:
      "The mirror's intern table - every path and directory the build " +
      'mentions, exactly once. The views already resolve their own labels ' +
      'through it, so query it directly only to search paths the graph ' +
      'itself never turned into a node.',
    columns: [
      {name: 'id', description: 'The interned id.', type: INT},
      {name: 'str', description: 'The string.', type: STR},
    ],
  },
];

/**
 * The relation functions: `SELECT * FROM dune_children(42)` and friends. They
 * are `RETURNS TABLE` functions, so they appear here as a call signature and
 * carry an `exampleQuery` - the generated `SELECT ... FROM <name>` would not
 * run without arguments.
 *
 * Each also has a same-named `!` list-macro wrapper, documented separately in
 * {@link DUNE_MACROS}.
 */
export const DUNE_FUNCTIONS: ReadonlyArray<TableListEntry> = [
  {
    name: 'dune_descendants(node_id, max_steps, step_kind)',
    description:
      'What `node_id` depends on, walking down, bounded. ' + RELATION_ARGS_DESC,
    exampleQuery: relationQuery('dune_descendants(42, 3, NULL)'),
    columns: RELATION_COLUMNS,
  },
  {
    name: 'dune_ancestors(node_id, max_steps, step_kind)',
    description:
      'What depends on `node_id`, walking up, bounded. ' + RELATION_ARGS_DESC,
    exampleQuery: relationQuery('dune_ancestors(42, 3, NULL)'),
    columns: RELATION_COLUMNS,
  },
  {
    name: 'dune_all_descendants(node_id)',
    description:
      'Everything `node_id` depends on, transitively and unbounded. Cheaper ' +
      'than the bounded form with no limit, which is why it exists ' +
      'separately.',
    exampleQuery: relationQuery('dune_all_descendants(42)'),
    columns: RELATION_COLUMNS,
  },
  {
    name: 'dune_all_ancestors(node_id)',
    description:
      'Everything that depends on `node_id`, transitively and unbounded.',
    exampleQuery: relationQuery('dune_all_ancestors(42)'),
    columns: RELATION_COLUMNS,
  },
  {
    name: 'dune_children(node_id)',
    description: "One hop down: `node_id`'s direct dependencies.",
    exampleQuery: relationQuery('dune_children(42)'),
    columns: RELATION_COLUMNS,
  },
  {
    name: 'dune_parents(node_id)',
    description: 'One hop up: what directly depends on `node_id`.',
    exampleQuery: relationQuery('dune_parents(42)'),
    columns: RELATION_COLUMNS,
  },
  {
    name: 'dune_forcers(node_id)',
    description:
      'Walking up, but only along forced edges: the chain of nodes that is ' +
      'why `node_id` was built at all.',
    exampleQuery: relationQuery('dune_forcers(42)'),
    columns: RELATION_COLUMNS,
  },
  {
    name: 'dune_forced(node_id)',
    description:
      'Walking down along forced edges: everything `node_id` is the reason ' +
      'for. LEFT JOIN this onto a result USING (dst) to annotate it with ' +
      'transitive forcing.',
    exampleQuery: relationQuery('dune_forced(42)'),
    columns: RELATION_COLUMNS,
  },
];

// A runnable example for a relation function: the call, with the anchor node
// left as a literal for the user to replace.
function relationQuery(call: string): string {
  return [
    '-- Replace 42 with the node_id you care about.',
    'SELECT src_id, dst_id, distance',
    `FROM ${call}`,
    'ORDER BY distance',
    'LIMIT 1000',
  ].join('\n');
}

/**
 * The macros. Two kinds, and the `!` in the name is part of calling them.
 *
 * Eight of them are the list wrappers over the relation functions: where the
 * function walks from one `node_id`, the macro takes a table or subquery of
 * them, runs the function per row and unions the results. That is the answer
 * to "do this for every failed rule" without a correlated subquery.
 *
 * The ninth, `dune_blocked!`, is the odd one out: it takes an edge set and
 * returns it with a `blocked_ns` column added, which is how `dune_edge_blocked`
 * is built. Worth knowing directly, because applying it to a *filtered* edge
 * set is much cheaper than selecting from the whole blocked view.
 */
export const DUNE_MACROS: ReadonlyArray<TableListEntry> = [
  ...DUNE_FUNCTIONS.map((fn) => macroFor(fn)),
  {
    name: 'dune_blocked!(edges)',
    description:
      'Takes any `dune_edge`-shaped table or subquery and returns it with a ' +
      '`blocked_ns` column: how long `src` sat waiting on that particular ' +
      '`dst`. `dune_edge_blocked` is exactly `dune_blocked!(dune_edge)`, so ' +
      'reach for the macro when you have already narrowed the edges down. ' +
      'Do NOT sum `blocked_ns` over a node’s edges - deps build in parallel, ' +
      'so their waits overlap and adding them double-counts; `max(blocked_ns)` ' +
      'is the honest per-node figure.',
    exampleQuery: [
      '-- Only the dynamic edges, with each one’s wait.',
      "WITH dyn AS (SELECT * FROM dune_edge WHERE edge_kind = 'dynamic')",
      'SELECT src, dst, blocked_ns',
      'FROM dune_blocked!(dyn)',
      'ORDER BY blocked_ns DESC',
      'LIMIT 1000',
    ].join('\n'),
    columns: [
      {
        name: 'blocked_ns',
        description:
          'The added column. Every column of the edge set passed in comes ' +
          'through unchanged alongside it.',
        type: DUR,
      },
    ],
  },
];

// The list-macro wrapper for one relation function: same name and columns, but
// `starts` (a table or subquery of node ids) in place of the single `node_id`.
function macroFor(fn: TableListEntry): TableListEntry {
  const [name, args] = fn.name.replace(')', '').split('(');
  const macroArgs = ['starts', ...args.split(', ').slice(1)];
  return {
    name: `${name}!(${macroArgs.join(', ')})`,
    description:
      `${name} run once per node id in \`starts\`, unioned. ` +
      'Same columns as the function; `starts` is any table or subquery with a ' +
      '`node_id` column.',
    exampleQuery: [
      '-- Every rule that failed, and what each one depends on.',
      'WITH starts AS (',
      '  SELECT node_id FROM dune_rule',
      "  WHERE outcome IN ('failed-action', 'failed-deps')",
      ')',
      'SELECT src_id, dst_id, distance',
      `FROM ${name}!(${['starts', ...macroArgs.slice(1).map(() => 'NULL')].join(', ')})`,
      'ORDER BY distance',
      'LIMIT 1000',
    ].join('\n'),
    columns: fn.columns,
  };
}

/**
 * The storage behind the public views. Documented one line each: enough to
 * recognise one in a query plan or a stack trace, not enough to encourage
 * querying it. Shapes here change without notice - the `dune_*` views are the
 * contract.
 */
export const DUNE_INTERNAL_TABLES: ReadonlyArray<TableListEntry> = [
  ['_dune_node', 'Raw node rows; dune_node is the typed view over this.'],
  ['_dune_rule', 'Raw per-rule rows behind dune_rule.'],
  ['_dune_dep', 'Raw per-dep rows behind dune_dep.'],
  [
    '_dune_edge',
    'Materialised edge set, built only when the edge tier is loaded.',
  ],
  ['_dune_edge_all', 'The whole edge set for a directed walk, as one view.'],
  ['_dune_node_out', "Each node's out-degree, for the walk's cost estimates."],
  ['_dune_core', 'Shared dependency cores - dep sets reused across rules.'],
  ['_dune_core_member', 'Membership of those cores.'],
  ['_dune_depset', 'A rule’s dependency set, as a factored reference.'],
  ['_dune_depset_add', 'Additions layered on top of a factored dep set.'],
  ['_dune_rule_dyn_stage', "One row per round of a rule's dynamic deps."],
  ['_dune_forced_edge', 'The forced-edge subset, precomputed.'],
  ['_dune_dir', 'Raw directory rows; dune_dir is the typed view.'],
  ['_dune_rule_dir', "Each rule's directory, before the tree is built."],
  [
    '_dune_span',
    "A node's lifecycle as a half-open interval, for the blocked-time macro.",
  ],
  [
    '_dune_timing',
    'One row per (kind, key): the canonical occurrence’s slice ids and ' +
      'duration, plus how many occurrences were seen. What the views join for ' +
      '`ts` / `dur_ns` (see lifecycle_sql.ts).',
  ],
  [
    '_dune_instant',
    'Raw lifecycle instants, one row each - the biggest thing the timing ' +
      'build ever holds. Dropped once _dune_timing is built.',
  ],
  [
    '_dune_seq',
    'Instants in sequence, on the way to pairing them. Also dropped.',
  ],
  ['_dune_pair', 'Paired start/finish instants, before they are collapsed.'],
  [
    '_dune_process',
    'The processes the build spawned; dune_process is the typed view over ' +
      'this (see process_sql.ts).',
  ],
].map(([name, description]) => ({name, description, columns: []}));

/**
 * The sidebar's sections, in display order: what to query, how to walk it,
 * what backs it, then the trace's own stdlib.
 *
 * `stdlibTables` comes from SqlModules and is absent while its catalogue is
 * still loading; its section is dropped until it arrives rather than shown
 * empty, since the Dune sections above are useful on their own.
 */
export function duneTableSections(
  stdlibTables?: ReadonlyArray<TableListEntry>,
): TableListSection[] {
  const sections: TableListSection[] = [
    {title: 'Dune tables', tables: DUNE_TABLES},
    {title: 'Dune functions', tables: DUNE_FUNCTIONS},
    {title: 'Dune macros', tables: DUNE_MACROS},
    {title: 'Dune internals', tables: DUNE_INTERNAL_TABLES},
  ];
  if (stdlibTables !== undefined && stdlibTables.length > 0) {
    sections.push({title: 'Perfetto stdlib', tables: stdlibTables});
  }
  return sections;
}
