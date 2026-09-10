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

import {loadTabs, type PersistedTab, saveTabs} from './tab_persistence';

const KEY = 'testQueryTabs';
const OTHER_KEY = 'testOtherQueryTabs';

function makeTabs(): PersistedTab[] {
  return [
    {id: 'a', title: 'Query 1', editorText: 'select 1'},
    {id: 'b', title: 'Query 2', editorText: 'select 2'},
    {id: 'c', title: 'Renamed', editorText: ''},
  ];
}

describe('tab persistence', () => {
  // The test environment is jsdom, which implements localStorage, so these
  // exercise the real storage the browser uses rather than a stub.
  beforeEach(() => {
    localStorage.clear();
  });

  test('round-trips tabs and the active tab', () => {
    const tabs = makeTabs();
    saveTabs(KEY, tabs, 'b');

    expect(loadTabs(KEY)).toEqual({tabs, activeTabId: 'b'});
  });

  test('preserves tab order', () => {
    // Tab order is user-visible (and drag-reorderable), so it has to survive
    // the round trip rather than coming back in some map-iteration order.
    const tabs = makeTabs().reverse();
    saveTabs(KEY, tabs, 'a');

    expect(loadTabs(KEY)?.tabs.map((t) => t.id)).toEqual(['c', 'b', 'a']);
  });

  test('keeps two keys apart', () => {
    // The key is a parameter precisely so that two query surfaces persisting
    // their tabs can't overwrite each other.
    saveTabs(KEY, [{id: 'a', title: 'One', editorText: 'select 1'}], 'a');
    saveTabs(OTHER_KEY, [{id: 'z', title: 'Two', editorText: 'select 2'}], 'z');

    expect(loadTabs(KEY)?.tabs.map((t) => t.id)).toEqual(['a']);
    expect(loadTabs(OTHER_KEY)?.tabs.map((t) => t.id)).toEqual(['z']);
  });

  test('loads nothing for a key never written', () => {
    expect(loadTabs(KEY)).toBeUndefined();
  });

  test('loads nothing from a blob that is not JSON', () => {
    localStorage.setItem(KEY, 'not json at all {');

    expect(loadTabs(KEY)).toBeUndefined();
  });

  test('loads nothing from valid JSON of the wrong shape', () => {
    // This is the path that matters when the schema changes between versions:
    // a blob written by an older UI still parses as JSON, so only safeParse
    // catches it, and it has to degrade to "no restore" rather than handing
    // the caller tabs with missing fields.
    localStorage.setItem(KEY, JSON.stringify({tabs: [{id: 'a'}]}));
    expect(loadTabs(KEY)).toBeUndefined();

    localStorage.setItem(KEY, JSON.stringify({activeTabId: 'a'}));
    expect(loadTabs(KEY)).toBeUndefined();

    localStorage.setItem(KEY, JSON.stringify(['a', 'b']));
    expect(loadTabs(KEY)).toBeUndefined();
  });

  test('loads nothing from an empty tab list', () => {
    // Restoring zero tabs would leave the caller with no editor open, so a
    // tab-less blob counts as nothing stored.
    saveTabs(KEY, [], '');

    expect(loadTabs(KEY)).toBeUndefined();
  });
});
