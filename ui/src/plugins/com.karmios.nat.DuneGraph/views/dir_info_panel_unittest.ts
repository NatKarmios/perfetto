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
    revealDirInExplorer: () => {},
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

// One `dune_dir` row as `childDirs` reads it. `n_gen_rules` is 1 unless a test
// says otherwise: it is what decides whether the child is a link at all.
function childRow(id: number, path: string, nGenRules = 1): Row {
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
    n_gen_rules: nGenRules,
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

    expect(line(root, 'Dune file')?.textContent).toContain('lib/foo/dune');
    expect(root.textContent).not.toContain('levels up');
    expect(root.textContent).not.toContain('level up');
  });

  test('falls back to the nearest ancestor that recorded one', async () => {
    // The walk stopped at dir 2, one level above dir 7. The file is shown, and
    // how far up it came from is a link - without which the reader cannot tell
    // whose `dune` file they are looking at. The distance rather than the
    // ancestor's name, which is this directory's path minus a segment and so
    // already on screen.
    const {engine} = stubEngine([
      {
        match: DETAILS,
        rows: [detailsRow({dune_file_dir_id: 2, dune_file: 'lib/dune'})],
      },
    ]);
    const dirs: number[] = [];
    const root = await renderPanel(
      fakeController({goToDir: async (id: number) => void dirs.push(id)}),
      engine,
    );

    const duneLine = line(root, 'Dune file');
    expect(duneLine?.textContent).toContain('lib/dune');
    expect(duneLine?.textContent).toContain('via');
    expect(duneLine?.textContent).toContain('1 level up');
    duneLine?.querySelector('a')?.click();
    expect(dirs).toEqual([2]);
  });

  test('pluralises the distance to the ancestor', async () => {
    // dir 3 (`_build/default/lib/foo/sub`) is three below dir 1
    // (`_build/default`), so the same wording must not read "1 levels".
    const {engine} = stubEngine([
      {
        match: DETAILS,
        rows: [detailsRow({dune_file_dir_id: 1, dune_file: 'dune'})],
      },
    ]);
    const root = await renderPanel(fakeController(), engine, 3);

    expect(line(root, 'Dune file')?.textContent).toContain('3 levels up');
  });

  test('says so when the finish recorded no dune file at all', async () => {
    const {engine} = stubEngine([
      {
        match: DETAILS,
        rows: [detailsRow({dune_file_dir_id: null, dune_file: null})],
      },
    ]);
    const root = await renderPanel(fakeController(), engine);

    expect(root.textContent).toContain('No dune file');
    expect(line(root, 'Dune file')).toBeUndefined();
  });

  test('shows the span’s duration', async () => {
    const {engine} = stubEngine([{match: DETAILS, rows: [detailsRow()]}]);
    const root = await renderPanel(fakeController(), engine);

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
    // And gets no `dune` file line at all - not even the ancestor's, which the
    // walk does return. A directory with no span is a path prefix rather than
    // somewhere dune read anything, so naming a file against it would read as
    // a claim about it.
    const {engine} = stubEngine([
      {
        match: DETAILS,
        rows: [
          detailsRow({
            n_gen_rules: 0,
            start_slice_id: null,
            finish_slice_id: null,
            dune_file_dir_id: 2,
            dune_file: 'lib/dune',
          }),
        ],
      },
    ]);
    const root = await renderPanel(fakeController(), engine);

    expect(root.textContent).toContain('no gen-rules');
    expect(root.textContent).not.toContain('Dune file');
    expect(root.textContent).not.toContain('No dune file');
    expect(root.textContent).not.toContain('lib/dune');
  });

  test('the parent link selects the parent directory', async () => {
    const dirs: number[] = [];
    const {engine} = stubEngine([{match: DETAILS, rows: [detailsRow()]}]);
    const root = await renderPanel(
      fakeController({goToDir: async (id: number) => void dirs.push(id)}),
      engine,
    );

    // Labelled by the relationship, not the path: this directory's path minus
    // its last segment is the parent's, so repeating it says nothing.
    const parent = Array.from(
      root.querySelectorAll<HTMLElement>('.pf-dune-graph__dir a'),
    ).find((a) => a.textContent?.includes('Parent'));
    expect(parent).not.toBeUndefined();
    expect(parent?.textContent).not.toContain('_build');
    parent?.click();
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

    // Named relative to the directory being shown, as the Explorer tree names
    // a row - the full path is the header's and repeating it buries the part
    // that differs.
    const section = sectionWithSummary(root, 'Subdirectories (1)');
    expect(section?.textContent).toContain('sub/');
    expect(section?.textContent).not.toContain('_build/default');
    section?.querySelector<HTMLElement>('.pf-dune-graph__ref a')?.click();
    expect(dirs).toEqual([3]);
  });

  test('a child with no gen-rules span is text rather than a dead link', async () => {
    // `goToDir` resolves the directory's `gen-rules` slice, so a directory
    // dune generated no rules for has nothing to go to and its anchor would
    // do nothing when clicked. 56 of merlin's 364 directories are like that.
    const {engine} = stubEngine([
      {match: DETAILS, rows: [detailsRow()]},
      {
        match: CHILDREN,
        rows: [
          childRow(3, '_build/default/lib/foo/sub'),
          childRow(4, '_build/default/lib/foo/gen', 0),
        ],
      },
    ]);
    const root = await renderPanel(fakeController(), engine);

    const section = sectionWithSummary(root, 'Subdirectories (2)')!;
    const rows = Array.from(
      section.querySelectorAll('.pf-dune-graph__ref-label'),
    );
    expect(rows.map((el) => el.textContent)).toEqual([
      // The linked row carries the anchor's own icon glyph; the plain one is
      // the label and nothing else.
      'sub/call_made',
      'gen/',
    ]);
    expect(rows.map((el) => el.querySelector('a') !== null)).toEqual([
      true,
      false,
    ]);
  });

  test('offers the way back into the Explorer tree', async () => {
    // The pane expands to the directory itself, over several redraws; all the
    // panel does is ask, since neither side-panel tab holds the other.
    const asked: number[] = [];
    const {engine} = stubEngine([{match: DETAILS, rows: [detailsRow()]}]);
    const root = await renderPanel(
      fakeController({
        revealDirInExplorer: (id: number) => void asked.push(id),
      }),
      engine,
    );

    const button = Array.from(root.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Show in Explorer'),
    );
    button?.click();
    expect(asked).toEqual([7]);
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
