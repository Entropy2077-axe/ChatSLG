import { describe, expect, it } from 'vitest'
import { parsePersonaGeneration } from './prompt'

const slots = ['morning', 'day', 'evening', 'night'] as const
const schedule = Array.from({ length: 7 }, (_, dayOfWeek) => slots.map((slot) => ({
  dayOfWeek, slot, locationId: 'home-living', activity: `${dayOfWeek}-${slot}`,
  phoneAccess: 'available', adherence: slot === 'night' ? 'optional' : 'normal',
}))).flat()

describe('persona schedule parsing', () => {
  it('accepts one complete 7 by 4 world-week schedule', () => {
    const parsed = parsePersonaGeneration(JSON.stringify({ name: '测试角色', persona: '稳定人设', worldSchedule: schedule }))
    expect(parsed?.worldSchedule).toHaveLength(28)
    expect(parsed?.worldSchedule[3].adherence).toBe('optional')
  })

  it('rejects incomplete or duplicate coverage', () => {
    expect(parsePersonaGeneration(JSON.stringify({ name: '测试角色', persona: '稳定人设', worldSchedule: schedule.slice(1) }))).toBeNull()
    expect(parsePersonaGeneration(JSON.stringify({ name: '测试角色', persona: '稳定人设', worldSchedule: [...schedule.slice(1), schedule[1]] }))).toBeNull()
  })
})
