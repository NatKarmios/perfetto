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
import {DataGrid} from '../../../components/widgets/datagrid/datagrid';
import {
  type ColumnSchema,
  escapePath,
} from '../../../components/widgets/datagrid/datagrid_schema';
import {resolveColumnRenderers} from '../../../components/widgets/datagrid/column_renderers';
import type {Column, Filter} from '../../../components/widgets/datagrid/model';
import {SQLDataSource} from '../../../components/widgets/datagrid/sql_data_source';
import type {Trace} from '../../../public/trace';
import type {SqlValue} from '../../../trace_processor/query_result';
import {ResultsPanelEmptyState} from '../query_builder/widgets';
import type {
  DashboardBrushFilter,
  DashboardDataSource,
  DashboardGrid,
} from './dashboard_registry';

export interface DashboardGridViewAttrs {
  trace: Trace;
  source: DashboardDataSource;
  grid: DashboardGrid;
  brushFilters: Map<string, DashboardBrushFilter[]>;
}

/**
 * Signature of the parts of a grid item that the DataGrid only reads on first
 * mount (its columns, which it takes as `initialColumns`). The Dashboard uses
 * this as the view's Mithril key, so editing the configuration re-creates the
 * grid instead of silently doing nothing.
 */
export function gridViewKey(grid: DashboardGrid): string {
  return `${grid.id}\u0001${grid.columns?.join('\u0000') ?? ''}`;
}

/**
 * Map dashboard brush filters onto DataGrid filters, dropping any that
 * reference a column the data source no longer has (which happens after the
 * grid's source is changed).
 *
 * DataGrid ANDs its filters and has no OR, so the per-value '=' filters that a
 * brush selection emits for one column are folded into a single 'in'. A brush
 * that picks NULL *alongside* real values is therefore inexpressible
 * (`x IN (...) OR x IS NULL`); the value set wins and the NULL is dropped, so
 * the grid shows too few rows rather than all of them.
 */
export function brushFiltersToGridFilters(
  filters: ReadonlyArray<DashboardBrushFilter>,
  validColumns: ReadonlySet<string>,
): Filter[] {
  const byColumn = new Map<string, DashboardBrushFilter[]>();
  for (const f of filters) {
    if (!validColumns.has(f.column)) continue;
    const list = byColumn.get(f.column) ?? [];
    list.push(f);
    byColumn.set(f.column, list);
  }

  const result: Filter[] = [];
  for (const [column, colFilters] of byColumn) {
    const field = escapePath(column);
    const eqValues: SqlValue[] = [];
    let hasNull = false;

    for (const f of colFilters) {
      if (f.op === '=') {
        eqValues.push(f.value ?? null);
      } else if (f.op === 'is null') {
        hasNull = true;
      } else {
        // Range ends ('>=' and '<'), which AND together as they are.
        result.push({field, op: f.op, value: f.value ?? null});
      }
    }

    if (eqValues.length === 1) {
      result.push({field, op: '=', value: eqValues[0]});
    } else if (eqValues.length > 1) {
      result.push({field, op: 'in', value: eqValues});
    } else if (hasNull) {
      result.push({field, op: 'is null'});
    }
  }
  return result;
}

/**
 * Renders a DataGrid over a dashboard data source. Only renders the grid itself
 * — the card wrapper, header, resize handles and drag-and-drop are handled by
 * the Dashboard component.
 *
 * Table name resolution works exactly as it does for charts: DashboardNode
 * populates the source's `tableName` once the upstream node has been executed,
 * and until then this component triggers execution via
 * `source.requestExecution()` and waits for a redraw.
 *
 * Column visibility, sorting and in-grid filters are all owned by the DataGrid
 * and live only as long as this component. The persisted item configuration
 * seeds them on mount.
 */
export class DashboardGridView implements m.ClassComponent<DashboardGridViewAttrs> {
  private dataSource?: SQLDataSource;
  private dataSourceTable?: string;
  private executionRequested = false;
  // Filters the user added from the grid's own column/cell menus. Merged with
  // (and overridden by) the dashboard's brush filters.
  private localFilters: readonly Filter[] = [];

