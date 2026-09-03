import { describe, it, expect } from 'vitest'
import { toIsoDate } from './dateUtils'

describe('toIsoDate', () => {
  it('reads back exactly the calendar date it was built from', () => {
    expect(toIsoDate(new Date(2026, 8, 1))).toBe('2026-09-01')
    expect(toIsoDate(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(toIsoDate(new Date(2026, 11, 31))).toBe('2026-12-31')
  })

  it('pads single-digit month and day', () => {
    expect(toIsoDate(new Date(2026, 0, 1))).toBe('2026-01-01')
  })
})
