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

import {OverlapCountNode} from './overlap_count_node';
import {NodeType} from '../../query_node';
import {
  createMockNodeWithStructuredQuery,
  createColumnInfo,
} from '../testing/test_utils';

function intervalInput() {
  return createMockNodeWithStructuredQuery('input', [
    createColumnInfo('id', 'int'),
    createColumnInfo('ts', 'timestamp'),
    createColumnInfo('dur', 'duration'),
    createColumnInfo('name', 'string'),
  ]);
}

describe('OverlapCountNode', () => {
  it('should have the correct node type', () => {
    expect(new OverlapCountNode({}).type).toBe(NodeType.kOverlapCount);
  });

  describe('finalCols', () => {
    it('should return empty array when no primary input', () => {
      expect(new OverlapCountNode({}).finalCols).toEqual([]);
    });

    it('should replace the input columns with ts and value', () => {
      const node = new OverlapCountNode({});
      node.primaryInput = intervalInput();

      expect(node.finalCols.map((c) => c.name)).toEqual(['ts', 'value']);
    });
  });

  describe('validate', () => {
    it('should fail with no input', () => {
      expect(new OverlapCountNode({}).validate()).toBe(false);
    });

    it('should fail when the input has no dur column', () => {
      const node = new OverlapCountNode({});
      node.primaryInput = createMockNodeWithStructuredQuery('input', [
        createColumnInfo('ts', 'timestamp'),
      ]);

      expect(node.validate()).toBe(false);
    });

    it('should succeed when the input has ts and dur', () => {
      const node = new OverlapCountNode({});
      node.primaryInput = intervalInput();

      expect(node.validate()).toBe(true);
    });
  });

  describe('getStructuredQuery', () => {
    it('should return undefined when invalid', () => {
      expect(new OverlapCountNode({}).getStructuredQuery()).toBeUndefined();
    });

    it('should emit the macro as a sql source over the input reference', () => {
      const node = new OverlapCountNode({});
      const inputNode = intervalInput();
      node.primaryInput = inputNode;

      const sq = node.getStructuredQuery();

      expect(sq?.id).toBe(node.nodeId);
      expect(sq?.sql?.sql).toContain(
        'intervals_overlap_count!($input, ts, dur)',
      );
      // The module must be declared here, not as an INCLUDE inside the SQL:
      // the summarizer includes referenced modules before it materializes
      // anything, but only discovers a Sql source's preamble too late for the
      // macro to resolve.
      expect(sq?.referencedModules).toEqual(['intervals.overlap']);
      expect(sq?.sql?.sql).not.toContain('INCLUDE');
      expect(sq?.sql?.columnNames).toEqual(['ts', 'value']);
      expect(sq?.sql?.dependencies?.length).toBe(1);
      expect(sq?.sql?.dependencies?.[0].alias).toBe('input');
      expect(sq?.sql?.dependencies?.[0].query?.innerQueryId).toBe(
        inputNode.nodeId,
      );
    });
  });

  describe('clone', () => {
    it('should produce a new OverlapCountNode', () => {
      const cloned = new OverlapCountNode({}).clone();

      expect(cloned).toBeInstanceOf(OverlapCountNode);
    });
  });
});
