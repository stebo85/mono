// Two views of ONE DANDI Archive OME-Zarr store, streamed straight from S3.
//
// The point of the demo is the shared seam. `fetchOmeZarrChunkedSource` opens a
// dandiset's OME-Zarr pyramid once and returns a `ChunkedVolumeSource`; that one
// object then feeds BOTH panes:
//
//   left   nv.loadChunkedVolume(source)          multi-LOD volume rendering
//   right  NVSlide.fromSource(                   deep-zoom of one plane
//            new VolumeSliceSource(source, ...))
//
// Because it is the same source instance, both panes share one zarrita byte
// cache: a brick the volume view already pulled is free for the slide view, and
// the other way round. Nothing is downloaded whole -- a 17 GB light-sheet store
// opens as fast as a 100 MB one, because only the visible bricks and tiles are
// fetched.
//
// Add `?backend=webgpu` to the URL to run both panes on WebGPU.
//
// Caveat worth knowing (and shown in the HUD): a volumetric pyramid is chunked
// CUBICALLY, so reading one plane at the finest level decodes a whole slab of
// 64^3 or 128^3 chunks and throws most of it away. Coarse levels are cheap; the
// finest level of a gigavoxel store is not. The tile size is aligned to the
// store's own chunk grid so neighbouring tiles at least share decodes.
import NiiVue, {
  fetchOmeZarrChunkedSource,
  lookupColorMap,
  NVSlide,
  SLICE_TYPE,
  SlideRenderer,
  SlideRendererGPU,
  VolumeSliceSource,
} from '../src/index.ts'

const backend =
  new URLSearchParams(location.search).get('backend') === 'webgpu'
    ? 'webgpu'
    : 'webgl2'

// DANDI serves every zarr asset from one public, CORS-enabled bucket, keyed by
// the asset's zarr id -- no API call and no credentials needed to stream one.
const DANDI_ZARR = 'https://dandiarchive.s3.amazonaws.com/zarr'

// Verified live (shape / chunks / dtype read from each level's .zarray). Both
// dandisets are CC-BY-4.0; the credit line is rendered in the page footer.
const DATASETS = {
  oct: {
    label: '000722 human brain OCT',
    zarrId: 'acffe53b-4849-4cc2-a01d-06e424896745',
    dandiset: '000722',
    asset: 'sub-I46/micr/sub-I46_sample-somatosensory_chunk-01_OCT.ome.zarr',
    size: '4.5 GB',
    // Serial-section OCT of somatosensory cortex: 20 um isotropic, float32
    // reflectivity, six levels, 64^3 chunks.
    axis: 'z',
    credit:
      'Chollet, Etienne; Yael Balbastre; Mauri, Chiara; Magnain, Caroline; ' +
      'Fischl, Bruce; Wang, Hui (2024). sOCT of the Human Somatosensory ' +
      'Cortex and Vessel Segmentation. DANDI archive, CC-BY-4.0.',
  },
  'oct-small': {
    label: '000722 OCT, small block',
    zarrId: '2aedcf87-6903-4080-9ccc-c17f1f13bc82',
    dandiset: '000722',
    asset: 'sub-I46/micr/sub-I46_sample-somatosensory_chunk-02_OCT.ome.zarr',
    size: '106 MB',
    axis: 'z',
    credit:
      'Chollet, Etienne; Yael Balbastre; Mauri, Chiara; Magnain, Caroline; ' +
      'Fischl, Bruce; Wang, Hui (2024). sOCT of the Human Somatosensory ' +
      'Cortex and Vessel Segmentation. DANDI archive, CC-BY-4.0.',
  },
  spim: {
    label: '000108 light-sheet SPIM',
    zarrId: 'f7e3a560-c4a6-4652-b8c8-66afe580e4cb',
    dandiset: '000108',
    asset:
      'sub-MITU01/ses-20210521h17m17s06/micr/' +
      'sub-MITU01_ses-20210521h17m17s06_sample-52_stain-YO_run-1_chunk-9_SPIM.ome.zarr',
    size: '17.7 GB',
    // 42371 x 2048 x 2048 uint16 strip. A z plane is a 20:1 ribbon, so the
    // deep-zoom pane defaults to a sagittal (x) plane: a square 2048^2 section.
    axis: 'x',
    credit:
      'Kamentsky, Lee; Marx, Slayton; Park, Juhyuk; Su-Arcaro, Clover; ' +
      'Moukheiber, Mira; Zhao, Victor (2023). Light sheet imaging of the ' +
      'human brain. DANDI archive, CC-BY-4.0.',
  },
}

