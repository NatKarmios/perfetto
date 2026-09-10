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
 * The two integer containers the columnar graph core (`graph.ts`,
 * `graph_build.ts`) is built out of. Both exist for the same reason: on a
 * monorepo-scale trace the graph holds ~28M edge references and ~820k nodes
 * (see PERF_PLAN.LOCAL.md), which fits in `Int32Array`s and does not fit in JS
 * arrays, objects or `Map`s.
 */

// 1M entries - 4 MB - per chunk. Small enough that the slack in the last chunk
// is noise, big enough that the chunk list stays short (28 entries for the
// monorepo trace's edge vector).
const CHUNK_SHIFT = 20;
const CHUNK_SIZE = 1 << CHUNK_SHIFT;
const CHUNK_MASK = CHUNK_SIZE - 1;

/**
 * A growable vector of int32s, stored as fixed-size chunks rather than one
 * contiguous buffer.
 *
 * Chunked because the sizes involved are large and only known at the end. The
 * edge vector is ~115 MB on a monorepo trace: growing that by the usual
 * double-and-copy means a ~190 MB transient peak at the last doubling and up to
 * 2x slack retained afterwards, and flattening it to one exact-sized array at
 * the end means a second full copy. Appending a chunk costs 4 MB and no copy.
 *
 * The price is that a read goes through {@link Int32Vector.at} instead of an
 * index - two extra arithmetic ops, against an access pattern (random reads over
 * 115 MB) that is dominated by cache misses either way.
 */
export class Int32Vector {
  private readonly chunks: Int32Array[] = [];
  private size = 0;

  // A zero-filled vector of exactly `length` entries, for the cases where the
  // size is known up front and only {@link set} is used (see the reverse index
  // in graph.ts).
  static ofLength(length: number): Int32Vector {
    const vector = new Int32Vector();
    for (let i = 0; i < length; i += CHUNK_SIZE) {
      vector.chunks.push(new Int32Array(CHUNK_SIZE));
    }
    vector.size = length;
    return vector;
  }

  get length(): number {
    return this.size;
  }

  push(value: number): void {
    const i = this.size++;
    const c = i >>> CHUNK_SHIFT;
    if (c === this.chunks.length) this.chunks.push(new Int32Array(CHUNK_SIZE));
    this.chunks[c][i & CHUNK_MASK] = value;
  }

  // The value at `i`. Out-of-range indices are the caller's problem (they read
  // as 0 or throw), exactly as they would be on a raw `Int32Array`.
  at(i: number): number {
    return this.chunks[i >>> CHUNK_SHIFT][i & CHUNK_MASK];
  }

  set(i: number, value: number): void {
    this.chunks[i >>> CHUNK_SHIFT][i & CHUNK_MASK] = value;
  }

  // Appends every entry of `other`, which is left unchanged. Used to join two
  // separately-accumulated runs into one (see graph_build.ts, which accumulates
  // rule and dep edges separately and concatenates them into node-id order).
  append(other: Int32Vector): void {
    for (let i = 0; i < other.size; i++) this.push(other.at(i));
  }
}

// Ids at or above this are never given a slot in an {@link IntIndex}'s dense
// array, so a single wild id can't make it allocate unboundedly. 16M slots is
// 64 MB, which only a trace whose dict is already many GB could reach.
const MAX_DENSE_ID = 1 << 24;

/**
 * A mapping from a trace-side id (a `graph-dict` id, a `rule_id`) to a dense
 * index, as an `Int32Array` keyed by the id itself, with a `Map` for the ids
 * that don't fit it.
 *
 * Both id spaces this is used for are dense counters in every blob the exporter
 * produces, so in practice everything lands in the array and the map stays
 * empty; the map is there so a sparse - or malformed - blob degrades in speed
 * rather than in memory.
 */
export class IntIndex {
  private dense = new Int32Array(0);
  private readonly overflow = new Map<number, number>();

  // The index `id` maps to, or -1 if it doesn't map to one.
  get(id: number): number {
    if (id >= 0 && id < this.dense.length) return this.dense[id];
    return this.overflow.get(id) ?? -1;
  }

  /**
   * Maps `id` to `index`, unless `id` is already mapped - in which case the
   * existing mapping wins and this returns false. First-occurrence-wins is the
   * blob's own rule for a repeated record (see graph_build.ts).
   */
  add(id: number, index: number): boolean {
    if (this.get(id) >= 0) return false;
    if (id >= 0 && id < MAX_DENSE_ID) {
      if (id >= this.dense.length) this.grow(id + 1);
      this.dense[id] = index;
    } else {
      this.overflow.set(id, index);
    }
    return true;
  }

  // Grows the dense array to hold at least `needed` ids, doubling so that a
  // whole ingest costs O(log n) copies of an array that is itself small (2.6 MB
  // for the monorepo trace's 660k dict ids).
  private grow(needed: number): void {
    let length = Math.max(this.dense.length, 1024);
    while (length < needed) length *= 2;
    const grown = new Int32Array(Math.min(length, MAX_DENSE_ID)).fill(-1);
    grown.set(this.dense);
    this.dense = grown;
  }
}
