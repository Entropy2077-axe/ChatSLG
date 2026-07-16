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
})