// VRAM ceilings, the same split range.js uses: a WebGL2 context dies long before
// a WebGPU one does, so the residency cap has to be much smaller there.
const MULTILOD_BUDGET_BYTES = 2048 * 1024 * 1024
const DEFAULT_RESIDENCY_BYTES =
  backend === 'webgpu' ? 8192 * 1024 * 1024 : 1280 * 1024 * 1024
// Store-level byte cache shared by both panes (raw zarr chunk responses).
const ZARR_CACHE_BYTES = 512 * 1024 * 1024
const SLIDE_CACHE_BYTES = 192 * 1024 * 1024
// Rebuilding the slide is cheap but it drops in-flight tiles, so a crosshair
// DRAG should not rebuild it once per mouse move.
const PLANE_DEBOUNCE_MS = 140
const AXIS_INDEX = { x: 0, y: 1, z: 2 }
const PLANE_AXES = { x: [1, 2], y: [0, 2], z: [0, 1] }
const AXIS_NAME = ['x', 'y', 'z']

function el(id) {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node
}

const els = {
  dataset: el('dataset'),
  axis: el('axis'),
  plane: el('plane'),
  planeVal: el('planeVal'),
  follow: el('follow'),
  detail: el('detail'),
  colormap: el('colormap'),
  window: el('window'),
  fit: el('fit'),
  canvas: el('nv-canvas'),
  slideCanvas: el('slide-canvas'),
  volBusy: el('volBusy'),
  volBusyLabel: el('volBusyLabel'),
  volHud: el('volHud'),
  slideBusy: el('slideBusy'),
  slideBusyLabel: el('slideBusyLabel'),
  slideHud: el('slideHud'),
  fallback: el('fallback'),
  provenance: el('provenance'),
}

let nv = null
let slideView = null
// Monotonic: a dataset switch bumps it so a superseded load's async tail is
// discarded instead of installing itself over the newer scene.
let loadToken = 0
let chunkSource = null
let activeCv = null
let slide = null
let slideFrame = 0
let slideFitted = false
let planeIndex = 0
let planeTimer = 0
let windowRange = [0, 1]
let drag = null
let dragMoved = false

// ---------------------------------------------------------------- utilities

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatValue(value) {
  const magnitude = Math.abs(value)
  if (magnitude === 0) return '0'
  if (magnitude < 0.01 || magnitude >= 1e5) return value.toExponential(2)
  return value.toFixed(magnitude < 1 ? 4 : 1)
}

function showFallback(message) {
  els.fallback.textContent = message
  els.fallback.setAttribute('aria-hidden', 'false')
}

function clearFallback() {
  els.fallback.textContent = ''
  els.fallback.setAttribute('aria-hidden', 'true')
}

// A 256-entry opaque RGBA ramp for the slide tiles, built from the same named
// colormap the volumetric pane uses so the two panes agree on colour. The core
// LUT builder is not part of the public surface, so this is the demo's own
// (equivalent) interpolation; alpha is forced opaque because a slide tile is
// the whole image, not an overlay.
function slideLut(name) {
  const lut = new Uint8Array(1024)
  const cmap = lookupColorMap(name)
  if (!cmap?.I || cmap.I.length < 2) {
    for (let i = 0; i < 256; i++) {
      lut[i * 4] = i
      lut[i * 4 + 1] = i
      lut[i * 4 + 2] = i
      lut[i * 4 + 3] = 255
    }
    return lut
  }
  const { R, G, B, I } = cmap
  for (let k = 0; k < I.length - 1; k++) {
    const lo = I[k]
    const hi = I[k + 1]
    const span = hi - lo || 1
    for (let j = lo; j <= hi && j < 256; j++) {
      const f = (j - lo) / span
      lut[j * 4] = Math.round(R[k] + f * (R[k + 1] - R[k]))
      lut[j * 4 + 1] = Math.round(G[k] + f * (G[k + 1] - G[k]))
      lut[j * 4 + 2] = Math.round(B[k] + f * (B[k + 1] - B[k]))
      lut[j * 4 + 3] = 255
    }
  }
  return lut
}

