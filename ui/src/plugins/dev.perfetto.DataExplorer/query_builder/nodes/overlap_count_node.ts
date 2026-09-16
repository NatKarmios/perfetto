// Copyright (C) 2025 The Android Open Source Project
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

import {
  type QueryNode,
  nextNodeId,
  NodeType,
  type NodeContext,
} from '../../query_node';
import type {ColumnInfo} from '../column_info';
import type protos from '../../../../protos';
import type m from 'mithril';
import {StructuredQueryBuilder} from '../structured_query_builder';
import {setValidationError} from '../node_issues';
import type {NodeModifyAttrs, NodeDetailsAttrs} from '../../node_types';
import {NodeDetailsMessage} from '../node_styling_widgets';
import {loadNodeDoc} from '../node_doc_loader';
import {PerfettoSqlTypes} from '../../../../trace_processor/perfetto_sql_type';

// The macro is invoked through a Sql source rather than a dedicated structured
// query message: it needs no configuration, so the input reference is the only
// thing which varies.
//
// The module is declared via `referencedModules` rather than an
// `INCLUDE PERFETTO MODULE` statement in the SQL itself. The summarizer runs
// every referenced module before materializing anything, but a preamble
// embedded in a Sql source is only discovered while the SQL is being generated,
// which is too late for the macro to resolve.
const OVERLAP_COUNT_MODULE = 'intervals.overlap';
const OVERLAP_COUNT_SQL =
  'SELECT ts, value FROM intervals_overlap_count!($input, ts, dur)';

// Serializable node configuration (empty — no config fields).
export interface OverlapCountNodeAttrs {}

export class OverlapCountNode implements QueryNode {
  readonly nodeId: string;
  readonly type = NodeType.kOverlapCount;
  primaryInput?: QueryNode;
  nextNodes: QueryNode[];
  readonly attrs: OverlapCountNodeAttrs;
  readonly context: NodeContext;

  constructor(attrs: OverlapCountNodeAttrs = {}, context: NodeContext = {}) {
    this.nodeId = nextNodeId();
    this.attrs = {...attrs};
    this.context = context;
    this.nextNodes = [];
  }

  onPrevNodesUpdated(): void {
    this.context.onchange?.();
  }

  get sourceCols(): ColumnInfo[] {
    return this.primaryInput?.finalCols ?? [];
  }

  getTitle(): string {
    return 'Overlap Count';
  }

  get finalCols(): ColumnInfo[] {
    if (!this.primaryInput) {
      return [];
    }
    // The macro collapses the input down to a counter: input columns are not
    // carried through.
    return [
      {name: 'ts', checked: true, type: PerfettoSqlTypes.TIMESTAMP},
      {name: 'value', checked: true, type: PerfettoSqlTypes.INT},
    ];
  }

  private hasRequiredColumns(): boolean {
    const colNames = new Set(this.sourceCols.map((c) => c.name));
    return colNames.has('ts') && colNames.has('dur');
  }

  validate(): boolean {
    if (this.context.issues) {
      this.context.issues.clear();
    }

    if (this.primaryInput === undefined) {
      setValidationError(this.context, 'No input node connected');
      return false;
    }

    if (!this.primaryInput.validate()) {
      setValidationError(this.context, 'Previous node is invalid');
      return false;
    }

    if (this.sourceCols.length === 0) {
      setValidationError(this.context, 'Input has no columns');
      return false;
    }

    if (!this.hasRequiredColumns()) {
      setValidationError(this.context, 'Input must have ts and dur columns');
      return false;
    }

    return true;
  }

  nodeDetails(): NodeDetailsAttrs {
    return {
      content: NodeDetailsMessage('Counts overlapping intervals over time'),
    };
  }

  nodeSpecificModify(): NodeModifyAttrs {
    return {
      info: 'Turns a set of (ts, dur) intervals into a counter which, at every timestamp where the count changes, reports how many intervals are open. The output has only ts and value columns; the input columns are dropped.',
    };
  }

  nodeInfo(): m.Children {
    return loadNodeDoc('overlap_count');
  }

  clone(): QueryNode {
    return new OverlapCountNode({}, this.context);
  }

  getStructuredQuery(): protos.PerfettoSqlStructuredQuery | undefined {
    if (!this.validate()) return undefined;
    if (this.primaryInput === undefined) return undefined;

    const inputRef = StructuredQueryBuilder.passthrough(
      this.primaryInput,
      `${this.nodeId}_input_ref`,
    );
    if (inputRef === undefined) return undefined;

    const sq = StructuredQueryBuilder.fromSql(
      OVERLAP_COUNT_SQL,
      [{alias: 'input', query: inputRef}],
      ['ts', 'value'],
      this.nodeId,
    );
    sq.referencedModules = [OVERLAP_COUNT_MODULE];
    return sq;
  }
}