  onremove() {
    this.dataSource?.dispose();
    this.dataSource = undefined;
    this.dataSourceTable = undefined;
  }

  view({attrs}: m.CVnode<DashboardGridViewAttrs>) {
    const {source, grid} = attrs;

    if (source.columns.length === 0) {
      return m(
        ResultsPanelEmptyState,
        {icon: 'warning', title: 'No columns'},
        'This data source exports no columns.',
      );
    }

    // If the table name isn't available yet, trigger execution once and wait.
    if (source.tableName === undefined) {
      if (!this.executionRequested && source.requestExecution) {
        this.executionRequested = true;
        source
          .requestExecution()
          .catch((e) => console.debug('Dashboard source execution failed:', e))
          .finally(() => {
            this.executionRequested = false;
          });
      }
      return m(ResultsPanelEmptyState, {
        icon: 'hourglass_empty',
        title: 'Loading data…',
      });
    }

    const sourceColumns = new Set(source.columns.map((c) => c.name));
    const brushFilters = brushFiltersToGridFilters(
      attrs.brushFilters.get(source.nodeId) ?? [],
      sourceColumns,
    );

    return m(DataGrid, {
      schema: buildSchema(attrs.trace, source),
      data: this.ensureDataSource(attrs.trace, source.tableName),
      fillHeight: true,
      initialColumns: buildColumns(grid, source),
      // Brush filters are owned by the dashboard's filter bar, so they are
      // appended on every redraw and never kept in localFilters. Removing such
      // a chip from inside the grid therefore has no lasting effect — it comes
      // back on the next redraw; the filter bar is where it can be dropped.
      filters: [...this.localFilters, ...brushFilters],
      onFiltersChanged: (filters) => {
        const brushKeys = new Set(brushFilters.map(filterKey));
        this.localFilters = filters.filter((f) => !brushKeys.has(filterKey(f)));
      },
      // The dashboard grid is a flat table; pivoting is not offered here.
      disablePivotControls: true,
    });
  }

  /** Create the data source lazily, re-creating it if the table changed. */
  private ensureDataSource(trace: Trace, tableName: string): SQLDataSource {
    if (this.dataSource === undefined || this.dataSourceTable !== tableName) {
      this.dataSource?.dispose();
      this.dataSource = new SQLDataSource({
        engine: trace.engine,
        tableOrSubquery: tableName,
      });
      this.dataSourceTable = tableName;
    }
    return this.dataSource;
  }
}

/**
 * Identity of a DataGrid filter, used to tell the dashboard's brush filters
 * apart from the ones the user added inside the grid. Values can be bigints, so
 * this is built by hand rather than with JSON.stringify.
 */
function filterKey(filter: Filter): string {
  const value = 'value' in filter ? filter.value : undefined;
  return `${filter.field}|${filter.op}|${String(value)}`;
}

/**
 * Build a DataGrid schema from the data source's column types.
 *
 * Rendering is decided by resolveColumnRenderers(), the same way the results
 * panel does it: timestamps and durations get widgets rather than raw
 * nanosecond integers, and id columns get whatever the id column renderer
 * registry has for the table they reference.
 */
function buildSchema(trace: Trace, source: DashboardDataSource): ColumnSchema {
  const schema: ColumnSchema = {};
  for (const col of source.columns) {
    schema[escapePath(col.name)] = resolveColumnRenderers(
      trace,
      col.type,
      col.name,
    );
  }
  return schema;
}

/**
 * Build the grid's initial columns: those configured on the item, minus any the
 * data source has since lost. Falls back to every column of the source, which
 * is also what an unconfigured grid shows.
 */
function buildColumns(
  grid: DashboardGrid,
  source: DashboardDataSource,
): Column[] {
  const sourceColumns = new Set(source.columns.map((c) => c.name));
  const configured = (grid.columns ?? []).filter((name) =>
    sourceColumns.has(name),
  );
  const names =
    configured.length > 0 ? configured : source.columns.map((c) => c.name);
  return names.map((name) => ({id: name, field: escapePath(name)}));
}
