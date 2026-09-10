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

import type {DunePageTab, DuneTabList} from './query_page';
import {
  addTab,
  closeTab,
  nextTabTitle,
  renameTab,
  reorderTabs,
  restoreTabs,
  setTabText,
} from './query_page';
import type {PersistedTab} from '../../components/query_table/tab_persistence';
import type {DuneQueryResults} from './query_results';

// None of the helpers under test touch `results` - it rides along so the page
// can hand each tab its own results view - so the tests hand them a
// placeholder rather than a real one, which would want a Trace and a loaded
// controller.
const RESULTS = undefined as unknown as DuneQueryResults;

function tab(id: string, title = id, editorText = ''): DunePageTab {
  return {id, title, editorText, results: RESULTS};
}

// The two things every assertion here is about: the order of the strip and
// which tab is showing.
function project(state: DuneTabList) {
  return {ids: state.tabs.map((t) => t.id), active: state.activeTabId};
}

describe('nextTabTitle', () => {
  it('starts at Query 1', () => {
    expect(nextTabTitle([])).toBe('Query 1');
  });

  it('picks the lowest free number, not the next highest', () => {
    const tabs = [tab('a', 'Query 1'), tab('b', 'Query 3')];
    expect(nextTabTitle(tabs)).toBe('Query 2');
  });

  it('skips the whole run of taken numbers', () => {
    const tabs = [
      tab('a', 'Query 1'),
      tab('b', 'Query 2'),
      tab('c', 'Query 3'),
    ];
    expect(nextTabTitle(tabs)).toBe('Query 4');
  });

  it('ignores renamed tabs', () => {
    const tabs = [tab('a', 'scratch'), tab('b', 'Query 2')];
    expect(nextTabTitle(tabs)).toBe('Query 1');
  });
});

describe('addTab', () => {
  it('appends the tab and focuses it', () => {
    const state = {tabs: [tab('a')], activeTabId: 'a'};
    expect(project(addTab(state, tab('b')))).toEqual({
      ids: ['a', 'b'],
      active: 'b',
    });
  });
});

describe('closeTab', () => {
  it('activates the tab that took the closed one’s place', () => {
    const state = {tabs: [tab('a'), tab('b'), tab('c')], activeTabId: 'b'};
    expect(project(closeTab(state, 'b'))).toEqual({
      ids: ['a', 'c'],
      active: 'c',
    });
  });

  it('activates the new last tab when the last one was closed', () => {
    const state = {tabs: [tab('a'), tab('b'), tab('c')], activeTabId: 'c'};
    expect(project(closeTab(state, 'c'))).toEqual({
      ids: ['a', 'b'],
      active: 'b',
    });
  });

  it('leaves the active tab alone when closing another one', () => {
    const state = {tabs: [tab('a'), tab('b'), tab('c')], activeTabId: 'a'};
    expect(project(closeTab(state, 'c'))).toEqual({
      ids: ['a', 'b'],
      active: 'a',
    });
  });

  it('refuses to close the last remaining tab', () => {
    const state = {tabs: [tab('a')], activeTabId: 'a'};
    expect(closeTab(state, 'a')).toBe(state);
  });

  it('ignores an unknown id', () => {
    const state = {tabs: [tab('a'), tab('b')], activeTabId: 'a'};
    expect(closeTab(state, 'zzz')).toBe(state);
  });
});

describe('renameTab', () => {
  it('retitles just that tab', () => {
    const state = {tabs: [tab('a'), tab('b')], activeTabId: 'a'};
    const next = renameTab(state, 'b', 'scratch');
    expect(next.tabs.map((t) => t.title)).toEqual(['a', 'scratch']);
    expect(next.activeTabId).toBe('a');
  });

  it('leaves the rest of the tab untouched', () => {
    const state = {tabs: [tab('a', 'a', 'select 1')], activeTabId: 'a'};
    const [renamed] = renameTab(state, 'a', 'scratch').tabs;
    expect(renamed.editorText).toBe('select 1');
    expect(renamed.results).toBe(RESULTS);
  });
});

