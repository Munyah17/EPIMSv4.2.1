import { describe, expect, it } from 'vitest'
import { isNationalId } from './validation'

describe('isNationalId', () => {
  it('accepts the 8-digit and 9-digit Zimbabwe formats', () => {
    expect(isNationalId('64192876H34')).toBe(true)
    expect(isNationalId('632118532K12')).toBe(true)
  })

  it('accepts the same IDs with card separators or lowercase letters', () => {
    expect(isNationalId('64-192876-H-34')).toBe(true)
    expect(isNationalId('63 2118532 k 12')).toBe(true)
  })

  it.each([
    '70091919',
    '387842F38',
    '6419287H34',
    '6419287610H34',
    '64192876HH34',
    '64192876H345',
    'H6419287634',
  ])('rejects a shape outside the two formats: %s', id => {
    expect(isNationalId(id)).toBe(false)
  })
})