function parseWindow(text, fallback) {
  const parts = String(text)
    .split(',')
    .map((part) => Number(part.trim()))
  if (parts.length !== 2 || !parts.every(Number.isFinite)) return fallback
  return parts[0] < parts[1] ? parts : fallback
}

// The finest-level voxel counts along each display axis.
function shape() {
  return chunkSource ? chunkSource.levels[0].shape : [1, 1, 1]
}

// The store's own chunk edge, in DISPLAY axis order. Aligning the slide tiles to
// it means two neighbouring tiles never decode the same chunk twice.
function displayChunkShape() {
  const { arrays, indices, order } = chunkSource.zarr
  const chunks = arrays[0].chunks
  const at = (position) =>
    position < 0 ? 1 : chunks[indices.spatial[position]]
  return [at(order.x), at(order.y), at(order.z)]
}

// A tile edge that is a multiple of the in-plane chunk edge and lands near 256:
// small enough that a pan does not stall on one huge decode, large enough that
// the per-tile overhead stays amortised.
function tileSizeForAxis(axis) {
  const [u, v] = PLANE_AXES[axis]
  const chunks = displayChunkShape()
  const edge = Math.max(chunks[u], chunks[v])
  if (!Number.isInteger(edge) || edge < 1) return 256
  return edge >= 256 ? edge : edge * Math.max(1, Math.round(256 / edge))
}

// ------------------------------------------------------------ source loading

// Robust window from the COARSEST level, which is one small read: percentiles
// rather than min/max, so a handful of hot voxels cannot flatten everything
// else. Needed because these stores range from 1e-4 float reflectivity (OCT) to
// raw uint16 photon counts (SPIM) -- no fixed default fits both.
const TYPED_ARRAYS = {
  2: Uint8Array,
  4: Int16Array,
  8: Int32Array,
  16: Float32Array,
  512: Uint16Array,
  768: Uint32Array,
}

async function autoWindow(source) {
  const index = source.levels.length - 1
  const level = source.levels[index]
  const Ctor = TYPED_ARRAYS[source.datatypeCode]
  if (!Ctor) return [0, 255]
  const bytes = await source.fetchChunk({
    levelIndex: index,
    texOrigin: [0, 0, 0],
    texDims: level.shape,
    bytesPerVoxel: Ctor.BYTES_PER_ELEMENT,
  })
  const aligned =
    bytes.byteOffset % Ctor.BYTES_PER_ELEMENT === 0 ? bytes : bytes.slice()
  const values = new Ctor(
    aligned.buffer,
    aligned.byteOffset,
    aligned.byteLength / Ctor.BYTES_PER_ELEMENT,
  )
  const sorted = Float64Array.from(values).sort()
  if (sorted.length === 0) return [0, 255]
  const at = (p) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  const low = at(0.02)
  const high = at(0.998)
  return high > low ? [low, high] : [sorted[0], sorted[sorted.length - 1] || 1]
}

function datasetUrl(def) {
  return `${DANDI_ZARR}/${def.zarrId}/`
}

// ------------------------------------------------------------- volumetric pane

function populateDetail() {
  els.detail.replaceChildren()
  for (const [index, level] of chunkSource.levels.entries()) {
    const option = document.createElement('option')
    option.value = String(index)
    option.textContent = `L${level.level} ${level.shape.join(' x ')}`
    els.detail.appendChild(option)
  }
  els.detail.value = '0'
}

async function loadVolumetric(def, token) {
  activeCv?.dispose()
  activeCv = null
  const stale = nv.volumes.map((volume) => volume.id)
  const cv = await nv.loadChunkedVolume(chunkSource, {
    id: `${def.zarrId}#${token}`,
    name: def.label,
    calMin: windowRange[0],
    calMax: windowRange[1],
    colormap: els.colormap.value,
    // 'focus' spends the byte budget around the crosshair, which is exactly the
    // policy that pairs with a linked deep-zoom pane: what you are inspecting in
    // one view is the region the other view has streamed at full detail.
    budgetPlan: 'focus',
    budgetBytes: MULTILOD_BUDGET_BYTES,
    minLevel: Number(els.detail.value) || 0,
    coarseFloor: true,
  })
  if (token !== loadToken) {
    cv.dispose()
    await removeVolumes([cv.volume.id])
    return
  }
  activeCv = cv
  await removeVolumes(stale)
  await activeCv.applyCoarseFloor()
}

