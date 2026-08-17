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

import {PerfRun, measure, measureSync} from './perf';

// The dump's rows are keyed by their display column names.
function phaseNames(run: PerfRun): string[] {
  return run.tableRows().map((r) => r['phase']);
}

function rowFor(run: PerfRun, phase: string): Record<string, string> {
  const row = run.tableRows().find((r) => r['phase'] === phase);
  expect(row).toBeDefined();
  return row!;
}

describe('PerfRun', () => {
  it('lists phases in the order they first ran, then the summary rows', () => {
    const run = new PerfRun('test');
    run.phaseSync('second-to-run', () => {});
    run.phaseSync('first-to-finish', () => {});
    expect(phaseNames(run)).toEqual([
      'second-to-run',
      'first-to-finish',
      '(unaccounted)',
      'TOTAL',
    ]);
  });

  it('accumulates re-entered phases into one row with a count', () => {
    const run = new PerfRun('test');
    for (let i = 0; i < 3; i++) {
      run.phaseSync('chunk', (p) => {
        p.rows(10);
        p.bytes(1024);
      });
    }
    expect(phaseNames(run)).toEqual(['chunk', '(unaccounted)', 'TOTAL']);
    const row = rowFor(run, 'chunk');
    expect(row['n']).toBe('3');
    expect(row['rows']).toBe('30');
    expect(row['bytes']).toBe('3.0 KB');
  });

  it('leaves counters blank when nothing reported them', () => {
    const run = new PerfRun('test');
    run.phaseSync('bare', () => {});
    const row = rowFor(run, 'bare');
    // A single run isn't worth a count, and no rows/bytes were reported.
    expect(row['n']).toBe('');
    expect(row['rows']).toBe('');
    expect(row['bytes']).toBe('');
    expect(row['notes']).toBe('');
  });

  it('joins notes and returns the measured value', () => {
    const run = new PerfRun('test');
    const value = run.phaseSync('noted', (p) => {
      p.note('first');
      p.note('second');
      return 42;
    });
    expect(value).toBe(42);
    expect(rowFor(run, 'noted')['notes']).toBe('first; second');
  });

  it('closes a phase (and records the failure) when the body throws', () => {
    const run = new PerfRun('test');
    expect(() =>
      run.phaseSync('boom', () => {
        throw new Error('nope');
      }),
    ).toThrow('nope');
    run.fail('nope');
    expect(phaseNames(run)).toContain('boom');
    expect(rowFor(run, 'TOTAL')['notes']).toBe('nope');
  });

  it('measures async phases and preserves their result', async () => {
    const run = new PerfRun('test');
    const value = await run.phase('async', async (p) => {
      p.rows(7);
      return 'done';
    });
    expect(value).toBe('done');
    expect(rowFor(run, 'async')['rows']).toBe('7');
  });

  it('ignores a second end() on the same phase handle', () => {
    const run = new PerfRun('test');
    const phase = run.begin('once');
    phase.end();
    phase.end();
    expect(rowFor(run, 'once')['n']).toBe('');
  });

  it('accounts for every phase, leaving only the residue unattributed', () => {
    const run = new PerfRun('test');
    run.phaseSync('a', () => {});
    run.phaseSync('b', () => {});
    const percents = run
      .tableRows()
      .filter((r) => r['phase'] !== 'TOTAL')
      .map((r) => Number(r['%'].replace('%', '')));
    const sum = percents.reduce((acc, p) => acc + p, 0);
    // Rounding aside, the phases plus the residue are the whole run.
    expect(sum).toBeGreaterThan(99);
    expect(sum).toBeLessThan(101);
  });
});

describe('measure helpers', () => {
  it('run the body and record a phase when given a run', async () => {
    const run = new PerfRun('test');
    expect(measureSync(run, 'sync', () => 1)).toBe(1);
    expect(await measure(run, 'async', async () => 2)).toBe(2);
    expect(phaseNames(run)).toEqual([
      'sync',
      'async',
      '(unaccounted)',
      'TOTAL',
    ]);
  });

  it('still run the body when instrumentation is off', async () => {
    // The `p` handle must be usable even with no run behind it - that's the
    // whole point of the optional-PerfRun plumbing.
    expect(
      measureSync(undefined, 'sync', (p) => {
        p.rows(1);
        p.bytes(2);
        p.note('ignored');
        return 1;
      }),
    ).toBe(1);
    expect(
      await measure(undefined, 'async', async (p) => {
        p.rows(1);
        return 2;
      }),
    ).toBe(2);
  });
});
