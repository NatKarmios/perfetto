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
 * The directory half of the selection panel, both ends of it: the panel a
 * `gen-rules` selection opens (dir_info_panel.ts), and the link back into it
 * from a node's own panel (selection_info_panel.ts's `renderDir`).
 *
 * There is no trace processor here, so the engine is a stub keyed on what each
 * statement contains and the assertions are about what the panel *asks for* and
 * what it draws. Three things are worth pinning, because all three fail
 * silently:
 *
 * - the `dune` file's two cases. A directory whose own `gen-rules` recorded
 *   one and a directory inheriting an ancestor's come back through the same
 *   column pair, distinguished only by an id comparison - get it backwards and
 *   every panel claims a file that is not its own.
 * - the members list staying unread until asked for. `t_deps` runs to six
 *   figures, so a panel that read it on open would hang on the directories
 *   most worth opening.
 * - the directory links actually calling `goToDir`, which is the whole of the
 *   second selection channel.
 */

import m from 'mithril';
import {describe, expect, test} from 'vitest';
import type {Trace} from '../../../public/trace';
import {TimestampFormat} from '../../../public/timeline';
import type {Engine} from '../../../trace_processor/engine';
import type {DuneGraphController} from '../controller';
import {dep, rule, testGraph} from '../model/graph_test_helper';
import {DirInfoPanel} from './dir_info_panel';
import {SelectionInfoPanel} from './selection_info_panel';

// Which statement is which. The panel issues three, and they are told apart by
// what they contain rather than by call order, so a test that only cares about
// one does not have to know when the others run.
const DETAILS = 'WITH RECURSIVE walk';
const CHILDREN = 'WITH RECURSIVE chain';
const MEMBERS = 'ORDER BY n.kind DESC';
const NODE_DIR = 'FROM dune_node WHERE node_id';

type Row = Record<string, unknown>;

// A stub engine that records every statement and answers the first canned
// entry whose `match` the statement contains. The same shape as the one in
// model/dir_explorer_unittest.ts, plus the match dispatch, because a panel
// issues several different queries where a single reader issues one.
//
// A column the row does not carry reads as NULL, not `undefined`: the readers
// distinguish a missing `dune` file from a present one by a NULL test, and
// `undefined` would defeat it.
function stubEngine(canned: ReadonlyArray<{match: string; rows: Row[]}>): {
  engine: Engine;
  sql: string[];
} {
  const sql: string[] = [];
  const engine = {
    query: async (q: string) => {
      sql.push(q);
      const rows = canned.find((c) => q.includes(c.match))?.rows ?? [];
      let i = 0;
      const it = {
        valid: () => i < rows.length,
        next: () => {
          i++;
        },
      };
      return {
        iter: () =>
          new Proxy(it, {
            get: (target, prop) => {
              if (prop in target) return target[prop as keyof typeof target];
              return rows[i]?.[prop as string] ?? null;
            },
          }),
      };
    },
  } as unknown as Engine;
  return {engine, sql};
}

// Only `timeline` beyond the engine: the shared `Timestamp` widget reads the
// trace's time domain and format, and `TraceNs` makes it render the raw value
// so a test can assert on it.
function fakeTrace(engine: Engine): Trace {
  return {
    engine,
    timeline: {
      toDomainTime: (t: bigint) => t,
      timestampFormat: TimestampFormat.TraceNs,
      hoverCursorTimestamp: undefined,
    },
  } as unknown as Trace;
}

const PATHS = new Map<number, string>([
  [1, '_build/default'],
  [2, '_build/default/lib'],
  [7, '_build/default/lib/foo'],
  [3, '_build/default/lib/foo/sub'],
]);

function fakeController(over: Partial<DuneGraphController> = {}) {
  return {
    mirrorVersion: 1,
    nodeMirrorReady: true,
    requestRedraw: () => {},
    graph: {buildRoots: ['_build/default']},
    dirPath: (id: number) => PATHS.get(id),
    goToDir: async () => {},
    nodeForNodeId: () => undefined,
    isInGraph: () => false,
    ...over,
  } as unknown as DuneGraphController;
}

function detailsRow(over: Row = {}): Row {
  return {
    parent_dir_id: 2,
    n_rules: 3,
    n_deps: 4,
    n_gen_rules: 1,
    start_slice_id: 8,
    finish_slice_id: 16,
    ts: 1234n,
    dur_ns: 12_000_000n,
    n_occurrences: 1n,
    dune_file_dir_id: 7,
    dune_file: 'lib/foo/dune',
    ...over,
  };
}

