import { describe, it, expect } from 'vitest'
import {
  LEAVES_PER_HECTARE, expectedLeavesForHectares, leavesInBarn,
  assessLoss, calculateClaim,
} from './agricultureClaim'

describe('agricultureClaim', () => {
  it('uses the industry standard of 15,000 plants x 18 leaves per hectare', () => {
    expect(LEAVES_PER_HECTARE).toBe(270_000)
    expect(expectedLeavesForHectares(1)).toBe(270_000)
    expect(expectedLeavesForHectares(2.5)).toBe(675_000)
  })

  it('counts barn contents as strings x leaves per string', () => {
    expect(leavesInBarn(500, 100)).toBe(50_000)
  })

  it('expresses damaged leaves as a percentage of leaves at topping', () => {
    // 27,000 of 270,000 leaves damaged on a one hectare crop.
    expect(assessLoss(27_000, 270_000).percentageLoss).toBeCloseTo(10, 6)
  })

  it('caps loss at 100% rather than reporting more than a total loss', () => {
    expect(assessLoss(400_000, 270_000).percentageLoss).toBe(100)
  })

  it('reports 0% when there is no expected crop, instead of dividing by zero', () => {
    const result = assessLoss(1_000, 0)
    expect(result.percentageLoss).toBe(0)
    expect(Number.isFinite(result.percentageLoss)).toBe(true)
  })

  it('deducts 10% handling and 15% excess from the gross loss', () => {
    // 10% loss on a $2,000 sum insured = $200 gross.
    const c = calculateClaim(10, 2_000)
    expect(c.grossLoss).toBe(200)
    expect(c.handlingExpenses).toBe(20)
    expect(c.excess).toBe(30)
    expect(c.claimPayable).toBe(150)
  })

  it('leaves 75% of the gross loss payable at any loss level', () => {
    for (const pct of [1, 12.5, 50, 100]) {
      const c = calculateClaim(pct, 4_000)
      expect(c.claimPayable).toBeCloseTo(c.grossLoss * 0.75, 2)
    }
  })

  it('never returns a negative payable amount', () => {
    expect(calculateClaim(0, 2_000).claimPayable).toBe(0)
    expect(calculateClaim(10, 0).claimPayable).toBe(0)
  })

  it('works end to end for a barn fire', () => {
    // One hectare expected (270,000 leaves); barn held 600 strings of 90
    // leaves (54,000) and the whole barn was lost.
    const expected = expectedLeavesForHectares(1)
    const inBarn = leavesInBarn(600, 90)
    const loss = assessLoss(inBarn, expected)
    expect(inBarn).toBe(54_000)
    expect(loss.percentageLoss).toBeCloseTo(20, 6)

    const claim = calculateClaim(loss.percentageLoss, 3_000)
    expect(claim.grossLoss).toBe(600)
    expect(claim.claimPayable).toBe(450)
  })
})
