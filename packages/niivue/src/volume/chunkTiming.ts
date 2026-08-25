/**
 * Per-phase timing for the chunked-volume streaming path.
 *
 * Streaming a brick costs three very different kinds of work, and the plan in
 * `docs/caching.md` turns on which one dominates: bytes over the wire, decode
 * on the main thread, and the GPU upload. A decode worker (stage C) can move
 * the first two off the render thread and can do nothing about the third, so
 * the split has to be measured before the worker plumbing is worth writing.
 *
 * The recorder is a module-level singleton: it aggregates every chunked volume
 * on every instance in the page, which is what a profiling aid wants. It also
 * aggregates across CONSUMERS: a slide reading a plane out of a chunked volume
 * goes through the same `fetchChunk`, so its tiles land in `net` and `read`
 * beside the volume's bricks while only the volume's reads reach the brick
 * uploader. Divide each phase by its own `count`; a mean taken across two
 * phases with different counts means nothing. Call
 * {@link resetChunkTiming} to start a measurement window, exercise the view,
 * then read {@link chunkTimingSnapshot}.
 *
 * ```ts
 * resetChunkTiming()
 * // ... scrub a slice, rotate, zoom ...
 * const t = chunkTimingSnapshot()
 * console.log(t.phases.upload.totalMs / t.phases.upload.count)
 * ```
 *
 * What each phase measures, and how honest each number is:
 *
 * - `net` — one store `get`: the network round trip, or a hit in the byte LRU
 *   / HTTP cache. Exact per call.
 * - `read` — one whole `fetchChunk`: `net` plus decompression, dtype
 *   conversion and the region assemble. Wall clock, so concurrent reads
 *   overlap and the total exceeds elapsed time.
 * - `assemble` — the synchronous transpose / zero-pad loop that lays a store
 *   block out x-fastest. Exact, and always main-thread blocking.
 * - `upload` — building a texture from the decoded bytes: a volume brick, or
 *   an `NVSlide` tile drawn from the same source. On
 *   WebGPU this awaits `onSubmittedWorkDone`, so it is real GPU time; on
 *   WebGL2 it is the `texImage3D` submission, which is main-thread blocking
 *   but does not include the driver's own asynchronous work.
 * - `gradient` — the per-chunk gradient pass, same caveat per backend.
 *
 * Two derived numbers sit beside the phases, and both are exact rather than
 * inferred:
 *
 * - `mainThreadMs` is `assemble + upload + gradient`: the streaming work that
 *   actually blocks the render loop. This is the number stage C has to beat,
 *   and the part of it a decode worker CANNOT move (`upload` + `gradient`) is
 *   visible right next to it.
 * - `netBusyMs` is wall clock with at least one store `get` outstanding, as a
 *   UNION rather than a sum. One `zarr.get` fans out to every store chunk
 *   covering the region, so those calls overlap each other and overlap sibling
 *   reads; summing them counts the same wall clock many times over.
 *
 * Decode is deliberately NOT reported as a derived figure. It happens inside
 * zarrita between the store read and our assemble loop, we cannot time it
 * directly, and `read - net - assemble` is not a bound in either direction once
 * the `get` calls overlap. Measure it instead: re-visit bricks whose bytes are
 * already in the byte LRU, where `net` falls to near zero and `read - assemble`
 * IS decode.
 */

/** A phase of the per-chunk streaming pipeline. */
export type ChunkPhase = 'net' | 'read' | 'assemble' | 'upload' | 'gradient'

/** Accumulated timing for one {@link ChunkPhase}. */
export interface ChunkPhaseTiming {
  /** How many times the phase ran. */
  count: number
  /** Summed wall clock, milliseconds. */
  totalMs: number
  /** Slowest single run, milliseconds. */
  maxMs: number
  /** Bytes moved, where the phase knows (0 otherwise). */
  bytes: number
}

