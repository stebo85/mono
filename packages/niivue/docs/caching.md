# Caching and Prefetch

What NiiVue caches today when it streams a remote pyramid, where Neuroglancer
is ahead of us, and the order we should close the gap. Written for the
2026-08-26 discussion following Stephan Bollmann's DANDI demo, where Daniel
Haehn raised caching and Chris Rorden pointed at Neuroglancer's predictive
caching.

Companion docs: `high-res-streaming.md` (how the chunked path works),
`budget-plans.md` (how a plan chooses which bricks to want),
`parity-neuroglancer-napari.md` (the wider feature comparison; its section 1
already grades our scheduler and budgets as partial),
`streaming-todos.md` (the open work list this doc feeds).

**Status:** Stage A landed on 2026-08-25 (`1a9d525d`). Section 2.2 and the
Stage A row below describe what changed; everything else is still open.

## 1. What we cache today

Two independent stacks, because a streamed volume and a deep-zoom slide are
different resources. Both are byte-budgeted LRUs; neither is persistent.

### Volume path (`loadChunkedVolume`)

| Tier | Holds | Where | Default budget |
|---|---|---|---|
| Store bytes | RAW compressed store responses, keyed by store path | `ByteLruCache` behind zarrita's `withByteCaching` (`volume/omeZarrChunkedSource.ts`) | 256 MB (`OME_ZARR_CHUNK_CACHE_BYTES`); dandi-demo raises it to 512 MB |
| GPU bricks | Uploaded 3D brick textures | `ChunkResidencyManager` (`volume/ChunkResidency.ts`) | 1.5 GB (`DEFAULT_CHUNK_RESIDENCY_BYTES`) |
| Coarse floor | The coarsest pyramid level as ONE whole-volume texture | `gl/render.ts`, `wgpu/render.ts` | always resident |

The residency LRU stamps recency from the per-frame working set
(`requestUpload`), never evicts a chunk touched in the current frame, and
cross-fades a newly admitted brick in over the coarse floor across
`chunkFadeMs` (120 ms). The pump uploads under an 8 ms per-frame budget capped
at 24 chunks, and peeks 16 chunks ahead (`CHUNK_PREFETCH_WINDOW`) to start
their source fetches in parallel with the serial upload.

Note the coarse floor is already the volume-side answer to "do not clear the
low resolution until the high resolution is ready". Nothing ever renders a
hole; the worst case is coarse data.

### Slide path (`NVSlide`)

| Tier | Holds | Where | Default budget |
|---|---|---|---|
| Decoded tiles | `ImageBitmap` per tile, accounted in decoded RGBA bytes | `NVSlideTileCache` (`slide/NVSlide.ts`) | 96 MB; dandi-demo raises it to 192 MB |
| GPU tiles | One 2D texture per tile key | `TileTextureCache` (`slide/tileTextureCache.ts`) | 128 MB per renderer |

The slide path already has the queue discipline the volume path lacks: the
load queue drains LIFO (`pop`, not `shift`) and every dequeued tile is checked
against the `_wanted` set first, so a tile queued for a viewport the user has
already left is DROPPED rather than fetched. Under a fast pan that is the
difference between fetching what is on screen and fetching where the user was
half a second ago.

As of `b245524e` it also keeps the previous resolution on screen: a zoom that
selects a finer level draws the already-cached coarser tiles underneath while
the fine tiles arrive, instead of flat placeholder quads.

## 2. Where Neuroglancer is ahead

Neuroglancer's chunk manager is the reference implementation here. Four
differences matter, roughly in descending order of what a user would feel.

### 2.1 Fetch and decode run on a worker

Neuroglancer does fetch, decompress, and dtype conversion on a chunk worker;
the main thread does little more than GPU upload. We do all of it on the main
thread: `omeZarrChunkedSource.fetchChunk` calls `readLevelRegion`, which runs
the whole zarrita path inline, and the upload pump then does its per-frame
work on that same thread under an 8 ms budget.

This is the crawl a user sees while a zoomed-in view streams. Every decode
competes with the render loop, so interaction stutters exactly when the most
bricks are arriving, which is exactly when it is most visible. It is item 1 in
`streaming-todos.md`.

`src/workers/` already exists and the chunked path does not use it. The shape
of the fix: a small decode-worker pool, transfer the decoded `Uint8Array` back
(transferable, not structured-cloned), and keep the existing
`createSourceChunkLoader` concurrency/retry/dedup wrapper unchanged so the
residency manager still sees one `VolumeChunkSource` contract.

Measure before plumbing: split the current per-brick cost into fetch, decode,
and upload. If most of the stall is `texSubImage3D` rather than decode, the
answer is a different one (smaller bricks, or a longer upload budget spread
over more frames).

### 2.2 Priority tiers and a queue that is rebuilt every frame

Neuroglancer assigns each chunk a priority tier (visible vs prefetch) plus a
numeric priority, recomputes them as the view changes, and keeps sorted queues
per tier with separate capacity limits for download, system memory, and GPU
memory.

This was our largest gap and it is now closed (Stage A). `_uploadQueue` used
to be a plain FIFO array: `orderByViewCenter` sorted the working set nicely
WITHIN one frame, but the queue persisted ACROSS frames and was pruned only by
`admit` (one index) and `remap` (clears it). Nothing dropped a queued chunk
that was no longer wanted, so a rotate or a pan filled the queue with chunks
for viewports we had left and they uploaded ahead of what was on screen.

