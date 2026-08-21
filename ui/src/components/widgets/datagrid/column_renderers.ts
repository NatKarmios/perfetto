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

// Maps a column's PerfettoSQL type onto the rendering bits of a DataGrid
// ColumnDef, so that every DataGrid host displays a given column the same way.
//
// Hosts build their schema by calling resolveColumnRenderers() per column
// instead of special-casing types themselves. Timestamps and durations are
// handled here directly; ID/JOINID columns are delegated to
// idColumnRenderers, a registry keyed by the *referenced* table, so a plugin
// can teach the grid how to render references to its own tables without
// touching this file.

import m from 'mithril';
import {Icons} from '../../../base/semantic_icons';
import {Duration, Time} from '../../../base/time';
import type {Trace} from '../../../public/trace';
import {
  isIdType,
  type PerfettoSqlType,
} from '../../../trace_processor/perfetto_sql_type';
import type {Row, SqlValue} from '../../../trace_processor/query_result';
import {Anchor} from '../../../widgets/anchor';
import {DurationWidget} from '../duration';
import {Timestamp} from '../timestamp';
import {renderCell} from './datagrid';
import type {CellRenderer, ColumnType} from './datagrid_schema';

/**
 * The subset of a ColumnDef that is derived from a column's type. Spread into
 * the ColumnDef by the host; every field is optional, so an empty object means
 * "render this column the default way".
 */
export interface ColumnRenderers {
  readonly columnType?: ColumnType;
  readonly cellRenderer?: CellRenderer;
  readonly actions?: (value: SqlValue, row: Row) => m.Children;
}

/** What an id-column renderer factory is told about the column. */
export interface IdColumnContext {
  readonly trace: Trace;
  /** Whether the column is the table's own id or a reference to it. */
  readonly kind: 'id' | 'joinid';
  /** The referenced table, i.e. the key this factory was registered under. */
  readonly table: string;
  /** The referenced column in that table (usually 'id'). */
  readonly column: string;
  /** The name of the column being rendered in this grid. */
  readonly columnName: string;
}

/**
 * Builds the renderers for a column holding ids of one particular table.
 * Returning undefined means "no special rendering after all", which lets a
 * factory bail out on e.g. a joinid it cannot resolve.
 */
export type IdColumnRendererFactory = (
  ctx: IdColumnContext,
) => ColumnRenderers | undefined;

/**
 * Cell renderer for a column of ids of a table that has a timeline track
 * renderer: renders the id as a link that selects the corresponding event.
 */
function createTimelineIdCellRenderer(
  trace: Trace,
  tableName: string,
  columnName: string,
): CellRenderer {
  return (value) => {
    const cell = renderCell(value, columnName);
    if (typeof value !== 'bigint' && typeof value !== 'number') {
      return cell;
    }
    const id = typeof value === 'bigint' ? Number(value) : value;
    return m(
      Anchor,
      {
        title: `Go to ${tableName} on the timeline`,
        icon: Icons.UpdateSelection,
        onclick: () => {
          trace.navigate('#!/viewer');
          trace.selection.selectSqlEvent(tableName, id, {
            switchToCurrentSelectionTab: false,
            scrollToSelection: true,
          });
        },
      },
      cell,
    );
  };
}

const timelineIdColumnRenderers: IdColumnRendererFactory = ({
  trace,
  table,
  columnName,
}) => ({
  cellRenderer: createTimelineIdCellRenderer(trace, table, columnName),
});

// Tables whose ids can be selected on the timeline, i.e. those with a track
// renderer that sets rootTableName. These are built in rather than registered
// so that they cannot be lost by a plugin's clean-up; a plugin registration
// for the same table shadows them for as long as it lives.
const BUILT_IN_ID_COLUMN_RENDERERS = new Map<string, IdColumnRendererFactory>([
  ['slice', timelineIdColumnRenderers],
  ['sched_slice', timelineIdColumnRenderers],
  ['thread_state', timelineIdColumnRenderers],
  ['android_logs', timelineIdColumnRenderers],
]);

/**
 * Registry of renderers for ID/JOINID columns, keyed by the table the ids
 * belong to. Consulted by resolveColumnRenderers(), so registering here
 * changes how *every* DataGrid renders references to that table.
 *
 * Registrations are global and outlive a trace, so a plugin registering from
 * onTraceLoad must dispose of its registration when the trace goes away:
 *
 *   trace.trash.use(idColumnRenderers.register('my_table', factory));
 *
 * Registering a table that is already registered throws, which is what makes a
 * leaked registration visible on the next trace load rather than silently
 * winning or losing.
 */
