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
 * The Explorer pane's two modes, driven through the source seam.
 *
 * There is no trace processor here and none is needed: the pane reads its rows
 * through `DirExplorerSource` (see dir_explorer_source.ts), so a fake returning
 * canned entries drives the whole component. What is worth pinning is the mode
 * switch, because both ways of getting it wrong are silent:
 *
 * - a row-driven source falling through to the *lazy* path would descend
 *   `rootDirs` / `childDirs` and draw the whole mirror's tree, which looks like
 *   a working chart that is ignoring its query;
 * - the side panel's source picking up the *filtered* path would read the whole
 *   hierarchy on open, and would stop offering the filter that path exists for.
 *
 * The mode is the source's to declare (`rowDriven`), so these are two mounts of
 * one component over two fakes.
 */

import m from 'mithril';
import {describe, expect, test} from 'vitest';
import type {DuneGraphController} from '../controller';
import type {DirEntry, MemberEntry, MemberFilter} from '../model/dir_explorer';
import {filterActive} from '../model/dir_explorer';
import type {DirExplorerSource} from './dir_explorer_source';
import {DirExplorerPanel} from './dir_explorer_panel';
import type {NodeKind} from '../model/graph';

// Everything the pane reads off the controller while drawing directory rows and
// the member chips under them: the mirror is up, nothing is busy, a landed fetch
// has somewhere to send its redraw, and no node id resolves to a node of the
// (unloaded) graph - which is what makes a member row fall back to its raw
// value rather than needing a whole `BuildGraph` here. Bulk actions only *hold*
// the controller until they are clicked, so nothing else is needed.
function fakeController(
  over: Partial<DuneGraphController> = {},
): DuneGraphController {
  return {
    mirrorVersion: 1,
    nodeMirrorReady: true,
    busy: false,
    requestRedraw: () => {},
    nodeForNodeId: () => undefined,
    goToDir: async () => {},
    // Nothing selected on the timeline, so the in-flight filter has no window
    // to take - read on every render, hence here rather than per test.
    selectedWindow: () => undefined,
    ...over,
  } as unknown as DuneGraphController;
}

function dir(over: Partial<DirEntry> & {id: number; path: string}): DirEntry {
  return {
    name: over.path.split('/').pop() ?? '',
    depth: 0,
    nRules: 0,
    nDeps: 0,
    nFailed: 0,
    tRules: 0,
    tDeps: 0,
    tFailed: 0,
    nGenRules: 0,
    totalDurNs: 0n,
    ...over,
  };
}

// `_build` → `_build/default` → {lib, bin}, with everything filed in `lib`. The
// pass-through run above it is what compression has to collapse.
const DIRS: readonly DirEntry[] = [
  dir({id: 0, path: '_build', tRules: 3, tDeps: 45}),
  dir({id: 1, parentId: 0, path: '_build/default', tRules: 3, tDeps: 45}),
  dir({
    id: 2,
    parentId: 1,
    path: '_build/default/lib',
    nRules: 3,
    nDeps: 5,
    tRules: 3,
    tDeps: 5,
  }),
  dir({id: 3, parentId: 1, path: '_build/default/bin', nDeps: 40, tDeps: 40}),
];

const MEMBERS: readonly MemberEntry[] = [
  {nodeId: 10, kind: 'rule', label: 'lib/foo'},
  {nodeId: 11, kind: 'dep', label: '_build/default/lib/a.ml'},
  {nodeId: 12, kind: 'dep', label: '_build/default/lib/b.ml'},
];

// A source over a *selection*: counts come from rows, so every kind is narrowed
// and there is no level to descend. `bin` is absent from both channels, which
// is what should keep it off the screen.
function rowDrivenSource(): DirExplorerSource {
  return {
    version: 1,
    rowDriven: true,
    rootDirs: () => Promise.reject(new Error('descended')),
    childDirs: () => Promise.reject(new Error('descended')),
    allDirs: async () => DIRS,
    matchingRuleDirs: async () => new Set(DIRS.map((d) => d.id)),
    matchingCounts: async (kind: NodeKind) =>
      kind === 'rule' ? new Map([[2, 1]]) : new Map([[2, 2]]),
    dirMembers: async () => MEMBERS,
    dirMemberIds: async () => MEMBERS.map((m) => m.nodeId),
  };
}

