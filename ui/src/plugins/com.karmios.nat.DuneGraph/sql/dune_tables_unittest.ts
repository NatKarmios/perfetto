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

// Keeps dune_tables.ts honest. Its column lists are a second copy of what
// sql_graph.ts declares in its `CREATE PERFETTO VIEW` statements, so this
// parses those statements out of the source and compares. A mirror change that
// adds, drops or renames a column fails here rather than quietly leaving the
// query page's "Tables" sidebar describing a table that no longer exists that
// way.
//
// Reading the source text rather than running the SQL is deliberate: creating
// the real views needs a loaded trace, a built graph and a trace_processor
// instance, which is an integration test. The names are all that need
// guarding; the descriptions are prose and can only be reviewed by a human.

import {readFileSync} from 'fs';
import * as path from 'path';
import {
  DUNE_FUNCTIONS,
  DUNE_MACROS,
  DUNE_TABLES,
  duneTableSections,
} from './dune_tables';

function read(file: string): string {
  return readFileSync(path.join(__dirname, file), 'utf8');
}

const SQL_GRAPH = read('sql_graph.ts');
// The mirror's tables are not all in sql_graph.ts: the lifecycle timing table
// and the process table (plus their intermediates) are created by their own
// modules, and the "documented every table" checks below would claim
// completeness while missing five of them.
const ALL_SQL = [
  SQL_GRAPH,
  read('lifecycle_sql.ts'),
  read('process_sql.ts'),
].join('\n');

// The `CREATE PERFETTO VIEW ${CONST}( ... ) AS` blocks, keyed by the *constant*
// name (`NODE_TABLE`), since that is what appears in the template literal.
// Column names are the first word of each entry.
//
// The body has to be terminated on `) AS` rather than on the first `)`: a
// column typed `JOINID(slice.id)` closes a paren of its own, which truncated
// this to four columns when it was written the obvious way.
function declaredColumns(constName: string): string[] | undefined {
  const re = new RegExp(
    `CREATE PERFETTO VIEW \\$\\{${constName}\\}\\(([\\s\\S]*?)\\)\\s*AS`,
  );
  const body = re.exec(SQL_GRAPH)?.[1];
  if (body === undefined) return undefined;
  return body
    .split(',')
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter((name) => name !== '');
}

// The public SQL names the mirror defines, from constants named `*_TABLE` /
// `*_VIEW`. That naming is the mirror's own way of separating a table or view
// from the other things it names: `NODE_ORIG_ID_INDEX` is an index and
// `BLOCKED_MACRO` is a macro, and neither belongs in a list of tables.
//
// The quote in the pattern anchors `dune_` to the start of the name, so this
// can't pick up the `_dune_` storage tables by accident - those are
// deliberately undocumented (see dune_tables.ts's header).
function definedNames(): Set<string> {
  const re = /const [A-Z_]*(?:TABLE|VIEW) = '(dune_[a-z_]+)'/g;
  return new Set([...ALL_SQL.matchAll(re)].map((m) => m[1]));
}

// `const NODE_TABLE = 'dune_node';` -> the SQL name for a constant.
function sqlNameOf(constName: string): string | undefined {
  return new RegExp(`const ${constName} = '([a-z_]+)'`).exec(SQL_GRAPH)?.[1];
}

// The public views whose columns are declared inline, and so can be checked
// mechanically. `dune_dir` builds its column list from DIR_COLUMNS and
// `dune_string` / `dune_rule_target` are materialised plain tables, so they are
// checked separately below.
const INLINE_VIEWS = [
  'NODE_TABLE',
  'RULE_TABLE',
  'DEP_TABLE',
  'EDGE_TABLE',
  'EDGE_BLOCKED_VIEW',
  'PROCESS_VIEW',
  'GEN_RULES_VIEW',
  'DYN_INCLUDES_VIEW',
];

function documentedColumns(sqlName: string): string[] {
  const entry = DUNE_TABLES.find((t) => t.name === sqlName);
  expect(entry, `${sqlName} is missing from DUNE_TABLES`).toBeDefined();
  return entry!.columns.map((c) => c.name);
}

