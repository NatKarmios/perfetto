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

import {IntIndex, Int32Vector} from './columns';

// One past the last index of the first chunk, so the tests below actually
// exercise a chunk crossing rather than trusting that they would. Kept in sync
// with columns.ts by construction: it's derived from where the crossing shows up
// (a fresh vector's 1048576th push), not hardcoded independently.
const CHUNK_SIZE = 1 << 20;

describe('Int32Vector', () => {
  it('reads back what was pushed', () => {
    const vector = new Int32Vector();
    for (let i = 0; i < 100; i++) vector.push(i * 3);

    expect(vector.length).toBe(100);
    expect(vector.at(0)).toBe(0);
    expect(vector.at(99)).toBe(297);
  });

  it('holds negative values (the dangling-reference encoding)', () => {
    const vector = new Int32Vector();
    vector.push(-1);
    vector.push(-2147483648);

    expect(vector.at(0)).toBe(-1);
    expect(vector.at(1)).toBe(-2147483648);
  });

  it('sets values in place', () => {
    const vector = new Int32Vector();
    for (let i = 0; i < 10; i++) vector.push(0);
    vector.set(4, 42);

    expect(vector.at(4)).toBe(42);
    expect(vector.at(3)).toBe(0);
    expect(vector.length).toBe(10);
  });

  it('reads and writes across a chunk boundary', () => {
    const vector = new Int32Vector();
    // Straddle the boundary: the last two entries of chunk 0 and the first two
    // of chunk 1.
    for (let i = 0; i < CHUNK_SIZE + 2; i++) vector.push(i);

    expect(vector.length).toBe(CHUNK_SIZE + 2);
    expect(vector.at(CHUNK_SIZE - 1)).toBe(CHUNK_SIZE - 1);
    expect(vector.at(CHUNK_SIZE)).toBe(CHUNK_SIZE);
    expect(vector.at(CHUNK_SIZE + 1)).toBe(CHUNK_SIZE + 1);
    vector.set(CHUNK_SIZE, -7);
    expect(vector.at(CHUNK_SIZE)).toBe(-7);
    expect(vector.at(CHUNK_SIZE - 1)).toBe(CHUNK_SIZE - 1);
  });

  it('ofLength gives a zero-filled vector of exactly that length', () => {
    const vector = Int32Vector.ofLength(CHUNK_SIZE + 3);

    expect(vector.length).toBe(CHUNK_SIZE + 3);
    expect(vector.at(0)).toBe(0);
    expect(vector.at(CHUNK_SIZE + 2)).toBe(0);
    vector.set(CHUNK_SIZE + 2, 5);
    expect(vector.at(CHUNK_SIZE + 2)).toBe(5);
  });

  it('ofLength(0) is empty, and can still be appended to', () => {
    const vector = Int32Vector.ofLength(0);
    expect(vector.length).toBe(0);
    vector.push(9);
    expect(vector.at(0)).toBe(9);
  });

  it('appends another vector, leaving it unchanged', () => {
    const first = new Int32Vector();
    first.push(1);
    first.push(2);
    const second = new Int32Vector();
    second.push(3);
    second.push(4);

    first.append(second);

    expect(first.length).toBe(4);
    expect([0, 1, 2, 3].map((i) => first.at(i))).toEqual([1, 2, 3, 4]);
    expect(second.length).toBe(2);
  });
});

describe('IntIndex', () => {
  it('reports -1 for an id it does not hold', () => {
    const index = new IntIndex();
    expect(index.get(0)).toBe(-1);
    expect(index.get(7)).toBe(-1);
    expect(index.get(-1)).toBe(-1);
  });

  it('maps ids to indices', () => {
    const index = new IntIndex();
    expect(index.add(5, 0)).toBe(true);
    expect(index.add(9, 1)).toBe(true);

    expect(index.get(5)).toBe(0);
    expect(index.get(9)).toBe(1);
    expect(index.get(6)).toBe(-1);
  });

  it('maps id 0 to index 0 (neither is mistaken for absent)', () => {
    const index = new IntIndex();
    index.add(0, 0);
    expect(index.get(0)).toBe(0);
  });

  it('keeps the first mapping when an id repeats', () => {
    const index = new IntIndex();
    index.add(3, 0);

    expect(index.add(3, 1)).toBe(false);
    expect(index.get(3)).toBe(0);
  });

  it('grows to hold ids well past its initial size', () => {
    const index = new IntIndex();
    index.add(0, 0);
    index.add(500_000, 1);

    expect(index.get(0)).toBe(0);
    expect(index.get(500_000)).toBe(1);
    expect(index.get(499_999)).toBe(-1);
  });

  it('holds an id past the dense limit in the overflow map', () => {
    const index = new IntIndex();
    const wild = 1 << 25; // past MAX_DENSE_ID
    index.add(wild, 0);
    index.add(1, 1);

    expect(index.get(wild)).toBe(0);
    expect(index.get(1)).toBe(1);
    expect(index.add(wild, 2)).toBe(false);
  });
});
