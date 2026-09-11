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
 * Load-time instrumentation for the Dune graph plugin: a {@link PerfRun}
 * accumulates named phases and dumps them as a console table when the run
 * finishes. See ARCHITECTURE.md, "Performance", for what it produces and how to read
 * a heap delta.
 *
 * Two properties that constrain how a caller may use it:
 *
 * - **Phases are flat, not nested.** Every phase is a leaf, so the times sum to
 *   just under the run's wall clock and the dump can make the residue explicit
 *   as an `(unaccounted)` row rather than hiding double-counting.
 * - **Re-entering a phase name accumulates** into the same row, with an `n`
 *   count, so per-chunk work can be measured without producing thousands of
 *   rows.
 */

import {formatBytesIec} from '../../base/bytes_format';

// Prefix for every `performance.mark`/`measure` name this module emits, so the
// plugin's entries are greppable/filterable in the profiler and in
// `performance.getEntriesByType('measure')`.
const MARK_PREFIX = 'dune:';

// Chrome-only, non-standard. Absent on Firefox/Safari (and in vitest), so every
// read is optional and heap columns simply don't appear when it's missing.
interface MemoryInfo {
  readonly usedJSHeapSize: number;
}

function usedHeap(): number | undefined {
  const memory = (performance as unknown as {memory?: MemoryInfo}).memory;
  return memory?.usedJSHeapSize;
}

// The User Timing API is what feeds the profiler's Timings track, but it isn't
// universally implemented (jsdom, where the unit tests run, has `performance.
// now()` and nothing else), so every mark/measure goes through this guard.
const USER_TIMING =
  typeof performance.mark === 'function' &&
  typeof performance.measure === 'function' &&
  typeof performance.clearMarks === 'function';

/**
 * Handle on a phase that is currently running: lets the measured code attach
 * the counters that make the timing interpretable (how many rows it moved, how
 * many bytes it parsed) without the caller having to know them up front.
 */
export interface Phase {
  // Add to the phase's row count (e.g. rows read from a query, rows inserted).
  rows(n: number): void;

  // Add to the phase's byte count (e.g. length of the text parsed). For a
  // JS string that's its `length`, i.e. UTF-16 code units rather than the
  // encoded byte length - close enough for the ASCII-ish blob payloads, and
  // the number that actually predicts V8's cost.
  bytes(n: number): void;

  // Attach a free-form note, shown in the dump's last column.
  note(text: string): void;
}

// A phase that hasn't been closed yet. `end()` is idempotent.
interface ActivePhase extends Phase {
  end(): void;
}

interface PhaseRecord {
  readonly name: string;
  ms: number;
  count: number;
  rows?: number;
  bytes?: number;
  heapDelta?: number;
  readonly notes: string[];
}

let nextRunId = 0;

/**
 * One instrumented operation (in practice: one graph load), made of flat named
 * phases. Create it, wrap the interesting work in `phase()` / `phaseSync()` /
 * `begin()`, then call `finish()` exactly once.
 */
export class PerfRun {
  private readonly id = nextRunId++;
  private readonly phases = new Map<string, PhaseRecord>();
  // Insertion order, so the dump reads chronologically rather than by name.
  private readonly order: string[] = [];
  private markSeq = 0;
  private readonly startedAt = performance.now();
  private readonly startHeap = usedHeap();
  private endedAt?: number;
  private endHeap?: number;
  private failure?: string;

  constructor(readonly label: string) {}

  // Total wall-clock of the run so far (or its full duration once finished).
  get totalMs(): number {
    return (this.endedAt ?? performance.now()) - this.startedAt;
  }

  get finished(): boolean {
    return this.endedAt !== undefined;
  }

