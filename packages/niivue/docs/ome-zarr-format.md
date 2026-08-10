# OME-Zarr (OME-NGFF) multiscale stores

OME-Zarr is the cloud-native container of the OME-NGFF specification: a Zarr
group whose attributes describe a resolution pyramid over up to five named
dimensions, with the pixels chunked into separately-fetchable objects. It is
the format the Allen Institute's IMSC viewer, IDR, and the Human Organ Atlas
publish, and the fourth microscopy container this package reads (after the
Allen JSON+PNG atlas, plain TIFF stacks and OME-TIFF).

Two modules, in layers:

| Module | Responsibility |
| --- | --- |
| `volume/omeZarr.ts` | The metadata. Parses a group's attributes into axes, pyramid datasets and omero channels, and answers the axis questions (which dimension is channel? which spatial axis is display x?). Pure JSON in, no network, Bun-testable. |
| `volume/omeZarrLoader.ts` | The pixels. Opens a store with zarrita, picks a pyramid level, pins time and channel, and assembles each requested channel into a NIfTI `File` for `loadVolumes`. |

Unlike TIFF, the container itself is NOT hand-parsed: chunk layout, codecs
(blosc, gzip, zstd) and both Zarr format versions come from `zarrita`, a
dependency shared with the streaming demos. This loader is the whole-volume,
per-channel path; chunk-at-a-time streaming of very large stores is the
`ChunkedVolumeSource` machinery's job (see `NVChunkedVolume.ts`).

## What is supported

- Zarr v2 (`.zattrs`/`.zarray`) and v3 (`zarr.json`), auto-detected.
- NGFF 0.4 metadata (`multiscales` at the group's top level) and 0.5 (wrapped
  in `ome`). 0.1-0.3 stores load too: string axes are accepted, and a store
  with no axes at all falls back to the fixed `t c z y x` order those versions
  mandated.
- Axes in any declared order. Spatial axes are matched by name (`x`/`y`/`z`),
  so an `x y z`-ordered store (the Human Organ Atlas) presents identically to
  the usual `z y x`; unconventional names fall back to fastest-varying = x.
  The read block is transposed to NIfTI's x-fastest layout when the two
  disagree.
- 2D images (two spatial axes) load as single-slice volumes.
- Dtypes: (u)int8, (u)int16, (u)int32, float32, float64.
- Voxel spacing from each dataset's `scale` transform, converted to
  MICROMETRES via the axis `unit` (shared `omeLengthToMicrons`; an unstated
  unit is already micrometres, OME's default). Volumes are centred on the
  origin, so every channel and level of a dataset shares one world position.

## What throws

- A store whose root is an array rather than a group, or a group without
  `multiscales`/`datasets`.
- Fewer than 2 or more than 3 spatial axes, or a declared axis count that
  contradicts an array's rank.
- int64/uint64 and non-numeric dtypes (NIfTI has no lossless home for them).
- Out-of-range channel, timepoint or level requests, validated before any
  chunk is fetched.

## Channel display: the omero block

The group may carry display metadata alongside the pyramid:

```json
"omero": {
  "channels": [
    { "label": "LaminB1", "color": "00FF00",
      "window": { "start": 0, "end": 1500, "min": 0, "max": 65535 } }
  ]
}
```

The loader consumes all of it: each volume is named by its channel `label`,
its colormap is the closest `CHANNEL_COLORMAPS` hue to `color` (falling back
to the shared palette rotation, so channels never collide), and `window.start`
/`window.end` become `calMin`/`calMax`. Colours tolerate a leading `#` and an
appended alpha byte. A store without an omero block gets positional names and
palette colours, like a colourless OME-TIFF.

## Level choice

`loadOmeZarrVolumes` reads ONE pyramid level per call (`level` option,
0 = finest). By default it picks the finest level whose per-channel decoded
size fits a 256 MiB budget (`levelBudgetBytes`): pointing the loader at a
slide-sized pyramid must not flood the network or the GPU, which is the lesson
of the streaming demo's L0 incident. `fetchOmeZarr` opens the store without
reading chunks, so a picker can list channels and levels (`OmeZarrLevel.dims`,
`channelBytes`) before committing; `omeZarrVolumesFrom` then reuses the opened
store.

## Sources verified against

- IDR idr0062 (`6001240.zarr`, NGFF 0.4, czyx uint16, 2 channels with omero
  colours and windows), idr0101 (tczyx, 6 channels, 18 timepoints) and
  idr0076 (cyx float64, 50 channels, loading as single-slice volumes).
- Human Organ Atlas hearts (NGFF 0.4, `x y z` declared order), also the
  streaming demo's store.
- The unit suite's in-memory v2 stores (raw codec), which pin the exact
  hyperslab and byte order read.
