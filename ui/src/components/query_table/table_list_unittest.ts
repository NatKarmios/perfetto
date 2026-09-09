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

import m from 'mithril';
import {TableList, type TableListEntry} from './table_list';

function makeTables(names: string[]): TableListEntry[] {
  return names.map((name) => ({name, description: '', columns: []}));
}

// Types `text` into the search box one character at a time, then deletes it,
// re-rendering after every keystroke. Each render re-runs the fuzzy filter and
// re-diffs the keyed accordion, which is what triggered the original crash.
function typeSearch(root: HTMLElement, comp: m.Component, text: string) {
  const feed = (value: string) => {
    const input = root.querySelector('input');
    if (input) {
      input.value = value;
      input.dispatchEvent(new Event('input', {bubbles: true}));
    }
    m.render(root, m(comp));
  };
  for (let i = 1; i <= text.length; i++) feed(text.slice(0, i));
  for (let i = text.length - 1; i >= 0; i--) feed(text.slice(0, i));
}

// A realistic set of stdlib-like names with word structure the fuzzy finder
// can rank and reorder.
function makeNames(): string[] {
  const prefixes = [
    'cpu',
    'thread',
    'process',
    'slice',
    'memory',
    'android',
    'linux',
    'counter',
    'sched',
    'battery',
  ];
  const suffixes = [
    'counters',
    'table',
    'state',
    'info',
    'summary',
    'usage',
    'events',
    'stats',
    'metadata',
    'residency',
  ];
  const names: string[] = [];
  for (const p of prefixes) for (const s of suffixes) names.push(`${p}_${s}`);
  return names;
}

// Finds the accordion row for a table by its displayed name. Deliberately
// located by name rather than by position, so the multi-section tests below
// don't depend on the DOM shape they're guarding.
function findRow(root: HTMLElement, name: string): HTMLDetailsElement[] {
  const rows = Array.from(
    root.querySelectorAll<HTMLDetailsElement>('.pf-accordion__item'),
  );
  return rows.filter(
    (row) =>
      row.querySelector('.pf-simple-table-list__item-name')?.textContent ===
      name,
  );
}

// Expands a row the way a click on its summary would: <details> flips `open`
// and fires `toggle`, which is what AccordionSection listens to.
function expandRow(row: HTMLDetailsElement) {
  row.open = true;
  row.dispatchEvent(new Event('toggle'));
}

describe('TableList', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('renders every table and does not crash with duplicate names', () => {
    // A registered SQL package can declare a table name that already exists in
    // the stdlib, so listTables() may return the same name more than once.
    // Duplicate mithril keys used to crash the accordion's keyed diff with
    // "Cannot read properties of null (reading 'tag')" as the fuzzy results
    // reordered on each keystroke. Both entries must still render.
    const names = makeNames();
    names.splice(15, 0, names[3]);
    names.splice(40, 0, names[3]);
    names.splice(70, 0, names[8]);

    const tables = makeTables(names);
    const comp = {
      view: () => m(TableList, {sections: [{title: 'Tables', tables}]}),
    };
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.render(root, m(comp));

    // Every table is shown, including the duplicates (nothing is collapsed).
    expect(root.querySelectorAll('.pf-accordion__item')).toHaveLength(
      names.length,
    );

    expect(() => {
      for (const t of ['slice', 'cpu', 'thread', 'counter', 's', 'state']) {
        typeSearch(root, comp, t);
      }
    }).not.toThrow();
  });

  test('keeps a row expanded when an earlier section filters out', () => {
    // Sections are dropped when their tables all filter out, so the sections
    // that survive shift up. Unless each section keeps its identity across
    // renders, the survivor is diffed against a different section's accordion,
    // whose rows are keyed under another title - so every row is rebuilt and
    // silently collapses.
    const comp = {
      view: () =>
        m(TableList, {
          sections: [
            {title: 'Zebras', tables: makeTables(['zebra_x', 'zebra_y'])},
            {title: 'Quokkas', tables: makeTables(['quokka_a', 'quokka_b'])},
          ],
        }),
    };
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.render(root, m(comp));

    const [row] = findRow(root, 'quokka_a');
    expandRow(row);
    m.render(root, m(comp));
    expect(findRow(root, 'quokka_a')[0].open).toBe(true);

    // Types 'quokka' - which empties the Zebras section - then clears it again.
    typeSearch(root, comp, 'quokka');

    expect(findRow(root, 'quokka_a')[0].open).toBe(true);
  });

  test('renders a table name that appears in two sections', () => {
    // Row keys are qualified by section title precisely so that the same table
    // name in two sections doesn't collide and crash the keyed diff.
    const comp = {
      view: () =>
        m(TableList, {
          sections: [
            {title: 'Stdlib', tables: makeTables(['shared_table', 'a_only'])},
            {title: 'Plugin', tables: makeTables(['shared_table', 'b_only'])},
          ],
        }),
    };
    const root = document.createElement('div');
    document.body.appendChild(root);

    expect(() => {
      m.render(root, m(comp));
      typeSearch(root, comp, 'shared');
    }).not.toThrow();

    expect(root.querySelectorAll('.pf-accordion__item')).toHaveLength(4);
    expect(findRow(root, 'shared_table')).toHaveLength(2);
  });
});
