import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import type { AppSettings } from '../types'
import { commitStateAdjudication, type StateAdjudicationInput, type StateAdjudicationResult, type StateDecision } from './stateAdjudicator'
import { ensureWorldInitialized } from './world'

const settings = { apiKey: 'test' } as AppSettings

async function resetWorld() {
  await db.open()
  for (const table of db.tables) await table.clear()
  const world = await ensureWorldInitialized()
  const base = { avatar: '🙂', avatarColor: '#eee', systemPrompt: 'test', createdAt: 1, memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 0, memoryMessageCursor: 0, relationshipBase: '朋友', relationshipDynamic: '' }
  await db.contacts.bulkAdd([{ ...base, id: 'a', name: 'A' }, { ...base, id: 'b', name: 'B' }])
  await db.conversations.bulkAdd([{ id: 'ca', contactId: 'a', pinned: false, createdAt: 1, updatedAt: 1 }, { id: 'cb', contactId: 'b', pinned: false, createdAt: 1, updatedAt: 1 }])
  return world
}

function decision(characterId: string, evidenceId: string, day: number, participants: string[]): StateDecision {
  return {
    characterId,
    evidenceIds: [evidenceId],
    schedule: { shouldChange: true, startDay: day, endDay: day, slots: ['evening'], locationId: 'mall-cafe', activity: '一起喝咖啡', phoneAccess: 'available', priority: 'commitment', participantIds: participants, reason: '角色本人明确同意' },
  }
}

function input(conversationId: string, characterId: string, evidenceId: string): StateAdjudicationInput {
  return { scene: 'private_phone', conversationId, characterIds: [characterId], settings, evidence: [{ id: evidenceId, actorId: characterId, actorName: characterId, content: '好，下午见', perceivedBy: [characterId] }] }
}

function result(worldVersion: number, day: number, value: StateDecision): StateAdjudicationResult {
  return { review: { valid: true, reason: '' }, decisions: [value], pendingIntents: [], worldVersion, day, receipts: [] }
}

beforeEach(async () => {
  await resetWorld()
})

describe('state application receipts and shared appointments', () => {
  it('returns a real schedule constraint id after one character agrees', async () => {
    const world = await db.worldState.get('global')
    const receipts = await commitStateAdjudication(input('ca', 'a', 'ea'), result(world!.worldVersion, world!.day, decision('a', 'ea', world!.day, ['user', 'a'])))
    const receipt = receipts.find((item) => item.kind === 'schedule')
    expect(receipt?.status).toBe('applied')
    expect(receipt?.recordIds).toHaveLength(1)
    expect(await db.scheduleConstraints.get(receipt!.recordIds[0])).toBeTruthy()
  })

  it('merges confirmations from separate private chats into one planned appointment', async () => {
    const world = await db.worldState.get('global')
    const participants = ['user', 'a', 'b']
    await commitStateAdjudication(input('ca', 'a', 'ea'), result(world!.worldVersion, world!.day, decision('a', 'ea', world!.day, participants)))
    const proposed = await db.appointments.toArray()
    expect(proposed).toHaveLength(1)
    expect(proposed[0].status).toBe('proposed')
    expect(proposed[0].acceptedParticipantIds).toEqual(['a'])

    await commitStateAdjudication(input('cb', 'b', 'eb'), result(world!.worldVersion, world!.day, decision('b', 'eb', world!.day, participants)))
    const planned = await db.appointments.toArray()
    expect(planned).toHaveLength(1)
    expect(planned[0].status).toBe('planned')
    expect(new Set(planned[0].acceptedParticipantIds)).toEqual(new Set(['a', 'b']))
    expect(new Set(planned[0].conversationIds)).toEqual(new Set(['ca', 'cb']))
  })

  it('rejects a silent listener while preserving another character valid independent dimension', async () => {
    const world = await db.worldState.get('global')
    const mixedInput: StateAdjudicationInput = {
      scene: 'scene',
      conversationId: 'ca',
      characterIds: ['a', 'b'],
      settings,
      evidence: [
        { id: 'ea', actorId: 'a', actorName: 'A', content: '好，我现在戴上蝴蝶结', perceivedBy: ['a', 'b'] },
        { id: 'eu', actorId: 'user', actorName: '用户', content: '你们都去客厅吧', perceivedBy: ['a', 'b'] },
      ],
    }
    const mixedResult: StateAdjudicationResult = {
      review: { valid: true, reason: '' },
      worldVersion: world!.worldVersion,
      day: world!.day,
      pendingIntents: [],
      receipts: [],
      decisions: [
        {
          characterId: 'a',
          evidenceIds: ['ea'],
          outfit: { shouldChange: true, timing: 'immediate', patch: { accessories: '蝴蝶结' }, reason: '本人明确执行' },
          schedule: { shouldChange: false },
          location: { shouldChange: false },
        },
        {
          characterId: 'b',
          evidenceIds: ['eu'],
          outfit: { shouldChange: false },
          schedule: { shouldChange: false },
          location: { shouldChange: true, locationId: 'home-living', reason: '用户提议' },
        },
      ],
    }
    const receipts = await commitStateAdjudication(mixedInput, mixedResult)
    expect(receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ characterId: 'a', kind: 'outfit', status: 'applied' }),
      expect.objectContaining({ characterId: 'b', kind: 'location', status: 'rejected' }),
    ]))
    expect(await db.outfitConstraints.where('characterId').equals('a').count()).toBe(1)
    expect((await db.contacts.get('b'))?.currentLocationId).toBeUndefined()
  })

  it('preserves a bounded duration when an outfit is put on immediately', async () => {
    const world = await db.worldState.get('global')
    const extended: StateDecision = {
      characterId: 'a',
      evidenceIds: ['ea'],
      outfit: {
        shouldChange: true,
        timing: 'immediate',
        patch: { accessories: '蝴蝶结' },
        startDay: world!.day,
        endDay: world!.day + 6,
        reason: '现在戴上并持续一周',
      },
      schedule: { shouldChange: false },
      location: { shouldChange: false },
    }
    const receipts = await commitStateAdjudication(
      { ...input('ca', 'a', 'ea'), evidence: [{ id: 'ea', actorId: 'a', actorName: 'A', content: '现在戴上，一周都戴着', perceivedBy: ['a'] }] },
      result(world!.worldVersion, world!.day, extended),
    )
    expect(receipts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'outfit', status: 'applied' })]))
    const constraint = await db.outfitConstraints.where('characterId').equals('a').first()
    expect(constraint).toMatchObject({ startDay: world!.day, endDay: world!.day + 6, patch: { accessories: '蝴蝶结' } })
    expect((await db.contacts.get('a'))?.outfit?.accessories).toBe('蝴蝶结')
  })
})