It is now a `Map` from chunk index to the frame the working set last asked for
that chunk. Each `requestUpload` re-stamps the entry and moves it to this
frame's request position (delete-then-set reorders a `Map` in O(1), so a
re-request costs nothing), the drain returns this frame's requests before any
older ones, and an entry unrequested for longer than one frame is dropped
instead of uploaded late. The slack is one frame rather than zero because the
pump is async and a frame boundary can land between `beginFrame` and the draw
that re-requests; a 60 fps pan outruns one frame anyway.

Two things fall out of it for free. A drag already pauses the pump while draws
keep stamping requests, so at pointerup the queue holds the final viewport's
working set instead of the whole drag path. And `chunkStreamStats` now reports
a cumulative `staleDropped`, which is a direct readout of upload work the old
queue would have spent on viewports the user had already left: 84 retired
requests over one slice scrub of DANDI 000722. The dandi-demo HUD shows it on
a queue row.

We still do not have Neuroglancer's explicit priority TIERS (visible vs
prefetch, with separate download / system-memory / GPU-memory capacities).
What we have is a single queue that is correctly ordered by the current view,
which is most of what tiers buy at our scale.

Related: a chunk fetch that is already in flight cannot be cancelled either.
`parity-neuroglancer-napari.md` records stale-request cancellation as partial,
present for desktop thumbnails and absent on the volume chunk path. Dropping a
queued request is most of the win, since the queue is where the backlog builds,
but an `AbortController` on the in-flight fetches is the other half.

The shape of the fix was NVSlide's `_wanted` discipline ported down into
`ChunkResidencyManager`: pure CPU bookkeeping, unit-tested with no GPU, and it
landed in both backends at once because the manager is shared.

### 2.3 Eviction demotes; ours destroys

In Neuroglancer a chunk evicted from GPU memory falls back to system memory
rather than disappearing, so bringing it back is a re-upload. For us, eviction
calls `destroy` and the brick is gone: showing it again costs fetch, decode,
AND upload. The only thing that survives is its compressed bytes in the store
LRU, and only if they have not been evicted there too.

Worth being honest about the shape of this: a decoded-chunk CPU tier is bytes
we are choosing to hold in JS heap, and browsers are less forgiving about that
than about GPU memory. The version I would build is a small decoded tier sized
as a fraction of the GPU budget, holding only chunks evicted from GPU (not
every chunk ever decoded), so it is a demotion buffer rather than a second
full cache.

### 2.4 Prefetch is predictive, ours is pipeline lookahead

`CHUNK_PREFETCH_WINDOW` is not prediction. It looks 16 entries into a queue we
have already decided we need, purely so the fetch pipe stays full ahead of the
serial upload. Neuroglancer extrapolates the navigation state and requests
chunks for where the view is GOING, at a priority tier that can never evict or
delay a visible chunk.

For our two dominant interactions the extrapolation is easy and does not need
a general framework:

- Slice scrolling: the user is stepping along one axis at a steady rate. Fetch
  the next N slices in the direction of travel. This is the single highest-value
  prediction for DANDI-style data and it is nearly free.
- Zoom: a zoom in progress will cross a level boundary. Start the next level's
  centre tiles before the boundary is reached.

Both are cheap because they are one-dimensional. Camera-orbit prediction is
the expensive case and I would not build it first.

## 3. What we should say tomorrow

We are not starting from nothing: three tiers on the volume side, two on the
slide side, byte budgets everywhere, frame-accurate LRU protection, a coarse
floor that means we never draw a hole, and a stale-request discipline on the
slide side that Neuroglancer's design agrees with. The honest gaps are
off-thread decode, a priority queue on the volume side, demotion instead of
destruction, and real prediction.

Two places we can be BETTER than Neuroglancer rather than catching up:

- **Persistence across sessions.** Every cache described above dies on reload.
  For DANDI over S3 the expensive part is the round trip, and Cache Storage or
  OPFS would let a second visit to a dataset start warm. Neuroglancer does not
  do this. It is the most visible thing we could offer a workshop audience
  clicking the same demo repeatedly.
- **The coarse floor.** A whole-volume coarsest level pinned resident is a
  cheap guarantee that the screen is never empty, and it composes with
  everything above.

## 4. Proposed order

| Stage | Work | Cost | Why here |
|---|---|---|---|
| A | DONE (`1a9d525d`) Stale-drop + per-frame reprioritization in `ChunkResidencyManager` | small | Pure CPU, shared by both backends, testable without a GPU, fixes a felt problem |
| B | Instrument fetch / decode / upload separately | small | Stage C is a guess without it |
| C | Worker pool for chunk fetch + decode | medium | The main-thread stall; `src/workers/` already exists |
| D | Directional prefetch for slice scrolling and zoom | small | One-dimensional prediction, big felt win, no framework needed |
| E | Decoded-chunk demotion tier under GPU eviction | medium | Makes eviction cheap to undo; sized off the GPU budget |
| F | Persistent cache (Cache Storage / OPFS) | medium | The differentiator; warm starts across reloads |

Stage A and B are a day between them, and they are the two that make every
later stage measurable, so they go first regardless of what the meeting decides
about the rest. A is done; B is next. The in-flight half of A, an
`AbortController` on fetches already issued, is still open and is worth folding
into C, where the worker pool owns the fetch.

## 5. Known gaps not covered above

- The 3D slide-plane renderer (`gl/slidePlaneRender.ts`,
  `wgpu/slidePlaneRender.ts`) drives its working set from world geometry via
  `requestTile` and does not use the new coarse fallback layer. Same fix
  applies, different visibility source.
- The slide fallback layer only walks COARSER levels. Zooming OUT to a level
  whose tiles are not cached still shows placeholders, even when finer tiles
  covering part of the view are resident. Lower value than the zoom-in case
  (the finer tiles only cover the middle of the new viewport) but it is the
  symmetric half of the same idea.
