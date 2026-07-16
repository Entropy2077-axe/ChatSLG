import { describe, expect, it } from 'vitest'
import type { Appointment, CharacterSchedule, Contact, LocationNode, WorldEvent } from '../types'
import { chooseDirectedEventCandidate, type EventDirectorInput } from './eventDirector'
import { weatherForWorld } from './worldWeather'

const contact = (id: string): Contact => ({
  id, name: id, avatar: '🙂', avatarColor: '#fff', systemPrompt: `${id}的人设`, createdAt: 0,
  memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 0, memoryMessageCursor: 0,
  relationshipBase: '朋友', relationshipDynamic: '', currentLocationId: 'cafe',
})

const location: LocationNode = {
  id: 'cafe', worldId: 'world', name: '咖啡店', kind: 'cafe', description: '', access: 'public',
  sortOrder: 1, createdAt: 0, updatedAt: 0,
}

function baseInput(day: number, step: number): EventDirectorInput {
  return {
    seed: 'event-world', worldId: 'world', day, slot: 'morning', step, playerLocationId: 'cafe',
    weather: weatherForWorld('event-world', day, 'morning'), contacts: [], locations: [location],
    schedules: [], appointments: [], relations: [], recentEvents: [],
  }
}

describe('sparse deterministic event director', () => {
  it('selects one public season event on the first morning of a season', () => {
    const event = chooseDirectedEventCandidate(baseInput(31, 120))
    expect(event).toMatchObject({ kind: 'seasonal', worldDay: 31, worldSlot: 'morning', visibility: 'public' })
  })

  it('does not repeat a season key already stored in the world', () => {
    const input = baseInput(31, 120)
    const existing: WorldEvent = {
      id: 'old', type: 'seasonal', worldStep: 119, worldDay: 31, worldSlot: 'morning', actorId: 'world',
      participantIds: [], content: '换季', visibility: 'public', directedEventKey: 'season:1:夏季', createdAt: 0,
    }
    input.recentEvents = [existing]
    expect(chooseDirectedEventCandidate(input)).toBeNull()
  })

  it('respects the cooldown before adding an appointment-side story', () => {
    const c1 = contact('c1')
    const schedule: CharacterSchedule = {
      id: 's1', characterId: c1.id, dayOfWeek: 1, slot: 'morning', locationId: 'cafe', activity: '赴约',
      phoneAccess: 'available', priority: 'base', sourceEventIds: [], createdAt: 0,
    }
    const appointment: Appointment = {
      id: 'a1', participantIds: ['user', c1.id], day: 2, slot: 'morning', locationId: 'cafe',
      description: '一起喝咖啡', status: 'planned', sourceEventIds: [], createdAt: 0,
    }
    const input = { ...baseInput(2, 5), contacts: [c1], schedules: [schedule], appointments: [appointment] }
    input.recentEvents = [{
      id: 'recent', type: 'story', worldStep: 1, actorId: 'c1', participantIds: ['c1'], content: '小事',
      visibility: 'scene', directedEventKey: 'story:recent', createdAt: 0,
    }]
    expect(chooseDirectedEventCandidate(input)).toBeNull()
    input.step = 12
    expect(chooseDirectedEventCandidate(input)).toMatchObject({ key: 'appointment:a1', locationId: 'cafe' })
  })
})
