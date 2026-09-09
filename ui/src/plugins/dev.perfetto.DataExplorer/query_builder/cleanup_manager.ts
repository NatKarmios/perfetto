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

import type {QueryNode} from '../query_node';
import {dashboardRegistry} from '../dashboard/dashboard_registry';
import type {QueryExecutionService} from './query_execution_service';

/**
 * Centralized manager for resource cleanup in the Data Explorer.
 *
 * Responsibilities:
 * - Cleans up JavaScript resources (intervals, subscriptions) via dispose()
 * - Coordinates cleanup between multiple cleanup operations
 *
 * Note: Materialized tables are managed by Trace Processor. Use
 * dropAllMaterializations() on component unmount for full cleanup.
 */
export class CleanupManager {
  private queryExecutionService: QueryExecutionService;

  constructor(queryExecutionService: QueryExecutionService) {
    this.queryExecutionService = queryExecutionService;
  }

  /**
   * Type guard to check if a node implements the dispose pattern.
   */
  private isDisposable(
    node: QueryNode,
  ): node is QueryNode & {dispose: () => void} {
    return 'dispose' in node && typeof node.dispose === 'function';
  }

  /**
   * Cleans up a single node's resources.
   *
   * @param node The node to clean up
   */
  cleanupNode(node: QueryNode): void {
    // Synchronous cleanup (intervals, subscriptions, etc.)
    if (this.isDisposable(node)) {
      try {
        node.dispose();
      } catch (e) {
        console.error(
          `Failed to dispose resources for node ${node.nodeId}:`,
          e,
        );
      }
    }

    // Remove all service-side state for this node so it doesn't accumulate
    // indefinitely in long-lived sessions.
    this.queryExecutionService.removeNode(node.nodeId);
  }

  /**
   * Cleans up multiple nodes' resources.
   *
   * @param nodes The nodes to clean up
   */
  cleanupNodes(nodes: QueryNode[]): void {
    for (const node of nodes) {
      this.cleanupNode(node);
    }
  }

  /**
   * Cleans up all resources for the entire graph.
   * Used when clearing all nodes or on component unmount.
   *
   * @param allNodes All nodes in the graph
   * @param graphId The id of the graph tab being cleaned up, if known
   */
  async cleanupAll(allNodes: QueryNode[], graphId?: string): Promise<void> {
    // Step 1 (synchronous): Dispose JS resources (intervals, subscriptions).
    // This is synchronous and completes before Step 2 starts, ensuring no JS
    // code (e.g., timers, callbacks) tries to access tables during cleanup.
    this.cleanupNodes(allNodes);

    // Step 2 (async): Drop all materialized tables in TP.
    // Safe to call after Step 1 because all JS resources are already disposed.
    await this.queryExecutionService.dropAllMaterializations();

    // Step 3: tell the dashboards their rows have gone. This unmount is not
    // necessarily the end of the session - the Data Explorer's component is
    // rebuilt on a route change, and on any restructuring of the page around
    // it (toggling a side panel changes the vnode above it, for instance) -
    // and dashboard items outlive it via the exported-source pool. Without
    // this they come back still naming the tables just dropped and query them
    // for the rest of the session. Scoped to `graphId`, like the drop above:
    // `dropAllMaterializations` is this tab's service and drops only this
    // tab's tables, so invalidating another tab's sources would send its
    // charts back through a full materialization for nothing.
    dashboardRegistry.invalidateTableNames(graphId);
  }
}