// A source over a *hierarchy*, i.e. what the side panel mounts: descended one
// level at a time, and `allDirs` is only read once a filter is applied.
function hierarchySource(calls: string[]): DirExplorerSource {
  return {
    version: 1,
    rowDriven: false,
    rootDirs: async () => {
      calls.push('rootDirs');
      return [DIRS[2]];
    },
    childDirs: async () => {
      calls.push('childDirs');
      return [];
    },
    allDirs: async () => {
      calls.push('allDirs');
      return DIRS;
    },
    matchingRuleDirs: async () => new Set<number>(),
    matchingCounts: async () => undefined,
    dirMembers: async () => MEMBERS,
    dirMemberIds: async () => [],
  };
}

type PaneAttrs = Parameters<DirExplorerPanel['view']>[0]['attrs'];

// The pane fetches on render and paints on the next frame, so a mounted test
// renders, lets the promises land, and renders again. Into the *same* root, so
// that the component instance - and therefore everything it caches - survives:
// what a filter does to those caches is half of what is being checked.
async function rerender(root: HTMLElement, attrs: PaneAttrs): Promise<void> {
  m.render(root, m(DirExplorerPanel, attrs));
  await new Promise((r) => setTimeout(r, 0));
  m.render(root, m(DirExplorerPanel, attrs));
}

async function renderPane(attrs: PaneAttrs): Promise<HTMLElement> {
  const root = document.createElement('div');
  await rerender(root, attrs);
  return root;
}

function dirNames(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('.pf-dune-explorer__dir-name')).map(
    (el) => el.textContent ?? '',
  );
}

