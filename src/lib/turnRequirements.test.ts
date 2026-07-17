import { describe, expect, it } from 'vitest'
import { groupTurnRequirement, privateTurnRequirement, validateGroupTurn, validatePrivateTurn } from './turnRequirements'

describe('turn requirements', () => {
  it('uses the configured private ranges including exactly seven lively bubbles', () => {
    expect(privateTurnRequirement('quiet')).toMatchObject({ minBubbles: 1, maxBubbles: 2 })
    expect(privateTurnRequirement('normal')).toMatchObject({ minBubbles: 3, maxBubbles: 4 })
    expect(privateTurnRequirement('lively')).toMatchObject({ minBubbles: 7, maxBubbles: 7 })
    expect(validatePrivateTurn(6, privateTurnRequirement('lively')).valid).toBe(false)
    expect(validatePrivateTurn(7, privateTurnRequirement('lively')).valid).toBe(true)
  })

  it('enforces bounded group participation and required speakers', () => {
    const requirement = groupTurnRequirement('lively', ['a', 'b', 'c', 'd'], ['a'])
    expect(requirement.minimumDistinctSpeakers).toBe(3)
    expect(validateGroupTurn([
      { speakerIndex: 2, type: 'text', content: '1' },
      { speakerIndex: 2, type: 'text', content: '2' },
      { speakerIndex: 3, type: 'text', content: '3' },
      { speakerIndex: 3, type: 'text', content: '4' },
      { speakerIndex: 4, type: 'text', content: '5' },
      { speakerIndex: 4, type: 'text', content: '6' },
      { speakerIndex: 4, type: 'text', content: '7' },
    ], ['a', 'b', 'c', 'd'], requirement)).toMatchObject({ valid: false })
    expect(validateGroupTurn([
      { speakerIndex: 1, type: 'text', content: '1' },
      { speakerIndex: 1, type: 'text', content: '2' },
      { speakerIndex: 2, type: 'text', content: '3' },
      { speakerIndex: 2, type: 'text', content: '4' },
      { speakerIndex: 3, type: 'text', content: '5' },
      { speakerIndex: 3, type: 'text', content: '6' },
      { speakerIndex: 3, type: 'text', content: '7' },
    ], ['a', 'b', 'c', 'd'], requirement)).toMatchObject({ valid: true })
  })

  it('caps the distinct-speaker minimum at the available population', () => {
    expect(groupTurnRequirement('lively', ['a', 'b']).minimumDistinctSpeakers).toBe(2)
    expect(groupTurnRequirement('normal', ['a']).minimumDistinctSpeakers).toBe(1)
  })
})