describe('setTabText', () => {
  it('replaces just that tab’s buffer', () => {
    const state = {tabs: [tab('a'), tab('b')], activeTabId: 'a'};
    const next = setTabText(state, 'a', 'select 2');
    expect(next.tabs.map((t) => t.editorText)).toEqual(['select 2', '']);
  });
});

describe('reorderTabs', () => {
  it('moves a tab before the given id', () => {
    const state = {tabs: [tab('a'), tab('b'), tab('c')], activeTabId: 'b'};
    expect(project(reorderTabs(state, 'c', 'b'))).toEqual({
      ids: ['a', 'c', 'b'],
      active: 'b',
    });
  });

  it('moves a tab to the end when no id is given', () => {
    const state = {tabs: [tab('a'), tab('b'), tab('c')], activeTabId: 'a'};
    expect(project(reorderTabs(state, 'a', undefined))).toEqual({
      ids: ['b', 'c', 'a'],
      active: 'a',
    });
  });

  it('treats an unknown target as the end', () => {
    const state = {tabs: [tab('a'), tab('b')], activeTabId: 'a'};
    expect(project(reorderTabs(state, 'a', 'zzz'))).toEqual({
      ids: ['b', 'a'],
      active: 'a',
    });
  });

  it('is a no-op for a drag onto itself', () => {
    const state = {tabs: [tab('a'), tab('b')], activeTabId: 'a'};
    expect(project(reorderTabs(state, 'b', 'b'))).toEqual({
      ids: ['a', 'b'],
      active: 'a',
    });
  });

  // The case the one above can't catch: a tab that is already last stays last
  // either way, so only a tab with something to its right proves the drag-onto
  // -itself guard is doing anything.
  it('leaves a middle tab where it is when dropped before itself', () => {
    const state = {
      tabs: [tab('a'), tab('b'), tab('c')],
      activeTabId: 'a',
    };
    expect(project(reorderTabs(state, 'b', 'b'))).toEqual({
      ids: ['a', 'b', 'c'],
      active: 'a',
    });
  });

  it('ignores an unknown dragged id', () => {
    const state = {tabs: [tab('a'), tab('b')], activeTabId: 'a'};
    expect(reorderTabs(state, 'zzz', 'a')).toBe(state);
  });
});

describe('restoreTabs', () => {
  // What the page passes is `makeTab`, which builds a real results view and so
  // wants a Trace; the helper takes the factory precisely so a test can pass
  // the same placeholder tabs the rest of this file uses.
  const make = (fields: PersistedTab) =>
    tab(fields.id, fields.title, fields.editorText);

  const stored = (id: string, title = id, editorText = ''): PersistedTab => ({
    id,
    title,
    editorText,
  });

  it('keeps the stored order and the stored focus', () => {
    const persisted = {
      tabs: [stored('a'), stored('b'), stored('c')],
      activeTabId: 'b',
    };
    expect(project(restoreTabs(persisted, make))).toEqual({
      ids: ['a', 'b', 'c'],
      active: 'b',
    });
  });

  it('carries each tab’s title and buffer', () => {
    const persisted = {
      tabs: [stored('a', 'scratch', 'select 1')],
      activeTabId: 'a',
    };
    const [restored] = restoreTabs(persisted, make).tabs;
    expect(restored.id).toBe('a');
    expect(restored.title).toBe('scratch');
    expect(restored.editorText).toBe('select 1');
  });

  it('falls back to the first tab when the stored focus names no tab', () => {
    const persisted = {tabs: [stored('a'), stored('b')], activeTabId: 'zzz'};
    expect(restoreTabs(persisted, make).activeTabId).toBe('a');
  });

  // The page auto-names a *new* tab around whatever came back, rather than
  // starting over at "Query 1" and colliding with a restored one.
  it('leaves nextTabTitle to pick the lowest free name around them', () => {
    const persisted = {
      tabs: [stored('a', 'Query 1'), stored('b', 'Query 2')],
      activeTabId: 'a',
    };
    expect(nextTabTitle(restoreTabs(persisted, make).tabs)).toBe('Query 3');
  });
});