describe('DirExplorerPanel over a row-driven source', () => {
  test('draws the tree from the counts, with no filter typed', async () => {
    const root = await renderPane({
      controller: fakeController(),
      source: rowDrivenSource(),
    });

    // One root row: the pass-through run from `_build` collapses onto the only
    // directory anything counted in, and `bin` - which holds 40 deps in the
    // mirror and none of the rows - is not drawn at all.
    expect(dirNames(root)).toEqual(['_build/default/lib/']);
    expect(root.textContent).not.toContain('bin');
  });

  test('qualifies the counts by the totals they were drawn from', async () => {
    const root = await renderPane({
      controller: fakeController(),
      source: rowDrivenSource(),
    });

    // The directory holds 3 rules and 5 deps; the query selected 1 and 2 of
    // them. A bare "1 rule · 2 deps" would claim the directory is that small,
    // so both are qualified by the total they were drawn from.
    const counts = root.querySelector('.pf-dune-tree__group-count');
    expect(counts?.textContent).toContain('1 of 3 rules');
    expect(counts?.textContent).toContain('2 of 5 deps');
  });

  test('still offers the filter bar and the Filters menu', async () => {
    // "Already narrowed by its query" is not "cannot be narrowed further": the
    // source re-queries for everything it shows, so the filter's predicates go
    // into those queries alongside its own semi-join (see `rowDriven`).
    const root = await renderPane({
      controller: fakeController(),
      source: rowDrivenSource(),
    });

    expect(root.querySelector('.pf-dune-explorer__filter')).not.toBeNull();
    expect(root.textContent).toContain('Filters');
    expect(root.textContent).toContain('Collapse all');
  });

  test('narrows through the source, and drops what it cached under no filter', async () => {
    const {source, counts, members} = recordingRowDrivenSource();
    const attrs = {controller: fakeController(), source};
    const root = await renderPane(attrs);

    // Expand the directory, so that a member page exists to be invalidated.
    dirHeader(root)?.click();
    await rerender(root, attrs);
    expect(members).toHaveLength(1);
    expect(filterActive(members[0].filter)).toBe(false);

    typeFilter(root, 'a.ml');
    await rerender(root, attrs);

    // Both count channels re-read under the filter, and the member page with
    // them: `apply` clears the member cache and its keys carry the filter's
    // fingerprint, so nothing read before the filter is served after it.
    expect(counts.filter(filterActive).map((f) => f.path?.text)).toEqual([
      'a.ml',
      'a.ml',
    ]);
    expect(members).toHaveLength(2);
    expect(members[1].filter.path?.text).toBe('a.ml');
    // `lib` is in the source's matching directories, so its rules can match at
    // all - the pane passes that in rather than making the query test it.
    expect(members[1].dirPathMatches).toBe(true);
  });

  test('qualifies the chip against the rows the query returned', async () => {
    // Two narrowings are active, so "1 matching" would be read against the
    // whole build. The 3 is what the query itself selected.
    const {source} = recordingRowDrivenSource();
    const attrs = {controller: fakeController(), source};
    const root = await renderPane(attrs);

    typeFilter(root, 'a.ml');
    await rerender(root, attrs);

    expect(
      root.querySelector('.pf-dune-explorer__filter-count')?.textContent,
    ).toBe('1 of 3 matching');
  });

  test('offers the narrowing button only when the mount takes one', async () => {
    const plain = await renderPane({
      controller: fakeController(),
      source: rowDrivenSource(),
    });
    expect(narrowButton(plain)).toBeUndefined();

    const narrowed: DirEntry[] = [];
    const root = await renderPane({
      controller: fakeController(),
      source: rowDrivenSource(),
      onFilterToDir: (d) => narrowed.push(d),
    });
    narrowButton(root)?.click();
    expect(narrowed.map((d) => d.path)).toEqual(['_build/default/lib']);
  });
});

/**
 * The narrowing button as a toggle. The pane cannot know which directory is
 * narrowed to - it hands one out and hears nothing back - so the answer comes
 * in as `filteredDirId`, and all the pane does is draw the button pressed and
 * report the click.
 */
