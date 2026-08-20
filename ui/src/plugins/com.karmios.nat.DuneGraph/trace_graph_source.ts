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

import type {Engine} from '../../trace_processor/engine';
import {
  LONG,
  LONG_NULL,
  NUM,
  STR,
  STR_NULL,
} from '../../trace_processor/query_result';
import type {
  BuildGraph,
  GraphSectionStats,
  GraphSource,
  GraphStats,
} from './graph';
import {GraphBuilder} from './graph_build';
import type {BlobChunkMeta, SectionChunks} from './graph_blob';
import {
  BLOB_TRACK,
  CORES_SECTION,
  DEPSETS_SECTION,
  DEPS_SECTION,
  DICT_SECTION,
  RULES_SECTION,
  orderedChunks,
  parseGraphBlob,
} from './graph_blob';
import type {PerfRun} from './perf';
import {measure} from './perf';

// Slice tracks carrying lifecycle instants that resolve to graph nodes. Each
// carries `<track>-start` / `<track>-finish` / `<track>-resolved` instants -
// see `graph_blob.ts`'s file header and `doc/dev/trace-graph-perfetto.md`.
// `gen-rules` / `dynamic-includes` are deliberately excluded: their start and
// finish instants share no join key (see the plugin's reported schema gaps),
// so they can't become nodes.
const RULE_TRACK = 'exec-rule';
const DEP_TRACK = 'build-dep';
const ACTION_TRACK = 'exec-rule-action';
const LIFECYCLE_TRACKS = [RULE_TRACK, DEP_TRACK, ACTION_TRACK];

// Average bytes per dep id in the `graph-rules` payload, used to turn that
// section's byte size into an edge-count estimate without parsing it (see
// `stats()`). The section is overwhelmingly comma-separated decimal dep ids -
// on the monorepo trace of the perf plan's baseline, 262 MB of blob against
// 28.0M real edges, this is within a few percent.
const BYTES_PER_DEP_ID = 7;

// What the panel shows - and what `load()` throws - when the trace carries no
// graph at all. Shared so the cheap `stats()` probe fails exactly the way a
// real load would.
function noBlobTrackError(): Error {
  return new Error(
    `No '${BLOB_TRACK}' track found in this trace. Either it predates ` +
      'the v1 Dune graph schema, or it was recorded without ' +
      "DUNE_TRACE=+graph (or the equivalent 'graph' category).",
  );
}

/**
 * A {@link GraphSource} that reads the v1 graph-blob schema: structure comes
 * from the chunked `dune-graph` blob (`graph_blob.ts`), timing from lifecycle
 * instants on `exec-rule` / `build-dep` / `exec-rule-action`, joined by
 * `rule_id` / `dep_id` - never by slice id or flow, per the schema's contract.
 */
export class TraceGraphSource implements GraphSource {
  constructor(private readonly engine: Engine) {}

  get description(): string {
    return `graph blob • ${BLOB_TRACK}`;
  }

  /**
   * The cheap probe behind the side panel's pre-load summary: how big the blob
   * is and how many lifecycle instants back it, as three SQL aggregates. The
   * payload strings are measured (`length()`) inside trace processor and never
   * cross into JS - the transfer is most of what makes `load()` expensive - so
   * this stays affordable on a trace whose blob is hundreds of megabytes.
   */
  async stats(): Promise<GraphStats> {
    const blob = await this.engine.query(`
      select s.name as section, count(*) as chunks,
        sum(length(extract_arg(s.arg_set_id, 'debug.dune.data'))) as bytes
      from slice s join track t on s.track_id = t.id
      where t.name = '${BLOB_TRACK}'
      group by s.name
      order by s.name
    `);
    const sections: GraphSectionStats[] = [];
    let bytes = 0;
    let rulesBytes = 0;
    const it = blob.iter({section: STR, chunks: NUM, bytes: LONG_NULL});
    for (; it.valid(); it.next()) {
      const sectionBytes = it.bytes === null ? 0 : Number(it.bytes);
      sections.push({name: it.section, chunks: it.chunks, bytes: sectionBytes});
      bytes += sectionBytes;
      if (it.section === RULES_SECTION) rulesBytes = sectionBytes;
    }
    if (sections.length === 0) throw noBlobTrackError();

    const tracks = LIFECYCLE_TRACKS.map((t) => `'${t}'`).join(', ');
    const lifecycle = await this.engine.query(`
      select count(*) as instants
      from slice s join track t on s.track_id = t.id
      where t.name in (${tracks})
    `);
    return {
      sections,
      bytes,
      lifecycleInstants: lifecycle.firstRow({instants: NUM}).instants,
      estimatedEdges: Math.round(rulesBytes / BYTES_PER_DEP_ID),
    };
  }