  /**
   * The phases recorded so far, in the order they first ran - the same order
   * the dump prints them in.
   *
   * Exposed so a declared list of phases can be checked against what the code
   * actually runs: sql_graph.ts's NODE_MIRROR_PHASES / EDGE_MIRROR_PHASES are
   * hand-written (the builders pass locals between phases, so they can't be a
   * driven-by-a-loop descriptor array), and this is what stops them drifting
   * when a `measure()` is added or renamed. Not for display - these are
   * console-facing diagnostic names.
   */
  get phaseNames(): readonly string[] {
    return this.order;
  }

  /**
   * Start a phase. The caller owns the returned handle and must `end()` it -
   * prefer `phase()`/`phaseSync()`, which do that (and cope with
   * exceptions) for you. Only use this directly when the measured region can't
   * be expressed as a single callback.
   */
  begin(name: string): ActivePhase {
    const record = this.recordFor(name);
    const startedAt = performance.now();
    const heapBefore = usedHeap();
    const mark = `${MARK_PREFIX}${this.id}#${this.markSeq++}`;
    if (USER_TIMING) performance.mark(`${mark}:begin`);
    let ended = false;
    return {
      rows: (n: number) => void (record.rows = (record.rows ?? 0) + n),
      bytes: (n: number) => void (record.bytes = (record.bytes ?? 0) + n),
      note: (text: string) => void record.notes.push(text),
      end: () => {
        if (ended) return;
        ended = true;
        record.ms += performance.now() - startedAt;
        record.count++;
        const heapAfter = usedHeap();
        if (heapBefore !== undefined && heapAfter !== undefined) {
          record.heapDelta = (record.heapDelta ?? 0) + (heapAfter - heapBefore);
        }
        if (USER_TIMING) {
          performance.mark(`${mark}:end`);
          performance.measure(
            `${MARK_PREFIX}${name}`,
            `${mark}:begin`,
            `${mark}:end`,
          );
          // The measure keeps its own copy of the timings; drop the marks so a
          // long load doesn't grow the user-timing buffer unboundedly.
          performance.clearMarks(`${mark}:begin`);
          performance.clearMarks(`${mark}:end`);
        }
      },
    };
  }

  // Measure an async region. The phase is closed even if `fn` throws, so a
  // failed load still reports where it got to.
  async phase<T>(name: string, fn: (p: Phase) => Promise<T>): Promise<T> {
    const p = this.begin(name);
    try {
      return await fn(p);
    } finally {
      p.end();
    }
  }

  // Synchronous `phase()`.
  phaseSync<T>(name: string, fn: (p: Phase) => T): T {
    const p = this.begin(name);
    try {
      return fn(p);
    } finally {
      p.end();
    }
  }

  // Record that the run failed; the message is shown in the dump's header.
  fail(message: string): void {
    this.failure = message;
  }

  /**
   * Close the run and print its breakdown. Calling this twice is a no-op after
   * the first.
   *
   * The console table is the only report: the marks this module emits are left
   * in the user-timing buffer as `dune:`-prefixed measures, so the profiler and
   * `performance.getEntriesByType('measure')` keep the timings on their own -
   * there is nothing for this module to retain and re-print.
   */
  finish(): void {
    if (this.endedAt !== undefined) return;
    this.endedAt = performance.now();
    this.endHeap = usedHeap();
    this.dump();
  }

  // Print this run's breakdown as a console table.
  private dump(): void {
    const heapTotal =
      this.startHeap !== undefined && this.endHeap !== undefined
        ? this.endHeap - this.startHeap
        : undefined;
    const header =
      `${MARK_PREFIX} ${this.label} — ${formatMs(this.totalMs)}` +
      (heapTotal === undefined
        ? ''
        : `, heap ${formatSignedBytes(heapTotal)}`) +
      (this.failure === undefined ? '' : ` — FAILED: ${this.failure}`);
    console.groupCollapsed(header);
    console.table(this.tableRows());
    console.groupEnd();
  }

