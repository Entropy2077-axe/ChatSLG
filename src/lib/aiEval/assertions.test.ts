import { describe, expect, it } from 'vitest'
import { assertGroupResult, assertStateResult, summarizeResults } from './assertions'
import { AI_EVAL_SCENARIOS } from './scenarios'
import type { AiEvalDatabaseState, AiEvalRunResult } from './types'

const groupScenario = AI_EVAL_SCENARIOS.find((item) => item.id === 'group-lively-four-open-topic')!

describe('AI eval assertions', () => {
  it('enforces lively count and distinct-speaker participation independently', () => {
    const assertions = assertGroupResult({
      scenario: groupScenario,
      bubbleCount: 7,
      speakerCounts: { a: 7 },
      illegalSpeakerIds: [],
      contactIds: { alice: 'a', bo: 'b', chen: 'c', dai: 'd' },
    })
    expect(assertions.find((item) => item.id === 'liveliness-count')).toMatchObject({ passed: true, blocking: true })
    expect(assertions.find((item) => item.id === 'multi-speaker-experience')).toMatchObject({ passed: false, blocking: true })
  })

  it('checks final database fields rather than only trusting receipts', () => {
    const scenario = AI_EVAL_SCENARIOS.find((item) => item.id === 'outfit-put-on-coat')!
    const state: AiEvalDatabaseState = {
      contactLocations: { a: 'home' },
      contactOutfits: { a: { outerwear: '无' } },
      outfitConstraints: [{ characterId: 'a', patch: { outerwear: '黑色外套' }, startDay: 1, endDay: 1 }],
      scheduleConstraints: [],
      appointments: [],
      messages: [],
      receipts: [{ kind: 'outfit', characterId: 'a', status: 'applied', reason: 'ok', recordIds: ['x'] }],
    }
    const assertions = assertStateResult({
      scenario,
      state,
      contactIds: { alice: 'a' },
      locationIds: { home: 'home', livingRoom: 'living', cafe: 'cafe', kitchen: 'kitchen' },
      worldDay: 1,
    })
    expect(assertions.find((item) => item.id === 'outfit-receipt')?.passed).toBe(true)
    expect(assertions.find((item) => item.id === 'outfit-patch-outerwear')?.passed).toBe(true)
  })

  it('does not report 100% false positives when no state scenarios ran', () => {
    const mock = {
      id: 'r', scenarioId: 'fault', category: 'fault_recovery', mode: 'mock', repetition: 1,
      status: 'passed', startedAt: '', durationMs: 0, assertions: [], failureType: 'parse_failure',
      rawOutputs: [], parsedOutputs: [], databaseState: { contactLocations: {}, contactOutfits: {}, outfitConstraints: [], scheduleConstraints: [], appointments: [], messages: [], receipts: [] },
      bubbleCount: 0, distinctSpeakerCount: 0, speakerCounts: {}, illegalSpeakerIds: [], parseFailure: true,
      retryCount: 0, repairAttempted: false, firstAttemptPassed: false, recovered: false, modelCalls: [], searchCalls: 0, searchQueries: [], notes: [],
    } satisfies AiEvalRunResult
    const summary = summarizeResults([mock])
    expect(summary.outfitFalsePositiveRate).toBe(0)
    expect(summary.scheduleFalsePositiveRate).toBe(0)
    expect(summary.locationFalsePositiveRate).toBe(0)
    expect(summary.replyFormatSuccessRate).toBe(0)
  })

  it('does not let classification-only mock checks inflate production pass rates', () => {
    const mock = {
      id: 'mock', scenarioId: 'fault-non-json', category: 'fault_recovery', mode: 'mock', repetition: 1,
      status: 'passed', startedAt: '', durationMs: 0, assertions: [], failureType: 'parse_failure',
      rawOutputs: [], parsedOutputs: [], databaseState: { contactLocations: {}, contactOutfits: {}, outfitConstraints: [], scheduleConstraints: [], appointments: [], messages: [], receipts: [] },
      bubbleCount: 0, distinctSpeakerCount: 0, speakerCounts: {}, illegalSpeakerIds: [], parseFailure: false,
      retryCount: 2, repairAttempted: false, firstAttemptPassed: false, recovered: false, modelCalls: [], searchCalls: 0, searchQueries: [], notes: [],
    } satisfies AiEvalRunResult
    const summary = summarizeResults([mock])
    expect(summary.completePassRate).toBe(0)
    expect(summary.classificationOnlyRuns).toBe(1)
    expect(summary.realRuns).toBe(0)
  })

  it('separates first-pass success from retry recovery', () => {
    const base: AiEvalRunResult = {
      id: 'base', scenarioId: 'private-quiet', category: 'private_reply', mode: 'real', repetition: 1,
      status: 'passed', startedAt: '', durationMs: 10, assertions: [], failureType: 'none',
      rawOutputs: [], parsedOutputs: [], databaseState: { contactLocations: {}, contactOutfits: {}, outfitConstraints: [], scheduleConstraints: [], appointments: [], messages: [], receipts: [] },
      bubbleCount: 1, distinctSpeakerCount: 1, speakerCounts: { a: 1 }, illegalSpeakerIds: [], parseFailure: false,
      retryCount: 0, repairAttempted: false, firstAttemptPassed: true, recovered: false,
      modelCalls: [], searchCalls: 0, searchQueries: [], notes: [],
    }
    const summary = summarizeResults([
      { ...base, id: 'first', firstAttemptPassed: true, repairAttempted: false, recovered: false },
      { ...base, id: 'recovered', firstAttemptPassed: false, repairAttempted: true, recovered: true, retryCount: 1 },
    ])
    expect(summary.realFirstAttemptPassRate).toBe(0.5)
    expect(summary.realCompletePassRate).toBe(1)
    expect(summary.repairRecoveryRate).toBe(1)
  })
})

describe('AI eval scenario schema', () => {
  it('gives every scenario the required reproducibility metadata', () => {
    expect(AI_EVAL_SCENARIOS.length).toBeGreaterThanOrEqual(30)
    for (const scenario of AI_EVAL_SCENARIOS) {
      expect(scenario.id).toBeTruthy()
      expect(scenario.description).toBeTruthy()
      expect(scenario.initialWorldState).toBeTruthy()
      expect(scenario.inputMessages.length).toBeGreaterThan(0)
      expect(scenario.expectedHardResults.length).toBeGreaterThan(0)
      expect(scenario.forbiddenResults.length).toBeGreaterThan(0)
      expect(scenario.repetitions).toBeGreaterThan(0)
      expect(scenario.timeoutMs).toBeGreaterThan(0)
      if (scenario.suite === 'acceptance') {
        expect(scenario.coverage).toBe('end_to_end')
        expect(scenario.kind).toBe('state_e2e')
        expect(scenario.evidence).toBeUndefined()
      }
    }
  })
})
