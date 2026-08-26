/**
 * Stream an OME-Zarr pyramid as a {@link ChunkedVolumeSource}.
 *
 * This is the whole-store streaming path: `nv.loadChunkedVolume` plans a
 * multi-LOD brick set, and this adapter reads each brick's voxel region from
 * one pyramid level with zarrita. The core owns plan-building, per-level
 * dispatch, concurrency, retry, dedup and GPU residency; this module only
 * moves bytes. (For whole-level, per-channel loading of modest stores, use
 * `omeZarrLoader.ts` instead.)
 *
 * ```ts
 * const source = await fetchOmeZarr(url)
 * await nv.loadChunkedVolume(omeZarrChunkedSource(source, { channel: 1 }))
 * ```
 *
 * The time and channel axes are pinned per source (one channel streams per
 * chunked volume), and the declared spatial axis order is honoured: bricks
 * from an `x y z`-ordered store (the Human Organ Atlas) are transposed to the
 * x-fastest layout the contract requires, so the anatomy presents identically
 * to a conventional `z y x` store. See `docs/ome-zarr-format.md`.
 */

import * as zarr from 'zarrita'
import type { TypedVoxelArray } from '@/NVTypes'
import type {
  ChunkedVolumeFetch,
  ChunkedVolumeSource,
} from './ChunkedVolumeSource'
import { allocTypedArrayLike } from './omeZarr'
import {
  type OmeZarrLoadOptions,
  type OmeZarrSource,
  type OpenOmeZarrOptions,
  omeZarrNiftiDatatype,
  openOmeZarr,
} from './omeZarrLoader'
import { getBitsPerVoxel } from './utils'

/**
 * A byte-bounded LRU cache for zarrita's `withByteCaching` store wrapper.
 *
 * Values are raw store responses; an entry holding `undefined` is a CONFIRMED
 * ABSENCE (zarr's missing-chunk-means-fill-value convention), remembered so a
 * sparse store's absent chunks are not re-requested on every plan rebuild —
 * a store is immutable for the life of a load, so an absence is permanent.
 * Absences cost 0 bytes and are evicted like any other entry.
 *
 * `totalBytes <= maxBytes` holds after every operation: a value larger than
 * the whole budget is never admitted (its key is simply left uncached, and no
 * resident entries are evicted for it). A budget of 0 therefore caches only
 * zero-byte absence entries; `Infinity` never evicts.
 *
 * ```ts
 * const store = zarr.withByteCaching(new zarr.FetchStore(url), {
 *   cache: new ByteLruCache(256 * 2 ** 20),
 * })
 * ```
 */
export class ByteLruCache {
  private entries = new Map<
    string,
    { value: Uint8Array | undefined; bytes: number }
  >()
  private total = 0

  constructor(readonly maxBytes: number) {
    // Rejects NaN and negatives in one comparison; 0 and Infinity are valid.
    if (!(maxBytes >= 0)) {
      throw new Error(
        `ByteLruCache: maxBytes must be a non-negative number, got ${maxBytes}`,
      )
    }
  }

