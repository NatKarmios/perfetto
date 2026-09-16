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
  NodeRegistry,
  type NodeDescriptor,
  type PreCreateContext,
  type PreCreateState,
} from './node_registry';
import {type QueryNode, NodeType} from '../query_node';

describe('NodeRegistry', () => {
  function createMockNode(nodeId: string): QueryNode {
    return {
      nodeId,
      type: NodeType.kTable,
      nextNodes: [],
      finalCols: [],
      attrs: {},
      context: {},
      validate: () => true,
      getTitle: () => 'Test',
      nodeSpecificModify: () => null,
      nodeDetails: () => ({content: null}),
      nodeInfo: () => null,
      clone: () => createMockNode(nodeId),
      getStructuredQuery: () => undefined,
    } as QueryNode;
  }

  // Default required fields for test descriptors (nodeType, inputs,
  // deserialize).
  const defaults = {
    nodeType: NodeType.kTable,
    inputs: 'none' as const,
    deserialize: () => createMockNode('mock'),
  };

  describe('register', () => {
    it('should register a node descriptor', () => {
      const registry = new NodeRegistry();
      const descriptor: NodeDescriptor = {
        ...defaults,
        name: 'Test Node',
        description: 'A test node',
        icon: 'test-icon',
        type: 'source',
        factory: (_state: PreCreateState) => createMockNode('test'),
      };

      registry.register('test-node', descriptor);

      const retrieved = registry.get('test-node');
      expect(retrieved).toBe(descriptor);
    });

    it('should allow registering multiple nodes', () => {
      const registry = new NodeRegistry();
      const descriptor1: NodeDescriptor = {
        ...defaults,
        name: 'Node 1',
        description: 'First node',
        icon: 'icon1',
        type: 'source',
        factory: (_state: PreCreateState) => createMockNode('node1'),
      };
      const descriptor2: NodeDescriptor = {
        ...defaults,
        nodeType: NodeType.kFilter,
        name: 'Node 2',
        description: 'Second node',
        icon: 'icon2',
        type: 'modification',
        factory: (_state: PreCreateState) => createMockNode('node2'),
      };

      registry.register('node1', descriptor1);
      registry.register('node2', descriptor2);

      expect(registry.get('node1')).toBe(descriptor1);
      expect(registry.get('node2')).toBe(descriptor2);
    });

    it('should throw when the same id is registered twice', () => {
      const registry = new NodeRegistry();
      const descriptor1: NodeDescriptor = {
        ...defaults,
        name: 'Node 1',
        description: 'First node',
        icon: 'icon1',
        type: 'source',
        factory: (_state: PreCreateState) => createMockNode('node1'),
      };
      const descriptor2: NodeDescriptor = {
        ...defaults,
        nodeType: NodeType.kFilter,
        name: 'Node 1 Updated',
        description: 'Updated node',
        icon: 'icon1-updated',
        type: 'source',
        factory: (_state: PreCreateState) => createMockNode('node1-updated'),
      };

      registry.register('node1', descriptor1);

      expect(() => registry.register('node1', descriptor2)).toThrow(
        /Node ID 'node1' is already registered/,
      );
    });

    it('should throw when the same node type is registered under another id', () => {
      const registry = new NodeRegistry();
      const descriptor1: NodeDescriptor = {
        ...defaults,
        nodeType: NodeType.kFilter,
        name: 'Node 1',
        description: 'First node',
        icon: 'icon1',
        type: 'modification',
        factory: (_state: PreCreateState) => createMockNode('node1'),
      };
      const descriptor2: NodeDescriptor = {
        ...defaults,
        nodeType: NodeType.kFilter,
        name: 'Node 2',
        description: 'Second node',
        icon: 'icon2',
        type: 'modification',
        factory: (_state: PreCreateState) => createMockNode('node2'),
      };

      registry.register('node1', descriptor1);

      expect(() => registry.register('node2', descriptor2)).toThrow(
        /Node type 'filter' is already registered by node ID 'node1', so it cannot also be registered by 'node2'/,
      );
    });

    it('should remove all lookups for a disposed registration', () => {
      const registry = new NodeRegistry();
      const descriptor: NodeDescriptor = {
        ...defaults,
        nodeType: NodeType.kFilter,
        name: 'Plugin Node',
        description: 'A node from another plugin',
        icon: 'icon',
        type: 'modification',
        factory: (_state: PreCreateState) => createMockNode('plugin'),
      };

      const registration = registry.register('plugin-node', descriptor);
      expect(registry.get('plugin-node')).toBe(descriptor);
      expect(registry.getByNodeType(NodeType.kFilter)).toBe(descriptor);
      expect(registry.getIdByNodeType(NodeType.kFilter)).toBe('plugin-node');

      registration[Symbol.dispose]();

      expect(registry.get('plugin-node')).toBeUndefined();
      expect(registry.getByNodeType(NodeType.kFilter)).toBeUndefined();
      expect(registry.getIdByNodeType(NodeType.kFilter)).toBeUndefined();
    });

    it('should register node with optional fields', () => {
      const registry = new NodeRegistry();
      const preCreate = async (_context: PreCreateContext) => ({});
      const descriptor: NodeDescriptor = {
        ...defaults,
        name: 'Advanced Node',
        description: 'Node with optional fields',
        icon: 'advanced-icon',
        type: 'multisource',
        hotkey: 'ctrl+a',
        preCreate,
        factory: (_state: PreCreateState) => createMockNode('advanced'),
      };

      registry.register('advanced-node', descriptor);

      const retrieved = registry.get('advanced-node');
      expect(retrieved?.hotkey).toBe('ctrl+a');
      expect(retrieved?.preCreate).toBe(preCreate);
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent id', () => {
      const registry = new NodeRegistry();

      const result = registry.get('non-existent');

      expect(result).toBeUndefined();
    });

    it('should return registered descriptor', () => {
      const registry = new NodeRegistry();
      const descriptor: NodeDescriptor = {
        ...defaults,
        name: 'Test Node',
        description: 'A test node',
        icon: 'test-icon',
        type: 'source',
        factory: (_state: PreCreateState) => createMockNode('test'),
      };

      registry.register('test-node', descriptor);

      const result = registry.get('test-node');
      expect(result).toBe(descriptor);
      expect(result?.name).toBe('Test Node');
    });

    it('should handle special characters in id', () => {
      const registry = new NodeRegistry();
      const descriptor: NodeDescriptor = {
        ...defaults,
        name: 'Special Node',
        description: 'Node with special id',
        icon: 'special-icon',
        type: 'source',
        factory: (_state: PreCreateState) => createMockNode('special'),
      };

      registry.register('node:with:special-chars_123', descriptor);

      const result = registry.get('node:with:special-chars_123');
      expect(result).toBe(descriptor);
    });
  });

  describe('list', () => {
    it('should return empty array for empty registry', () => {
      const registry = new NodeRegistry();

      const result = registry.list();

      expect(result).toEqual([]);
    });

    it('should return all registered nodes', () => {
      const registry = new NodeRegistry();
      const descriptor1: NodeDescriptor = {
        ...defaults,
        name: 'Node 1',
        description: 'First node',
        icon: 'icon1',
        type: 'source',
        factory: (_state: PreCreateState) => createMockNode('node1'),
      };
      const descriptor2: NodeDescriptor = {
        ...defaults,
        nodeType: NodeType.kFilter,
        name: 'Node 2',
        description: 'Second node',
        icon: 'icon2',
        type: 'modification',
        factory: (_state: PreCreateState) => createMockNode('node2'),
      };
      const descriptor3: NodeDescriptor = {
        ...defaults,
        nodeType: NodeType.kSort,
        name: 'Node 3',
        description: 'Third node',
        icon: 'icon3',
        type: 'multisource',
        factory: (_state: PreCreateState) => createMockNode('node3'),
      };

      registry.register('node1', descriptor1);
      registry.register('node2', descriptor2);
      registry.register('node3', descriptor3);

      const result = registry.list();

      expect(result.length).toBe(3);
      expect(result).toContainEqual(['node1', descriptor1]);
      expect(result).toContainEqual(['node2', descriptor2]);
      expect(result).toContainEqual(['node3', descriptor3]);
    });

    it('should return tuples of [id, descriptor]', () => {
      const registry = new NodeRegistry();
      const descriptor: NodeDescriptor = {
        ...defaults,
        name: 'Test Node',
        description: 'A test node',
        icon: 'test-icon',
        type: 'source',
        factory: (_state: PreCreateState) => createMockNode('test'),
      };

      registry.register('test-node', descriptor);

      const result = registry.list();

      expect(result.length).toBe(1);
      expect(result[0][0]).toBe('test-node');
      expect(result[0][1]).toBe(descriptor);
    });

    it('should drop a node when its registration is disposed', () => {
      const registry = new NodeRegistry();
      const descriptor1: NodeDescriptor = {
        ...defaults,
        name: 'Node 1',
        description: 'First node',
        icon: 'icon1',
        type: 'source',
        factory: (_state: PreCreateState) => createMockNode('node1'),
      };
      const descriptor2: NodeDescriptor = {
        ...defaults,
        nodeType: NodeType.kFilter,
        name: 'Node 2',
        description: 'Second node',
        icon: 'icon2',
        type: 'modification',
        factory: (_state: PreCreateState) => createMockNode('node2'),
      };

      registry.register('node1', descriptor1);
      const registration2 = registry.register('node2', descriptor2);
      expect(registry.list().length).toBe(2);

      registration2[Symbol.dispose]();

      const result = registry.list();
      expect(result.length).toBe(1);
      expect(result[0][1].name).toBe('Node 1');
    });
  });

  describe('getAllowedChildrenFor', () => {
    it('should return default allowed children when node has no override', () => {
      const registry = new NodeRegistry();
      registry.register('source', {
        ...defaults,
        nodeType: NodeType.kTable,
        name: 'Source',
        description: 'A source',
        icon: 'icon',
        type: 'source',
        factory: () => createMockNode('s'),
      });
      registry.register('filter', {
        ...defaults,
        nodeType: NodeType.kFilter,
        name: 'Filter',
        description: 'A filter',
        icon: 'icon',
        type: 'modification',
        factory: () => createMockNode('f'),
      });
      registry.setDefaultAllowedChildren(['filter']);

      const result = registry.getAllowedChildrenFor(NodeType.kTable);

      expect(result).toEqual(['filter']);
    });

    it('should return per-node override when set', () => {
      const registry = new NodeRegistry();
      registry.register('source', {
        ...defaults,
        nodeType: NodeType.kTable,
        name: 'Source',
        description: 'A source',
        icon: 'icon',
        type: 'source',
        allowedChildren: ['filter'],
        factory: () => createMockNode('s'),
      });
      registry.register('filter', {
        ...defaults,
        nodeType: NodeType.kFilter,
        name: 'Filter',
        description: 'A filter',
        icon: 'icon',
        type: 'modification',
        factory: () => createMockNode('f'),
      });
      registry.setDefaultAllowedChildren(['filter', 'sort']);

      const result = registry.getAllowedChildrenFor(NodeType.kTable);

      expect(result).toEqual(['filter']);
    });

    it('should return empty array when override is empty', () => {
      const registry = new NodeRegistry();
      registry.register('source', {
        ...defaults,
        nodeType: NodeType.kTable,
        name: 'Source',
        description: 'A source',
        icon: 'icon',
        type: 'source',
        allowedChildren: [],
        factory: () => createMockNode('s'),
      });
      registry.setDefaultAllowedChildren(['filter']);

      const result = registry.getAllowedChildrenFor(NodeType.kTable);

      expect(result).toEqual([]);
    });
  });

  describe('isConnectionAllowed', () => {
    it('should allow connection when child type is in allowed list', () => {
      const registry = new NodeRegistry();
      registry.register('source', {
        ...defaults,
        nodeType: NodeType.kTable,
        name: 'Source',
        description: 'A source',
        icon: 'icon',
        type: 'source',
        factory: () => createMockNode('s'),
      });
      registry.register('filter', {
        ...defaults,
        nodeType: NodeType.kFilter,
        name: 'Filter',
        description: 'A filter',
        icon: 'icon',
        type: 'modification',
        factory: () => createMockNode('f'),
      });
      registry.setDefaultAllowedChildren(['filter']);

      expect(
        registry.isConnectionAllowed(NodeType.kTable, NodeType.kFilter),
      ).toBe(true);
    });

    it('should block connection when child type is not in allowed list', () => {
      const registry = new NodeRegistry();
      registry.register('source', {
        ...defaults,
        nodeType: NodeType.kTable,
        name: 'Source',
        description: 'A source',
        icon: 'icon',
        type: 'source',
        allowedChildren: ['filter'],
        factory: () => createMockNode('s'),
      });
      registry.register('filter', {
        ...defaults,
        nodeType: NodeType.kFilter,
        name: 'Filter',
        description: 'A filter',
        icon: 'icon',
        type: 'modification',
        factory: () => createMockNode('f'),
      });
      registry.register('sort', {
        ...defaults,
        nodeType: NodeType.kSort,
        name: 'Sort',
        description: 'A sort',
        icon: 'icon',
        type: 'modification',
        factory: () => createMockNode('so'),
      });

      expect(
        registry.isConnectionAllowed(NodeType.kTable, NodeType.kSort),
      ).toBe(false);
    });

    it('should block all connections when allowed children is empty', () => {
      const registry = new NodeRegistry();
      registry.register('source', {
        ...defaults,
        nodeType: NodeType.kTable,
        name: 'Source',
        description: 'A source',
        icon: 'icon',
        type: 'source',
        allowedChildren: [],
        factory: () => createMockNode('s'),
      });
      registry.register('filter', {
        ...defaults,
        nodeType: NodeType.kFilter,
        name: 'Filter',
        description: 'A filter',
        icon: 'icon',
        type: 'modification',
        factory: () => createMockNode('f'),
      });

      expect(
        registry.isConnectionAllowed(NodeType.kTable, NodeType.kFilter),
      ).toBe(false);
    });

    it('should block connection for unregistered child type', () => {
      const registry = new NodeRegistry();
      registry.register('source', {
        ...defaults,
        nodeType: NodeType.kTable,
        name: 'Source',
        description: 'A source',
        icon: 'icon',
        type: 'source',
        factory: () => createMockNode('s'),
      });
      registry.setDefaultAllowedChildren(['filter']);

      // kFilter is not registered, only listed as allowed
      expect(
        registry.isConnectionAllowed(NodeType.kTable, NodeType.kFilter),
      ).toBe(false);
    });

    it('should allow connection into a node added by addDefaultAllowedChild', () => {
      const registry = new NodeRegistry();
      registry.register('source', {
        ...defaults,
        nodeType: NodeType.kTable,
        name: 'Source',
        description: 'A source',
        icon: 'icon',
        type: 'source',
        factory: () => createMockNode('s'),
      });
      registry.setDefaultAllowedChildren([]);

      // A node registered after the default list was set is absent from it.
      registry.register('plugin-node', {
        ...defaults,
        nodeType: NodeType.kFilter,
        name: 'Plugin Node',
        description: 'A node from another plugin',
        icon: 'icon',
        type: 'modification',
        factory: () => createMockNode('p'),
      });
      expect(
        registry.isConnectionAllowed(NodeType.kTable, NodeType.kFilter),
      ).toBe(false);

      registry.addDefaultAllowedChild('plugin-node');

      expect(
        registry.isConnectionAllowed(NodeType.kTable, NodeType.kFilter),
      ).toBe(true);
    });
  });

  describe('validateAllowedChildren', () => {
    it('should pass when all references are valid', () => {
      const registry = new NodeRegistry();
      registry.register('source', {
        ...defaults,
        nodeType: NodeType.kTable,
        name: 'Source',
        description: 'A source',
        icon: 'icon',
        type: 'source',
        allowedChildren: ['filter'],
        factory: () => createMockNode('s'),
      });
      registry.register('filter', {
        ...defaults,
        nodeType: NodeType.kFilter,
        name: 'Filter',
        description: 'A filter',
        icon: 'icon',
        type: 'modification',
        factory: () => createMockNode('f'),
      });
      registry.setDefaultAllowedChildren(['filter']);

      expect(() => registry.validateAllowedChildren()).not.toThrow();
    });

    it('should throw when per-node allowedChildren references unregistered ID', () => {
      const registry = new NodeRegistry();
      registry.register('source', {
        ...defaults,
        nodeType: NodeType.kTable,
        name: 'Source',
        description: 'A source',
        icon: 'icon',
        type: 'source',
        allowedChildren: ['nonexistent_node'],
        factory: () => createMockNode('s'),
      });

      expect(() => registry.validateAllowedChildren()).toThrow(
        /Node 'source' allowedChildren references unregistered node ID: 'nonexistent_node'/,
      );
    });

    it('should throw when default allowedChildren references unregistered ID', () => {
      const registry = new NodeRegistry();
      registry.register('source', {
        ...defaults,
        nodeType: NodeType.kTable,
        name: 'Source',
        description: 'A source',
        icon: 'icon',
        type: 'source',
        factory: () => createMockNode('s'),
      });
      registry.setDefaultAllowedChildren(['ghost_node']);

      expect(() => registry.validateAllowedChildren()).toThrow(
        /Default allowedChildren references unregistered node ID: 'ghost_node'/,
      );
    });

    it('should pass after a late registration adds itself to the defaults', () => {
      const registry = new NodeRegistry();
      registry.register('source', {
        ...defaults,
        nodeType: NodeType.kTable,
        name: 'Source',
        description: 'A source',
        icon: 'icon',
        type: 'source',
        factory: () => createMockNode('s'),
      });
      registry.setDefaultAllowedChildren([]);
      registry.validateAllowedChildren();

      registry.register('plugin-node', {
        ...defaults,
        nodeType: NodeType.kFilter,
        name: 'Plugin Node',
        description: 'A node from another plugin',
        icon: 'icon',
        type: 'modification',
        factory: () => createMockNode('p'),
      });
      registry.addDefaultAllowedChild('plugin-node');

      expect(() => registry.validateAllowedChildren()).not.toThrow();
    });

    it('should throw when a late registration references an unregistered ID', () => {
      const registry = new NodeRegistry();
      registry.register('source', {
        ...defaults,
        nodeType: NodeType.kTable,
        name: 'Source',
        description: 'A source',
        icon: 'icon',
        type: 'source',
        factory: () => createMockNode('s'),
      });
      registry.validateAllowedChildren();

      registry.register('plugin-node', {
        ...defaults,
        nodeType: NodeType.kFilter,
        name: 'Plugin Node',
        description: 'A node from another plugin',
        icon: 'icon',
        type: 'modification',
        allowedChildren: ['no_such_node'],
        factory: () => createMockNode('p'),
      });

      expect(() => registry.validateAllowedChildren()).toThrow(
        /Node 'plugin-node' allowedChildren references unregistered node ID: 'no_such_node'/,
      );
    });
  });

  describe('integration tests', () => {
    it('should handle full lifecycle of node registration', () => {
      const registry = new NodeRegistry();

      // Start empty
      expect(registry.list().length).toBe(0);

      // Register first node
      const descriptor1: NodeDescriptor = {
        ...defaults,
        name: 'Source Node',
        description: 'A source node',
        icon: 'source-icon',
        type: 'source',
        factory: (_state: PreCreateState) => createMockNode('source'),
      };
      const sourceRegistration = registry.register('source-node', descriptor1);
      expect(registry.list().length).toBe(1);
      expect(registry.get('source-node')).toBe(descriptor1);

      // Register second node
      const descriptor2: NodeDescriptor = {
        ...defaults,
        nodeType: NodeType.kFilter,
        name: 'Modify Node',
        description: 'A modification node',
        icon: 'modify-icon',
        type: 'modification',
        factory: (_state: PreCreateState) => createMockNode('modify'),
      };
      registry.register('modify-node', descriptor2);
      expect(registry.list().length).toBe(2);
      expect(registry.get('modify-node')).toBe(descriptor2);

      // Dispose of the first node, then register a replacement under the same
      // ID and node type — which only works because disposal freed both.
      sourceRegistration[Symbol.dispose]();
      const descriptor1Replacement: NodeDescriptor = {
        ...defaults,
        name: 'Source Node Replacement',
        description: 'Replacement source node',
        icon: 'source-icon-replacement',
        type: 'source',
        factory: (_state: PreCreateState) =>
          createMockNode('source-replacement'),
      };
      registry.register('source-node', descriptor1Replacement);
      expect(registry.list().length).toBe(2);
      expect(registry.get('source-node')).toBe(descriptor1Replacement);
    });
  });
});