// One `dune_dir` row as `childDirs` reads it.
function childRow(id: number, path: string): Row {
  return {
    dir_id: id,
    parent_dir_id: 7,
    name: path.split('/').pop(),
    path,
    depth: 4,
    n_rules: 1,
    n_deps: 2,
    n_failed: 0,
    t_rules: 1,
    t_deps: 2,
    t_failed: 0,
    total_dur_ns: 0n,
  };
}

// The panel fetches on render and paints on the next frame, so a mounted test
// renders, lets the promises land, and renders again - into the same root, so
// the component instance and everything it cached survive. A *factory*, not a
// vnode: mithril mutates the vnodes it renders and skips a second render of the
// identical object, so re-rendering one would never repaint.
async function rerender(
  root: HTMLElement,
  vnode: () => m.Children,
): Promise<void> {
  m.render(root, vnode());
  await new Promise((r) => setTimeout(r, 0));
  m.render(root, vnode());
}

async function renderPanel(
  controller: DuneGraphController,
  engine: Engine,
  dirId = 7,
): Promise<HTMLElement> {
  const root = document.createElement('div');
  await rerender(root, () =>
    m(DirInfoPanel, {controller, trace: fakeTrace(engine), dirId}),
  );
  return root;
}

// The muted `label: value` line with this label, of which there is at most one.
function line(root: HTMLElement, label: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll('.pf-dune-graph__dir')).find(
    (el) =>
      el.querySelector('.pf-dune-graph__dir-label')?.textContent === label,
  ) as HTMLElement | undefined;
}

function sectionWithSummary(
  root: HTMLElement,
  starts: string,
): HTMLElement | undefined {
  return Array.from(root.querySelectorAll('details')).find((el) =>
    el.querySelector('summary')?.textContent?.includes(starts),
  ) as HTMLElement | undefined;
}

describe('DirInfoPanel', () => {
  test("shows the directory's own dune file, unqualified", async () => {
    // `dune_file_dir_id` is this very directory, so the file is its own.
    const {engine} = stubEngine([{match: DETAILS, rows: [detailsRow()]}]);
    const root = await renderPanel(fakeController(), engine);

    expect(line(root, 'dune')?.textContent).toContain('lib/foo/dune');
    expect(root.textContent).not.toContain('inherited');
  });

  test('falls back to the nearest ancestor that recorded one', async () => {
    // The walk stopped two levels up, at dir 2. The file is shown, marked as
    // inherited, and the ancestor it came from is a link of its own - without
    // which the reader cannot tell whose `dune` file they are looking at.
    const {engine} = stubEngine([
      {
        match: DETAILS,
        rows: [detailsRow({dune_file_dir_id: 2, dune_file: 'lib/dune'})],
      },
    ]);
    const root = await renderPanel(fakeController(), engine);

    const duneLine = line(root, 'dune (inherited)');
    expect(duneLine?.textContent).toContain('lib/dune');
    expect(duneLine?.textContent).toContain('_build/default/lib');
    expect(duneLine?.querySelector('a')).not.toBeNull();
  });

  test('says so when the finish recorded no dune file at all', async () => {
    const {engine} = stubEngine([
      {
        match: DETAILS,
        rows: [detailsRow({dune_file_dir_id: null, dune_file: null})],
      },
    ]);
    const root = await renderPanel(fakeController(), engine);

    expect(line(root, 'dune')?.textContent).toContain('not recorded');
  });

  test('shows the span’s timestamp and duration', async () => {
    const {engine} = stubEngine([{match: DETAILS, rows: [detailsRow()]}]);
    const root = await renderPanel(fakeController(), engine);

    expect(line(root, 'ts')?.textContent).toContain('1234');
    expect(root.querySelector('.pf-dune-graph__status')?.textContent).toContain(
      '12ms',
    );
  });

  test('an unfinished span is named rather than left blank', async () => {
    // An interrupted build flushes a `-start` with no `-finish`, so there is a
    // row with no duration. Unnamed it is indistinguishable from a bug.
    const {engine} = stubEngine([
      {
        match: DETAILS,
        rows: [detailsRow({finish_slice_id: null, dur_ns: null})],
      },
    ]);
    const root = await renderPanel(fakeController(), engine);

    expect(root.querySelector('.pf-dune-graph__status')?.textContent).toContain(
      'unfinished',
    );
  });

  test('a directory dune generated no rules for says that instead', async () => {
    const {engine} = stubEngine([
      {match: DETAILS, rows: [detailsRow({n_gen_rules: 0})]},
    ]);
    const root = await renderPanel(fakeController(), engine);

    expect(root.textContent).toContain('no gen-rules');
    expect(line(root, 'dune')).toBeUndefined();
    expect(line(root, 'ts')).toBeUndefined();
  });

  test('the parent link selects the parent directory', async () => {
    const dirs: number[] = [];
    const {engine} = stubEngine([{match: DETAILS, rows: [detailsRow()]}]);
    const root = await renderPanel(
      fakeController({goToDir: async (id: number) => void dirs.push(id)}),
      engine,
    );

    const parent = line(root, 'parent');
    expect(parent?.textContent).toContain('_build/default/lib');
    parent?.querySelector('a')?.click();
    expect(dirs).toEqual([2]);
  });

  test('each child directory is a link that selects it', async () => {
    const dirs: number[] = [];
    const {engine} = stubEngine([
      {match: DETAILS, rows: [detailsRow()]},
      {
        match: CHILDREN,
        rows: [childRow(3, '_build/default/lib/foo/sub')],
      },
    ]);
    const root = await renderPanel(
      fakeController({goToDir: async (id: number) => void dirs.push(id)}),
      engine,
    );

    const section = sectionWithSummary(root, 'Directories (1)');
    expect(section?.textContent).toContain('_build/default/lib/foo/sub');
    section?.querySelector<HTMLElement>('.pf-dune-graph__ref a')?.click();
    expect(dirs).toEqual([3]);
  });

  test('the members list is counted first and read only when asked for', async () => {
    const {engine, sql} = stubEngine([
      {match: DETAILS, rows: [detailsRow()]},
      {
        match: MEMBERS,
        rows: [
          {node_id: 10, kind: 'rule', label: 'lib/foo'},
          {node_id: 11, kind: 'dep', label: '_build/default/lib/foo/a.ml'},
        ],
      },
    ]);
    const controller = fakeController();
    const root = await renderPanel(controller, engine);

    // 3 rules + 4 deps, off the directory's own row - no member query yet.
    const section = sectionWithSummary(root, 'Members (7)');
    expect(section).not.toBeUndefined();
    expect(sql.some((q) => q.includes(MEMBERS))).toBe(false);

    section?.querySelector('button')?.click();
    await rerender(root, () =>
      m(DirInfoPanel, {controller, trace: fakeTrace(engine), dirId: 7}),
    );

    expect(sql.some((q) => q.includes(MEMBERS))).toBe(true);
    expect(sectionWithSummary(root, 'Members (7)')?.textContent).toContain(
      '11',
    );
  });
});

