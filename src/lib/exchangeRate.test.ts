import { describe, it, expect } from 'vitest'
import {
  daysSince, isStale, rateAgeLabel, convertUsdToZig, validateRate, RATE_STALE_AFTER_DAYS,
  type ExchangeRate,
} from './exchangeRate'

function rate(effectiveDate: string, value = 26): ExchangeRate {
  return {
    id: 'r1', currency: 'ZWG', rate: value, effectiveDate,
    source: 'manual', createdAt: `${effectiveDate}T00:00:00Z`,
  }
}

describe('daysSince', () => {
  it('counts whole days back from today', () => {
    expect(daysSince('2026-09-02', new Date(2026, 8, 2))).toBe(0)
    expect(daysSince('2026-09-01', new Date(2026, 8, 2))).toBe(1)
    expect(daysSince('2026-08-26', new Date(2026, 8, 2))).toBe(7)
  })

  it('treats an unparseable date as infinitely old rather than as today', () => {
    expect(daysSince('not-a-date', new Date(2026, 8, 2))).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('isStale', () => {
  it('is stale when there is no rate at all', () => {
    expect(isStale(null)).toBe(true)
  })

  it('holds until the weekly mark, then goes stale', () => {
    const today = new Date(2026, 8, 2)
    expect(daysSince('2026-08-27', today)).toBe(RATE_STALE_AFTER_DAYS - 1)
    expect(isStale(rate('2026-08-27'), today)).toBe(false)

    expect(daysSince('2026-08-26', today)).toBe(RATE_STALE_AFTER_DAYS)
    expect(isStale(rate('2026-08-26'), today)).toBe(true)
  })
})

describe('rateAgeLabel', () => {
  it('reads naturally for the recent cases', () => {
    const today = new Date(2026, 8, 2)
    expect(rateAgeLabel(null)).toBe('No rate set')
    expect(rateAgeLabel(rate('2026-09-02'), today)).toBe('Set today')
    expect(rateAgeLabel(rate('2026-09-01'), today)).toBe('Set yesterday')
    expect(rateAgeLabel(rate('2026-08-26'), today)).toBe('Set 7 days ago')
  })
})

describe('convertUsdToZig', () => {
  it('converts and rounds to cents', () => {
    expect(convertUsdToZig(10, 26.5)).toBe(265)
    expect(convertUsdToZig(12.34, 26.5)).toBe(327.01)
  })

  it('does not accumulate floating point drift', () => {
    expect(convertUsdToZig(0.1 + 0.2, 10)).toBe(3)
  })
})

describe('validateRate', () => {
  it('accepts a plausible rate', () => {
    expect(validateRate('26.4')).toEqual({ ok: true, rate: 26.4 })
    expect(validateRate('  26.4  ')).toEqual({ ok: true, rate: 26.4 })
  })

  it.each([
    ['', 'Enter the rate.'],
    ['abc', 'The rate must be a number.'],
    ['0', 'The rate must be greater than zero.'],
    ['-5', 'The rate must be greater than zero.'],
  ])('rejects %s', (input, error) => {
    expect(validateRate(input)).toEqual({ ok: false, error })
  })

  it('catches a rate entered the wrong way round', () => {
    const result = validateRate('0.038')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('inverted')
  })

  it('catches a slipped decimal point', () => {
    const result = validateRate('264000')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('decimal point')
  })
})
