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

import {z} from 'zod';

// Persists a set of query editor tabs to localStorage, so a query surface can
// restore what the user had open. Every caller passes its own storage key -
// two surfaces persisting tabs must not fight over one blob.
//
// Deliberately knows nothing about settings: whether persistence is enabled is
// the caller's business (and lives in the caller's plugin, which components/
// can't reach anyway), so a caller that is switched off simply doesn't call.

// What this module needs to know about a tab. A caller's own tab type usually
// has more on it (query results, loading flags); it maps down to this on save
// and builds back up from it on restore.
export interface PersistedTab {
  readonly id: string;
  readonly title: string;
  readonly editorText: string;
}

export interface PersistedTabs {
  readonly tabs: readonly PersistedTab[];
  readonly activeTabId: string;
}

const persistedTabSchema = z.object({
  id: z.string(),
  editorText: z.string(),
  title: z.string(),
});

const persistedTabsSchema = z.object({
  // A blob with no tabs isn't worth restoring - the caller would be left with
  // no editor at all, so it's treated as nothing stored.
  tabs: z.array(persistedTabSchema).min(1),
  activeTabId: z.string(),
});

export function saveTabs(
  key: string,
  tabs: readonly PersistedTab[],
  activeTabId: string,
): void {
  const state: PersistedTabs = {
    tabs: tabs.map((tab) => ({
      id: tab.id,
      editorText: tab.editorText,
      title: tab.title,
    })),
    activeTabId,
  };
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // localStorage can throw outright when site data is blocked (private
    // browsing, some enterprise configs). Losing the saved tabs is acceptable;
    // taking down the keystroke handler that triggered the save is not.
  }
}

// Returns undefined when there is nothing usable stored under `key`: the blob
// is absent, isn't JSON, or doesn't match the schema - which is also how a
// stale blob written by an older version degrades, rather than throwing.
export function loadTabs(key: string): PersistedTabs | undefined {
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return undefined;

    const parsed = JSON.parse(stored);
    const result = persistedTabsSchema.safeParse(parsed);
    if (!result.success) {
      return undefined;
    }
    return result.data;
  } catch {
    return undefined;
  }
}
