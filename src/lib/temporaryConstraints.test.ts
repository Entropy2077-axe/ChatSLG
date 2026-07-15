import { describe, expect, it } from 'vitest'
import { activeInRange, normalizedSlots, resolveCurrentOutfit, resolveScheduleConstraint, validRange } from './temporaryConstraints'
import type { Contact, OutfitConstraint, ScheduleConstraint } from '../types'

const contact = { id: 'a', name: 'A', avatar: '🙂', avatarColor: '#fff', systemPrompt: '', createdAt: 1, memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 1, memoryMessageCursor: 0, relationshipBase: '', relationshipDynamic: '', defaultOutfit: { head: '头发', top: 'T恤', bottom: '牛仔裤', outerwear: '无', footwear: '鞋', accessories: '无', updatedAt: 1, sourceEventIds: [] } } as Contact
const outfit = { id: 'o', characterId: 'a', startDay: 2, endDay: 3, slots: ['evening'], patch: { top: '睡衣' }, sourceEventIds: ['m'], reason: '同意', conversationId: 'c', createdAt: 2 } as OutfitConstraint
const schedule = { id: 's', characterId: 'a', startDay: 2, endDay: 8, locationId: 'home', activity: '在家', phoneAccess: 'available', priority: 'commitment', sourceEventIds: ['m'], reason: '同意', conversationId: 'c', createdAt: 2 } as ScheduleConstraint

describe('temporary chat constraints', () => {
  it('uses inclusive ranges and all slots when slots are omitted', () => {
    expect(activeInRange(schedule, 2, 'morning')).toBe(true)
    expect(activeInRange(schedule, 8, 'night')).toBe(true)
    expect(activeInRange(schedule, 9, 'morning')).toBe(false)
    expect(normalizedSlots(['morning', 'day', 'evening', 'night'])).toBeUndefined()
  })
  it('does not apply a future or wrong-slot outfit early, and restores default after expiry', () => {
    expect(resolveCurrentOutfit(contact, [outfit], 1, 'evening').top).toBe('T恤')
    expect(resolveCurrentOutfit(contact, [outfit], 2, 'day').top).toBe('T恤')
    expect(resolveCurrentOutfit(contact, [outfit], 2, 'evening').top).toBe('睡衣')
    expect(resolveCurrentOutfit(contact, [outfit], 4, 'evening').top).toBe('T恤')
  })
  it('honors commitment range and rejects invalid dates', () => {
    expect(resolveScheduleConstraint([schedule], 5, 'night')?.locationId).toBe('home')
    expect(validRange(2, 8, 2)).toBe(true)
    expect(validRange(8, 2, 2)).toBe(false)
    expect(validRange(1, 1, 2)).toBe(false)
  })
})
