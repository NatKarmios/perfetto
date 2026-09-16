# Overlap Count

**Purpose:** Measure concurrency. Turn a set of intervals into a counter which, at every timestamp where the count changes, reports how many of the input intervals are open at that moment.

**How to use:**
- Connect an input that contains interval data with `ts` and `dur` columns
- No configuration is required

**Data transformation:**
- Each interval contributes `+1` at its start and `-1` at its end
- Events at the same timestamp are merged, so there are no zero-length artifacts
- The output is a running total, ordered by timestamp

**Output columns:**
- `ts`: The timestamp at which the count changed
- `value`: The number of intervals open from `ts` until the next row

The input columns are **not** preserved: the output is only `ts` and `value`. Put any filtering (for example, restricting to one slice name or one track) upstream of this node.

Intervals with `dur = -1` (unfinished) never close, so they keep contributing to the count for the rest of the trace.

**Example 1 - Concurrent work:** Count how many slices of a given name run at once:
- Input: Table Source with the `slice` table, filtered to the name of interest
- Result: A counter showing how many of those slices overlap over time

**Example 2 - Thread-level parallelism:** Count runnable threads over time:
- Input: Scheduling intervals for the runnable state
- Result: A counter showing how many threads were runnable at each moment

**SQL equivalent:** Uses the `intervals_overlap_count!()` PerfettoSQL macro from the `intervals.overlap` module.
