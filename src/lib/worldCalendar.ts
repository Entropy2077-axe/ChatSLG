import type { TimeSlot } from '../types'

export const DAYS_PER_SEASON = 30
export const SEASONS_PER_YEAR = 4
export const DAYS_PER_YEAR = DAYS_PER_SEASON * SEASONS_PER_YEAR

export const SEASON_LABELS = ['春季', '夏季', '秋季', '冬季'] as const

const SLOT_LABELS: Record<TimeSlot, string> = {
  morning: '早晨',
  day: '白天',
  evening: '傍晚',
  night: '夜晚',
}

export const WORLD_TIME_SLOTS: TimeSlot[] = ['morning', 'day', 'evening', 'night']

export function worldSlotIndex(slot: TimeSlot): number {
  return WORLD_TIME_SLOTS.indexOf(slot)
}

export function hasWorldMomentPassed(
  current: { day: number; slot: TimeSlot },
  target: { day: number; slot?: TimeSlot },
): boolean {
  if (target.day !== current.day) return target.day < current.day
  return target.slot !== undefined && worldSlotIndex(target.slot) < worldSlotIndex(current.slot)
}

export interface WorldCalendarDate {
  absoluteDay: number
  year: number
  season: (typeof SEASON_LABELS)[number]
  seasonIndex: number
  seasonDay: number
  dayOfYear: number
}

type WorldClockLike = { day: number; slot: TimeSlot; hour: number }

/** Derives the fictional calendar from the world's single monotonic day value. */
export function worldCalendarDate(worldDay: number): WorldCalendarDate {
  const absoluteDay = Math.max(1, Math.floor(Number.isFinite(worldDay) ? worldDay : 1))
  const zeroBasedDay = absoluteDay - 1
  const dayOfYear = zeroBasedDay % DAYS_PER_YEAR
  const seasonIndex = Math.floor(dayOfYear / DAYS_PER_SEASON)
  return {
    absoluteDay,
    year: Math.floor(zeroBasedDay / DAYS_PER_YEAR) + 1,
    season: SEASON_LABELS[seasonIndex],
    seasonIndex,
    seasonDay: dayOfYear % DAYS_PER_SEASON + 1,
    dayOfYear: dayOfYear + 1,
  }
}

export function formatWorldDate(worldDay: number): string {
  const date = worldCalendarDate(worldDay)
  return `架空历第${date.year}年 · ${date.season}第${date.seasonDay}日`
}

export function formatWorldDateTime(clock: WorldClockLike): string {
  return `${formatWorldDate(clock.day)} · ${SLOT_LABELS[clock.slot]}（${String(clock.hour).padStart(2, '0')}:00）`
}

/** Model-facing wording explicitly excludes the device clock and real calendar. */
export function modelWorldTimeText(clock: WorldClockLike): string {
  return `${formatWorldDate(clock.day)} · ${SLOT_LABELS[clock.slot]}；世界连续第${Math.max(1, Math.floor(clock.day))}天。这里是唯一有效的当前时段，不得推测或使用现实日期、星期、设备钟点。`
}

/** Removes legacy `[device locale date/time]` prefixes from persisted group
 * summaries before they are shown to a model. The summary text itself stays. */
export function stripLegacyRealTimePrefixes(text: string): string {
  return text.replace(/^\s*\[[^\]\n]*(?:\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})[^\]\n]*\]\s*/gm, '')
}
