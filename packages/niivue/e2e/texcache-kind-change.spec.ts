import { expect, test } from '@playwright/test'

// Issue #145, reported by @stebo85 as stale numbers out of `chunkStreamStats()`.
//
// `_destroyTexEntry` released an entry's GPU resources but left the entry in
// `_texCache`, and the one path that dropped the key by hand ran only for
// multi-instance callers. So a volume that stopped being chunked -- its plan
// cleared, or the same url reloaded as a plain volume -- left its chunked entry
// in the map for the life of the renderer: every brick texture still held, the
// upload pump still walking it, and `chunkStreamStats` still counting it.
//
// The assertion is that the brick count goes to zero once the volume is a single
// texture. It is a real regression test rather than a restatement of the fix:
// revert either backend's eviction and the second expect reports the full brick
// count for a volume that no longer has bricks.
//
// Both backends, because the leak and the fix are mirrored in gl/render.ts and
// wgpu/render.ts. WebGPU is skipped when the runner has no adapter (headless
// Chromium usually has SwiftShader for WebGL2 only).

test.use({
  launchOptions: {
    args: [
      '--enable-unsafe-swiftshader',
      '--enable-unsafe-webgpu',
      '--use-angle=swiftshader',
      '--enable-features=Vulkan',
    ],
  },
})

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

// A 2x2x2 forced plan: mni152 fits in one texture, so the tiling is forced
// rather than required. Eight bricks is enough to tell "chunked" from "not"
// without paying for 27 uploads under SwiftShader.
const GRID = 2
const EXPECTED_CHUNKS = GRID * GRID * GRID

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`a volume that stops being chunked drops its bricks (${backend})`, async ({
    page,
  }) => {
    test.setTimeout(180_000)

    const result = await page.evaluate(`(async () => {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        const adapter = await navigator.gpu.requestAdapter()
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const { default: NiiVue, SLICE_TYPE, chunkVolumeGrid } =
        await import('/src/index.ts')
      const nextFrame = () => new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)))

      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 256
      document.body.appendChild(canvas)
      const nv = new NiiVue({
        backend: '${backend}',
        sliceType: SLICE_TYPE.RENDER,
      })
      await nv.attachToCanvas(canvas)
      await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
      await nextFrame()

      const vol = nv.volumes[0]
      const d = vol.dimsRAS
      // The device limit only has to exceed the largest brick edge: the point
      // is to force a plan, not to model a real device cap.
      vol.chunkPlan = chunkVolumeGrid(
        [d[1], d[2], d[3]],
        [${GRID}, ${GRID}, ${GRID}],
        4096,
        [3, 3, 3],
      )
      await nv.updateGLVolume()
      await nextFrame()
      const chunked = nv.chunkStreamStats()

      // Back to one texture under the SAME cache key (vol.url), which is the
      // kind change that used to strand the chunked entry.
      vol.chunkPlan = undefined
      await nv.updateGLVolume()
      await nextFrame()
      const single = nv.chunkStreamStats()

      return {
        chunkedTotal: chunked ? chunked.total : null,
        singleTotal: single ? single.total : null,
        singleResident: single ? single.resident : null,
      }
    })()`)

    // biome-ignore lint/suspicious/noExplicitAny: page.evaluate returns unknown
    const r = result as any
    if (r.skip) {
      test.skip(true, r.skip)
      return
    }

    // Guard the guard: if the forced plan never took, the real assertion below
    // would pass for the wrong reason.
    expect(r.chunkedTotal).toBe(EXPECTED_CHUNKS)

    expect(r.singleTotal).toBe(0)
    expect(r.singleResident).toBe(0)
  })
}