describe("SelectionInfoPanel's link back to a directory", () => {
  test("a rule's dir line links to that directory's panel", async () => {
    // The reverse of the `dir_id` chip a query result draws: the directory
    // comes from `dune_node.dir_id`, which is the authoritative answer for a
    // dep as much as for a rule.
    const g = testGraph([
      rule('r1', {dir: '_build/default/lib/foo', staticDeps: ['a.ml']}),
      dep('a.ml'),
    ]);
    const dirs: number[] = [];
    const {engine} = stubEngine([{match: NODE_DIR, rows: [{dir_id: 7}]}]);
    const controller = fakeController({
      graph: g.graph,
      nodeForSelection: () => g.id('r1'),
      dirForSelection: () => undefined,
      timingFor: async () => ({}),
      processesForRule: async () => [],
      parentsOf: () => [],
      selectedProcessSlice: () => undefined,
      goToDir: async (id: number) => void dirs.push(id),
    });

    const root = document.createElement('div');
    await rerender(root, () =>
      m(SelectionInfoPanel, {controller, trace: fakeTrace(engine)}),
    );

    const dirLine = line(root, 'dir');
    expect(dirLine?.textContent).toContain('lib/foo');
    dirLine?.querySelector('a')?.click();
    expect(dirs).toEqual([7]);
  });

  test('a directory selection renders the directory panel instead', async () => {
    const {engine} = stubEngine([{match: DETAILS, rows: [detailsRow()]}]);
    const controller = fakeController({
      nodeForSelection: () => undefined,
      dirForSelection: () => 7,
    });

    const root = document.createElement('div');
    await rerender(root, () =>
      m(SelectionInfoPanel, {controller, trace: fakeTrace(engine)}),
    );

    // The header is the directory's path with its build root folded into the
    // leading icon, exactly as a dep path is rendered.
    expect(root.textContent).toContain('lib/foo');
    expect(root.textContent).toContain('Members (7)');
  });
});
