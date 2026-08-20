import { describe, expect, test } from 'bun:test'
import {
  GAMMA_RANGE,
  invGamma,
  isPaqd,
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
