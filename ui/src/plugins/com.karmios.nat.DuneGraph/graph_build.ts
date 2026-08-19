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
 * Builds the columnar {@link BuildGraph} from the blob's records.
 *
 * {@link GraphBuilder} is the {@link GraphBlobSink} the parser streams into: it
 * copies each record's scalars into per-node columns and each of its dep
 * references into an edge vector, then drops the record. Nothing the parser
 * hands over is retained, which is the point - a `graph-rules` record holds the
 * rule's whole dep list, and 386k of them are the 28M-reference edge set (see
 * PERF_PLAN.LOCAL.md, stage 3).
 *
 * References can't be resolved as they arrive: a rule lists dep ids, and the
 * deps section is parsed after the rules section. So ingest stores the blob's own
 * trace-side ids and {@link GraphBuilder.finish} rewrites them in place into node
 * ids - one pass over the edge vector, no second copy of it - marking the ones no
 * record ever turned up for as {@link dangling}.
 */

import {IntIndex, Int32Vector} from './columns';
import type {ForcedByTag, GraphBlobSink, StringTable} from './graph_blob';
import type {DepRecord, RuleRecord} from './graph_blob';
import {EMPTY_STRING_TABLE} from './graph_blob';
import type {GraphColumns} from './graph';
import {
  BuildGraph,
  DEP_RESOLUTIONS,
  DEP_STATUSES,
  FORCED_BY_KINDS,
  NO_REF,
  OUTCOME_UNFINISHED,
  RESOLUTION_UNFINISHED,
  RULE_OUTCOMES,
  STATUS_OK,
  dangling,
} from './graph';
import type {PerfRun} from './perf';
import {measureSync} from './perf';

// Ids are stored in `Int32Array`s, and a dangling one as `-(id + 2)`, so this is
// the largest id that survives the round trip. Every id the exporter writes is a
// small counter; anything past this is a malformed blob, and is dropped rather
// than silently truncated into a collision with a real id.
const MAX_ID = 0x7ffffffd;

function isValidId(id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id <= MAX_ID;
}

// The stored code of a `forced_by` kind (see FORCED_BY_KINDS), offset by one so
// 0 means "not recorded".
function forcedByCode(tag: ForcedByTag | undefined): number {
  if (tag === undefined) return 0;
  const index = FORCED_BY_KINDS.indexOf(tag.kind);
  return index < 0 ? FORCED_BY_KINDS.indexOf('UNKNOWN') + 1 : index + 1;
}

// The trace-side id a `forced_by` tag names, or NaN for the payload-less kinds -
// resolved to a node (or to a dangling reference) by `finish`.
function forcedByRawId(tag: ForcedByTag | undefined): number {
  if (tag === undefined) return NaN;
  switch (tag.kind) {
    case 'RULE':
    case 'RULE_RECOVERY':
      return tag.ruleId;
    case 'DEP':
      return tag.depId;
    case 'DYNAMIC_INCLUDES':
    case 'GEN_RULES':
    case 'PFORM':
      return tag.pathId;
    default:
      return NaN;
  }
}

const RESOLUTION_RULE = DEP_RESOLUTIONS.indexOf('rule');

/**
 * Accumulates the blob's records into {@link GraphColumns}.
 *
 * Rules and deps are accumulated separately, each in ingest order, and joined
 * into one node-id space by {@link GraphBuilder.finish} - rules `[0, ruleCount)`,
 * then deps.
 * Keeping them apart is what makes the join a concatenation of the two edge
 * vectors (the dep one being tiny) rather than a reordering of the big one, and
 * it means the builder doesn't care which section the parser hands over first.
 *
 * The per-node scalar columns are plain JS arrays while they grow and become
 * `Int32Array`s in `finish`: they are ~400k entries each, so the transient copy
 * is a few MB, unlike the edge vector's 115 MB.
 */
export class GraphBuilder implements GraphBlobSink {
  private table: StringTable = EMPTY_STRING_TABLE;

  // Rules, indexed by rule node id.
  private readonly ruleIndex = new IntIndex();
  private readonly ruleIds: number[] = [];
  private readonly ruleDirIds: number[] = [];
  private readonly ruleOutcomes: number[] = [];
  private readonly ruleStaticCounts: number[] = [];
  private readonly ruleTargetStarts: number[] = [];
  private readonly ruleTargetFileCounts: number[] = [];
  private readonly ruleTargetIds: number[] = [];
  private readonly ruleDepsUnknown: number[] = [];
  private readonly ruleDynStages = new Map<number, Int32Array>();
  private readonly ruleEdgeStarts: number[] = [];
  private readonly ruleEdges = new Int32Vector();
  private readonly ruleForcedByKinds: number[] = [];
  private readonly ruleForcedByRawIds: number[] = [];