  // The dump's rows, as plain display strings: the phases in the order they
  // first ran, then the residue between their sum and the run's wall clock,
  // then the total. Deliberately string-y - these are read by a human in a
  // console, not processed further.
  tableRows(): ReadonlyArray<TableRow> {
    // Snapshot the total once: on a run that hasn't finished yet it keeps
    // ticking, and a per-row re-read would make the percentages inconsistent
    // (they'd be taken against different denominators and wouldn't sum to 100).
    const totalMs = this.totalMs;
    const rows: TableRow[] = [];
    let accountedMs = 0;
    for (const name of this.order) {
      const record = this.phases.get(name);
      if (record === undefined) continue;
      accountedMs += record.ms;
      rows.push(
        tableRow(record.name, record.ms, totalMs, {
          count: record.count,
          rows: record.rows,
          bytes: record.bytes,
          heapDelta: record.heapDelta,
          notes: record.notes.join('; '),
        }),
      );
    }
    const heapTotal =
      this.startHeap !== undefined && this.endHeap !== undefined
        ? this.endHeap - this.startHeap
        : undefined;
    rows.push(tableRow('(unaccounted)', totalMs - accountedMs, totalMs, {}));
    rows.push(
      tableRow('TOTAL', totalMs, totalMs, {
        heapDelta: heapTotal,
        notes: this.failure,
      }),
    );
    return rows;
  }

  private recordFor(name: string): PhaseRecord {
    const existing = this.phases.get(name);
    if (existing !== undefined) return existing;
    const record: PhaseRecord = {name, ms: 0, count: 0, notes: []};
    this.phases.set(name, record);
    this.order.push(name);
    return record;
  }
}

// A `Phase` that records nothing, so the `measure`/`measureSync` helpers below
// can hand the measured code a handle even when instrumentation is off.
const NULL_PHASE: Phase = {
  rows: () => {},
  bytes: () => {},
  note: () => {},
};

/**
 * `run.phase(...)` when `run` is present, plain `fn()` when it isn't - so a
 * function that takes an optional {@link PerfRun} can instrument itself without
 * an `if` around every measured region.
 */
export async function measure<T>(
  run: PerfRun | undefined,
  name: string,
  fn: (p: Phase) => Promise<T>,
): Promise<T> {
  return run === undefined ? fn(NULL_PHASE) : run.phase(name, fn);
}

export function measureSync<T>(
  run: PerfRun | undefined,
  name: string,
  fn: (p: Phase) => T,
): T {
  return run === undefined ? fn(NULL_PHASE) : run.phaseSync(name, fn);
}

// One line of the dump. The keys are the console table's column headers, hence
// the display-friendly (and not identifier-shaped) names.
type TableRow = Record<string, string>;

function tableRow(
  phase: string,
  ms: number,
  totalMs: number,
  extra: {
    readonly count?: number;
    readonly rows?: number;
    readonly bytes?: number;
    readonly heapDelta?: number;
    readonly notes?: string;
  },
): TableRow {
  return {
    'phase': phase,
    'ms': formatMs(ms),
    '%': formatPercent(ms, totalMs),
    // Only worth showing when a phase ran more than once.
    'n': extra.count === undefined || extra.count === 1 ? '' : `${extra.count}`,
    'rows': extra.rows === undefined ? '' : extra.rows.toLocaleString(),
    'bytes': extra.bytes === undefined ? '' : formatBytesIec(extra.bytes),
    'heap Δ':
      extra.heapDelta === undefined ? '' : formatSignedBytes(extra.heapDelta),
    'notes': extra.notes ?? '',
  };
}

function formatMs(ms: number): string {
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms.toFixed(1)} ms`;
}

function formatPercent(part: number, whole: number): string {
  if (whole <= 0) return '';
  return `${((100 * part) / whole).toFixed(1)}%`;
}

// A heap delta, which is only readable with its sign spelled out: a phase that
// frees is as interesting as one that allocates. `formatBytesIec` writes the
// minus itself, so only the plus needs adding.
function formatSignedBytes(bytes: number): string {
  return bytes < 0 ? formatBytesIec(bytes) : `+${formatBytesIec(bytes)}`;
}
