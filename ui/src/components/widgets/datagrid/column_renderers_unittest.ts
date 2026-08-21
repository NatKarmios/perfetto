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
import {afterEach, describe, expect, test, vi} from 'vitest';
import type {Trace} from '../../../public/trace';
import type {PerfettoSqlType} from '../../../trace_processor/perfetto_sql_type';
import {
  getColumnType,
  idColumnRenderers,
  type IdColumnContext,
  resolveColumnRenderers,
} from './column_renderers';

// resolveColumnRenderers only ever passes the trace through to the widgets and
// (for id columns) calls navigate/selectSqlEvent, so a stub with those two is
// enough for everything tested here.
function fakeTrace() {
  return {
    navigate: vi.fn(),
    selection: {selectSqlEvent: vi.fn()},
  } as unknown as Trace & {
    navigate: ReturnType<typeof vi.fn>;
    selection: {selectSqlEvent: ReturnType<typeof vi.fn>};
  };
}

function idType(table: string, column = 'id'): PerfettoSqlType {
  return {kind: 'id', source: {table, column}};
}

afterEach(() => {
  idColumnRenderers.unregisterAllForTesting();
});

describe('getColumnType', () => {
  test('classifies text types', () => {
    expect(getColumnType({kind: 'string'})).toBe('text');
    expect(getColumnType({kind: 'bytes'})).toBe('text');
  });

  test('classifies identifier types', () => {
    expect(getColumnType(idType('slice'))).toBe('identifier');
    expect(
      getColumnType({kind: 'joinid', source: {table: 't', column: 'id'}}),
    ).toBe('identifier');
    expect(getColumnType({kind: 'arg_set_id'})).toBe('identifier');
    expect(getColumnType({kind: 'boolean'})).toBe('identifier');
  });

  test('classifies everything else as quantitative', () => {
    expect(getColumnType({kind: 'int'})).toBe('quantitative');
    expect(getColumnType({kind: 'double'})).toBe('quantitative');
    expect(getColumnType({kind: 'timestamp'})).toBe('quantitative');
    expect(getColumnType({kind: 'duration'})).toBe('quantitative');
  });
});

describe('resolveColumnRenderers', () => {
  test('an unknown type renders the plain cell', () => {
    expect(resolveColumnRenderers(fakeTrace(), undefined, 'x')).toEqual({});
  });

  test('a plain int gets a column type but no renderer', () => {
    const res = resolveColumnRenderers(fakeTrace(), {kind: 'int'}, 'x');
    expect(res.columnType).toBe('quantitative');
    expect(res.cellRenderer).toBeUndefined();
  });

  test('timestamps and durations get a renderer', () => {
    const trace = fakeTrace();
    expect(
      resolveColumnRenderers(trace, {kind: 'timestamp'}, 'ts').cellRenderer,
    ).toBeDefined();
    expect(
      resolveColumnRenderers(trace, {kind: 'duration'}, 'dur').cellRenderer,
    ).toBeDefined();
  });

  test('the timestamp renderer passes non-numeric values through', () => {
    const renderer = resolveColumnRenderers(
      fakeTrace(),
      {kind: 'timestamp'},
      'ts',
    ).cellRenderer;
    expect(renderer?.(null, {})).toBe('null');
  });

  test('an id of an unregistered table falls back to the plain cell', () => {
    const res = resolveColumnRenderers(fakeTrace(), idType('my_table'), 'id');
    expect(res.cellRenderer).toBeUndefined();
    // Still classified as an identifier, just not rendered specially.
    expect(res.columnType).toBe('identifier');
  });

  test('registering a table changes the outcome', () => {
    const trace = fakeTrace();
    const before = resolveColumnRenderers(trace, idType('my_table'), 'id');
    expect(before.cellRenderer).toBeUndefined();

    const marker = () => 'chip';
    using _reg = idColumnRenderers.register('my_table', () => ({
      cellRenderer: marker,
    }));

    const after = resolveColumnRenderers(trace, idType('my_table'), 'id');
    expect(after.cellRenderer).toBe(marker);
    expect(after.columnType).toBe('identifier');
  });

  test('a registration is passed the referenced table and column', () => {
    const seen: IdColumnContext[] = [];
    using _reg = idColumnRenderers.register('my_table', (ctx) => {
      seen.push(ctx);
      return {};
    });

    const trace = fakeTrace();
    resolveColumnRenderers(
      trace,
      {kind: 'joinid', source: {table: 'my_table', column: 'node_id'}},
      'parent_id',
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      trace,
      kind: 'joinid',
      table: 'my_table',
      column: 'node_id',
      columnName: 'parent_id',
    });
  });

  test('a factory returning undefined falls back to the plain cell', () => {
    using _reg = idColumnRenderers.register('my_table', () => undefined);
    const res = resolveColumnRenderers(fakeTrace(), idType('my_table'), 'id');
    expect(res.cellRenderer).toBeUndefined();
    expect(res.columnType).toBe('identifier');
  });

  test('actions come through too', () => {
    const actions = () => 'action';
    using _reg = idColumnRenderers.register('my_table', () => ({actions}));
    expect(
      resolveColumnRenderers(fakeTrace(), idType('my_table'), 'id').actions,
    ).toBe(actions);
  });
});

