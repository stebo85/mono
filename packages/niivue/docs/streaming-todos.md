# Chunked Streaming TODOs

Open follow-ups for the multi-LOD chunked volume path
(`src/volume/chunking.ts`, `src/volume/NVChunkedVolume.ts`, the `gl/` and
`wgpu/` chunk renderers). Design context: `docs/high-res-streaming.md` and
`docs/tiled-volumes.md`. Anything that changes rendering must land in BOTH
backends in the same change.

Order of work (Chris, 2026-08-21): fix the VISUAL artifacts first, then the
performance items. The two visual items are at the bottom of this file; decode
and budget plans wait behind them.

## Move chunk decode off the main thread

- [ ] Decode OME-Zarr chunks in a worker instead of on the main thread.

  `omeZarrChunkedSource.fetchChunk` calls `readLevelRegion`, which runs the
  whole zarrita path (fetch, decompress, dtype convert, region assemble) on the
  main thread. The GPU upload pump (`pumpChunkUploads`, both backends) then does
  its per-frame work on that same thread under a time budget. The result is the
  crawl a user sees while a zoomed-in view streams: every decode competes with
  the render loop, so interaction stutters exactly when the most bricks are
  arriving.

  `src/workers/` already exists but the chunked path does not use it. The shape
  of the fix: a small pool of decode workers, transfer the decoded
  `Uint8Array` back (transferable, not structured-cloned), keep the existing
  `createSourceChunkLoader` concurrency/retry/dedup wrapper unchanged so the
  manager sees the same `VolumeChunkSource` contract. `maxConcurrentLoads`
  (default 6) becomes the pool's queue depth rather than a bound on
  main-thread work.

  Worth measuring first: split the current per-brick cost into fetch, decode,
  and upload so the win is quantified before the worker plumbing lands. If most
  of the stall is `texSubImage3D` rather than decode, the answer is a different
  one (smaller bricks, or a longer upload budget spread over more frames).

## Budget plans

- [ ] Give the planner named **budget plans** rather than one crosshair-focused
      policy with a byte budget.

  Full design and staging: **`docs/budget-plans.md`**. In short: today's single
  policy is right for interactive exploration, wrong for a static whole-volume
  figure (which wants the finest UNIFORM level that fits) and wrong for smooth
  rotation (which wants a frame-time budget, since bytes do not predict draw
  cost). Presets `'focus'` / `'uniform'` / `'interactive'`, staged so the first
  two are near-free and only `'interactive'` needs a new cost model.

  Sequenced AFTER the visual-artifact work below.

## Carried over from the LOD compensation work

- [ ] Level-grid texture misregistration in `chunkUniformsFor`
      (`src/gl/render.ts`, `src/wgpu/render.ts`) and `chunkSampleTransform`
      (`src/volume/chunking.ts`). Confirmed real, but NOT the cause of the block
      seams (that was `lodGammaExponent`, fixed in `63e7df5d`). Must land in
      both backends.

- [ ] Residual LOD seams. At the refitted default (`0.08`) the measured step
      across a level boundary is about -10% on `hoa_heart`, down from +36%. No
      single coefficient nulls every dataset (sparse thin material wants ~0.11,
      dense structure ~0.05), so closing the rest is structural: either
      cross-LOD blending at brick faces (tracked as deferred in
      `FEATURE_PARITY.md`) or publishing a coverage-preserving pyramid. The
      max/mean blend prototype (0.85 max) landed every measured region within
      4% at every level and is the stronger lead.
