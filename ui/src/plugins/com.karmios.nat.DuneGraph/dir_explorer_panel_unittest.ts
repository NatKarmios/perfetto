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
import type {DuneGraphController} from './controller';
import type {DirEntry, MemberEntry, MemberFilter} from './dir_explorer';
import {filterActive} from './dir_explorer';
import type {DirExplorerSource} from './dir_explorer_source';
import {DirExplorerPanel} from './dir_explorer_panel';
import type {NodeKind} from './graph';

// Everything the pane reads off the controller while drawing directory rows and
// the member chips under them: the mirror is up, nothing is busy, a landed fetch
// has somewhere to send its redraw, and no node id resolves to a node of the
// (unloaded) graph - which is what makes a member row fall back to its raw
// value rather than needing a whole `BuildGraph` here. Bulk actions only *hold*
// the controller until they are clicked, so nothing else is needed.
function fakeController(): DuneGraphController {
  return {
    mirrorVersion: 1,
    nodeMirrorReady: true,
    busy: false,
    requestRedraw: () => {},
    nodeForNodeId: () => undefined,
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
 * The pane reporting its own filter outwards, which is the other half of the
 * `onFilterToDir` split: the pane owns the filter UI and the caller owns
 * whatever else is narrowed by it (a dashboard brush, in the chart mount - see
 * dir_explorer_chart.ts).
 *
 * Both arguments matter and both are easy to get subtly wrong. A report that
 * arrived before the tree was built would carry the previous count; one that
 * skipped the clear would leave the caller narrowed to a filter that is no
 * longer on screen.
 */
describe('DirExplorerPanel reporting its filter', () => {
  test('reports the applied filter with what it matched', async () => {
    const {source} = recordingRowDrivenSource();
    const changes: Array<{path?: string; count: number}> = [];
    const attrs = {
      controller: fakeController(),
      source,
      onFilterChange: (filter: MemberFilter, count: number) =>
        changes.push({path: filter.path?.text, count}),
    };
    const root = await renderPane(attrs);

    // The pane's initial state over a row-driven source is the empty filter,
    // which is a report in its own right: the rows are not a subset of
    // anything the pane narrowed.
    expect(changes).toEqual([{path: undefined, count: 3}]);

    typeFilter(root, 'a.ml');
    await rerender(root, attrs);

    // The count is the tree's own `matchCount`, i.e. what the filter matched -
    // not the 3 the query named.
    expect(changes[changes.length - 1]).toEqual({path: 'a.ml', count: 1});
  });

  test('reports an inactive filter when the filter is cleared', async () => {
    const {source} = recordingRowDrivenSource();
    const changes: MemberFilter[] = [];
    const attrs = {
      controller: fakeController(),
      source,
      onFilterChange: (filter: MemberFilter) => changes.push(filter),
    };
    const root = await renderPane(attrs);

    typeFilter(root, 'a.ml');
    await rerender(root, attrs);
    expect(filterActive(changes[changes.length - 1])).toBe(true);

    clearChip(root)?.click();
    await rerender(root, attrs);

    // Whatever the caller narrowed has to be un-narrowed: the filter that
    // named it is gone from the box as well as from the tree.
    expect(filterActive(changes[changes.length - 1])).toBe(false);
  });

  test('reports the filter gone when applying it failed', async () => {
    // `apply` drops the filter on a failed query, so a caller left narrowed to
    // it would be narrowed to something the tree is not showing either.
    const changes: MemberFilter[] = [];
    const source: DirExplorerSource = {
      ...rowDrivenSource(),
      matchingCounts: async (_kind, filter) => {
        if (filterActive(filter)) throw new Error('no such column');
        return new Map([[2, 1]]);
      },
    };
    const attrs = {
      controller: fakeController(),
      source,
      onFilterChange: (filter: MemberFilter) => changes.push(filter),
    };
    const root = await renderPane(attrs);

    typeFilter(root, 'a.ml');
    await rerender(root, attrs);

    expect(root.textContent).toContain('Could not apply the filter');
    expect(filterActive(changes[changes.length - 1])).toBe(false);
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

  test('leaves it unpressed for any other directory', async () => {
    // Deliberately id 0, which is `_build` - a directory the compressed row
    // above swallowed. The row is keyed on the deepest of the run (id 2), and
    // that is the id handed to `onFilterToDir`, so it is the id that has to
    // come back for the button to light up.
    const root = await renderPane({
      controller: fakeController(),
      source: rowDrivenSource(),
      onFilterToDir: () => {},
      filteredDirId: 0,
    });

    const button = narrowButton(root)!;
    expect(button.classList.contains('pf-active')).toBe(false);
    expect(button.querySelector('.pf-filled')).toBeNull();
    expect(button.getAttribute('title')).toContain('Narrow everything else');
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
    // The side panel passes neither `onFilterToDir` nor `onFilterChange` nor
    // `filteredDirId`, so every one of them has to be genuinely optional -
    // including on the paths that report a change.
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
function narrowButton(root: HTMLElement): HTMLElement | undefined {
  return Array.from(root.querySelectorAll('button')).find((b) =>
    /narrow/i.test(b.getAttribute('title') ?? ''),
  );
}

// The active filter chip's dismiss button, which is how the filter is cleared
// from the filter bar rather than from the Filters menu.
function clearChip(root: HTMLElement): HTMLElement | undefined {
  return (
    root.querySelector<HTMLElement>('.pf-dune-explorer__filter-chip button') ??
    undefined
  );
}
