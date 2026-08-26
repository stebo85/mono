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

**Status:** Stages A, B and G landed on 2026-08-25 (`1a9d525d`, `1a76c7c5`).
Sections 2.2, 2.5, 2.6 and the stage table below describe what changed;
everything else is still open. Section 2.5 is the measured answer to the
question this doc was written to ask, and it moved two items up the list.
Section 2.6 retires stage G: the byte cache turned out to be sized correctly,
and the finding that said otherwise was a misreading of section 2.5's numbers.

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

### 2.1 Fetch and decode run on a worker (DONE, stage C)

Neuroglancer does fetch, decompress, and dtype conversion on a chunk worker; the
main thread does little more than GPU upload. We used to do all of it on the main
thread, and it was the single largest cost in the streaming path.

Stage B measured it rather than assuming it, in case most of the stall turned out
to be `texSubImage3D` rather than decode. It is not. Section 2.5 has the numbers:
on a 20 second streaming window the render loop lost 8.6 seconds over a 24 ms
budget, and 125 ms of that was texture upload. Everything else ran between the
store read and our assemble loop, which is the zarrita decode.

Stage C moved it. `fetchOmeZarrChunkedSource` now opens the store on the calling
thread for its metadata and then puts every chunk read on a small pool of
workers:

- `src/workers/omeZarrChunk.worker.ts` opens its OWN view of the store (a zarrita
  array is not structured-cloneable) through the same `openOmeZarrChunkedSource`
  the main thread uses, so the worker is not a reimplementation of the read path.
  It runs store `get`, decompress, dtype convert, and our transpose / zero-pad
  assemble, then transfers the finished `Uint8Array` back.
- `src/volume/omeZarrChunkWorkerPool.ts` routes a request by hashing its region
  (level, texture origin, texture dims) rather than picking the idlest worker.
  Each worker keeps its own byte LRU, so a revisited brick has to come back to
  the worker that already holds its bytes. Sizing is half the reported cores,
  clamped to `[1, 4]`; these reads are network-bound, several are already
  outstanding per worker, and each extra worker costs another store open and
  another slice of the byte budget.
- Timing survives the move. Each worker reports a CUMULATIVE
  `ChunkTimingSnapshot`; the pool diffs it against what it last merged and folds
  the delta into a module-level off-thread total, so `mainThreadMs` now reports
  only what still blocks the render loop and a new `offThreadMs` reports what was
  moved. `netBusyMs` is a union per recorder, so the merged figure is an upper
  bound with a pool running and exact with one worker or none.
- `createSourceChunkLoader` still presents the residency manager with one
  `VolumeChunkSource` contract and the same concurrency, retry and dedup wrapper,
  and it now carries the in-flight cancellation stage A left open. A chunk the
  working set stops asking for is dropped from the queue, and that drop reaches
  the uploader, the loader, the pool, the worker and finally zarrita's own
  `signal`, so the read is abandoned on the wire instead of discarded on
  arrival. Because several chunk indices can share one region, the loader counts
  waiters and only aborts when the last one withdraws.

A worker failure is not automatically fatal: the caller still holds a main-thread
source. Only failures a re-run would repeat come back marked final
(`OmeZarrChunkError` for a missing store or an undecodable region, `AbortError`
for a cancelled read), and those are rethrown rather than paid for twice. A pool
that has been disposed reports as an abort too: a read that outlives the volume
it belongs to must not be "recovered" by fetching the same bytes on the main
thread for a view that is gone.

Two build details are load-bearing and easy to undo by accident. The module that
knows about the pool must stay OUTSIDE anything the worker imports, which is why
`fetchOmeZarrChunkedSource` lives in its own file and the worker imports only the
pool-free `openOmeZarrChunkedSource`. And zarrita loads its blosc / lz4 / zstd
codecs through dynamic imports, which would split the worker bundle into chunks
that an inlined worker has nowhere to fetch from, so `vite.config.lib.ts` sets
`worker.rollupOptions.output.inlineDynamicImports`. The pool itself is imported
on demand, so the megabyte-scale inlined worker is only downloaded by a caller
who actually streams chunks.

Section 2.7 has the result.

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

### 2.5 Measured: where the time actually goes

Stage B added a per-phase recorder (`src/volume/chunkTiming.ts`, exposed as
`nv.chunkTimingStats()`) that times five spans we own: `net` (one store `get`),
`read` (one whole `fetchChunk`), `assemble` (our transpose and zero-pad loop),
`upload` (building a texture, either a volume brick or an `NVSlide` tile), and
`gradient`. Two figures sit beside them, both exact rather than inferred:
`mainThreadMs` is `assemble + upload + gradient`, the streaming work that
actually blocks the render loop, and `netBusyMs` is wall clock with at least one
store read outstanding, counted as a union so overlapping reads do not
multiply-count the same seconds.

