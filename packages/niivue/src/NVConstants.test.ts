import { describe, expect, test } from 'bun:test'
import {
  GAMMA_RANGE,
  invGamma,
  isPaqd,
  LOD_BRIGHTNESS_RANGE,
  LOD_OPACITY_RANGE,
  lodGammaExponent,
  lodOpacityScale,
  NiiDataType,
  NiiIntentCode,
  SLICE_TYPE,
  sliceTypeDim,
} from './NVConstants'

describe('isPaqd', () => {
  test('labelAndRGBA32_returnsTrue', () => {
    expect(
      isPaqd({
        intent_code: NiiIntentCode.NIFTI_INTENT_LABEL,
        datatypeCode: NiiDataType.DT_RGBA32,
      }),
    ).toBe(true)
  })

  test('wrongIntent_returnsFalse', () => {
    expect(
      isPaqd({
        intent_code: NiiIntentCode.NIFTI_INTENT_NONE,
        datatypeCode: NiiDataType.DT_RGBA32,
      }),
    ).toBe(false)
  })

  test('wrongDatatype_returnsFalse', () => {
    expect(
      isPaqd({
        intent_code: NiiIntentCode.NIFTI_INTENT_LABEL,
        datatypeCode: NiiDataType.DT_FLOAT32,
      }),
    ).toBe(false)
  })
})

describe('sliceTypeDim', () => {
  test('axial_returns2', () => {
    expect(sliceTypeDim(SLICE_TYPE.AXIAL)).toBe(2)
  })

  test('coronal_returns1', () => {
    expect(sliceTypeDim(SLICE_TYPE.CORONAL)).toBe(1)
  })

  test('sagittal_returns0', () => {
    expect(sliceTypeDim(SLICE_TYPE.SAGITTAL)).toBe(0)
  })

  test('noneFallsBackToDefault', () => {
    // SLICE_TYPE.NONE hides the spatial view (no slice dim applies); the helper
    // must return its safe default (2) rather than throw or yield NaN.
    expect(sliceTypeDim(SLICE_TYPE.NONE)).toBe(2)
  })

  test('sliceTypeNoneIsDistinct', () => {
    const values = Object.values(SLICE_TYPE)
    expect(SLICE_TYPE.NONE).toBe(5)
    expect(new Set(values).size).toBe(values.length) // all enum values unique
  })
})