// `nv.addVolume` stores a SHALLOW COPY of the NVImage it is handed
// (`NVModel.prepareVolume`), so the object a chunked handle exposes as
// `cv.volume` is NOT the object sitting in `nv.volumes`. Address volumes by
// `id`, the way the core itself does -- an identity match silently yields -1
// and turns every `setVolume` into a no-op.
function volumeIndexById(id) {
  if (!nv) return -1
  return nv.volumes.findIndex((volume) => volume.id === id)
}

// `loadChunkedVolume` is ADDITIVE and the controller exposes no single-volume
// removal, so displaced streamed volumes go out through the model plus one GL
// refresh. Walk high-to-low so an earlier removal cannot shift a pending index.
async function removeVolumes(ids) {
  if (!nv || ids.length === 0) return
  const drop = new Set(ids)
  const volumes = nv.volumes
  let removed = false
  for (let i = volumes.length - 1; i >= 0; i--) {
    if (drop.has(volumes[i].id)) {
      nv.model.removeVolume(i)
      removed = true
    }
  }
  if (removed) await nv.updateGLVolume()
}

// ------------------------------------------------------------- deep-zoom pane

function rebuildSlide({ keepViewport = true } = {}) {
  if (!chunkSource) return
  const axis = els.axis.value
  const previous = slide
  const viewport = keepViewport && previous ? { ...previous.viewport } : null
  previous?.removeEventListener('change', requestSlideRender)
  previous?.dispose?.()
  slideView?.renderer?.clearTextures?.()
  const [u, v] = PLANE_AXES[axis]
  const spacing = chunkSource.levels[0].spacing
  const source = new VolumeSliceSource(chunkSource, {
    axis,
    index: planeIndex,
    window: windowRange,
    lut: slideLut(els.colormap.value),
    tileSize: tileSizeForAxis(axis),
    id: els.dataset.value,
    name: `${DATASETS[els.dataset.value].label} (${axis} ${planeIndex})`,
    // ChunkedVolumeLevel.spacing carries the OME-Zarr scale in MICROMETRES (the
    // core adapter documents the field as mm; the OME-Zarr path fills it with
    // um), so convert here rather than mislabel the plane's physical size.
    pixelSpacingMM: [spacing[u] / 1000, spacing[v] / 1000],
  })
  slide = NVSlide.fromSource(source, {
    maxCacheBytes: SLIDE_CACHE_BYTES,
    targetScreenPixelsPerTilePixel: 0.75,
    ...(viewport ? { viewport } : {}),
  })
  slide.addEventListener('change', requestSlideRender)
  if (!viewport) slideFitted = false
  requestSlideRender()
}

function slideScreen() {
  const rect = els.slideCanvas.getBoundingClientRect()
  return {
    widthCss: Math.max(1, rect.width),
    heightCss: Math.max(1, rect.height),
    devicePixelRatio: window.devicePixelRatio || 1,
  }
}

function resizeSlideCanvas(screen) {
  const dpr = screen.devicePixelRatio ?? 1
  const width = Math.max(1, Math.floor(screen.widthCss * dpr))
  const height = Math.max(1, Math.floor(screen.heightCss * dpr))
  if (els.slideCanvas.width !== width) els.slideCanvas.width = width
  if (els.slideCanvas.height !== height) els.slideCanvas.height = height
}

async function createSlideView() {
  if (backend === 'webgpu' && 'gpu' in navigator) {
    const renderer = await SlideRendererGPU.create(els.slideCanvas)
    if (renderer) return { kind: 'gpu', renderer }
    console.warn('WebGPU unavailable for the slide pane; using WebGL2')
  }
  const gl = els.slideCanvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
  })
  if (!gl) throw new Error('WebGL2 is not available')
  const renderer = new SlideRenderer()
  renderer.init(gl)
  return { kind: 'gl', gl, renderer }
}

function requestSlideRender() {
  if (slideFrame !== 0) return
  slideFrame = window.requestAnimationFrame(() => {
    slideFrame = 0
    renderSlide()
  })
}

function renderSlide() {
  if (!slideView) return
  const screen = slideScreen()
  resizeSlideCanvas(screen)
  if (slide) {
    if (!slideFitted) {
      slide.fitToScreen(screen)
      slideFitted = true
    }
    slide.clampViewport(screen)
    if (slideView.kind === 'gpu') {
      slideView.renderer.render([slide], screen)
    } else {
      slideView.renderer.draw(slideView.gl, [slide], screen)
    }
  }
  updateSlideHud(screen)
}

