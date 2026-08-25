# Chunked Streaming TODOs

Open follow-ups for the multi-LOD chunked volume path
(`src/volume/chunking.ts`, `src/volume/NVChunkedVolume.ts`, the `gl/` and
`wgpu/` chunk renderers). Design context: `docs/high-res-streaming.md` and
`docs/tiled-volumes.md`. Anything that changes rendering must land in BOTH
backends in the same change.

Order of work (Chris, 2026-08-21): fix the VISUAL artifacts first, then the
performance items. The visual items are under "Carried over from the LOD
compensation work"; decode and budget plans wait behind them.

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

- [x] Level-grid texture misregistration in `chunkUniformsFor`
      (`src/gl/render.ts`, `src/wgpu/render.ts`) and `chunkSampleTransform`
      (`src/volume/chunking.ts`). FIXED: `chunkOwnedTexBox` in `chunking.ts` is
      now the single source for the texture remap in all three call sites, and
      it maps the brick's OWNED common-grid box rather than the fetched box
      that `emitBrick` snaps out to whole level voxels. On the real hoa_heart
      pyramid this moved brick content by up to 3.4 / 6.3 / 8.7 common voxels at
      L2 / L3 / L4 and corrected a stretch of up to 5.9 / 12.4 / 23.7. A
      single-level plan is bit-identical to before. This was NOT the cause of
      the block seams (that was `lodGammaExponent`, fixed in `63e7df5d`).

- [ ] Residual LOD seams. At the refitted default (`0.08`) the measured step
      across a level boundary is about -10% on `hoa_heart`, down from +36%. No
      single coefficient nulls every dataset (sparse thin material wants ~0.11,
      dense structure ~0.05), so closing the rest is structural: either
      cross-LOD blending at brick faces (tracked as deferred in
      `FEATURE_PARITY.md`) or publishing a coverage-preserving pyramid. The
      max/mean blend prototype (0.85 max) landed every measured region within
      4% at every level and is the stronger lead.

## Two-panel block inspector demo

- [ ] A demo with two side-by-side panels for looking INSIDE one LOD brick.

  Left panel: `hoa_heart` at a coarse level (L3 or L4) with the explode factor
  above 1, so the brick lattice is visible and individually pickable. The user
  clicks a brick.

  Right panel: that same brick re-rendered on its own, but built from the L0
  chunks that tile it, loaded as a separate `NVImage`. So the left panel shows
  where the brick sits in the whole heart at the level the streamer actually
  chose, and the right shows the finest data underneath it.

  What it is for: this is the direct visual test for exactly the class of bug
  `chunkOwnedTexBox` just fixed. A registration or reconstruction error inside a
  single brick is nearly invisible in the full render and obvious when the
  coarse brick and its L0 constituents sit side by side. It also gives the
  pyramid-coverage work (the max/mean blend) a way to compare a coarse brick
  against its own fine data directly rather than through a whole-volume
  difference.

  Notes for whoever builds it: brick picking needs a ray test against the
  exploded brick boxes (the plan already has every box in common-grid coords);
  the right panel needs the set of L0 chunks covering one brick's common box,
  which is a `chunkVolumeGrid` over that sub-box against level 0; both panels
  must work on both backends.

  Partly built. `examples/vox.block.pick.html` does the picking half against a
  CPU-resident NIfTI: `pickExplodedBlock` ray-tests the exploded brick boxes and
  `extractChunkBlock` copies the picked brick out as a standalone volume that
  keeps the parent's anatomy. What is still missing is the multi-LOD half, which
  is the part that tests `chunkOwnedTexBox`: a streamed volume holds its voxels
  in GPU brick textures, so `extractSubVolume` returns null for one and the right
  panel has to be built by fetching the L0 chunks that tile the picked brick
  rather than by copying out of `img`.

## OME-Zarr world origin never reaches the volume affine

- [ ] Thread the OME-NGFF `translation` through to the streamed volume's affine.

  OME-NGFF's equivalent of a NIfTI sform/qform is the per-dataset
  `coordinateTransformations` list, which carries a `scale` and a `translation`.
  `src/volume/omeZarr.ts` already parses BOTH, but only the scale survives the
  trip to a volume:

  - `omeZarrChannelFile` / `channelVolumeFile` (`src/volume/omeZarrLoader.ts`)
    build an explicitly origin-centred volume.
  - `ChunkedVolumeLevel` (`src/volume/ChunkedVolumeSource.ts`) carries
    `level` / `shape` / `spacing` and has no origin field.
  - `createStreamingNVImage` (`src/volume/streamingVolume.ts`) builds
    `affine = diag(spacing)`, pinning the origin at voxel `[0,0,0]`.

  So an OME-Zarr volume's mm coordinates are relative to its own corner, not to
  the world origin the store declares. Anything that reasons in anatomical mm is
  affected: the crosshair readout, cross-store alignment, and in particular
  `extractSubVolume` (`src/volume/ChunkExtract.ts`), which inherits the parent's
  `matRAS` verbatim. For a NIfTI parent that means the extracted block reports
  true anatomical mm; for an OME-Zarr parent it means the block faithfully
  reproduces an affine that was already missing its world origin. See
  `examples/vox.block.pick.html`, which demonstrates the NIfTI case.

  Shape of the fix: add an optional per-level `originMM` (or a full affine) to
  `ChunkedVolumeLevel`, populate it from the parsed `translation` in the
  OME-Zarr loader path, and have `createStreamingNVImage` write it into the
  affine's translation column instead of leaving it at zero. Levels declare
  their own translation in NGFF, so the coarse levels must not be assumed to
  share level 0's origin. Unit-testable end to end (no GPU needed): parse a
  fixture `.zattrs`, build the streaming NVImage, assert `matRAS[3,7,11]`.
