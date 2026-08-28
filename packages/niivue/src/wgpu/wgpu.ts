import * as NVCmaps from '@/cmap/NVCmaps'
import { applyCORS } from '@/NVLoader'
import {
  GRAD_EPS,
  GRAD_SCALE,
  GRAD_SHIFT,
  SOBEL_RADIUS,
} from '@/view/NVGradient'
import sobelWGSL from './sobel.wgsl?raw'

// --- per-device cached pipelines ---
interface GradientPipelines {
  sobelPipeline: GPUComputePipeline
  sobelBindLayout: GPUBindGroupLayout
  sampler: GPUSampler
}
const _deviceCache = new WeakMap<GPUDevice, GradientPipelines>()

// ensure the gradient pipeline exists and is cached for this device
function ensureComputePipelines(device: GPUDevice): GradientPipelines {
  let cached = _deviceCache.get(device)
  if (cached) return cached
  const compModule = device.createShaderModule({ code: sobelWGSL })
  const sobelPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: {
      module: compModule,
      entryPoint: 'main',
      // Pipeline-overridable constants rather than string-interpolated
      // literals, so this and the GLSL in gl/gradient.ts read the same
      // numbers from view/NVGradient.ts by construction.
      constants: {
        sobelRadius: SOBEL_RADIUS,
        gradEps: GRAD_EPS,
        gradShift: GRAD_SHIFT,
        gradScale: GRAD_SCALE,
      },
    },
  })
  // LINEAR + clamp-to-edge, matching the filtering and wrap gl/gradient.ts
  // sets on its input texture. The filtering is what makes the fractional
  // sobelRadius tap smooth, so it is load-bearing, not a default.
  const sampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
  })
  cached = {
    sobelPipeline,
    sobelBindLayout: sobelPipeline.getBindGroupLayout(0),
    sampler,
  }
  _deviceCache.set(device, cached)
  return cached
}

/**
 * Await-free gradient build, for callers that cannot be async.
 *
 * The `await onSubmittedWorkDone()` in the async wrapper below is a
 * synchronisation convenience, not a correctness requirement: the compute pass
 * and every later render pass that samples its output go on the same queue, so
 * the queue already orders the write before the read. This variant encodes and
 * submits exactly the same work and hands back the texture immediately, which
 * is what lets the per-frame lazy fill run inside the synchronous frame hook.
 */
export function volume2TextureGradientRGBASync(
  device: GPUDevice,
  textureRGBA: GPUTexture,
): GPUTexture {
  const cached = ensureComputePipelines(device)
  const vx = textureRGBA.width
  const vy = textureRGBA.height
  const vz = textureRGBA.depthOrArrayLayers
  // 1) Create the output texture. One pass, so no temp texture and no
  // ping-pong: the blur that used to sit between them is gone (its smoothing
  // now comes from the linear sampler, as it does on WebGL2).
  const finalVolumeTexture = device.createTexture({
    size: [vx, vy, vz],
    format: 'rgba8unorm',
    dimension: '3d',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_SRC,
  })
  // 2) Bind the input texture directly, plus the filtering sampler
  const sobelBindGroup = device.createBindGroup({
    layout: cached.sobelBindLayout,
    entries: [
      { binding: 0, resource: textureRGBA.createView() },
      { binding: 1, resource: finalVolumeTexture.createView() },
      { binding: 2, resource: cached.sampler },
    ],
  })
  // 3) Dispatch
  const encoder = device.createCommandEncoder()
  {
    const pass = encoder.beginComputePass()
    pass.setPipeline(cached.sobelPipeline)
    pass.setBindGroup(0, sobelBindGroup)
    pass.dispatchWorkgroups(
      Math.ceil(vx / 8),
      Math.ceil(vy / 8),
      Math.ceil(vz / 4),
    )
    pass.end()
  }
  device.queue.submit([encoder.finish()])
  return finalVolumeTexture
}

export async function volume2TextureGradientRGBA(
  device: GPUDevice,
  textureRGBA: GPUTexture,
): Promise<GPUTexture> {
  const texture = volume2TextureGradientRGBASync(device, textureRGBA)
  await device.queue.onSubmittedWorkDone()
  return texture
}

export async function lutBytes2texture(
  device: GPUDevice,
  lut: Uint8ClampedArray,
): Promise<GPUTexture> {
  const texture = device.createTexture({
    size: [256, 1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  const lutUpload = new Uint8Array(lut)
  device.queue.writeTexture(
    { texture: texture },
    lutUpload,
    { bytesPerRow: 256 * 4, rowsPerImage: 1 },
    [256, 1],
  )
  await device.queue.onSubmittedWorkDone()
  return texture
}

export async function lut2texture(
  device: GPUDevice,
  lutName: string,
  invert = false,
): Promise<GPUTexture> {
  return lutBytes2texture(device, NVCmaps.lutrgba8(lutName, invert))
}

export async function bitmap2texture(
  device: GPUDevice,
  imageSrc: string,
): Promise<GPUTexture> {
  const image = new Image()
  applyCORS(image)
  image.src = imageSrc
  await image.decode()
  const bitmap = await createImageBitmap(image)
  const texture = device.createTexture({
    size: [bitmap.width, bitmap.height, 1],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  })
  const src = { source: bitmap }
  const dst = { texture: texture }
  device.queue.copyExternalImageToTexture(src, dst, [
    bitmap.width,
    bitmap.height,
  ])
  await device.queue.onSubmittedWorkDone()
  return texture
}

export async function bitmap2textureOrFallback(
  device: GPUDevice,
  imageSrc: string,
): Promise<GPUTexture> {
  if (!imageSrc) {
    // 1x1 white fallback: matcap_rgb * color = color
    const texture = device.createTexture({
      size: [1, 1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    device.queue.writeTexture(
      { texture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    )
    return texture
  }
  return bitmap2texture(device, imageSrc)
}

export function destroy(device: GPUDevice): void {
  _deviceCache.delete(device)
}