describe('DirExplorerPanel narrowing toggle', () => {
  test('draws the button pressed for the directory it is told about', async () => {
    const root = await renderPane({
      controller: fakeController(),
      source: rowDrivenSource(),
      onFilterToDir: () => {},
      filteredDirId: 2,
    });

    const button = narrowButton(root)!;
    expect(button.classList.contains('pf-active')).toBe(true);
    expect(button.querySelector('.pf-filled')).not.toBeNull();
    expect(button.getAttribute('title')).toContain('Stop narrowing');
  });

  test('leaves it unpressed when the brushed directory has no row', async () => {
    // Deliberately `bin`, which holds 40 deps in the mirror and none of the
    // query's rows: nothing matching is under it, so it gets no row at all and
    // `rowIdFor` says so by returning undefined. Nothing draws pressed, which
    // is the honest answer - the brushed directory is not on screen, rather
    // than some other row owning the brush.
    const root = await renderPane({
      controller: fakeController(),
      source: rowDrivenSource(),
      onFilterToDir: () => {},
      filteredDirId: 3,
    });

    const button = narrowButton(root)!;
    expect(button.classList.contains('pf-active')).toBe(false);
    expect(button.querySelector('.pf-filled')).toBeNull();
    expect(button.getAttribute('title')).toContain('Narrow everything else');
  });

  test('presses the row that swallowed the brushed directory', async () => {
    // The brush names `_build`, which under these rows is swallowed by the
    // compressed row for `_build/default`. Comparing the id raw pressed
    // nothing, which left the toggle with no way back: clicking any row
    // re-brushed that row instead of clearing the brush.
    const narrowed: DirEntry[] = [];
    const attrs = {
      controller: fakeController(),
      source: twoBranchRowDrivenSource(),
      onFilterToDir: (d: DirEntry) => narrowed.push(d),
      filteredDirId: 0,
    };
    const root = await renderPane(attrs);
    // Opened, so that the directories under the compressed row have rows - and
    // therefore buttons - of their own to be told apart from it.
    dirHeader(root)?.click();
    await rerender(root, attrs);
    expect(dirNames(root)).toEqual(['_build/default/', 'bin/', 'lib/']);

    const buttons = narrowButtons(root);
    expect(buttons.map((b) => b.classList.contains('pf-active'))).toEqual([
      true,
      false,
      false,
    ]);

    // And the click reports the row's own directory, since that is the one the
    // caller can hand back as `filteredDirId` next time.
    buttons[0].click();
    expect(narrowed.map((d) => d.path)).toEqual(['_build/default']);
  });

  test('reports a click on the pressed button like any other', async () => {
    // Which way the click goes is the caller's decision, since it owns the
    // filter; the pane's job is to report it either way.
    const narrowed: DirEntry[] = [];
    const root = await renderPane({
      controller: fakeController(),
      source: rowDrivenSource(),
      onFilterToDir: (d) => narrowed.push(d),
      filteredDirId: 2,
    });

    narrowButton(root)!.click();
    expect(narrowed.map((d) => d.id)).toEqual([2]);
  });

  test('does not expand the row it is on', async () => {
    // The button sits inside the header whose click expands the directory, so
    // a click that reached it would open the directory as a side effect.
    const source = rowDrivenSource();
    const attrs = {
      controller: fakeController(),
      source,
      onFilterToDir: () => {},
    };
    const root = await renderPane(attrs);
    expect(root.querySelector('.pf-dune-tree__children')).toBeNull();

    narrowButton(root)!.click();
    await rerender(root, attrs);
    expect(root.querySelector('.pf-dune-tree__children')).toBeNull();
  });
});

describe('DirExplorerPanel over a hierarchy source', () => {
  test('descends lazily and reads no whole hierarchy', async () => {
    const calls: string[] = [];
    const root = await renderPane({
      controller: fakeController(),
      source: hierarchySource(calls),
    });

    expect(calls).toEqual(['rootDirs']);
    expect(dirNames(root)).toEqual(['_build/default/lib/']);
  });

  test('still offers the filter bar and the Filters menu', async () => {
    const root = await renderPane({
      controller: fakeController(),
      source: hierarchySource([]),
    });

    expect(root.querySelector('.pf-dune-explorer__filter')).not.toBeNull();
    expect(root.textContent).toContain('Filters');
  });

  test("filters and unfilters with none of the chart mount's attrs", async () => {
    // The side panel passes neither `onFilterToDir` nor `filteredDirId`, so
    // both have to be genuinely optional - including on the paths that filter
    // and unfilter.
    const calls: string[] = [];
    const attrs = {
      controller: fakeController(),
      source: hierarchySource(calls),
    };
    const root = await renderPane(attrs);
    expect(calls).toEqual(['rootDirs']);

    typeFilter(root, 'lib');
    await rerender(root, attrs);
    // The filtered tree, compressed over what survives: this fake's counts say
    // "all of them", so the run above `_build/default` collapses onto the first
    // row with two visible children.
    expect(dirNames(root)).toEqual(['_build/default/']);
    expect(narrowButton(root)).toBeUndefined();

    clearChip(root)?.click();
    await rerender(root, attrs);
    // Back on the lazy descent, with the filter's whole-hierarchy read behind
    // it and no second `rootDirs` (the roots are still cached).
    expect(calls).toEqual(['rootDirs', 'allDirs']);
    expect(dirNames(root)).toEqual(['_build/default/lib/']);
  });

  test('shows the stored rollups a narrowed pane has to drop', async () => {
    // Unqualified counts, plus the failure count and duration, which are stored
    // over every member and so cannot be narrowed to a subset.
    const failing = dir({
      id: 4,
      path: 'lib',
      nRules: 2,
      tRules: 2,
      nFailed: 1,
      tFailed: 1,
      totalDurNs: 5_000_000n,
    });
    const source: DirExplorerSource = {
      ...hierarchySource([]),
      rootDirs: async () => [failing],
    };
    const root = await renderPane({controller: fakeController(), source});

    const counts = root.querySelector('.pf-dune-tree__group-count');
    expect(counts?.textContent).toContain('2 rules');
    expect(counts?.textContent).toContain('1 failed');
  });
});

