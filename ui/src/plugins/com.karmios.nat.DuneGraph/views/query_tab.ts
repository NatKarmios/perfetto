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

import type m from 'mithril';
import type {Tab} from '../../../public/tab';
import type {Trace} from '../../../public/trace';
import type {DuneGraphController} from '../controller';
import {DuneQueryResults} from './query_results';

/**
 * A details-drawer tab that runs SQL over the Dune graph tables and lets the
 * user push result rows into the graph selection. Driven by the `@` omnibox
 * mode / "Dune: query graph" command, which call `runQuery`.
 *
 * Everything below the tab title is `DuneQueryResults`, which knows nothing
 * about being in the drawer - so another surface can wrap the same results
 * view. This class is only the tab identity around it.
 */
export class DuneQueryTab implements Tab {
  private readonly results: DuneQueryResults;

  constructor(
    trace: Trace,
    controller: DuneGraphController,
    // Where the results view's "Open in page" button sends the query. Owned by
    // the caller because the route belongs to the plugin's entry point, not to
    // the drawer tab or the results view (see index.ts).
    onOpenInPage?: (sql: string) => void,
  ) {
    this.results = new DuneQueryResults(
      trace,
      controller,
      undefined,
      onOpenInPage,
    );
  }

  getTitle(): string {
    const n = this.results.rowCount;
    return n === undefined
      ? 'Dune query'
      : `Dune query (${n.toLocaleString()})`;
  }

  render(): m.Children {
    return this.results.render();
  }

  async runQuery(query: string): Promise<void> {
    await this.results.runQuery(query);
  }
}
