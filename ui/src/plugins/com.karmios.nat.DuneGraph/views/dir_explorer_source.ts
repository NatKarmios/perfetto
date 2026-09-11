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

/**
 * Where the Explorer pane's rows come from: one interface, and the SQL mirror
 * behind the side panel's copy of the pane.
 *
 * **ARCHITECTURE.md, "The Explorer pane", is the contract** - what an implementation
 * has to promise about ids, compression, paging and `version`, and why the two
 * implementations drive different halves of the pane. Getting any of it wrong
 * is silent, so read it before writing a third one.
 */

import type {Engine} from '../../../trace_processor/engine';
import type {DuneGraphController} from '../controller';
import type {
  DirEntry,
  MemberEntry,
  MemberFilter,
  PathFilter,
} from '../model/dir_explorer';
import {
  allDirs,
  childDirs,
  dirMemberIds,
  dirMembers,
  matchingCounts,
  matchingRuleDirs,
  rootDirs,
} from '../model/dir_explorer';
import type {NodeKind} from '../model/graph';

/**
 * The directory tree the Explorer pane draws, and the members hanging off it.
 *
 * Two shapes of access, and the split is the pane's two modes rather than an
 * arbitrary grouping: {@link rootDirs} / {@link childDirs} are the lazy descent
 * the unfiltered pane makes a level at a time, and {@link allDirs} /
 * {@link matchingRuleDirs} / {@link matchingCounts} are the whole hierarchy at
 * once, which is what a hard filter needs (see dir_filter.ts for why it cannot
 * be done a level at a time). Members are fetched the same way in both modes.
 */
export interface DirExplorerSource {
  // Bumped when the ids stop meaning what they meant; read every render.
  readonly version: number;

  // Whether this source's rows *are* a selection rather than a hierarchy to
  // descend. True implies `matchingCounts` never returns undefined.
  readonly rowDriven: boolean;

  // The tree's roots - normally several, since a build's paths mix absolute and
  // relative ones. Order must be stable across calls.
  rootDirs(): Promise<readonly DirEntry[]>;

  // The children of `id`, compressed past any run of pass-through directories.
  childDirs(id: number): Promise<readonly DirEntry[]>;

  // Every directory, in id order, uncompressed - dir_filter.ts re-runs the
  // compression itself and needs the tree's real shape.
  allDirs(): Promise<readonly DirEntry[]>;

  // The directories whose own path matches, i.e. where *rules* can match at
  // all: a rule's label is its bare dune id and carries no path. Passed back in
  // below as `dirPathMatches`, where it is a constant rather than a predicate.
  matchingRuleDirs(path: PathFilter): Promise<ReadonlySet<number>>;

  // How many members of `kind` match `filter` per directory, or undefined
  // meaning "all of them". `ruleDirs` is matchingRuleDirs()'s answer and is
  // passed only for `kind === 'rule'`; an implementation may derive the same
  // test itself but must not drop it.
  matchingCounts(
    kind: NodeKind,
    filter: MemberFilter,
    ruleDirs?: ReadonlySet<number>,
  ): Promise<ReadonlyMap<number, number> | undefined>;

  // One page of the direct members of `id`, of `kind` if given and of both
  // otherwise. Rules before deps, stable order, and a short page means there
  // are no more.
  dirMembers(
    id: number,
    kind: NodeKind | undefined,
    limit: number,
    offset: number,
    filter: MemberFilter,
    dirPathMatches: boolean,
  ): Promise<readonly MemberEntry[]>;

  // Every direct member of `id` of the given kinds, as node ids - what the bulk
  // +all / -all buttons act on. Unbounded, unlike dirMembers: nothing is
  // rendered from these and the count is already on screen.
  dirMemberIds(
    id: number,
    kinds: readonly NodeKind[],
    filter: MemberFilter,
    dirPathMatches: boolean,
  ): Promise<readonly number[]>;
}

// The Explorer over the SQL mirror. Every member is the matching
// dir_explorer.ts function with the engine bound. `version` is the controller's
// `mirrorVersion`, not a counter of this object's own: the mirror is rebuilt
// without this object being replaced.
export class SqlDirExplorerSource implements DirExplorerSource {
  readonly rowDriven = false;

  constructor(
    private readonly engine: Engine,
    private readonly controller: DuneGraphController,
  ) {}

  get version(): number {
    return this.controller.mirrorVersion;
  }

  rootDirs(): Promise<readonly DirEntry[]> {
    return rootDirs(this.engine);
  }

  childDirs(id: number): Promise<readonly DirEntry[]> {
    return childDirs(this.engine, id);
  }

  allDirs(): Promise<readonly DirEntry[]> {
    return allDirs(this.engine);
  }

  matchingRuleDirs(path: PathFilter): Promise<ReadonlySet<number>> {
    return matchingRuleDirs(this.engine, path);
  }

  matchingCounts(
    kind: NodeKind,
    filter: MemberFilter,
    ruleDirs?: ReadonlySet<number>,
  ): Promise<ReadonlyMap<number, number> | undefined> {
    return matchingCounts(this.engine, kind, filter, ruleDirs);
  }

  dirMembers(
    id: number,
    kind: NodeKind | undefined,
    limit: number,
    offset: number,
    filter: MemberFilter,
    dirPathMatches: boolean,
  ): Promise<readonly MemberEntry[]> {
    return dirMembers(
      this.engine,
      id,
      kind,
      limit,
      offset,
      filter,
      dirPathMatches,
    );
  }

  dirMemberIds(
    id: number,
    kinds: readonly NodeKind[],
    filter: MemberFilter,
    dirPathMatches: boolean,
  ): Promise<readonly number[]> {
    return dirMemberIds(this.engine, id, kinds, filter, dirPathMatches);
  }
}