/**
 * The select affordance, which is the only row control that is not always
 * offered: `controller.goToDir` selects a directory's `gen-rules` span, and a
 * directory dune generated no rules for has none - so on those rows the button
 * would be a control that does nothing.
 */
describe('DirExplorerPanel select affordance', () => {
  // Two sibling roots holding the same thing, differing only in whether dune
  // generated rules for them.
  const WITH_SPAN = dir({
    id: 4,
    path: 'lib',
    nRules: 2,
    tRules: 2,
    nGenRules: 1,
  });
  const WITHOUT_SPAN = dir({
    id: 5,
    path: 'gen',
    nRules: 1,
    tRules: 1,
    nGenRules: 0,
  });

  function paneOver(
    dirs: readonly DirEntry[],
    seen: number[],
  ): Promise<HTMLElement> {
    return renderPane({
      controller: fakeController({
        goToDir: async (dirId: number) => void seen.push(dirId),
      }),
      source: {...hierarchySource([]), rootDirs: async () => [...dirs]},
    });
  }

  test('is offered only for a directory with a gen-rules span', async () => {
    const root = await paneOver([WITH_SPAN, WITHOUT_SPAN], []);

    expect(dirNames(root)).toEqual(['lib/', 'gen/']);
    expect(selectButtons(root).map((b) => b.getAttribute('title'))).toEqual([
      'Select lib',
    ]);
  });

  test('selects the directory it sits on', async () => {
    const seen: number[] = [];
    const root = await paneOver([WITH_SPAN, WITHOUT_SPAN], seen);

    selectButtons(root)[0].click();
    expect(seen).toEqual([4]);
  });

  test('sits beside the name, not among the member actions', async () => {
    // It acts on the directory, which is what the name names; everything in
    // the actions box acts on what the directory *holds*. The chart mount,
    // because that is the one offering a narrowing button to be beside.
    const root = await renderPane({
      controller: fakeController(),
      source: {
        ...hierarchySource([]),
        rootDirs: async () => [WITH_SPAN],
      },
      onFilterToDir: () => {},
    });

    expect(
      Array.from(
        root.querySelectorAll('.pf-dune-tree__group-actions button'),
      ).map((b) => b.getAttribute('title')),
    ).not.toContain('Select lib');
    const select = root.querySelector(
      '.pf-dune-tree__group-select button',
    ) as HTMLElement | null;
    expect(select?.getAttribute('title')).toEqual('Select lib');
    // Directly after the name, so it reads as part of it.
    expect(
      select?.closest('.pf-dune-tree__group-select')?.previousElementSibling
        ?.className,
    ).toContain('pf-dune-explorer__dir-name');
  });

  test('draws a row that holds nothing but a span', async () => {
    // The select button lives outside the actions box, which is skipped
    // entirely when there is nothing to act on - so a directory with no
    // members of its own keeps it.
    const empty = dir({id: 6, path: 'scaffolding', nGenRules: 1, tRules: 1});
    const root = await paneOver([empty], []);

    expect(selectButtons(root)).toHaveLength(1);
  });
});

/**
 * The reveal route: the directory panel asks the controller to expand this
 * pane's tree down to a directory (see controller.ts's `revealDirInExplorer`),
 * and the pane works through it a level per redraw, because each level is a
 * query.
 */