Decode is deliberately NOT reported. It happens inside zarrita, between the
store read and our assemble loop, and we cannot time it from outside. An earlier
draft reported `read - net - assemble` as a decode estimate; that is invalid,
because one `zarr.get` fans out to every store chunk covering the region, so
several `net` spans overlap inside a single `read` and the subtraction is not a
bound in either direction. It read as zero or negative in practice. The
replacement is to measure the effect instead: the demo accumulates rAF gaps over
a 24 ms budget, which catches main-thread time no matter which library spends
it.

All figures below are WebGL2 in Chrome against the live DANDI stores.

**HiP-CT (000026, roughly 1 TB, over S3), 20 second window, streaming only, no
interaction:**

| Figure | Value |
|---|---|
| Frames drawn | 1267 |
| Main-thread time lost over a 24 ms budget | 8604 ms |
| Worst single frame gap | 1052 ms |
| Instrumented main-thread work (`mainThreadMs`) | 125 ms |
| Brick reads / mean read | 187 / 822 ms |
| Store gets / mean get | 1955 / 189 ms |
| Store bytes delivered | 3340 MB |
| Network busy (union) | 10083 ms of 20006 ms |

The idle baseline over 400 frames with nothing streaming is 0 ms over budget, so
the 8.6 seconds is the streaming path and not a noisy machine.

Three things follow.

**Decode dominates the main thread, and upload is a rounding error.** Of 8.6
seconds of lost frame time, 125 ms is instrumented, and every instrumented
millisecond is texture upload. The remainder is un-instrumented main-thread work
inside the read path. This is the number Stage C has to beat, and the part a
decode worker cannot move (upload plus gradient) is 1.5 percent of it.

**We fetch and decode far more than we use.** On the smaller OCT store a 20
second window delivered 493 MB of store bytes to produce 33.9 MB of brick
voxels, and a slice scrub delivered 948 MB to produce 24.6 MB. That is 15x to
39x amplification, and it is structural rather than a bug: a 2D plane through a
3D-chunked store still requires whole 3D chunks, so the useful fraction is
bounded by one over the chunk depth. It also explains the decode cost directly,
since decode scales with bytes delivered rather than bytes displayed. Read
"delivered" strictly: `withChunkTiming` wraps the store outside the byte cache,
so these totals count reads the cache answered as well as reads that went to the
network. They are the right figure for decode cost, which is paid either way,
and an overstatement of network traffic. Stage G below measures the split.

**The byte cache looked like it was thrashing, and it is not.** An earlier
reading of these numbers concluded that a scan evicts the byte cache before it
can be reused, because one pass delivered roughly twice the 512 MB budget. That
inference was wrong, and the error is the one flagged above: `net` counts every
read the store serves, hits included, so a delivered total larger than the
budget is evidence of reuse rather than of eviction. Section 2.6 has the direct
measurement.

For contrast, the small OCT store over the same 20 seconds lost 316 ms with a
worst gap of 128 ms, against 493 MB delivered. Main-thread cost tracks bytes
delivered, not bricks drawn.

### 2.6 Measured: the byte cache is sized correctly

Stage G set out to size the byte cache to the working set, or failing that to
give it a scan-resistant policy. Before changing either, it needed to answer a
question the previous numbers could not: is the cache missing because the budget
is too small to hold the working set, or because this access pattern never
revisits a chunk? Both look identical from outside, both read as a low hit rate,
and they want opposite fixes.

Evictions tell them apart, so `ByteLruCache` now counts them, along with hits,
misses, admissions and oversize rejections. The counters are exposed as
`source.byteCache.stats` and the demo prints them as a `byte cache` HUD row.
Counting happens in `has`, which is the single gate `withByteCaching` consults
before every read; `get` runs only after a hit, so a lookup cannot be counted
twice.

WebGL2 in Chrome, live DANDI stores, 512 MB budget:

| | OCT, 4.5 GB | HiP-CT, 1 TB |
|---|---|---|
| Store gets | 733 | 737 |
| Bytes delivered | 415 MB | 1154 MB |
| Hits / misses | 183 / 550 | 376 / 361 |
| Hit rate | 25% | 51% |
| Resident at end | 265 MiB of 512 | 328 MiB of 512 |
| Evicted | 0 entries, 0 bytes | 0 entries, 0 bytes |
| Rejected as oversize | 0 | 0 |

The OCT session was a full sweep of all 561 axial planes and back again; the
HiP-CT session was a load plus a sweep across half of its 10656 planes. Neither
evicted a single entry.

Three conclusions.

**The budget is not the binding constraint.** Nothing was ever evicted, on
either store, in any pattern tried. The store-level working set is bounded by
what is on screen times the number of resolution levels in play, not by the size
of the dataset, which is why a 1 TB volume settles at 328 MiB just as a 4.5 GB
one settles at 265 MiB. There is no scan to be resistant to, and raising
`OME_ZARR_CHUNK_CACHE_BYTES` would buy nothing.