  // Deps, indexed by dep node id minus the rule count.
  private readonly depIndex = new IntIndex();
  private readonly depDictIds: number[] = [];
  private readonly depResolutions: number[] = [];
  private readonly depStatuses: number[] = [];
  private readonly depEdgeStarts: number[] = [];
  private readonly depEdges = new Int32Vector();
  private readonly depForcedByKinds: number[] = [];
  private readonly depForcedByRawIds: number[] = [];

  strings(table: StringTable): void {
    this.table = table;
  }

  /**
   * Ingests one `graph-rules` record. A repeated `rule_id` is dropped (first
   * occurrence wins, as the blob's own reading of a repeated span), so a
   * watch-mode trace doesn't get two sets of edges for one rule.
   */
  rule(record: RuleRecord): void {
    const nodeId = this.ruleIds.length;
    if (!isValidId(record.ruleId)) return;
    if (!this.ruleIndex.add(record.ruleId, nodeId)) return;
    this.ruleIds.push(record.ruleId);
    this.ruleDirIds.push(
      record.dirId !== undefined && isValidId(record.dirId)
        ? record.dirId
        : NO_REF,
    );
    const outcome = RULE_OUTCOMES.indexOf(record.outcome);
    this.ruleOutcomes.push(outcome < 0 ? OUTCOME_UNFINISHED : outcome);
    this.ruleDepsUnknown.push(record.depsUnknown ? 1 : 0);
    this.ruleForcedByKinds.push(forcedByCode(record.forcedBy));
    this.ruleForcedByRawIds.push(forcedByRawId(record.forcedBy));

    // Targets: files then dirs, so the split is one count rather than a flag
    // per target.
    this.ruleTargetStarts.push(this.ruleTargetIds.length);
    const files = this.pushIds(this.ruleTargetIds, record.targetFileIds);
    this.ruleTargetFileCounts.push(files);
    this.pushIds(this.ruleTargetIds, record.targetDirIds);

    // Edges: static deps then each dynamic stage in order, so an edge's kind
    // follows from its position (see BuildGraph.outEdges).
    const start = this.ruleEdges.length;
    this.ruleEdgeStarts.push(start);
    this.ruleStaticCounts.push(this.pushIds(this.ruleEdges, record.depIds));
    if (record.dynDepStages.length > 0) {
      const dynStart = this.ruleEdges.length;
      const ends = new Int32Array(record.dynDepStages.length);
      for (let stage = 0; stage < record.dynDepStages.length; stage++) {
        this.pushIds(this.ruleEdges, record.dynDepStages[stage]);
        ends[stage] = this.ruleEdges.length - dynStart;
      }
      this.ruleDynStages.set(nodeId, ends);
    }
  }

  // Ingests one `graph-deps` record; a repeated `dep_id` is dropped, as for
  // rules above.
  dep(record: DepRecord): void {
    const index = this.depDictIds.length;
    if (!isValidId(record.depId)) return;
    if (!this.depIndex.add(record.depId, index)) return;
    this.depDictIds.push(record.depId);
    const resolution = DEP_RESOLUTIONS.indexOf(record.resolution.kind);
    this.depResolutions.push(
      resolution < 0 ? RESOLUTION_UNFINISHED : resolution,
    );
    const status = DEP_STATUSES.indexOf(record.status);
    this.depStatuses.push(status < 0 ? STATUS_OK : status);
    this.depForcedByKinds.push(forcedByCode(record.forcedBy));
    this.depForcedByRawIds.push(forcedByRawId(record.forcedBy));

    // A dep's resolution *is* its out-edges: the one rule it resolved to, or
    // the deps it expanded to. `source` / `unknown` / `unfinished` have none.
    this.depEdgeStarts.push(this.depEdges.length);
    if (record.resolution.kind === 'rule') {
      if (isValidId(record.resolution.ruleId)) {
        this.depEdges.push(record.resolution.ruleId);
      }
    } else if (record.resolution.kind === 'expanded') {
      this.pushIds(this.depEdges, record.resolution.depIds);
    }
  }

  // Appends the ids that can be stored at all to a column, and returns how many
  // that was. An id the blob wrote unparseably (NaN) or out of range is dropped
  // here rather than becoming a reference to whatever node its truncation lands
  // on. `sink` is either an edge vector or a plain column - both just push.
  private pushIds(
    sink: {push(id: number): void},
    ids: readonly number[],
  ): number {
    let pushed = 0;
    for (const id of ids) {
      if (!isValidId(id)) continue;
      sink.push(id);
      pushed++;
    }
    return pushed;
  }

