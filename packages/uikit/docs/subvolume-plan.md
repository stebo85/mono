# Sub-volume selector + block selector (plan)

Branch `feat/uikit-subvolume-tools`, based on `ohif-viewer-integration`
(the only line carrying `@niivue/uikit`, and it already contains main plus
the chunked-volume machinery). Decisions taken with Chris 2026-08-11:

- Blocks come from the CHUNK PLAN when the volume is chunked/streamed, with a
  configurable uniform NxNxN grid as the fallback for ordinary volumes.
- V1 interaction is a programmatic API plus demo sliders; drag handles on the
  2D slices are V2.

## The two widgets

**Sub-volume selector.** A box in volume space. Rendering: UIKit line
geometry through the overlay hook (12-edge outline on the render tile, the
box's cross-section rectangle on each 2D slice). Clipping: SIX axis-aligned
clip planes via the existing `nv.setClipPlanes(depthAziElevs)` (solid mode
keeps the intersection of half-spaces, which for +-x/+-y/+-z planes is
exactly the box interior). `clipPlaneOverlay` sections every channel of a
multi-channel stack.

**Block selector/highlighter.** Composes the first: blocks enumerated from
`vol.chunkPlan` (texOrigin/texDims on the finest grid) or the fallback grid;
a selected block gets a highlight outline, and "show alone" applies the
sub-volume box to the block's bounds and re-centres the origin on the block
centre via `nv.renderPivotMM` / `nv.centerRenderOnMM` (both already in
core from the crosshair-centring work).

## Module layout (uikit conventions: pure builders + overlay classes)

- `src/subvolume.ts` — pure, Bun-tested:
  - `SubvolumeBox` (frac-space min/max) + mm conversions given extents.
  - `subvolumeClipPlanes(box)` -> six `[depth, azimuth, elevation]` triples
    for `setClipPlanes`. Axis normals via the `depthAziElevToClipPlane`
    convention (`n = sph2cartDeg(az, elev)`, plane `[n, -depth]`, shader eqn
    `dot(n, p - 0.5) + depth`).
  - `blockGrid(dims, blockShape)` and `blocksFromChunkPlan(plan)` -> block
    boxes; `blockAt(blocks, frac)` for selection-by-point.
  - `buildBoxEdges(project)` / `buildBoxSection(project, slicePlane)` ->
    LineData via an injected mm->screen projector, so the builders stay pure.
- `src/subvolumeOverlay.ts` — `UIKitSubvolumeOverlay implements
  UIKitOverlayRenderer`, composing `UIKitLineOverlay` (+ `UIKitTextOverlay`
  for block labels). Public API: `setBox`, `clearBox`, `setBlocks`,
  `selectBlock`, `showBlockAlone`, `clearSelection`.
- Demo `subvolume.html` beside the existing uikit demo pages: a volume, six
  range sliders driving the box, a block-grid toggle, click-to-select via
  the existing pointer events, and a "show alone" button.

## Open items to resolve while implementing

1. PIN THE KEPT-SIDE SIGN empirically before writing tests: the shader keeps
   the side where `dot(n, p - 0.5) + depth` is negative for solid mode
   (verify with one plane in the demo, then encode in `subvolumeClipPlanes`
   unit tests). The `|a| > 1` sentinel disables a plane.
2. mm->screen projection for the outline: the overlay frame is screen-space
   only. Find (or thread) the per-tile projection the annotation overlay
   uses; worst case the demo passes a projector built from
   `nv.mmToCanvas`-family view utilities.
3. Multi-plane solid-clip semantics: confirm the background pass intersects
   ranges correctly for 6 planes (read `clipSampleRange` accumulation), and
   that the depth-pick path (fixed 2026-08-11 on the microscopy branch)
   behaves with 6 planes. NOTE: that pick fix is NOT on this branch yet —
   it lands when the microscopy branch merges; picking through the box will
   inherit it then.
4. Blocks for multi-LOD plans: v1 uses the plan's bricks as-is (mixed
   sizes); the "variable-sized blocks" backlog item in the iiif TODO is the
   deeper render-side follow-up.