**Reuse is real when it is asked for.** The return leg of the OCT sweep, back
across planes the forward leg had already visited, was 168 lookups and 168 hits:
zero misses, zero new bytes, the whole pass served from memory. That is the
behaviour the earlier reading concluded was absent.

**The headline hit rate understates the cache** because it averages a cold first
pass into the total, and every miss in these sessions is a first touch. That
also says where the remaining wins are. Stage D (prefetch) attacks the cold
pass, which is where all the misses live. Stage F (a persistent tier) attacks
the fact that this cache dies with the page, so every reload starts cold again.
Neither is a byte-budget change.

Stage G therefore lands as instrumentation and no policy change. The counters
stay because they are what proved the point, and because they are the check to
re-run before anyone proposes a bigger budget.

### 2.7 Measured: stage C removed the stall

The check is deliberately the same one that condemned the main-thread path in
2.5: HiP-CT (000026, roughly 1 TB, over S3), WebGL2 in Chrome, tab foregrounded,
streaming with no interaction, rAF gaps accumulated over a 24 ms budget.

| Figure | Stage B (main thread) | Stage C (worker pool) |
|---|---|---|
| Main-thread time lost over a 24 ms budget | 8604 ms | none |
| Worst single frame gap | 1052 ms | none over budget |
| Streaming work accounted for off-thread | 0 ms | 1898 ms, 100% |

The stall is gone rather than reduced: over the measured window not one frame
went over budget, against 8.6 seconds of lost frame time before. Every
millisecond of instrumented streaming work now lands in `offThreadMs`, and the
`workers` HUD row in the DANDI demo reports the share so a regression that
silently falls back to the main thread is visible rather than merely slow.

A slice-scrub on the smaller OCT store (000722, 4.5 GB), which is the more
interactive pattern, agrees: roughly 40 seconds of scrubbing left 2 ms of
main-thread streaming cost in total and 1 ms over budget across the whole
session, with 9874 ms accounted for off-thread.

Two caveats worth stating out loud. The GPU upload cannot move and did not: it
is still on the render thread, and it was already only 1.5 percent of the
problem. And a worker pool does not reduce the bytes fetched or decoded, it only
stops them competing with drawing. The amplification measured in 2.5, 15x to 39x
between bytes delivered and voxels used, is untouched and is what stage D is
for.

## 3. What we should say tomorrow

We are not starting from nothing: three tiers on the volume side, two on the
slide side, byte budgets everywhere, frame-accurate LRU protection, a coarse
floor that means we never draw a hole, and a stale-request discipline on the
slide side that Neuroglancer's design agrees with. The honest gaps are
off-thread decode, a priority queue on the volume side, demotion instead of
destruction, and real prediction. The priority queue is now closed (stage A),
and we have measured the rest rather than guessing at it (stage B).

The one number worth putting on a slide: streaming a HiP-CT volume from S3 for
20 seconds costs the render loop 8.6 seconds, and 125 ms of that is GPU upload.
The rest is decode on the main thread. That is the case for the worker, and it
is measured rather than asserted.

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
| B | DONE Per-phase timing (`chunkTimingStats`) plus a main-thread stall monitor in the demo | small | Turned stage C from a guess into a measurement |
| G | DONE Hit / miss / eviction counters on `ByteLruCache`, exposed as `source.byteCache.stats` | small | Measured (2.6): zero evictions on a 1 TB store, so no budget or policy change was needed |
| C | DONE Worker pool for chunk fetch + decode (`omeZarrChunkWorkerPool.ts`, `workers/omeZarrChunk.worker.ts`) | medium | Measured (2.7): the 8.6 s of lost frame time is gone, 100% of streaming work is off-thread |
| D | Directional prefetch for slice scrolling and zoom | small | One-dimensional prediction, big felt win, no framework needed |
| E | Decoded-chunk demotion tier under GPU eviction | medium | Makes eviction cheap to undo; sized off the GPU budget |
| F | Persistent cache (Cache Storage / OPFS) | medium | The differentiator; warm starts across reloads |

A, B, G and C are done. A and B were the two that make every later stage
measurable, and B changed the order of what followed: G came straight out of the
measurement and turned out to need no policy change at all, while C was
confirmed as the big one and delivered accordingly. The in-flight half of A, an
`AbortController` on fetches already issued, folded into C as planned: the
worker pool owns the fetch, so a cancelled read is now aborted on the wire
rather than merely ignored on arrival.

What remains is D, E, F: predict, then soften eviction, then persist. D is next
and it is the one that attacks a cost C did not touch, since a worker pool moves
the decode but does not avoid it.

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
