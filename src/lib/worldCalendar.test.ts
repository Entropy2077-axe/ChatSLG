import { describe, expect, it } from 'vitest'
import { formatWorldDateTime, hasWorldMomentPassed, modelWorldTimeText, stripLegacyRealTimePrefixes, worldCalendarDate } from './worldCalendar'

describe('worldCalendarDate', () => {
  it.each([
    [1, 1, '春季', 1],
    [30, 1, '春季', 30],
    [31, 1, '夏季', 1],
    [61, 1, '秋季', 1],
    [91, 1, '冬季', 1],
    [120, 1, '冬季', 30],
    [121, 2, '春季', 1],
  ])('maps world day %i to its fictional date', (day, year, season, seasonDay) => {
    expect(worldCalendarDate(day)).toMatchObject({ absoluteDay: day, year, season, seasonDay })
  })

  it('uses only the fixed world slot time in output', () => {
    expect(formatWorldDateTime({ day: 31, slot: 'evening', hour: 18 }))
      .toBe('架空历第1年 · 夏季第1日 · 傍晚（18:00）')
    expect(modelWorldTimeText({ day: 31, slot: 'evening', hour: 18 })).not.toContain('18:00')
  })

  it('removes persisted device-time prefixes without deleting summaries', () => {
    expect(stripLegacyRealTimePrefixes('[2026/7/16 04:12:30] 大家聊到了初雪。\n普通摘要'))
      .toBe('大家聊到了初雪。\n普通摘要')
  })

  it('orders appointments within a world day by the four time slots', () => {
    expect(hasWorldMomentPassed({ day: 3, slot: 'evening' }, { day: 3, slot: 'day' })).toBe(true)
    expect(hasWorldMomentPassed({ day: 3, slot: 'evening' }, { day: 3, slot: 'night' })).toBe(false)
    expect(hasWorldMomentPassed({ day: 4, slot: 'morning' }, { day: 3, slot: 'night' })).toBe(true)
  })
})