describe('DirExplorerPanel revealing a directory', () => {
  // Three levels, one child each, so every step of the descent is a fetch.
  const LEVELS: ReadonlyMap<number, readonly DirEntry[]> = new Map([
    [-1, [dir({id: 1, path: '_build/default', tRules: 3})]],
    [1, [dir({id: 2, parentId: 1, path: '_build/default/lib', tRules: 3})]],
    [
      2,
      [
        dir({
          id: 3,
          parentId: 2,
          path: '_build/default/lib/foo',
          nRules: 3,
          tRules: 3,
          nGenRules: 1,
        }),
      ],
    ],
    [3, []],
  ]);
  const PATHS = new Map(
    [...LEVELS.values()].flat().map((d) => [d.id, d.path] as const),
  );

  function revealable(): {
    attrs: PaneAttrs;
    reveal: (dirId: number) => void;
  } {
    let serial = 0;
    const controller = {
      mirrorVersion: 1,
      nodeMirrorReady: true,
      busy: false,
      requestRedraw: () => {},
      nodeForNodeId: () => undefined,
      goToDir: async () => {},
      selectedWindow: () => undefined,
      dirPath: (id: number) => PATHS.get(id),
      explorerRevealRequest: undefined as
        {dirId: number; serial: number} | undefined,
    };
    const attrs: PaneAttrs = {
      controller: controller as unknown as DuneGraphController,
      source: {
        ...hierarchySource([]),
        rootDirs: async () => [...LEVELS.get(-1)!],
        childDirs: async (id: number) => [...(LEVELS.get(id) ?? [])],
      },
    };
    return {
      attrs,
      reveal: (dirId: number) => {
        controller.explorerRevealRequest = {dirId, serial: ++serial};
      },
    };
  }

  test('expands every level above it, a redraw at a time', async () => {
    const {attrs, reveal} = revealable();
    const root = await renderPane(attrs);
    expect(dirNames(root)).toEqual(['_build/default/']);

    reveal(3);
    // One redraw per level, because each level is a query: the fetch the walk
    // starts asks for the redraw that resumes it.
    await rerender(root, attrs);
    expect(dirNames(root)).toEqual(['_build/default/', 'lib/']);
    await rerender(root, attrs);
    expect(dirNames(root)).toEqual(['_build/default/', 'lib/', 'foo/']);

    // And the target itself is left open, which is what says the walk arrived
    // rather than stopping one short: three open rows, not two.
    await rerender(root, attrs);
    expect(root.querySelectorAll('.pf-dune-tree__children')).toHaveLength(3);
  });

  test('gives up where no row leads there, rather than expanding the tree', async () => {
    const {attrs, reveal} = revealable();
    const root = await renderPane(attrs);

    // A directory of some other subtree: the first level holds no row whose
    // path contains it.
    reveal(9);
    await rerender(root, attrs);
    await rerender(root, attrs);
    expect(dirNames(root)).toEqual(['_build/default/']);
  });

  test('ignores a directory the mirror has no path for', async () => {
    // Every id at all before the mirror is built, and any id of a replaced
    // one. There is nothing to match rows against, so the request is dropped.
    const {attrs, reveal} = revealable();
    const root = await renderPane(attrs);

    reveal(404);
    await rerender(root, attrs);
    expect(dirNames(root)).toEqual(['_build/default/']);
  });

  test('descends in one go while a filter is active', async () => {
    // The filtered tree is the whole hierarchy in memory, so every level is a
    // lookup rather than a query and the walk runs to the end in one render.
    const {attrs, reveal} = revealable();
    const filtered: PaneAttrs = {...attrs, source: hierarchySource([])};
    const root = await renderPane(filtered);
    typeFilter(root, 'lib');
    await rerender(root, filtered);
    expect(dirNames(root)).toEqual(['_build/default/']);

    reveal(2);
    await rerender(root, filtered);
    expect(dirNames(root)).toEqual(['_build/default/', 'bin/', 'lib/']);
  });
});

