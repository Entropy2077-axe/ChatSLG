import { describe, expect, it } from 'vitest'
import { salaryForWorldDays, salaryForWorldRange } from './finance'

describe('world-day salary settlement', () => {
  it('pays one thirtieth of monthly salary per elapsed world day', () => {
    expect(salaryForWorldDays(9000, 1)).toBe(300)
    expect(salaryForWorldDays(9000, 3)).toBe(900)
  })

  it('never pays for negative or fractional elapsed days', () => {
    expect(salaryForWorldDays(9000, -1)).toBe(0)
    expect(salaryForWorldDays(9000, 0.9)).toBe(0)
  })

  it('pays exactly one monthly salary after 30 world days regardless of daily rounding', () => {
    const dailyPayments = Array.from({ length: 30 }, (_, index) => salaryForWorldRange(1000, 1, index + 1, index + 2))
    expect(dailyPayments.reduce((sum, amount) => sum + amount, 0)).toBe(1000)
    expect(salaryForWorldRange(1000, 1, 1, 31)).toBe(1000)
  })
})