// -------------------------------------------------------------------- linking

function setPlane(index, { fromCrosshair = false } = {}) {
  const axis = els.axis.value
  const count = shape()[AXIS_INDEX[axis]]
  const next = Math.max(0, Math.min(count - 1, Math.round(index)))
  if (next === planeIndex) return
  planeIndex = next
  els.plane.value = String(next)
  els.planeVal.textContent = String(next)
  if (fromCrosshair) {
    // Coalesce a crosshair DRAG into one rebuild: every rebuild drops the
    // slide's in-flight tile requests, so rebuilding per pointer move would
    // stream nothing to completion.
    if (planeTimer !== 0) window.clearTimeout(planeTimer)
    planeTimer = window.setTimeout(() => {
      planeTimer = 0
      rebuildSlide()
    }, PLANE_DEBOUNCE_MS)
    return
  }
  rebuildSlide()
}

function syncPlaneControl() {
  const axis = els.axis.value
  const count = shape()[AXIS_INDEX[axis]]
  els.plane.min = '0'
  els.plane.max = String(Math.max(0, count - 1))
  els.plane.value = String(planeIndex)
  els.planeVal.textContent = String(planeIndex)
}

// Crosshair -> plane. The streamed volume is built on a positive-diagonal
// centred affine, so a RAS voxel index IS the source's finest-level voxel index
// and no remapping is needed.
function onLocationChange(event) {
  if (!els.follow.checked || !chunkSource) return
  const vox = event.detail?.vox
  if (!vox) return
  setPlane(vox[AXIS_INDEX[els.axis.value]], { fromCrosshair: true })
}

// Slide click -> crosshair. `screenToSlide` returns base-level pixels in the
// plane's own (u, v) display axes; with displayYAxis 'up' the slide y IS the
// data v coordinate, so the two in-plane axes drop straight into the voxel.
function slideClickToCrosshair(event) {
  if (!els.follow.checked || !slide || !nv || !activeCv) return
  const rect = els.slideCanvas.getBoundingClientRect()
  const point = slide.screenToSlide(
    event.clientX - rect.left,
    event.clientY - rect.top,
    slideScreen(),
  )
  if (!point) return
  const dims = shape()
  const [u, v] = PLANE_AXES[els.axis.value]
  const vox = [0, 0, 0]
  vox[AXIS_INDEX[els.axis.value]] = planeIndex
  vox[u] = Math.max(0, Math.min(dims[u] - 1, Math.floor(point.x)))
  vox[v] = Math.max(0, Math.min(dims[v] - 1, Math.floor(point.y)))
  nv.crosshairPos = nv.vox2frac(vox)
}

// ----------------------------------------------------------------------- HUDs

function setBusy(node, label, text, busy) {
  node.classList.toggle('on', busy)
  if (busy) label.textContent = text
}

function updateVolumeHud() {
  if (!chunkSource || !nv) return
  const def = DATASETS[els.dataset.value]
  const stats = nv.chunkStreamStats()
  const plan = activeCv?.currentPlan ?? null
  const dims = shape()
  const levels = plan
    ? [...new Set(plan.chunks.map((chunk) => chunk.sourceLevel))].sort(
        (a, b) => a - b,
      )
    : []
  const inFlight = stats ? stats.pending + stats.inFlight : 0
  setBusy(
    els.volBusy,
    els.volBusyLabel,
    `streaming ${inFlight} brick${inFlight === 1 ? '' : 's'}`,
    inFlight > 0,
  )
  els.volHud.innerHTML = `
    <div class="title">${def.label}</div>
    <div class="row"><span class="key">backend</span><span>${
      backend === 'webgpu' ? 'WebGPU' : 'WebGL2'
    }</span></div>
    <div class="row"><span class="key">store</span><span>${def.size}, ${
      chunkSource.levels.length
    } levels</span></div>
    <div class="row"><span class="key">finest</span><span>${dims.join(
      ' x ',
    )}</span></div>
    <div class="row"><span class="key">bricks</span><span>${
      stats ? `${stats.resident}/${stats.total} resident` : 'planning'
    }</span></div>
    <div class="row"><span class="key">levels</span><span>${
      levels.length > 0 ? levels.map((l) => `L${l}`).join(' ') : '-'
    }</span></div>
    <div class="row"><span class="key">window</span><span>${formatValue(
      windowRange[0],
    )} .. ${formatValue(windowRange[1])}</span></div>
  `
}