/** Everything the recorder holds, as a plain snapshot. */
export interface ChunkTimingSnapshot {
  /** Per-phase totals. */
  phases: Record<ChunkPhase, ChunkPhaseTiming>
  /**
   * Wall clock with at least one store `get` outstanding, as a union of the
   * outstanding intervals rather than a sum of them. Overlapping reads count
   * this time once.
   */
  netBusyMs: number
  /**
   * Streaming work that blocked the render loop: `assemble + upload +
   * gradient`. Exact, and the figure a decode worker has to improve on.
   */
  mainThreadMs: number
}

const PHASES: readonly ChunkPhase[] = [
  'net',
  'read',
  'assemble',
  'upload',
  'gradient',
]

function emptyPhase(): ChunkPhaseTiming {
  return { count: 0, totalMs: 0, maxMs: 0, bytes: 0 }
}

const totals = new Map<ChunkPhase, ChunkPhaseTiming>()

/** Outstanding store reads, for the `netBusyMs` union. */
let netOutstanding = 0
/** When the current run of outstanding reads began. */
let netRunStart = 0
/** Accumulated union of the outstanding-read intervals. */
let netBusyMs = 0

/** Add one run of `phase` to the totals. Non-finite durations are ignored. */
export function recordChunkPhase(
  phase: ChunkPhase,
  ms: number,
  bytes = 0,
): void {
  if (!Number.isFinite(ms) || ms < 0) return
  let entry = totals.get(phase)
  if (!entry) {
    entry = emptyPhase()
    totals.set(phase, entry)
  }
  entry.count++
  entry.totalMs += ms
  if (ms > entry.maxMs) entry.maxMs = ms
  if (Number.isFinite(bytes) && bytes > 0) entry.bytes += bytes
}

/** Time a synchronous span and record it as `phase`. */
export function timeChunkPhase<T>(
  phase: ChunkPhase,
  run: () => T,
  bytes = 0,
): T {
  const start = performance.now()
  try {
    return run()
  } finally {
    recordChunkPhase(phase, performance.now() - start, bytes)
  }
}

/**
 * Time an awaited span and record it as `phase`. The result is wall clock, so
 * overlapping calls each count their own full duration.
 */
export async function timeChunkPhaseAsync<T>(
  phase: ChunkPhase,
  run: () => Promise<T>,
  bytes = 0,
): Promise<T> {
  const start = performance.now()
  try {
    return await run()
  } finally {
    recordChunkPhase(phase, performance.now() - start, bytes)
  }
}

/**
 * Time an awaited store read: it counts toward the `net` phase like any other
 * span, and also toward the {@link ChunkTimingSnapshot.netBusyMs} union so
 * concurrent reads do not multiply-count the same wall clock.
 */
export async function timeChunkNetAsync<T extends { byteLength: number }>(
  run: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const start = performance.now()
  if (netOutstanding++ === 0) netRunStart = start
  let bytes: T | undefined
  try {
    bytes = await run()
    return bytes
  } finally {
    const end = performance.now()
    if (--netOutstanding === 0) netBusyMs += Math.max(0, end - netRunStart)
    recordChunkPhase('net', end - start, bytes?.byteLength ?? 0)
  }
}

/** Read the accumulated totals. The returned object is a copy. */
export function chunkTimingSnapshot(): ChunkTimingSnapshot {
  const phases = {} as Record<ChunkPhase, ChunkPhaseTiming>
  for (const phase of PHASES) {
    const entry = totals.get(phase)
    phases[phase] = entry ? { ...entry } : emptyPhase()
  }
  // A run still open at snapshot time counts up to now, so a long stall shows
  // as it happens rather than only once the last read lands.
  const openRun =
    netOutstanding > 0 ? Math.max(0, performance.now() - netRunStart) : 0
  return {
    phases,
    netBusyMs: netBusyMs + openRun,
    mainThreadMs:
      phases.assemble.totalMs + phases.upload.totalMs + phases.gradient.totalMs,
  }
}

/** Clear every phase. Call this to start a measurement window. */
export function resetChunkTiming(): void {
  totals.clear()
  netBusyMs = 0
  // Reads already in flight belong to the new window from here on.
  netRunStart = performance.now()
}
