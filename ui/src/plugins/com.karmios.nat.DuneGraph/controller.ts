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

import type {Trace} from '../../public/trace';
import type {BuildGraph, GraphNode, GraphSource} from './graph';
import {EMPTY_GRAPH} from './graph';
import {SliceArgsGraphSource} from './slice_args_graph_source';

/**
 * Holds the extracted build graph plus the active source, and knows how to
 * (re)load it. The sidebar panel reads state directly off this each render.
 */
export class DuneGraphController {
  private source: GraphSource;

  loading = false;
  graph: BuildGraph = EMPTY_GRAPH;
  error?: string;

  constructor(private readonly trace: Trace) {
    this.source = this.makeSource();
  }

  get sourceDescription(): string {
    return this.source.description;
  }

  // The node corresponding to the current timeline selection, if a "build-dep"
  // or "exec-rule" slice is selected. For slice tracks the selection's eventId
  // is the slice id, which is what the reverse index is keyed on.
  nodeForSelection(): GraphNode | undefined {
    const selection = this.trace.selection.selection;
    if (selection.kind !== 'track_event') return undefined;
    return this.graph.bySliceId.get(selection.eventId);
  }

  // The single seam to swap while experimenting with where the graph comes
  // from - everything else only sees the GraphSource contract.
  private makeSource(): GraphSource {
    return new SliceArgsGraphSource(this.trace.engine);
  }

  async reload(): Promise<void> {
    this.loading = true;
    this.error = undefined;
    try {
      this.graph = await this.source.load();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.graph = EMPTY_GRAPH;
    } finally {
      this.loading = false;
    }
  }
}