  /**
   * Resolves every reference to a node id and returns the finished graph. The
   * builder must not be used afterwards: the edge vector is rewritten in place
   * and handed over.
   */
  finish(perf?: PerfRun): BuildGraph {
    return measureSync(perf, 'graph: link references', (p) => {
      const ruleCount = this.ruleIds.length;
      const depCount = this.depDictIds.length;
      const ruleEdgeCount = this.ruleEdges.length;

      // Every rule edge names a dep by dict id.
      for (let i = 0; i < ruleEdgeCount; i++) {
        this.ruleEdges.set(i, this.depRef(this.ruleEdges.at(i), ruleCount));
      }
      // A dep's edges name either the rule it resolved to or further deps.
      for (let dep = 0; dep < depCount; dep++) {
        const start = this.depEdgeStarts[dep];
        const end =
          dep + 1 < depCount
            ? this.depEdgeStarts[dep + 1]
            : this.depEdges.length;
        const toRule = this.depResolutions[dep] === RESOLUTION_RULE;
        for (let i = start; i < end; i++) {
          const raw = this.depEdges.at(i);
          this.depEdges.set(
            i,
            toRule ? this.ruleRef(raw) : this.depRef(raw, ruleCount),
          );
        }
      }
      // One CSR over both kinds: the rule edges as they lie, then the dep edges
      // appended (0.7M against 28M on the monorepo trace, so this copies the
      // small side).
      const edgeTarget = this.ruleEdges;
      edgeTarget.append(this.depEdges);

      const nodeCount = ruleCount + depCount;
      const edgeOffset = new Int32Array(nodeCount + 1);
      for (let rule = 0; rule < ruleCount; rule++) {
        edgeOffset[rule] = this.ruleEdgeStarts[rule];
      }
      for (let dep = 0; dep < depCount; dep++) {
        edgeOffset[ruleCount + dep] = ruleEdgeCount + this.depEdgeStarts[dep];
      }
      edgeOffset[nodeCount] = edgeTarget.length;

      // Per-node columns are the two kinds' arrays laid end to end, which is
      // exactly node-id order.
      const forcedByKind = Uint8Array.from([
        ...this.ruleForcedByKinds,
        ...this.depForcedByKinds,
      ]);

      const ruleTargetOffset = new Int32Array(ruleCount + 1);
      ruleTargetOffset.set(this.ruleTargetStarts);
      ruleTargetOffset[ruleCount] = this.ruleTargetIds.length;

      const columns: GraphColumns = {
        strings: this.table,
        ruleId: Int32Array.from(this.ruleIds),
        ruleDirId: Int32Array.from(this.ruleDirIds),
        ruleOutcome: Uint8Array.from(this.ruleOutcomes),
        ruleStaticCount: Int32Array.from(this.ruleStaticCounts),
        ruleTargetOffset,
        ruleTargetFiles: Int32Array.from(this.ruleTargetFileCounts),
        ruleTargetId: Int32Array.from(this.ruleTargetIds),
        ruleDepsUnknown: Uint8Array.from(this.ruleDepsUnknown),
        ruleDynStages: this.ruleDynStages,
        depDictId: Int32Array.from(this.depDictIds),
        depResolution: Uint8Array.from(this.depResolutions),
        depStatus: Uint8Array.from(this.depStatuses),
        forcedByKind,
        forcedByPayload: this.forcedByPayloads(forcedByKind, ruleCount),
        edgeOffset,
        edgeTarget,
        ruleIndex: this.ruleIndex,
        depIndex: this.depIndex,
      };
      p.rows(edgeTarget.length);
      p.note(`${ruleCount} rules, ${depCount} deps`);
      return new BuildGraph(columns);
    });
  }

  // The `forced_by` payload column: one entry per node, in node-id order, with
  // each rule/dep forcer (RULE, RULE_RECOVERY, DEP) resolved to the node it
  // names (or to a dangling reference) and each path-bearing kind left as its
  // dict id.
  private forcedByPayloads(
    forcedByKind: Uint8Array,
    ruleCount: number,
  ): Int32Array {
    const payloads = new Int32Array(forcedByKind.length);
    for (let i = 0; i < forcedByKind.length; i++) {
      const kind = FORCED_BY_KINDS[forcedByKind[i] - 1];
      const id =
        i < ruleCount
          ? this.ruleForcedByRawIds[i]
          : this.depForcedByRawIds[i - ruleCount];
      if (kind === 'RULE' || kind === 'RULE_RECOVERY') {
        payloads[i] = this.ruleRef(id);
      } else if (kind === 'DEP') {
        payloads[i] = this.depRef(id, ruleCount);
      } else if (
        kind === 'DYNAMIC_INCLUDES' ||
        kind === 'GEN_RULES' ||
        kind === 'PFORM'
      ) {
        payloads[i] = isValidId(id) ? id : NO_REF;
      } else {
        payloads[i] = NO_REF;
      }
    }
    return payloads;
  }

  // A reference to the rule / dep a trace-side id names: its node id, a dangling
  // reference when no record turned up for it, or NO_REF when the id itself is
  // unusable.
  private ruleRef(ruleId: number): number {
    if (!isValidId(ruleId)) return NO_REF;
    const nodeId = this.ruleIndex.get(ruleId);
    return nodeId < 0 ? dangling(ruleId) : nodeId;
  }

  private depRef(dictId: number, ruleCount: number): number {
    if (!isValidId(dictId)) return NO_REF;
    const index = this.depIndex.get(dictId);
    return index < 0 ? dangling(dictId) : ruleCount + index;
  }
}
