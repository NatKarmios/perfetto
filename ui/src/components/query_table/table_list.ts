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

import './table_list.scss';
import m from 'mithril';
import {fuzzySearch, type FuzzySegment} from '../../base/fuzzy';
import {Accordion, AccordionSection} from '../../widgets/accordion';
import {Button} from '../../widgets/button';
import {CopyToClipboardButton} from '../../widgets/copy_to_clipboard_button';
import {Icon} from '../../widgets/icon';
import {TextInput} from '../../widgets/text_input';
import {
  perfettoSqlTypeIcon,
  perfettoSqlTypeToString,
} from '../../trace_processor/perfetto_sql_type';
import type {PerfettoSqlType} from '../../trace_processor/perfetto_sql_type';
import {EmptyState} from '../../widgets/empty_state';

// What this list needs to know about a column. `SqlColumn` from SqlModules
// satisfies it structurally, so a caller with a stdlib catalogue passes its
// tables straight through; a caller documenting tables it created itself (the
// Dune plugin's `dune_*` mirror, say) writes the same shape by hand.
export interface TableListColumn {
  readonly name: string;
  readonly description?: string;
  readonly type?: PerfettoSqlType;
}

// What this list needs to know about a table. `SqlTable` satisfies this too -
// deliberately a structural subset of it rather than an import, so that
// components/ doesn't depend on a plugin.
export interface TableListEntry {
  readonly name: string;
  readonly description?: string;
  // `INCLUDE PERFETTO MODULE <key>;`, prepended to the generated query and
  // offered for copying. Absent for a table that is already in scope.
  readonly includeKey?: string;
  readonly columns: ReadonlyArray<TableListColumn>;
  // SQL to open when the "run" button is pressed, in place of the generated
  // `SELECT <columns> FROM <name>`. For an entry that can't simply be selected
  // from - a table function, whose name is a call needing arguments - the
  // generated form would land the user with SQL that doesn't run.
  readonly exampleQuery?: string;
}

// One titled group of tables. Sections are rendered in the order given, each
// under its own heading; a section that no longer matches the search filter is
// dropped rather than shown empty.
export interface TableListSection {
  readonly title: string;
  readonly tables: ReadonlyArray<TableListEntry>;
}

interface FilteredTable {
  readonly table: TableListEntry;
  readonly segments: readonly FuzzySegment[];
}

function renderHighlightedName(segments: readonly FuzzySegment[]): m.Children {
  return segments.map(({matching, value}) =>
    matching ? m('span.pf-simple-table-list__highlight', value) : value,
  );
}

export interface TableListAttrs {
  readonly sections: ReadonlyArray<TableListSection>;
  // Called when user wants to query a table in a new tab
  onQueryTable?(tableName: string, query: string): void;
}

export class TableList implements m.ClassComponent<TableListAttrs> {
  private searchQuery = '';

  view({attrs}: m.CVnode<TableListAttrs>): m.Children {
    const searchTerm = this.searchQuery.trim();
    const sections = attrs.sections
      .map((section) => ({
        title: section.title,
        tables: filterTables(section.tables, searchTerm),
      }))
      // A section whose tables all filtered out says nothing useful, so it
      // goes rather than leaving a run of empty headings behind.
      .filter((section) => section.tables.length > 0);

    return m(
      '.pf-simple-table-list',
      m(TextInput, {
        className: 'pf-simple-table-list__search',
        placeholder: 'Search tables...',
        value: this.searchQuery,
        leftIcon: 'search',
        onInput: (value) => {
          this.searchQuery = value;
        },
      }),
      sections.length > 0
        ? m(
            '.pf-simple-table-list__items',
            sections.map((section) => [
              // Only worth a heading when there's more than one group to tell
              // apart; a single-section list is just a list of tables.
              attrs.sections.length > 1 &&
                m(
                  '.pf-simple-table-list__section-title',
                  section.title,
                  m(
                    'span.pf-simple-table-list__section-count',
                    section.tables.length,
                  ),
                ),
              m(
                Accordion,
                this.renderSections(
                  section.title,
                  section.tables,
                  attrs.onQueryTable,
                ),
              ),
            ]),
          )
        : m(EmptyState, {
            title: 'No matching tables found',
          }),
    );
  }