/**
 * What a source replacement does to the pane, which is not quite what it looks
 * like: the filter is the user's input and survives, so everything derived from
 * it has to be rebuilt rather than merely dropped. Half a rebuild is silent -
 * the tree draws the source's unfiltered counts while the member queries below
 * it still carry the filter.
 */
describe('DirExplorerPanel across a source replacement', () => {
  test('re-applies the filter it kept', async () => {
    const {source, reload, members} = reloadableHierarchySource();
    const attrs = {controller: fakeController(), source};
    const root = await renderPane(attrs);

    typeFilter(root, 'a.ml');
    await rerender(root, attrs);
    expect(chipCount(root)).toBe('2 matching');

    // A graph reload: the mirror is rebuilt from scratch, so the pane throws
    // away every id it was holding and starts again.
    reload();
    await rerender(root, attrs);

    // The chip has a reach to report, which it only has from a tree...
    expect(chipCount(root)).toBe('2 matching');
    // ...and the row's numbers are the filter's: `lib` holds 5 deps and the
    // filter matched 2 of them, where an unfiltered tree would say "5 deps".
    expect(rowCounts(root)).toContain('2 of 5 deps');

    // The member query is asked under the same filter, `dirPathMatches`
    // included. This fake's filter matches no rule directory, so `lib`'s path
    // did not match - and a pane that kept the filter without rebuilding
    // `ruleDirs` would pass `true` here and quietly let every rule match.
    dirHeader(root)?.click();
    await rerender(root, attrs);
    expect(members).toHaveLength(1);
    expect(members[0].filter.path?.text).toBe('a.ml');
    expect(members[0].dirPathMatches).toBe(false);
  });

  test('rebuilds a row-driven tree with nothing typed', async () => {
    // A row-driven source's rows *are* its filter, so there is no typed filter
    // to re-apply and the tree still has to come back (see `rowDriven`).
    let version = 1;
    const source: DirExplorerSource = {
      ...rowDrivenSource(),
      get version() {
        return version;
      },
    };
    const attrs = {controller: fakeController(), source};
    const root = await renderPane(attrs);
    expect(rowCounts(root)).toContain('1 of 3 rules');

    version++;
    await rerender(root, attrs);

    expect(dirNames(root)).toEqual(['_build/default/lib/']);
    // Qualified again, which only a rebuilt tree can say: without one the row
    // would show the mirror's bare "3 rules".
    expect(rowCounts(root)).toContain('1 of 3 rules');
  });
});

/**
 * A hierarchy source that can be replaced under the pane, and that records what
 * its member queries were asked for.
 *
 * Its filter reaches deps only - no rule directory matches, and the rule counts
 * come back empty with it - which is what makes `dirPathMatches` observable: a
 * pane that lost its `ruleDirs` answers `true` for every directory instead of
 * `false` for this one.
 */
function reloadableHierarchySource(): {
  source: DirExplorerSource;
  reload: () => void;
  members: ReadonlyArray<{filter: MemberFilter; dirPathMatches: boolean}>;
} {
  let version = 1;
  const members: Array<{filter: MemberFilter; dirPathMatches: boolean}> = [];
  const source: DirExplorerSource = {
    ...hierarchySource([]),
    get version() {
      return version;
    },
    matchingRuleDirs: async () => new Set<number>(),
    matchingCounts: async (kind) =>
      kind === 'rule' ? new Map() : new Map([[2, 2]]),
    dirMembers: async (_id, _kind, _limit, _offset, filter, dirPathMatches) => {
      members.push({filter, dirPathMatches});
      return MEMBERS.filter((entry) => entry.kind === 'dep');
    },
  };
  return {source, reload: () => version++, members};
}

/**
 * A row-driven source whose rows land in *both* of `_build/default`'s children,
 * so the compressed root row is `_build/default` and the two directories under
 * it get rows of their own - three narrowing buttons to tell apart, and a
 * swallowed `_build` above them.
 */
