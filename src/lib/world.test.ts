import { describe, expect, it } from 'vitest'
import { nextWorldClock, resolveSchedule } from './world'
import type { CharacterSchedule, WorldState } from '../types'

const world: WorldState = {
  id: 'global', worldId: 'default', worldVersion: 3, day: 1, slot: 'morning', hour: 8,
  step: 0, playerLocationId: 'home-living', advancing: false, updatedAt: 0,
}

describe('ChatSLG discrete world clock', () => {
  it('advances only through the four fixed slots and rolls the day', () => {
    const noon = nextWorldClock(world)
    expect(noon).toMatchObject({ day: 1, slot: 'day', hour: 12, step: 1 })
    const evening = nextWorldClock({ ...world, ...noon })
    const night = nextWorldClock({ ...world, ...evening })
    const tomorrow = nextWorldClock({ ...world, ...night })
    expect(tomorrow).toMatchObject({ day: 2, slot: 'morning', hour: 8, step: 4 })
  })
})

describe('authoritative schedule priority', () => {
  const schedule = (id: string, priority: CharacterSchedule['priority'], effectiveDay?: number): CharacterSchedule => ({
    id, characterId: 'c1', slot: 'evening', locationId: id, activity: id,
    phoneAccess: 'available', priority, sourceEventIds: [], createdAt: 0, effectiveDay,
  })

  it('resolves commitment over override over base', () => {
    expect(resolveSchedule([schedule('base', 'base'), schedule('override', 'override', 2), schedule('commitment', 'commitment', 2)], 2, 'evening')?.id).toBe('commitment')
    expect(resolveSchedule([schedule('base', 'base'), schedule('override', 'override', 2)], 2, 'evening')?.id).toBe('override')
    expect(resolveSchedule([schedule('base', 'base')], 2, 'evening')?.id).toBe('base')
  })

  it('does not apply an override on a different day', () => {
    expect(resolveSchedule([schedule('base', 'base'), schedule('override', 'override', 3)], 2, 'evening')?.id).toBe('base')
  })
})