function updateSlideHud(screen) {
  if (!slide) return
  const level = slide.selectLevel()
  const stats = slide.stats
  setBusy(
    els.slideBusy,
    els.slideBusyLabel,
    `streaming ${slide.pendingCount} tile${slide.pendingCount === 1 ? '' : 's'}`,
    slide.pendingCount > 0,
  )
  if (!level) return
  const visible = slide.visibleTiles(screen).tiles.length
  const spacing = slide.manifest.pixelSpacingMM
  const scale = slide.viewport.scale
  const zoom =
    scale >= 1 ? `${scale.toFixed(2)}x` : `1:${(1 / scale).toFixed(1)}`
  // One screen pixel covers `downsample / scale` base pixels, so the physical
  // size of a screen pixel is that times the base pixel spacing.
  const umPerPixel = spacing
    ? (spacing[0] * 1000 * level.downsample) / Math.max(scale, 1e-6)
    : null
  const [u, v] = PLANE_AXES[els.axis.value]
  els.slideHud.innerHTML = `
    <div class="title">${AXIS_NAME[u]}${AXIS_NAME[v]} plane, ${
      els.axis.value
    } = ${planeIndex}</div>
    <div class="row"><span class="key">plane</span><span>${
      slide.manifest.width
    } x ${slide.manifest.height} px</span></div>
    <div class="row"><span class="key">level</span><span>L${level.index} ${
      level.width
    } x ${level.height}, tile ${level.tileWidth}</span></div>
    <div class="row"><span class="key">zoom</span><span>${zoom}${
      umPerPixel ? ` (${umPerPixel.toFixed(2)} um/px)` : ''
    }</span></div>
    <div class="row"><span class="key">tiles</span><span>${visible} visible, ${
      slide.pendingCount
    } pending</span></div>
    <div class="row"><span class="key">decoded</span><span>${formatBytes(
      stats.wireBytes,
    )} of voxels</span></div>
    <div class="row"><span class="key">cache</span><span>${formatBytes(
      stats.cacheBytes,
    )} / ${stats.cacheHits} hits</span></div>
  `
}

// ------------------------------------------------------------------ lifecycle

async function loadDataset() {
  const token = ++loadToken
  const def = DATASETS[els.dataset.value]
  clearFallback()
  setBusy(els.volBusy, els.volBusyLabel, 'opening store', true)
  setBusy(els.slideBusy, els.slideBusyLabel, 'opening store', true)
  slide?.removeEventListener('change', requestSlideRender)
  slide?.dispose?.()
  slide = null
  slideView?.renderer?.clearTextures?.()
  try {
    const source = await fetchOmeZarrChunkedSource(datasetUrl(def), {
      cacheBytes: ZARR_CACHE_BYTES,
      ignoreMissingLevels: true,
    })
    if (token !== loadToken) return
    chunkSource = source
    windowRange = await autoWindow(source)
    if (token !== loadToken) return
    els.window.value = `${formatValue(windowRange[0])},${formatValue(
      windowRange[1],
    )}`
    els.axis.value = def.axis
    planeIndex = Math.floor(shape()[AXIS_INDEX[def.axis]] / 2)
    syncPlaneControl()
    populateDetail()
    updateProvenance(def)
    await loadVolumetric(def, token)
    if (token !== loadToken) return
    // Park the crosshair on the plane the slide opens at, so the two panes agree
    // from the first frame rather than after the first click.
    const dims = shape()
    const vox = dims.map((n) => Math.floor(n / 2))
    vox[AXIS_INDEX[def.axis]] = planeIndex
    nv.crosshairPos = nv.vox2frac(vox)
    rebuildSlide({ keepViewport: false })
  } catch (err) {
    if (token !== loadToken) return
    console.error(err)
    showFallback(err instanceof Error ? err.message : String(err))
    setBusy(els.volBusy, els.volBusyLabel, '', false)
    setBusy(els.slideBusy, els.slideBusyLabel, '', false)
  }
}