describe('invGamma', () => {
  test('neutralGammaIsExactlyOne', () => {
    // The shaders skip the pow() on an exact 1.0, so the default must land
    // there bit-for-bit rather than at 0.9999.
    expect(invGamma(1)).toBe(1)
  })

  test('aboveOneBrightens', () => {
    // pow(rgb, e) with e < 1 moves a value in [0,1] toward 1.
    const e = invGamma(2)
    expect(e).toBeCloseTo(0.5, 10)
    expect(0.25 ** e).toBeGreaterThan(0.25)
  })

  test('belowOneDarkens', () => {
    const e = invGamma(0.5)
    expect(e).toBeCloseTo(2, 10)
    expect(0.25 ** e).toBeLessThan(0.25)
  })

  test('clampsToRange', () => {
    expect(invGamma(0)).toBe(1 / GAMMA_RANGE[0])
    expect(invGamma(-5)).toBe(1 / GAMMA_RANGE[0])
    expect(invGamma(1e6)).toBe(1 / GAMMA_RANGE[1])
  })

  test('nonFiniteIsNeutral', () => {
    // A NaN exponent would blank every sample, so it must fall back to the
    // no-op rather than reach the shader.
    expect(invGamma(Number.NaN)).toBe(1)
    expect(invGamma(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('lodGammaExponent', () => {
  const beta = 0.022

  test('is an exact no-op at the finest level', () => {
    expect(lodGammaExponent(1, beta)).toBe(1)
    // Below 1 is not a coarser level; treat it as no compensation.
    expect(lodGammaExponent(0.5, beta)).toBe(1)
  })

  test('a zero coefficient disables it at every level', () => {
    expect(lodGammaExponent(2, 0)).toBe(1)
    expect(lodGammaExponent(8, 0)).toBe(1)
  })

  test('brightens more as the brick gets coarser', () => {
    // Exponent < 1 raises a [0,1] colour, so a coarser brick is lifted further.
    const a = lodGammaExponent(2, beta)
    const b = lodGammaExponent(4, beta)
    const c = lodGammaExponent(8, beta)
    expect(a).toBeLessThan(1)
    expect(b).toBeLessThan(a)
    expect(c).toBeLessThan(b)
  })

  test('follows 1 - coefficient * (downsample - 1)', () => {
    expect(lodGammaExponent(2, beta)).toBeCloseTo(1 - beta, 10)
    expect(lodGammaExponent(4, beta)).toBeCloseTo(1 - 3 * beta, 10)
  })

  test('clamps the coefficient to the accepted range', () => {
    // Picked at a downsample where the 0.25 floor does not also bite, so this
    // measures the coefficient clamp alone.
    const capped = lodGammaExponent(1.5, 10)
    expect(capped).toBeCloseTo(
      lodGammaExponent(1.5, LOD_BRIGHTNESS_RANGE[1]),
      10,
    )
    expect(capped).toBeCloseTo(1 - 0.5 * LOD_BRIGHTNESS_RANGE[1], 10)
  })

  test('shares one accepted range with the opacity coefficient', () => {
    // Two adjacent knobs, one rule: copying a value from one into the other
    // must not silently clamp.
    expect(LOD_BRIGHTNESS_RANGE).toEqual(LOD_OPACITY_RANGE)
  })

  test('floors the exponent so a deep pyramid cannot blow out', () => {
    expect(lodGammaExponent(1e6, LOD_BRIGHTNESS_RANGE[1])).toBe(0.25)
  })

  test('non-finite inputs are a no-op rather than reaching the shader', () => {
    expect(lodGammaExponent(Number.NaN, beta)).toBe(1)
    expect(lodGammaExponent(Number.POSITIVE_INFINITY, beta)).toBe(1)
    expect(lodGammaExponent(4, Number.NaN)).toBe(1)
  })
})

describe('lodOpacityScale', () => {
  const c = 0.1

  test('defaults to a strict no-op', () => {
    // The default coefficient is 0: measured, this correction costs more in
    // accumulated colour than it recovers in alpha on dense structure.
    expect(lodOpacityScale(8, 0)).toBe(1)
    expect(lodOpacityScale(2, 0)).toBe(1)
  })

  test('is an exact no-op at the finest level', () => {
    expect(lodOpacityScale(1, c)).toBe(1)
    expect(lodOpacityScale(0.5, c)).toBe(1)
  })

  test('follows 1 + coefficient * (downsample - 1)', () => {
    expect(lodOpacityScale(2, c)).toBeCloseTo(1 + c, 10)
    expect(lodOpacityScale(4, c)).toBeCloseTo(1 + 3 * c, 10)
  })

  test('makes a coarser brick more opaque, never less', () => {
    const a = lodOpacityScale(2, c)
    const b = lodOpacityScale(4, c)
    expect(a).toBeGreaterThan(1)
    expect(b).toBeGreaterThan(a)
  })

  test('clamps the coefficient to the accepted range', () => {
    expect(lodOpacityScale(2, 10)).toBeCloseTo(1 + LOD_OPACITY_RANGE[1], 10)
  })

  test('caps the scale so a deep pyramid cannot go fully opaque', () => {
    expect(lodOpacityScale(1e6, LOD_OPACITY_RANGE[1])).toBe(8)
  })

  test('non-finite inputs are a no-op rather than reaching the shader', () => {
    expect(lodOpacityScale(Number.NaN, c)).toBe(1)
    expect(lodOpacityScale(Number.POSITIVE_INFINITY, c)).toBe(1)
    expect(lodOpacityScale(4, Number.NaN)).toBe(1)
  })
})
