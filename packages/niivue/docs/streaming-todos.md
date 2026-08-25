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

## Caching and prefetch

Full comparison against Neuroglancer, with the staged plan: **`docs/caching.md`**
(written for the 2026-08-26 discussion). The items it raises, shortest first:

- [x] Stale-drop and per-frame reprioritization in `ChunkResidencyManager`.
      DONE (`1a9d525d`). `_uploadQueue` was a plain FIFO that persisted across
      frames and was pruned only by `admit` and `remap`, so chunks requested for
      a viewport the user had already left still uploaded ahead of what was on
      screen. It is now a `Map` from chunk index to the frame the working set
      last asked for it: `requestUpload` re-stamps and reorders in O(1), the
      drain returns this frame's requests before older ones, and an entry
      unrequested for more than one frame is dropped rather than uploaded late
      (one frame of slack, because the pump is async). Same discipline `NVSlide`
      has always applied to tiles. `chunkStreamStats` reports a cumulative
      `staleDropped` on both backends so the win is measurable; the dandi-demo
      HUD shows it. Still open, and folded into the worker work below: an
      `AbortController` for fetches already in flight.

- [ ] Instrument fetch / decode / upload separately, before the worker work
      below. Without the split, the decode-worker win is a guess.

- [ ] Directional prefetch for slice scrolling and zoom. `CHUNK_PREFETCH_WINDOW`
      is pipeline lookahead over chunks we have already decided we need, not
      prediction. Both dominant interactions are one-dimensional, so
      extrapolating them needs no general framework.

- [ ] Demote on eviction instead of destroying. An evicted brick currently costs
      a full fetch + decode + upload to bring back; a small decoded tier sized
      off the GPU budget, holding only evicted chunks, makes it a re-upload.

- [ ] Persistent cross-session cache (Cache Storage or OPFS). Every tier we have
      dies on reload. For DANDI over S3 this is the most visible improvement
      available, and Neuroglancer does not do it.

- [x] Keep the previous resolution on screen while a finer level loads
      (NVSlide). `visibleTiles` now returns a `fallback` list of already-cached
      tiles from coarser levels covering the same viewport, coarsest first; both
      slide renderers paint it under the target level and skip the placeholder
      quad for any target tile still loading. Nothing is fetched for the fallback
      layer, and it is empty once every target tile is cached, so a settled view
      pays nothing. The volume path's equivalent is the coarse floor, which
      already exists. Not yet applied to the 3D slide-plane renderers, which
      drive visibility from world geometry via `requestTile`.

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

- [x] A demo with two side-by-side panels for looking INSIDE one LOD brick.

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

  Built, in two halves. `examples/vox.block.pick.html` does the picking half
  against a CPU-resident NIfTI: `pickExplodedBlock` ray-tests the exploded brick
  boxes and `extractChunkBlock` copies the picked brick out as a standalone
  volume that keeps the parent's anatomy.

  `examples/vox.block.pick.zarr.html` does the multi-LOD half against
  `hoa_heart` streamed from the public store, which is the part that tests
  `chunkOwnedTexBox`. A streamed volume holds its voxels in GPU brick textures,
  so `extractSubVolume` returns null for one and the right panel cannot be built
  by copying out of `img`. It instead opens a SECOND streamed volume over the
  same store, cropped to the picked brick's common-grid box, and lets that
  volume's own octree pull the crop down toward level 0 near its crosshair. Two
  details are worth carrying into any similar work:

  - A brick is already one texture's worth of data AT ITS OWN LEVEL, so
    re-fetching it at that level buys nothing. The detail comes from the crop
    source's finest levels, which is why the right panel is a fresh
    `loadChunkedVolume` over a cropped `ChunkedVolumeSource` rather than a
    re-request of the picked brick.
  - Picking needed a core change. `pickExplodedDraw` sampled the parent's CPU
    `img` to find the first voxel above threshold along the ray; a streamed
    volume has no `img`, so every pick landed on the brick's box face. It now
    falls back to `vol.pickSampler` (mm-space, backed by the coarse floor) when
    `img` is absent. That lives in `control/`, so both backends get it.

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

  Measured on `hoa_heart` (2026-08, all 7 levels): every dataset's
  `translation` is exactly half its own `scale` -- e.g. L5 has scale
  `[224.416, 224.416, 224.416]` um and translation `[112.208, 112.208,
  112.208]`. That is the OME-NGFF voxel-CENTRE convention, not a world origin:
  every level is corner-aligned at world 0, so what NiiVue drops for this store
  is a uniform half-voxel shift with NO inter-level misregistration. The gap
  still matters for any store that declares a real world origin (or per-level
  translations that are not a pure centre offset), and it is worth fixing for
  the half-voxel alone, but it is not the cause of any brick-alignment artifact
  seen so far. `examples/vox.block.pick.zarr.html` prints each level's `scale`,
  `translation`, and their ratio so the convention is visible in the demo.

  Shape of the fix: add an optional per-level `originMM` (or a full affine) to
  `ChunkedVolumeLevel`, populate it from the parsed `translation` in the
  OME-Zarr loader path, and have `createStreamingNVImage` write it into the
  affine's translation column instead of leaving it at zero. Levels declare
  their own translation in NGFF, so the coarse levels must not be assumed to
  share level 0's origin. Unit-testable end to end (no GPU needed): parse a
  fixture `.zattrs`, build the streaming NVImage, assert `matRAS[3,7,11]`.