  private renderSections(
    sectionTitle: string,
    filteredTables: ReadonlyArray<FilteredTable>,
    onQueryTable?: (tableName: string, query: string) => void,
  ): m.Children {
    // Table names are usually unique, but a registered SQL package can declare
    // one that already exists in the stdlib, so the same name can appear more
    // than once. Suffix repeats to keep the accordion keys unique: mithril
    // crashes on duplicate keys during its keyed diff.
    const nameCounts = new Map<string, number>();
    return filteredTables.map(({table, segments}) => {
      const dup = nameCounts.get(table.name) ?? 0;
      nameCounts.set(table.name, dup + 1);
      // Section-qualified, so the same table name appearing in two sections
      // can't collide either.
      const key =
        dup === 0
          ? `${sectionTitle}/${table.name}`
          : `${sectionTitle}/${table.name} (${dup})`;
      return m(
        AccordionSection,
        {
          key,
          summary: m(
            'code.pf-simple-table-list__item-name',
            renderHighlightedName(segments),
          ),
        },
        m(TableContent, {table, onQueryTable}),
      );
    });
  }
}

// Fuzzy-filters one section's tables, ordered by relevance, keeping the match
// segments so the name can be highlighted. An empty term keeps everything in
// its given order.
function filterTables(
  tables: ReadonlyArray<TableListEntry>,
  searchTerm: string,
): readonly FilteredTable[] {
  if (searchTerm === '') {
    return tables.map((table) => ({
      table,
      segments: [{matching: false, value: table.name}],
    }));
  }
  return fuzzySearch(tables, (t) => t.name, searchTerm).map((result) => ({
    table: result.item,
    segments: result.segments,
  }));
}

interface TableContentAttrs {
  readonly table: TableListEntry;
  onQueryTable?(tableName: string, query: string): void;
}

const TableContent: m.Component<TableContentAttrs> = {
  view({attrs}: m.CVnode<TableContentAttrs>): m.Children {
    const {table, onQueryTable} = attrs;
    return [
      // Description
      table.description &&
        m('.pf-simple-table-list__description', table.description),

      m(
        '.pf-simple-table-list__detail-row',
        m('span.pf-simple-table-list__detail-label', 'Table name'),
        m('code.pf-simple-table-list__detail-value', table.name),
        m(CopyToClipboardButton, {
          className: 'pf-show-on-hover',
          textToCopy: table.name,
          tooltip: 'Copy table name to clipboard',
        }),
        onQueryTable &&
          m(Button, {
            className: 'pf-show-on-hover',
            icon: 'play_arrow',
            compact: true,
            tooltip: `SELECT * FROM ${table.name} in a new tab`,
            onclick: () => onQueryTable(table.name, generateQuery(table)),
          }),
      ),
      // Module
      table.includeKey &&
        m(
          '.pf-simple-table-list__detail-row',
          m('span.pf-simple-table-list__detail-label', 'Include'),
          m(
            'code.pf-simple-table-list__detail-value',
            `INCLUDE PERFETTO MODULE ${table.includeKey};`,
          ),
          m(CopyToClipboardButton, {
            className: 'pf-show-on-hover',
            textToCopy: `INCLUDE PERFETTO MODULE ${table.includeKey};`,
            tooltip: 'Copy include string to clipboard',
          }),
        ),

      // Columns
      table.columns.length > 0 &&
        m(
          '.pf-simple-table-list__columns',
          m('span.pf-simple-table-list__detail-label', 'Columns'),
          m(
            '.pf-simple-table-list__column-list',
            table.columns.map((col) =>
              m(
                '.pf-simple-table-list__column',
                m(Icon, {
                  icon: perfettoSqlTypeIcon(col.type),
                  className: 'pf-simple-table-list__column-icon',
                }),
                m(
                  '.pf-simple-table-list__column-info',
                  m(
                    '.pf-simple-table-list__column-header',
                    m('code.pf-simple-table-list__column-name', col.name),
                    m(
                      '.pf-simple-table-list__column-copy',
                      m(CopyToClipboardButton, {
                        textToCopy: col.name,
                        compact: true,
                        tooltip: 'Copy column name to clipboard',
                      }),
                    ),
                    m(
                      'span.pf-simple-table-list__column-type',
                      perfettoSqlTypeToString(col.type),
                    ),
                  ),
                  col.description &&
                    m('.pf-simple-table-list__column-desc', col.description),
                ),
              ),
            ),
          ),
        ),
    ];
  },
};

function generateQuery(table: TableListEntry): string {
  if (table.exampleQuery !== undefined) return table.exampleQuery;

  const lines: string[] = [];

  // Add INCLUDE statement if needed
  if (table.includeKey) {
    lines.push(`INCLUDE PERFETTO MODULE ${table.includeKey};`);
    lines.push('');
  }

  // Build SELECT with all columns
  const columns =
    table.columns.length > 0
      ? table.columns.map((c) => c.name).join(',\n  ')
      : '*';

  lines.push('SELECT');
  lines.push(`  ${columns}`);
  lines.push(`FROM ${table.name}`);
  lines.push('LIMIT 1000');

  return lines.join('\n');
}
