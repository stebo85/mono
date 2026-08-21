# Chunked Streaming TODOs

Open follow-ups for the multi-LOD chunked volume path
(`src/volume/chunking.ts`, `src/volume/NVChunkedVolume.ts`, the `gl/` and
`wgpu/` chunk renderers). Design context: `docs/high-res-streaming.md` and
`docs/tiled-volumes.md`. Anything that changes rendering must land in BOTH
backends in the same change.

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

  Today `loadChunkedVolume` always plans the same way: an octree focused on the
  crosshair (or a pinned point), refined by `detail`, then coarsened until it
  fits `budgetBytes` and `maxBricks`. That is the right policy for exploring a
  volume interactively, and the wrong one for at least two other real uses:

  | Use case | What the user wants | What they get today |
  | --- | --- | --- |
  | Static image of the whole volume | The finest UNIFORM level that fits VRAM, no focus falloff, quality everywhere | A sharp core around the crosshair and a coarse periphery, which is wrong for a figure |
  | Smooth rotate/zoom | The finest detail that still holds a frame-rate target | A byte budget, which does not predict frame time: brick count and total sampled voxels do |
  | Interactive exploration (current) | Detail where you are looking | Correct |

  Proposed API: a `budgetPlan` option on `loadChunkedVolume` taking either a
  preset name or an explicit object, so the presets stay readable and the
  escape hatch stays open.

  ```ts
  nv.loadChunkedVolume(url, { budgetPlan: 'uniform' })
  nv.loadChunkedVolume(url, { budgetPlan: { ...BUDGET_PLANS.interactive, budgetBytes: 2e9 } })
  ```

  Presets to start with:

  - `'focus'` (default, current behaviour): crosshair-follow, `radius: 'auto'`,
    `detail: 1`, byte-budgeted.
  - `'uniform'`: no falloff. Every brick at the finest level that fits the
    budget. Mechanically this already works today by planning with a radius
    that covers the whole volume: the `detail` shrink pass then has nothing to
    do and the budget pass raises the global level floor, which converges
    exactly to "finest uniform level that fits". What is missing is the name,
    the default of not subscribing `locationChange`, and the docs.
  - `'interactive'`: budgeted by draw cost, not VRAM. Caps `maxBricks` and
    total sampled voxels against a frame-time target.

  Two things need real work beyond naming:

  1. **A cost model.** `'interactive'` needs frame time as a budget currency.
     A static estimate (bricks x sampled voxels per brick x step count) is a
     starting point; a closed loop that measures actual frame time and steps
     `detail`/`minLevel` until it holds the target is the honest version, and
     needs a damping rule so it does not oscillate between two levels.
  2. **Switching plans mid-session.** A budget plan is not load-time-only. The
     natural flow is explore with `'focus'`, then switch to `'uniform'` to take
     a figure. `swapChunkedVolumePlan` already swaps a plan in place keeping
     unchanged bricks resident, so the plumbing exists; it needs a public
     `setBudgetPlan()` and a decision about what happens to a crosshair
     subscription when the plan no longer uses one.

  Naming note: "budget plan" is the user's term and reads well against the
  existing `ChunkPlan` (the output). Keep the distinction sharp in the docs:
  a **budget plan** is the POLICY, a **chunk plan** is the RESULT of applying
  it.

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