  /** Bytes currently held (absence entries count 0). */
  get totalBytes(): number {
    return this.total
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  get(key: string): Uint8Array | undefined {
    const entry = this.entries.get(key)
    if (!entry) {
      return undefined
    }
    // Re-insert so iteration order stays least-recently-used first.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: Uint8Array | undefined): void {
    const existing = this.entries.get(key)
    if (existing) {
      this.total -= existing.bytes
      this.entries.delete(key)
    }
    const bytes = value?.byteLength ?? 0
    // A value larger than the whole budget can never be held within it. Do
    // not admit it, and do not evict resident entries to make room that will
    // not suffice. (The stale same-key entry was already dropped above.)
    if (bytes > this.maxBytes) {
      return
    }
    this.entries.set(key, { value, bytes })
    this.total += bytes
    // Every admitted entry fits the budget on its own, so evicting oldest
    // first always reaches totalBytes <= maxBytes by the time one entry is
    // left.
    while (this.total > this.maxBytes && this.entries.size > 1) {
      const oldest = this.entries.entries().next().value
      if (!oldest) {
        return
      }
      this.entries.delete(oldest[0])
      this.total -= oldest[1].bytes
    }
  }
}

/** Options for {@link omeZarrChunkedSource}. */
export interface OmeZarrChunkedSourceOptions {
  /** Channel to stream. Defaults to the first. */
  channel?: number
  /** Timepoint to stream. Defaults to the first. */
  timepoint?: number
}

/** A {@link ChunkedVolumeSource} that keeps its opened pyramid reachable. */
export interface OmeZarrChunkedSource extends ChunkedVolumeSource {
  /** The opened store behind the adapter (levels, omero channels, axes). */
  readonly zarr: OmeZarrSource
}

/**
 * Read one brick's voxel region from one pyramid level: clamp the requested
 * display-space region to the level's extent, slice the store over its own
 * declared axes, and lay the block out x-fastest, zero-padded back up to the
 * full `texDims` where the region runs past the array bounds.
 */
async function readLevelRegion(
  source: OmeZarrSource,
  channel: number,
  timepoint: number,
  req: ChunkedVolumeFetch,
): Promise<Uint8Array> {
  const { levelIndex, texOrigin, texDims, bytesPerVoxel } = req
  if (
    !Number.isInteger(levelIndex) ||
    levelIndex < 0 ||
    levelIndex >= source.levels.length
  ) {
    throw new Error(
      `OME-Zarr: level index ${levelIndex} is out of range ` +
        `(source has ${source.levels.length})`,
    )
  }
  const level = source.levels[levelIndex]
  const array = source.arrays[levelIndex]
  const [sx, sy, sz] = texDims
  const [x0, y0, z0] = texOrigin
  const expectedBytes = sx * sy * sz * bytesPerVoxel

  // Clamp to the level's real extent; the remainder zero-pads (out-of-bounds
  // voxels hold the fill value 0, matching zarr's own convention).
  const rx = Math.min(x0 + sx, level.dims[0]) - x0
  const ry = Math.min(y0 + sy, level.dims[1]) - y0
  const rz = Math.min(z0 + sz, level.dims[2]) - z0
  if (rx <= 0 || ry <= 0 || rz <= 0) {
    return new Uint8Array(expectedBytes)
  }

  const { indices, order } = source
  const selection = array.shape.map((_extent, axis) => {
    if (axis === indices.channel) {
      return channel
    }
    if (axis === indices.time) {
      return timepoint
    }
    const position = indices.spatial.indexOf(axis)
    if (position < 0) {
      return 0
    }
    if (position === order.x) {
      return zarr.slice(x0, x0 + rx)
    }
    if (position === order.y) {
      return zarr.slice(y0, y0 + ry)
    }
    return zarr.slice(z0, z0 + rz)
  })

  const block = await zarr.get(array, selection)
  if (typeof block !== 'object' || block === null || !('data' in block)) {
    throw new Error('OME-Zarr: reading a level region returned no block')
  }
  const data = block.data as TypedVoxelArray
  const stride = block.stride
  const strideX = stride[order.x]
  const strideY = stride[order.y]
  const strideZ = order.z < 0 ? 0 : stride[order.z]

  // Fast path: full-coverage read already in x-fastest order.
  if (
    rx === sx &&
    ry === sy &&
    rz === sz &&
    strideX === 1 &&
    strideY === rx &&
    (rz === 1 || strideZ === rx * ry)
  ) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    if (bytes.byteLength !== expectedBytes) {
      throw new Error(
        `OME-Zarr: region at ${texOrigin.join(',')} returned ` +
          `${bytes.byteLength}B, expected ${expectedBytes}B`,
      )
    }
    return bytes
  }

  const out = allocTypedArrayLike(data, sx * sy * sz)
  for (let z = 0; z < rz; z++) {
    for (let y = 0; y < ry; y++) {
      const src = z * strideZ + y * strideY
      const dst = z * sx * sy + y * sx
      if (strideX === 1) {
        out.set(data.subarray(src, src + rx), dst)
      } else {
        for (let x = 0; x < rx; x++) {
          out[dst + x] = data[src + x * strideX]
        }
      }
    }
  }
  return new Uint8Array(out.buffer, out.byteOffset, expectedBytes)
}

