import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, CharacterSchedule } from '../types'

vi.mock('./deepseek', () => ({ chatCompletion: vi.fn() }))

import { chatCompletion } from './deepseek'
import { adjudicateScheduleDeviations, type ScheduleDeviationCandidate } from './scheduleDeviation'

const settings = { apiKey: 'test', baseUrl: '', utilityModel: 'utility' } as AppSettings

function candidate(adherence: CharacterSchedule['adherence'] = 'normal'): ScheduleDeviationCandidate {
  return {
    schedule: {
      id: 'schedule-1', characterId: 'c1', slot: 'day', locationId: 'office', activity: '上班',
      phoneAccess: 'unavailable', adherence, priority: 'base', sourceEventIds: [], createdAt: 0,
    },
    proposal: {
      characterId: 'c1', scheduleId: 'schedule-1', targetLocationId: 'home-bedroom', activity: '休息',
      reason: '当下发生的情况使原安排无法继续', evidenceIds: ['evidence-1'],
    },
    evidence: [{ id: 'evidence-1', kind: 'event', content: '一个已记录、与当前行动直接相关的特殊情况。' }],
  }
}

describe('semantic schedule-deviation gate', () => {
  beforeEach(() => vi.mocked(chatCompletion).mockReset())

  it('requires high-impact, high-confidence evidence for required schedules', async () => {
    vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify({ verdicts: [{
      characterId: 'c1', scheduleId: 'schedule-1', allow: true, impact: 'moderate', confidence: .99,
      evidenceIds: ['evidence-1'], scope: 'current_slot_only', explanation: '有影响但未达到硬安排门槛',
    }] }))
    const verdict = (await adjudicateScheduleDeviations([candidate('required')], settings)).get('c1')
    expect(verdict?.allow).toBe(false)
  })

  it('can accept an unforeseen situation without any keyword list when semantic impact is sufficient', async () => {
    vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify({ verdicts: [{
      characterId: 'c1', scheduleId: 'schedule-1', allow: true, impact: 'high', confidence: .97,
      evidenceIds: ['evidence-1'], scope: 'current_slot_only', explanation: '现有记录直接支持本时段无法继续原安排',
    }] }))
    const verdict = (await adjudicateScheduleDeviations([candidate('required')], settings)).get('c1')
    expect(verdict?.allow).toBe(true)
  })

  it('rejects invented evidence ids before calling the utility model', async () => {
    const input = candidate('optional')
    input.proposal.evidenceIds = ['not-in-context']
    const verdict = (await adjudicateScheduleDeviations([input], settings)).get('c1')
    expect(verdict?.allow).toBe(false)
    expect(chatCompletion).not.toHaveBeenCalled()
  })

  it('blocks repeated low or moderate deviations during cooldown', async () => {
    const input = candidate('normal')
    input.stepsSinceLastDeviation = 2
    vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify({ verdicts: [{
      characterId: 'c1', scheduleId: 'schedule-1', allow: true, impact: 'moderate', confidence: .93,
      evidenceIds: ['evidence-1'], scope: 'current_slot_only', explanation: '本次理由成立',
    }] }))
    const verdict = (await adjudicateScheduleDeviations([input], settings)).get('c1')
    expect(verdict?.allow).toBe(false)
    expect(verdict?.explanation).toContain('冷却')
  })
})
