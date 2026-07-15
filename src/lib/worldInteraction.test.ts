import { describe, expect, it } from 'vitest'
import { parseLocationChange } from './aiProtocol'
import { CHAT_LIVELINESS } from './chatLiveliness'
import { worldTimeIcon } from './worldTimeIcon'
import { parseGroupAiResponse } from './groupChat'

describe('world interaction helpers', () => {
  it('maps each world time slot to its app icon', () => {
    expect(worldTimeIcon('morning')).toBe('🌅')
    expect(worldTimeIcon('day')).toBe('☀️')
    expect(worldTimeIcon('evening')).toBe('🌆')
    expect(worldTimeIcon('night')).toBe('🌙')
  })

  it('keeps the configured reply-count ranges stable', () => {
    expect(CHAT_LIVELINESS.quiet).toMatchObject({ min: 1, max: 2 })
    expect(CHAT_LIVELINESS.normal).toMatchObject({ min: 3, max: 4 })
    expect(CHAT_LIVELINESS.lively).toMatchObject({ min: 5, max: 6 })
  })

  it('only accepts complete, source-grounded location changes', () => {
    expect(parseLocationChange({ characterId: 'c1', worldVersion: 2, locationId: 'park', sourceEventIds: ['event-1'], reason: '决定去散步' })).toMatchObject({ characterId: 'c1', locationId: 'park' })
    expect(parseLocationChange({ characterId: 'c1', worldVersion: 2, locationId: 'park', sourceEventIds: [], reason: '决定去散步' })).toBeUndefined()
  })

  it('parses only explicitly accepted group schedule constraints', () => {
    const parsed = parseGroupAiResponse(JSON.stringify({ messages: [{ speakerIndex: 1, type: 'text', content: '好，我这周都在家。' }], groupVibe: '平静', scheduleChanges: [{ characterId: 'c1', worldVersion: 2, startDay: 2, endDay: 8, slots: ['morning', 'day', 'evening', 'night'], locationId: 'home', activity: '在家', phoneAccess: 'available', priority: 'commitment', sourceEventIds: ['message-1'], reason: '明确同意', accepted: true }] }), 1)
    expect(parsed.scheduleChanges).toHaveLength(1)
    expect(parsed.scheduleChanges[0]).toMatchObject({ characterId: 'c1', startDay: 2, endDay: 8 })
    expect(parseGroupAiResponse(JSON.stringify({ messages: [{ speakerIndex: 1, type: 'text', content: '我考虑一下' }], groupVibe: '平静', scheduleChanges: [{ characterId: 'c1', worldVersion: 2, startDay: 2, endDay: 8, slots: ['day'], locationId: 'home', activity: '在家', phoneAccess: 'available', priority: 'commitment', sourceEventIds: ['message-1'], reason: '未同意', accepted: false }] }), 1).scheduleChanges).toHaveLength(0)
  })
})