class IdColumnRendererRegistry {
  private readonly registered = new Map<string, IdColumnRendererFactory>();

  /**
   * Registers a factory for ids of `table`, shadowing any built-in entry.
   *
   * @param table The referenced table name, e.g. 'slice'.
   * @param factory Builds the renderers for such a column.
   * @returns A disposable that removes this registration again.
   */
  register(table: string, factory: IdColumnRendererFactory): Disposable {
    if (this.registered.has(table)) {
      throw new Error(
        `An id column renderer for table '${table}' is already registered`,
      );
    }
    this.registered.set(table, factory);
    return {
      [Symbol.dispose]: () => {
        // Only remove our own entry: disposing a stale registration must not
        // clobber whatever has replaced it in the meantime.
        if (this.registered.get(table) === factory) {
          this.registered.delete(table);
        }
      },
    };
  }

  /** Whether any factory (registered or built in) handles `table`. */
  has(table: string): boolean {
    return this.tryGet(table) !== undefined;
  }

  /** The factory for `table`, or undefined if nothing handles it. */
  tryGet(table: string): IdColumnRendererFactory | undefined {
    return (
      this.registered.get(table) ?? BUILT_IN_ID_COLUMN_RENDERERS.get(table)
    );
  }

  /** Drops all registrations, leaving the built-in ones in place. */
  unregisterAllForTesting(): void {
    this.registered.clear();
  }
}

export const idColumnRenderers = new IdColumnRendererRegistry();

/**
 * Cell renderer for timestamp columns: they are stored as raw nanosecond
 * integers, which are unreadable as numbers, and the widget also picks up the
 * trace's timestamp format preference.
 */
export function createTimestampCellRenderer(trace: Trace): CellRenderer {
  return (value) => {
    if (typeof value === 'number') {
      value = BigInt(Math.round(value));
    }
    if (typeof value !== 'bigint') {
      return String(value);
    }
    return m(Timestamp, {
      trace,
      ts: Time.fromRaw(value),
    });
  };
}

/** Cell renderer for duration columns, for the same reasons as timestamps. */
export function createDurationCellRenderer(trace: Trace): CellRenderer {
  return (value) => {
    if (typeof value === 'number') {
      value = BigInt(Math.round(value));
    }
    if (typeof value !== 'bigint') {
      return String(value);
    }
    return m(DurationWidget, {
      trace,
      dur: Duration.fromRaw(value),
    });
  };
}

/**
 * Maps a PerfettoSQL type onto a DataGrid ColumnType, which decides which
 * filters and value pickers the column offers.
 */
export function getColumnType(type: PerfettoSqlType): ColumnType {
  // ID types (id, joinid, arg_set_id) should be treated as identifiers:
  // they're numeric, but we want distinct value pickers.
  if (isIdType(type) || type.kind === 'arg_set_id' || type.kind === 'boolean') {
    return 'identifier';
  }

  // String and bytes are text types.
  if (type.kind === 'string' || type.kind === 'bytes') {
    return 'text';
  }

  // All other numeric types (int, double, timestamp, duration) are
  // quantitative.
  return 'quantitative';
}

/**
 * Resolves the type-driven parts of a column's ColumnDef. This is the entry
 * point for DataGrid hosts: whatever they build their schema from, calling
 * this makes a given column render the same way everywhere.
 *
 * @param trace The trace the data belongs to.
 * @param type The column's PerfettoSQL type, if known.
 * @param columnName The column's name, used for labels and blob file names.
 * @returns The renderer bits to spread into the ColumnDef. All fields are
 * optional, so an unknown type or an unhandled table yields the plain cell.
 */
export function resolveColumnRenderers(
  trace: Trace,
  type: PerfettoSqlType | undefined,
  columnName: string,
): ColumnRenderers {
  if (type === undefined) return {};
  const columnType = getColumnType(type);

  if (type.kind === 'timestamp') {
    return {columnType, cellRenderer: createTimestampCellRenderer(trace)};
  }
  if (type.kind === 'duration') {
    return {columnType, cellRenderer: createDurationCellRenderer(trace)};
  }
  if (isIdType(type)) {
    const renderers = idColumnRenderers.tryGet(type.source.table)?.({
      trace,
      kind: type.kind,
      table: type.source.table,
      column: type.source.column,
      columnName,
    });
    if (renderers !== undefined) {
      return {columnType, ...renderers};
    }
  }
  return {columnType};
}