describe('built-in timeline id columns', () => {
  test.each(['slice', 'sched_slice', 'thread_state', 'android_logs'])(
    '%s ids are rendered as timeline links',
    (table) => {
      const trace = fakeTrace();
      const renderer = resolveColumnRenderers(
        trace,
        idType(table),
        'id',
      ).cellRenderer;
      expect(renderer).toBeDefined();

      const vnode = renderer?.(42n, {}) as m.Vnode<{
        title: string;
        onclick: () => void;
      }>;
      expect(vnode.attrs.title).toBe(`Go to ${table} on the timeline`);

      vnode.attrs.onclick();
      expect(trace.navigate).toHaveBeenCalledWith('#!/viewer');
      expect(trace.selection.selectSqlEvent).toHaveBeenCalledWith(table, 42, {
        switchToCurrentSelectionTab: false,
        scrollToSelection: true,
      });
    },
  );

  test('non-numeric values are not turned into links', () => {
    const renderer = resolveColumnRenderers(
      fakeTrace(),
      idType('slice'),
      'id',
    ).cellRenderer;
    expect(renderer?.(null, {})).toBe('null');
  });
});

describe('idColumnRenderers', () => {
  test('has() covers built-in and registered tables', () => {
    expect(idColumnRenderers.has('slice')).toBe(true);
    expect(idColumnRenderers.has('my_table')).toBe(false);
    using _reg = idColumnRenderers.register('my_table', () => ({}));
    expect(idColumnRenderers.has('my_table')).toBe(true);
  });

  test('registering the same table twice throws', () => {
    using _reg = idColumnRenderers.register('my_table', () => ({}));
    expect(() =>
      idColumnRenderers.register('my_table', () => ({})),
    ).toThrowError(/already registered/);
  });

  test('disposing removes the registration', () => {
    const factory = () => ({});
    const reg = idColumnRenderers.register('my_table', factory);
    expect(idColumnRenderers.tryGet('my_table')).toBe(factory);
    reg[Symbol.dispose]();
    expect(idColumnRenderers.tryGet('my_table')).toBeUndefined();
    // ...and the table can be registered again, so a plugin re-registering on
    // the next trace load neither throws nor leaks.
    using _again = idColumnRenderers.register('my_table', factory);
    expect(idColumnRenderers.tryGet('my_table')).toBe(factory);
  });

  test('a registration shadows a built-in one, and disposing restores it', () => {
    const builtIn = idColumnRenderers.tryGet('slice');
    expect(builtIn).toBeDefined();

    const factory = () => ({});
    const reg = idColumnRenderers.register('slice', factory);
    expect(idColumnRenderers.tryGet('slice')).toBe(factory);
    reg[Symbol.dispose]();
    expect(idColumnRenderers.tryGet('slice')).toBe(builtIn);
  });

  test('disposing a stale registration does not remove its replacement', () => {
    const first = () => ({});
    const stale = idColumnRenderers.register('my_table', first);
    stale[Symbol.dispose]();

    const second = () => ({});
    using _reg = idColumnRenderers.register('my_table', second);
    stale[Symbol.dispose]();
    expect(idColumnRenderers.tryGet('my_table')).toBe(second);
  });
});
