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
import {
  type ChartTypeDefinition,
  getChartTypeDefinition,
  getChartTypes,
  getDefaultChartLabel,
  isValidChartType,
  registerChartType,
  renderChartByType,
} from './chart_type_registry';
import {renderChartTypePickerGrid} from './chart_type_picker';
import type {ChartLoaderEntry, ChartRenderContext} from './chart_renderers';
import type {ChartConfig} from '../nodes/visualisation_node';

// The registry is module state, but every registration is disposable, so the
// tests below register with `using` and hand the registry back as they found
// it. That is what lets them all share one type name.
const builtInTypes = getChartTypes().map((d) => d.type);
const TEST_TYPE = 'test-chart';

function makeDefinition(
  type: string = TEST_TYPE,
  overrides: Partial<ChartTypeDefinition> = {},
): ChartTypeDefinition {
  return {
    type,
    label: `Label for ${type}`,
    icon: 'science',
    supportsAggregation: false,
    supportsBinning: false,
    requiresNumericDimension: false,
    primaryColumnLabel: 'Column',
    supportsYColumn: false,
    supportsGroupColumn: false,
    supportsSizeColumn: false,
    description: `Description for ${type}`,
    createLoader: () => {},
    render: () => m('.pf-test-chart', type),
    defaultLabel: (config) => `Test ${type}: ${config.column}`,
    ...overrides,
  };
}

function makeConfig(chartType: string): ChartConfig {
  return {id: 'chart-1', column: 'dur', chartType};
}

// Nothing under test reads the render context, so a bare stub is enough.
const ctx = {} as ChartRenderContext;
const entry: ChartLoaderEntry = {key: ''};

function render(child: m.Children): HTMLElement {
  const root = document.createElement('div');
  m.render(root, child);
  return root;
}

describe('registerChartType', () => {
  test('makes the type resolvable', () => {
    const def = makeDefinition();
    using _reg = registerChartType(def);

    expect(getChartTypeDefinition(TEST_TYPE)).toBe(def);
    expect(isValidChartType(TEST_TYPE)).toBe(true);
  });

  test('orders registered types after the built-ins', () => {
    using _reg = registerChartType(makeDefinition());

    const types = getChartTypes().map((d) => d.type);
    expect(types.slice(0, builtInTypes.length)).toEqual(builtInTypes);
    expect(types[types.length - 1]).toEqual(TEST_TYPE);
  });

  test('rejects a built-in type', () => {
    expect(() => registerChartType(makeDefinition('bar'))).toThrow();
  });

  test('rejects a type that is already registered', () => {
    using _reg = registerChartType(makeDefinition());

    expect(() => registerChartType(makeDefinition())).toThrow();
  });

  test('un-registers the type again when disposed', () => {
    {
      using _reg = registerChartType(makeDefinition());
      expect(isValidChartType(TEST_TYPE)).toBe(true);
    }

    expect(isValidChartType(TEST_TYPE)).toBe(false);
    expect(getChartTypes().map((d) => d.type)).toEqual(builtInTypes);
    // Registering afresh is what the next trace load does.
    using _again = registerChartType(makeDefinition());
    expect(isValidChartType(TEST_TYPE)).toBe(true);
  });

  test('leaves a replacement registration alone when disposed late', () => {
    const first = registerChartType(makeDefinition());
    first[Symbol.dispose]();

    const second = makeDefinition();
    using _reg = registerChartType(second);
    // A stale disposable must not take the live registration with it.
    first[Symbol.dispose]();

    expect(getChartTypeDefinition(TEST_TYPE)).toBe(second);
  });
});

describe('isValidChartType', () => {
  test('accepts a built-in type', () => {
    expect(isValidChartType('histogram')).toBe(true);
  });

  test('rejects an unregistered type', () => {
    expect(isValidChartType('test-never-registered')).toBe(false);
  });
});

describe('renderChartByType', () => {
  test('renders a registered chart type', () => {
    using _reg = registerChartType(makeDefinition());

    const root = render(renderChartByType(ctx, makeConfig(TEST_TYPE), entry));
    expect(root.querySelector('.pf-test-chart')).not.toBeNull();
  });

  test('renders a placeholder naming an unregistered chart type', () => {
    const child = renderChartByType(ctx, makeConfig('test-missing'), entry);

    expect(child).not.toBeUndefined();
    expect(render(child).textContent).toContain('test-missing');
  });
});

describe('getDefaultChartLabel', () => {
  test('uses the built-in label', () => {
    expect(getDefaultChartLabel(makeConfig('histogram'))).toEqual(
      'Histogram: dur',
    );
  });

  test('uses the registered type label', () => {
    using _reg = registerChartType(makeDefinition());

    expect(getDefaultChartLabel(makeConfig(TEST_TYPE))).toEqual(
      `Test ${TEST_TYPE}: dur`,
    );
  });

  test('falls back for an unregistered type', () => {
    expect(getDefaultChartLabel(makeConfig('test-missing'))).toEqual(
      'test-missing: dur',
    );
  });

  test('reports an unconfigured chart', () => {
    expect(
      getDefaultChartLabel({id: 'c', column: '', chartType: 'bar'}),
    ).toEqual('Not configured');
  });
});

describe('renderChartTypePickerGrid', () => {
  test('renders a card per chart type, previewless types included', () => {
    using _reg = registerChartType(makeDefinition());

    const root = render(renderChartTypePickerGrid(() => {}));
    const cards = root.querySelectorAll('.pf-chart-type-picker__card');
    expect(cards.length).toEqual(getChartTypes().length);
    expect(root.textContent).toContain(`Label for ${TEST_TYPE}`);
  });
});