function twoBranchRowDrivenSource(): DirExplorerSource {
  return {
    ...rowDrivenSource(),
    matchingCounts: async (kind: NodeKind) =>
      kind === 'rule'
        ? new Map([[2, 1]])
        : new Map([
            [2, 2],
            [3, 4],
          ]),
  };
}

/**
 * A row-driven source that records what it was asked for and actually narrows
 * itself when handed a filter, which is what the pane's filter UI expects of
 * one.
 *
 * The directory holds 1 rule and 2 deps of the query's rows; the filter keeps
 * one dep of them. Both channels are asked, since the pane cannot know which
 * kinds a filter reaches.
 */
function recordingRowDrivenSource(): {
  source: DirExplorerSource;
  counts: MemberFilter[];
  members: ReadonlyArray<{filter: MemberFilter; dirPathMatches: boolean}>;
} {
  const counts: MemberFilter[] = [];
  const members: Array<{filter: MemberFilter; dirPathMatches: boolean}> = [];
  const source: DirExplorerSource = {
    ...rowDrivenSource(),
    // Only `lib`'s own path matches, which is where the rules could match.
    matchingRuleDirs: async () => new Set([2]),
    matchingCounts: async (kind, filter) => {
      counts.push(filter);
      if (filterActive(filter)) {
        return kind === 'rule' ? new Map() : new Map([[2, 1]]);
      }
      return kind === 'rule' ? new Map([[2, 1]]) : new Map([[2, 2]]);
    },
    dirMembers: async (_id, _kind, _limit, _offset, filter, dirPathMatches) => {
      members.push({filter, dirPathMatches});
      return MEMBERS;
    },
  };
  return {source, counts, members};
}

// The first directory row's header, which is what expands it.
function dirHeader(root: HTMLElement): HTMLElement | undefined {
  return (
    root.querySelector<HTMLElement>('.pf-dune-tree__group-header') ?? undefined
  );
}

// Types `text` into the filter box and submits it, the way the box's own
// handlers see it: the draft follows `input`, and only Enter applies it.
function typeFilter(root: HTMLElement, text: string): void {
  const input = root.querySelector('input');
  if (input === null) throw new Error('no filter input');
  input.value = text;
  input.dispatchEvent(new Event('input', {bubbles: true}));
  input.dispatchEvent(
    new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}),
  );
}

// The pane's per-row "narrow everything else to here" button, found by the one
// thing that distinguishes it from the bulk pair beside it. Matched loosely
// because the title says which way the toggle would go ("Narrow everything else
// to …" / "Stop narrowing …"), and both are this button.
function narrowButtons(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll('button')).filter((b) =>
    /narrow/i.test(b.getAttribute('title') ?? ''),
  );
}

function narrowButton(root: HTMLElement): HTMLElement | undefined {
  return narrowButtons(root)[0];
}

// The row buttons that select a directory's `gen-rules` span, in row order.
function selectButtons(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll('button')).filter((b) =>
    (b.getAttribute('title') ?? '').startsWith('Select '),
  );
}

// What the active filter's chip says about its reach, or undefined where there
// is no chip. `''` is a distinct and wrong answer - a chip with nothing in it -
// which is why this does not flatten the two together.
function chipCount(root: HTMLElement): string | undefined {
  return (
    root.querySelector('.pf-dune-explorer__filter-count')?.textContent ??
    undefined
  );
}

// The first directory row's numbers.
function rowCounts(root: HTMLElement): string {
  return root.querySelector('.pf-dune-tree__group-count')?.textContent ?? '';
}

// The active filter chip's dismiss button, which is how the filter is cleared
// from the filter bar rather than from the Filters menu.
function clearChip(root: HTMLElement): HTMLElement | undefined {
  return (
    root.querySelector<HTMLElement>('.pf-dune-explorer__filter-chip button') ??
    undefined
  );
}
