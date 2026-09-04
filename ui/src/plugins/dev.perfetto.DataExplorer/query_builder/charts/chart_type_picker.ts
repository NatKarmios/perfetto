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
import {classNames} from '../../../../base/classnames';
import type {ChartType} from '../nodes/visualisation_node';
import {getChartTypes, type ChartTypeDefinition} from './chart_type_registry';
import {Icon} from '../../../../widgets/icon';

/**
 * Renders a grid of chart type cards. Each card fires `onSelect` when clicked.
 * When `selectedType` is provided, the matching card is visually highlighted.
 */
export function renderChartTypePickerGrid(
  onSelect: (type: ChartType) => void,
  selectedType?: ChartType,
): m.Children {
  return m(
    '.pf-chart-type-picker',
    getChartTypes().map((def) =>
      renderChartTypeCard(def, onSelect, selectedType),
    ),
  );
}

function renderChartTypeCard(
  def: ChartTypeDefinition,
  onSelect: (type: ChartType) => void,
  selectedType?: ChartType,
): m.Children {
  const description = def.description;
  const isSelected = selectedType === def.type;

  return m(
    'button.pf-chart-type-picker__card',
    {
      key: def.type,
      className: classNames(isSelected && 'pf-selected'),
      title: description,
      onclick: () => onSelect(def.type),
    },
    [
      m('.pf-chart-type-picker__preview', renderPreview(def)),
      m('.pf-chart-type-picker__label', def.label),
    ],
  );
}

// Registered chart types needn't supply an SVG thumbnail; fall back to the
// descriptor's icon so the card still reads as a chart type.
function renderPreview(def: ChartTypeDefinition): m.Children {
  return def.preview !== undefined
    ? def.preview()
    : m(Icon, {
        className: 'pf-chart-type-picker__preview-icon',
        icon: def.icon,
      });
}