function updateProvenance(def) {
  els.provenance.replaceChildren()
  const lead = document.createElement('span')
  lead.textContent = 'Streamed from the DANDI Archive: '
  const link = document.createElement('a')
  link.href = `https://dandiarchive.org/dandiset/${def.dandiset}`
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.textContent = `dandiset ${def.dandiset}`
  const asset = document.createElement('span')
  asset.textContent = ` / ${def.asset} (${def.size}). ${def.credit}`
  els.provenance.append(lead, link, asset)
}

function applyWindow() {
  const next = parseWindow(els.window.value, windowRange)
  const changed = next[0] !== windowRange[0] || next[1] !== windowRange[1]
  windowRange = next
  if (!changed) return
  const index = activeCv ? volumeIndexById(activeCv.volume.id) : -1
  if (index >= 0) {
    nv.setVolume(index, { calMin: windowRange[0], calMax: windowRange[1] })
  }
  rebuildSlide()
}

function applyColormap() {
  const index = activeCv ? volumeIndexById(activeCv.volume.id) : -1
  if (index >= 0) {
    nv.setVolume(index, { colormap: els.colormap.value })
  }
  rebuildSlide()
}

// ---------------------------------------------------------------- slide input

els.slideCanvas.addEventListener('pointerdown', (event) => {
  drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
  dragMoved = false
})

els.slideCanvas.addEventListener('pointermove', (event) => {
  if (!drag || drag.pointerId !== event.pointerId || !slide) return
  const dx = event.clientX - drag.x
  const dy = event.clientY - drag.y
  if (!dragMoved && Math.abs(dx) + Math.abs(dy) < 3) return
  if (!dragMoved) {
    dragMoved = true
    els.slideCanvas.setPointerCapture(event.pointerId)
  }
  drag.x = event.clientX
  drag.y = event.clientY
  slide.panByScreenDelta(dx, dy, slideScreen())
  requestSlideRender()
})

function endDrag(event) {
  if (!drag || drag.pointerId !== event.pointerId) return
  if (dragMoved) {
    els.slideCanvas.releasePointerCapture?.(event.pointerId)
  } else {
    slideClickToCrosshair(event)
  }
  drag = null
  dragMoved = false
}

els.slideCanvas.addEventListener('pointerup', endDrag)
els.slideCanvas.addEventListener('pointercancel', endDrag)

els.slideCanvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault()
    if (!slide) return
    const rect = els.slideCanvas.getBoundingClientRect()
    slide.zoomBy(
      Math.exp(-event.deltaY * 0.0013),
      event.clientX - rect.left,
      event.clientY - rect.top,
      slideScreen(),
    )
    requestSlideRender()
  },
  { passive: false },
)

// -------------------------------------------------------------- control wiring

els.dataset.addEventListener('change', () => {
  void loadDataset()
})
els.axis.addEventListener('change', () => {
  planeIndex = Math.floor(shape()[AXIS_INDEX[els.axis.value]] / 2)
  syncPlaneControl()
  rebuildSlide({ keepViewport: false })
})
els.plane.addEventListener('input', () => {
  setPlane(Number(els.plane.value))
})
els.detail.addEventListener('change', () => {
  activeCv?.setMaxDetail(Number(els.detail.value) || 0)
})
els.colormap.addEventListener('change', applyColormap)
els.window.addEventListener('change', applyWindow)
els.fit.addEventListener('click', () => {
  slideFitted = false
  requestSlideRender()
})
window.addEventListener('resize', requestSlideRender)

async function main() {
  nv = new NiiVue({
    backend,
    backgroundColor: [0.02, 0.03, 0.03, 1],
    isColorbarVisible: true,
    sliceType: SLICE_TYPE.MULTIPLANAR,
    maxTextureDimension3D: 256,
    maxChunkResidencyBytes: DEFAULT_RESIDENCY_BYTES,
  })
  await nv.attachToCanvas(els.canvas)
  nv.addEventListener('locationChange', onLocationChange)
  slideView = await createSlideView()
  await loadDataset()
  // Both panes stream asynchronously with no completion event, so the HUDs poll.
  // Cheap: two innerHTML writes a few times a second.
  // The render pump goes FIRST: a throw while building the HUD string must not
  // be able to stop the slide from redrawing.
  window.setInterval(() => {
    requestSlideRender()
    updateVolumeHud()
  }, 250)
}

main().catch((err) => {
  console.error(err)
  showFallback(err instanceof Error ? err.message : String(err))
})
