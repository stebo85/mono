/**
 * Shared constants for the precomputed gradient volume.
 *
 * Both backends build the same RGBA8 3D texture from the colormapped volume
 * texture: RGB holds a unit normal encoded to [0, 1], alpha holds a
 * log-encoded gradient magnitude. Three features read it -- matcap
 * illumination, gradientOpacity, and silhouettePower -- and all three must
 * look identical on WebGL2 and WebGPU.
 *
 * `gl/gradient.ts` interpolates these into its GLSL; `wgpu/sobel.wgsl`
 * declares them as pipeline-overridable constants and `wgpu/wgpu.ts` supplies
 * them at pipeline creation. Neither backend redefines them locally, so the
 * two encodings cannot drift apart.
 *
 * THE ESTIMATOR IS DEFINED BY WHAT WEBGL2 CAN DO. It has no compute shaders,
 * so its gradient is a fragment pass rendered one z-slice at a time through an
 * FBO, and its only smoothing is whatever the sampler gives it. WebGPU
 * reproduces that exactly rather than doing something better, because a
 * "better" gradient on one backend is just a rendering difference the user
 * sees when they switch.
 */

/**
 * Offset, in voxels, of each central-difference tap.
 *
 * Deliberately fractional. The input texture is sampled LINEAR, so a tap at
 * 0.7 voxels is a trilinear blend of the surrounding voxels and the stencil
 * gets its smoothing from the sampler for free -- no separate blur pass, which
 * is what keeps the WebGPU path reproducible on WebGL2.
 */
export const SOBEL_RADIUS = 0.7

/**
 * The magnitude written to alpha is LOGARITHMIC in the SQUARED gradient, and
 * that is not cosmetic. `gradientOpacity` raises the stored value to the power
 * `gradientOpacity * 8`, and a linear magnitude sits near zero through most of
 * a volume, so any useful slider position drives the whole render to black
 * (measured: mean luminance 29 to under 1 at 0.7). The log spreads "one 8-bit
 * level of contrast" to "full contrast" over [0, 1], which is the range those
 * exponents were tuned against.
 *
 * Each axis is a difference of two [0, 1] samples, so the squared gradient
 * spans [0, 3].
 */
/** Squared gradient of a single 8-bit intensity level: the noise floor. */
export const GRAD_EPS = 1 / 255 ** 2
/** Moves that floor to 0. */
export const GRAD_SHIFT = -Math.log2(GRAD_EPS)
/** Moves full scale (a squared gradient of 3) to 1. */
export const GRAD_SCALE = 1 / (Math.log2(3) + GRAD_SHIFT)

/**
 * Both backends differentiate the colormapped texture's ALPHA channel.
 *
 * This is a correctness choice, not a coin flip. A colormap LUT's alpha ramp
 * is monotonic in intensity by construction; its colour channels are not. On
 * `hot` (R: 3, 255, 255, 255 over I: 0, 95, 191, 255) red saturates at 37% of
 * the intensity range and is flat above it, so differentiating red returns
 * zero gradient across the top 63% of the data -- no lighting, no silhouette,
 * no gradient opacity, on exactly the voxels that matter. Alpha keeps rising
 * across the whole range for every LUT.
 *
 * WebGPU's sobel.wgsl read `.r` until this was fixed, which is why the two
 * backends disagreed by a factor of 2 on `gray` (R ramps to 255, A to 128) and
 * disagreed completely on any coloured colormap.
 */
export const GRADIENT_SOURCE_CHANNEL = 'a'