/**
 * Adapt an opened OME-Zarr pyramid to the core chunk-streaming seam.
 *
 * The returned source's `levels` are finest-first in DISPLAY terms (dims and
 * micrometre spacing in x, y, z), with each level labelled by its dataset
 * index so telemetry matches the store's own pyramid numbering.
 */
export function omeZarrChunkedSource(
  source: OmeZarrSource,
  options: OmeZarrChunkedSourceOptions = {},
): OmeZarrChunkedSource {
  const dtype = source.levels[0].dtype
  for (const level of source.levels) {
    if (level.dtype !== dtype) {
      throw new Error(
        `OME-Zarr: mixed level dtypes ('${dtype}' vs '${level.dtype}')`,
      )
    }
  }
  const datatypeCode = omeZarrNiftiDatatype(dtype)
  const bytesPerVoxel = getBitsPerVoxel(datatypeCode) / 8

  const channel = options.channel ?? 0
  if (
    !Number.isInteger(channel) ||
    channel < 0 ||
    channel >= source.channelCount
  ) {
    throw new Error(
      `OME-Zarr: channel ${channel} is out of range ` +
        `(store has ${source.channelCount})`,
    )
  }
  const timepoint = options.timepoint ?? 0
  if (
    !Number.isInteger(timepoint) ||
    timepoint < 0 ||
    timepoint >= source.timepointCount
  ) {
    throw new Error(
      `OME-Zarr: timepoint ${timepoint} is out of range ` +
        `(store has ${source.timepointCount})`,
    )
  }

  return {
    zarr: source,
    datatypeCode,
    levels: source.levels.map((level) => ({
      level: level.datasetIndex,
      shape: [level.dims[0], level.dims[1], level.dims[2]],
      spacing: [level.spacingUm[0], level.spacingUm[1], level.spacingUm[2]],
    })),
    async fetchChunk(req: ChunkedVolumeFetch): Promise<Uint8Array> {
      if (req.bytesPerVoxel !== bytesPerVoxel) {
        throw new Error(
          `OME-Zarr: fetch asked for ${req.bytesPerVoxel} bytes/voxel, ` +
            `the store holds ${bytesPerVoxel}`,
        )
      }
      return readLevelRegion(source, channel, timepoint, req)
    },
  }
}

/** Options for {@link fetchOmeZarrChunkedSource}. */
export interface FetchOmeZarrChunkedSourceOptions
  extends OpenOmeZarrOptions,
    OmeZarrChunkedSourceOptions,
    Pick<OmeZarrLoadOptions, 'fetchImpl'> {
  /**
   * Byte budget for the store-level LRU cache (raw store responses, including
   * remembered absent chunks). 0 disables caching. Default 256 MiB.
   */
  cacheBytes?: number
}

/** Default byte budget for {@link fetchOmeZarrChunkedSource}'s store cache. */
export const OME_ZARR_CHUNK_CACHE_BYTES = 256 * 2 ** 20

/**
 * One-call convenience: open a store by URL with a byte-caching wrapper and
 * adapt it for `nv.loadChunkedVolume`. The opened pyramid stays reachable on
 * the result's `zarr` property (level metadata, omero channels).
 */
export async function fetchOmeZarrChunkedSource(
  url: string,
  options: FetchOmeZarrChunkedSourceOptions = {},
): Promise<OmeZarrChunkedSource> {
  const cacheBytes = options.cacheBytes ?? OME_ZARR_CHUNK_CACHE_BYTES
  const base = options.fetchImpl
    ? new zarr.FetchStore(url, { fetch: options.fetchImpl })
    : new zarr.FetchStore(url)
  const store =
    cacheBytes > 0
      ? zarr.withByteCaching(base, { cache: new ByteLruCache(cacheBytes) })
      : base
  return omeZarrChunkedSource(await openOmeZarr(store, options), options)
}