describe('dune_tables matches sql_graph', () => {
  it.each(INLINE_VIEWS)('documents %s exactly as declared', (constName) => {
    const sqlName = sqlNameOf(constName);
    expect(sqlName, `no constant ${constName} in sql_graph.ts`).toBeDefined();
    const declared = declaredColumns(constName);
    expect(
      declared,
      `no CREATE PERFETTO VIEW for ${constName} in sql_graph.ts`,
    ).toBeDefined();
    expect(documentedColumns(sqlName!)).toEqual(declared);
  });

  it('documents dune_dir with DIR_COLUMNS, in order', () => {
    const list = /const DIR_COLUMNS = \[([^\]]*)\]/.exec(SQL_GRAPH)?.[1];
    expect(list).toBeDefined();
    const declared = [...list!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    expect(documentedColumns('dune_dir')).toEqual(declared);
  });

  // The two materialised plain tables: their columns come from the schema
  // string passed to materializeTable, e.g. 'id INTEGER PRIMARY KEY, str TEXT'.
  it.each([
    ['STRING_TABLE', 'dune_string'],
    ['RULE_TARGET_TABLE', 'dune_rule_target'],
  ])('documents %s as materialised', (constName, sqlName) => {
    const re = new RegExp(`${constName},\\s*\\n\\s*'([^']*)'`);
    const schema = re.exec(SQL_GRAPH)?.[1];
    expect(schema, `no materializeTable schema for ${constName}`).toBeDefined();
    const declared = schema!
      .split(',')
      .map((entry) => entry.trim().split(/\s+/)[0]);
    expect(documentedColumns(sqlName)).toEqual(declared);
  });

  it('documents every relation function, with the shared column shape', () => {
    const listed = [
      ...SQL_GRAPH.matchAll(
        /\{name: '(dune_[a-z_]+)', extraArgs: \[([^\]]*)\]/g,
      ),
    ];
    expect(listed.length).toBeGreaterThan(0);

    // Every function in RELATION_FUNCTIONS has an entry, matched on the name
    // before the '(' of its documented call signature.
    const documented = DUNE_FUNCTIONS.map((f) => f.name.split('(')[0]);
    expect(documented.sort()).toEqual(listed.map((m) => m[1]).sort());

    // And each documented signature names exactly the args the function takes:
    // `node_id` plus whatever its list-macro wrapper forwards.
    for (const [, name, extraArgs] of listed) {
      const expectedArgs = [
        'node_id',
        ...[...extraArgs.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
      ];
      const signature = DUNE_FUNCTIONS.find(
        (f) => f.name.split('(')[0] === name,
      )!.name;
      const args = /\(([^)]*)\)/
        .exec(signature)![1]
        .split(',')
        .map((a) => a.trim());
      expect(args, `${name}'s documented signature`).toEqual(expectedArgs);
    }

    // The functions all return RELATION_COLS, so the docs must too.
    const cols = /const RELATION_COLS = `([^`]*)`/.exec(SQL_GRAPH)?.[1];
    expect(cols).toBeDefined();
    const declared = cols!
      .split(',')
      .map((entry) => entry.trim().split(/\s+/)[0])
      .filter((name) => name !== '');
    for (const fn of DUNE_FUNCTIONS) {
      expect(
        fn.columns.map((c) => c.name),
        `${fn.name}'s columns`,
      ).toEqual(declared);
    }
  });

  it('documents a list-macro wrapper for every relation function', () => {
    // The wrappers are generated from RELATION_FUNCTIONS: `starts` in place of
    // `node_id`, then the same trailing scalar args (see the loop at the end
    // of createRelationFunctions).
    const listed = [
      ...SQL_GRAPH.matchAll(
        /\{name: '(dune_[a-z_]+)', extraArgs: \[([^\]]*)\]/g,
      ),
    ];
    expect(listed.length).toBeGreaterThan(0);

    for (const [, name, extraArgs] of listed) {
      const expected = [
        'starts',
        ...[...extraArgs.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
      ];
      const entry = DUNE_MACROS.find((mc) => mc.name.startsWith(`${name}!(`));
      expect(entry, `no macro documented for ${name}`).toBeDefined();
      const args = /\(([^)]*)\)/
        .exec(entry!.name)![1]
        .split(',')
        .map((a) => a.trim());
      expect(args, `${name}!'s documented signature`).toEqual(expected);
      // A wrapper returns exactly what the function it wraps does.
      expect(entry!.columns).toEqual(
        DUNE_FUNCTIONS.find((f) => f.name.startsWith(`${name}(`))!.columns,
      );
    }
  });

  it('documents every macro the mirror defines', () => {
    // Macro names come from a `*_MACRO` constant or from RELATION_FUNCTIONS.
    const fromConstants = [
      ...ALL_SQL.matchAll(/const [A-Z_]*MACRO = '(dune_[a-z_]+)'/g),
    ].map((m) => m[1]);
    const fromFunctions = [
      ...SQL_GRAPH.matchAll(/\{name: '(dune_[a-z_]+)', extraArgs:/g),
    ].map((m) => m[1]);
    const declared = new Set([...fromConstants, ...fromFunctions]);
    expect(declared.size).toBeGreaterThan(fromFunctions.length);

    // Documented macro names, with the `!(args)` call syntax stripped back off.
    const documented = new Set(DUNE_MACROS.map((mc) => mc.name.split('!')[0]));
    expect([...declared].filter((n) => !documented.has(n))).toEqual([]);
    expect([...documented].filter((n) => !declared.has(n))).toEqual([]);

    // Every documented macro is spelled as a call, `!` and all - that is how
    // it has to be invoked, and it is what separates it from the same-named
    // function in the sidebar.
    for (const mc of DUNE_MACROS) {
      expect(mc.name, 'macros are documented as calls').toMatch(
        /^dune_[a-z_]+!\([a-z_, ]*\)$/,
      );
    }
  });

  it('documents every public dune_ view the mirror creates', () => {
    const declared = definedNames();
    expect(declared.size).toBeGreaterThan(0);
    const documented = new Set(DUNE_TABLES.map((t) => t.name));
    expect([...declared].filter((n) => !documented.has(n))).toEqual([]);
    expect([...documented].filter((n) => !declared.has(n))).toEqual([]);
  });
});

describe('duneTableSections', () => {
  it('omits the stdlib section until its catalogue arrives', () => {
    expect(duneTableSections().map((s) => s.title)).toEqual([
      'Dune tables',
      'Dune functions',
      'Dune macros',
    ]);
    expect(duneTableSections([]).map((s) => s.title)).toHaveLength(3);
  });

  it('appends the stdlib section last', () => {
    const sections = duneTableSections([
      {name: 'slice', description: '', columns: []},
    ]);
    expect(sections.map((s) => s.title)).toEqual([
      'Dune tables',
      'Dune functions',
      'Dune macros',
      'Perfetto stdlib',
    ]);
    expect(sections[3].tables).toHaveLength(1);
  });
});