  /**
   * The structural graph, straight off the blob. Nothing timing-shaped is read
   * here: since the perf plan's stage 2 the lifecycle instants are paired in
   * SQL (see `lifecycle_sql.ts`) and a node's timing is looked up when it's
   * shown, so a load no longer transfers 2.4M instants into JS to build a
   * `SpanTiming` per node and a slice-id index over all of them.
   *
   * The blob's records are streamed straight into the columnar store
   * (`graph_build.ts`) and never collected: since the perf plan's stage 3 there
   * is no intermediate array of records, no node object and no per-rule dep
   * array - a rule's deps are edges in one shared CSR, and its `dir` / target
   * ids stay dict ids, resolved through the intern table only where they're
   * displayed. On the monorepo trace those references number 28M against 660k
   * distinct strings.
   *
   * Throws (surfaced by the controller as the panel's error state) rather than
   * returning an empty graph when the `dune-graph` track is absent - a trace
   * that predates the v1 schema, or one recorded without `DUNE_TRACE=+graph`,
   * should fail loudly rather than silently show nothing.
   *
   * The blob itself is read in two passes: a cheap metadata query that validates
   * each section's chunk set without reading a byte of payload, then one query
   * per chunk, each fed straight into the streaming parser. Deliberately *not*
   * one query for everything: a query result decodes and holds every string
   * column it returned for as long as it's alive, so a single blob query would
   * keep all 262 MB of a monorepo trace's payload live for the whole parse - on
   * top of everything the parse itself builds. Per-chunk, only the chunk
   * currently being parsed is live.
   */
  async load(perf?: PerfRun): Promise<BuildGraph> {
    const index = await this.readChunkIndex(perf);
    if (index.size === 0) throw noBlobTrackError();
    const sections = new Map<string, SectionChunks>();
    // The parser fixes the order it consumes these in (a rule's dep set has to
    // be known by the time the rule arrives), so this is just the set of
    // sections to look for - a trace missing one, `graph-cores` in particular,
    // is normal and parses as empty.
    for (const name of [
      DICT_SECTION,
      CORES_SECTION,
      DEPSETS_SECTION,
      RULES_SECTION,
      DEPS_SECTION,
    ]) {
      sections.set(name, this.sectionChunks(name, index.get(name) ?? [], perf));
    }
    const builder = new GraphBuilder();
    await parseGraphBlob(sections, builder, perf);
    return builder.finish(perf);
  }

  // Every blob chunk's metadata (and the slice it lives on), grouped by
  // section. No payloads: `extract_arg(... 'data')` is the expensive column and
  // is left for `sectionChunks` to fetch one chunk at a time.
  private async readChunkIndex(
    perf?: PerfRun,
  ): Promise<Map<string, ChunkRef[]>> {
    const result = await measure(perf, 'blob: chunk index', () =>
      this.engine.query(`
        select s.id as sliceId, s.name as section,
          extract_arg(s.arg_set_id, 'debug.dune.version') as version,
          extract_arg(s.arg_set_id, 'debug.dune.seq') as seq,
          extract_arg(s.arg_set_id, 'debug.dune.total') as total
        from slice s join track t on s.track_id = t.id
        where t.name = '${BLOB_TRACK}'
        order by s.name, seq
      `),
    );
    const bySection = new Map<string, ChunkRef[]>();
    const it = result.iter({
      sliceId: NUM,
      section: STR,
      version: LONG,
      seq: LONG,
      total: LONG,
    });
    for (; it.valid(); it.next()) {
      const list = bySection.get(it.section) ?? [];
      list.push({
        sliceId: it.sliceId,
        name: it.section,
        version: Number(it.version),
        seq: Number(it.seq),
        total: Number(it.total),
      });
      bySection.set(it.section, list);
    }
    return bySection;
  }

  // One section's payloads, in `seq` order, fetched lazily as the parser pulls
  // them. `orderedChunks` validates the set (version / seq / total) before the
  // first fetch, so a corrupt section still fails loudly rather than parsing
  // half a graph.
  private async *sectionChunks(
    name: string,
    chunks: readonly ChunkRef[],
    perf?: PerfRun,
  ): SectionChunks {
    for (const chunk of orderedChunks(name, chunks)) {
      yield await measure(perf, 'blob: fetch chunks', async (p) => {
        const result = await this.engine.query(`
          select extract_arg(arg_set_id, 'debug.dune.data') as data
          from slice where id = ${chunk.sliceId}
        `);
        const data = result.firstRow({data: STR_NULL}).data ?? '';
        p.rows(1);
        p.bytes(data.length);
        return data;
      });
    }
  }
}

// A blob chunk's metadata plus the slice it lives on, so its payload can be
// fetched on its own later (see `sectionChunks`).
interface ChunkRef extends BlobChunkMeta {
  readonly sliceId: number;
}
