import { CHAT_LIVELINESS } from '../chatLiveliness'
import type { OutfitPart, StateApplicationReceipt } from '../../types'
import { AI_EVAL_SCENARIOS } from './scenarios'
import type {
  AiEvalAssertion,
  AiEvalDatabaseState,
  AiEvalFailureType,
  AiEvalRunResult,
  AiEvalScenario,
  AiEvalSummary,
} from './types'

const assertion = (
  id: string,
  label: string,
  passed: boolean,
  expected?: unknown,
  actual?: unknown,
  blocking = true,
): AiEvalAssertion => ({ id, label, passed, expected, actual, blocking })

function receiptStatus(receipts: StateApplicationReceipt[], kind: 'outfit' | 'schedule' | 'location', characterId: string) {
  return receipts.filter((item) => item.kind === kind && item.characterId === characterId).at(-1)?.status
}

function expectedReceiptMatches(
  expected: 'applied' | 'unchanged' | 'duplicate' | 'rejected' | 'no_write',
  actual: StateApplicationReceipt['status'] | undefined,
): boolean {
  if (expected === 'no_write') return actual === undefined || actual === 'duplicate'
  return expected === 'unchanged' ? actual === undefined : actual === expected
}

export function assertStateResult(opts: {
  scenario: AiEvalScenario
  state: AiEvalDatabaseState
  contactIds: Record<string, string>
  locationIds: Record<string, string>
  worldDay: number
}): AiEvalAssertion[] {
  if (opts.scenario.expectedStateByContact) {
    return Object.entries(opts.scenario.expectedStateByContact).flatMap(([key, expected]) =>
      assertStateResult({
        ...opts,
        scenario: { ...opts.scenario, expectedStateByContact: undefined, expectedState: expected },
        contactIds: { ...opts.contactIds, alice: opts.contactIds[key] },
      }).map((item) => ({ ...item, id: `${key}-${item.id}`, label: `${key}｜${item.label}` })),
    )
  }
  const expected = opts.scenario.expectedState
  if (!expected) return []
  const primaryId = opts.contactIds.alice
  const contactOutfit = opts.state.contactOutfits[primaryId] as Partial<Record<OutfitPart, string>> | undefined
  const assertions: AiEvalAssertion[] = []
  for (const kind of ['outfit', 'schedule', 'location'] as const) {
    const value = expected[kind]
    if (!value) continue
    const actual = receiptStatus(opts.state.receipts, kind, primaryId)
    assertions.push(assertion(
      `${kind}-receipt`,
      `${kind}状态结果`,
      expectedReceiptMatches(value, actual),
      value,
      actual ?? 'unchanged',
    ))
  }
  if (expected.outfitPatch) {
    for (const [part, value] of Object.entries(expected.outfitPatch)) {
      const constraints = opts.state.outfitConstraints as Array<{ characterId?: string; patch?: Record<string, string>; startDay?: number; endDay?: number }>
      const matching = constraints.find((item) => item.characterId === primaryId && item.patch?.[part] === value)
      const actualValue = matching?.patch?.[part] ?? contactOutfit?.[part as OutfitPart]
      assertions.push(assertion(`outfit-patch-${part}`, `衣着字段 ${part}`, actualValue === value, value, actualValue))
      if (expected.outfitStartDayOffset !== undefined) assertions.push(assertion('outfit-start-day', '衣着约束开始日', matching?.startDay === opts.worldDay + expected.outfitStartDayOffset, opts.worldDay + expected.outfitStartDayOffset, matching?.startDay))
      if (expected.outfitEndDayOffset !== undefined) assertions.push(assertion('outfit-end-day', '衣着约束结束日', matching?.endDay === opts.worldDay + expected.outfitEndDayOffset, opts.worldDay + expected.outfitEndDayOffset, matching?.endDay))
    }
  }
  if (expected.schedule === 'applied') {
    const schedules = opts.state.scheduleConstraints as Array<{ characterId?: string; locationId?: string; startDay?: number; endDay?: number; slots?: string[] }>
    const matching = schedules.find((item) => item.characterId === primaryId)
    if (expected.scheduleLocation) assertions.push(assertion('schedule-location', '日程地点', matching?.locationId === opts.locationIds[expected.scheduleLocation], opts.locationIds[expected.scheduleLocation], matching?.locationId))
    if (expected.scheduleDayOffset !== undefined) assertions.push(assertion('schedule-start-day', '日程开始日', matching?.startDay === opts.worldDay + expected.scheduleDayOffset, opts.worldDay + expected.scheduleDayOffset, matching?.startDay))
    if (expected.scheduleEndDayOffset !== undefined) assertions.push(assertion('schedule-end-day', '日程结束日', matching?.endDay === opts.worldDay + expected.scheduleEndDayOffset, opts.worldDay + expected.scheduleEndDayOffset, matching?.endDay))
    if (expected.scheduleSlots) assertions.push(assertion('schedule-slots', '日程时段', JSON.stringify(matching?.slots ?? []) === JSON.stringify(expected.scheduleSlots), expected.scheduleSlots, matching?.slots ?? []))
  }
  if (expected.locationTarget) {
    const actual = opts.state.contactLocations[primaryId]
    assertions.push(assertion('location-target', '当前位置', actual === opts.locationIds[expected.locationTarget], opts.locationIds[expected.locationTarget], actual))
  }
  return assertions
}

export function assertGroupResult(opts: {
  scenario: AiEvalScenario
  bubbleCount: number
  speakerCounts: Record<string, number>
  illegalSpeakerIds: string[]
  contactIds: Record<string, string>
}): AiEvalAssertion[] {
  const group = opts.scenario.group
  if (!group) return []
  const target = CHAT_LIVELINESS[group.energy === 'cold' ? 'quiet' : group.energy]
  const distinct = Object.keys(opts.speakerCounts).length
  const assertions = [
    assertion('has-reply', '产生回复', opts.bubbleCount > 0, '> 0', opts.bubbleCount),
    assertion('liveliness-count', `${target.label}气泡数量`, opts.bubbleCount >= target.min && opts.bubbleCount <= target.max, `${target.min}-${target.max}`, opts.bubbleCount),
    assertion('legal-speakers', '无非法发言者', opts.illegalSpeakerIds.length === 0, [], opts.illegalSpeakerIds),
  ]
  if (group.mention) {
    const mentionedId = opts.contactIds[group.mention]
    assertions.push(assertion('mentioned-speaker', '被@角色参与', (opts.speakerCounts[mentionedId] ?? 0) > 0, mentionedId, opts.speakerCounts))
  }
  if (group.minimumDistinctSpeakers !== undefined) {
    assertions.push(assertion('multi-speaker-experience', '多人参与', distinct >= group.minimumDistinctSpeakers, `>=${group.minimumDistinctSpeakers}`, distinct, true))
  }
  return assertions
}

export function assertPrivateResult(scenario: AiEvalScenario, messages: Array<{ content: string }>): AiEvalAssertion[] {
  const config = scenario.private
  if (!config) return []
  const normalized = messages.map((message) => message.content.trim()).filter(Boolean)
  const distinct = new Set(normalized).size
  const allQuestions = normalized.length > 0 && normalized.every((text) => /[?？]$/.test(text))
  const input = scenario.inputMessages.join('\n').trim()
  return [
    assertion('has-reply', '产生回复', normalized.length > 0, '>0', normalized.length),
    assertion('private-bubble-count', '私聊气泡数量', normalized.length >= config.minBubbles && normalized.length <= config.maxBubbles, `${config.minBubbles}-${config.maxBubbles}`, normalized.length),
    assertion('private-no-verbatim-echo', '没有完全复读用户输入', !normalized.includes(input), `不等于“${input}”`, normalized, false),
    assertion('private-no-exact-repeat', '气泡没有全部机械重复', normalized.length <= 1 || distinct > 1, '至少2种内容', distinct, false),
    assertion('private-not-all-questions', '不是每条都用问句追问', !allQuestions, false, allQuestions, false),
  ]
}

export function classifyFailure(error: unknown, assertions: AiEvalAssertion[], receipts: StateApplicationReceipt[] = []): AiEvalFailureType {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (/超时|timeout|timed out/i.test(message)) return 'timeout'
  if (/HTTP 429|HTTP 500|网络|fetch|request/i.test(message)) return 'request_failure'
  if (/JSON|解析|字段|Unexpected token/i.test(message)) return 'parse_failure'
  if (/事务|transaction|提交失败|commit/i.test(message) || receipts.some((item) => item.status === 'failed')) return 'database_commit_failure'
  if (receipts.some((item) => item.status === 'rejected')) return 'validation_rejected'
  if (assertions.some((item) => item.blocking && !item.passed)) return 'model_missed'
  return message ? 'tool_failure' : 'none'
}

const rate = (numerator: number, denominator: number) => denominator ? numerator / denominator : 0
const percentile = (values: number[], p: number) => {
  if (!values.length) return 0
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * p) - 1)]
}

function categoryMetric(results: AiEvalRunResult[], category: AiEvalScenario['category'], positive: boolean, kind: 'outfit' | 'schedule' | 'location') {
  const relevant = results.filter((result) => result.category === category && result.assertions.some((item) => item.id === `${kind}-receipt` && (positive ? item.expected === 'applied' : item.expected === 'unchanged')))
  if (!relevant.length) return positive ? 0 : 1
  return rate(relevant.filter((result) => result.assertions.find((item) => item.id === `${kind}-receipt`)?.passed).length, relevant.length)
}

export function summarizeResults(results: AiEvalRunResult[]): AiEvalSummary {
  const real = results.filter((item) => item.mode === 'real' && item.status !== 'blocked')
  const executed = results.filter((item) => item.status !== 'blocked')
  const scenarioById = new Map(AI_EVAL_SCENARIOS.map((scenario) => [scenario.id, scenario]))
  const coverage = (result: AiEvalRunResult) => {
    const scenario = scenarioById.get(result.scenarioId)
    if (scenario?.coverage) return scenario.coverage
    if (scenario?.kind === 'state') return 'adjudicator_only'
    if (scenario?.kind === 'fault') return 'classification_only'
    return 'end_to_end'
  }
  const suite = (result: AiEvalRunResult) => scenarioById.get(result.scenarioId)?.suite ?? 'development'
  const endToEnd = real.filter((item) => coverage(item) === 'end_to_end')
  const adjudicatorOnly = real.filter((item) => coverage(item) === 'adjudicator_only')
  const acceptance = real.filter((item) => suite(item) === 'acceptance')
  const development = real.filter((item) => suite(item) === 'development')
  const repairAttempted = real.filter((item) => item.repairAttempted)
  const faultInjection = results.filter((item) => coverage(item) === 'fault_injection')
  const byCategory: AiEvalSummary['byCategory'] = {}
  for (const result of results) {
    const row = byCategory[result.category] ?? { runs: 0, passed: 0, rate: 0 }
    row.runs += 1
    if (result.status === 'passed') row.passed += 1
    row.rate = rate(row.passed, row.runs)
    byCategory[result.category] = row
  }
  const group = results.filter((item) => item.category === 'group_liveliness')
  const multiSpeakerEligible = group.filter((item) => {
    const expected = item.assertions.find((assertion) => assertion.id === 'multi-speaker-experience')?.expected
    return typeof expected === 'string' && Number(expected.replace('>=', '')) >= 2
  })
  const multi = results.filter((item) => item.category === 'multi_state')
  const failuresByType: Record<string, number> = {}
  for (const result of results) if (result.status !== 'passed' && result.failureType !== 'none') failuresByType[result.failureType] = (failuresByType[result.failureType] ?? 0) + 1
  const durations = real.map((item) => item.durationMs)
  return {
    totalRuns: results.length,
    executedRuns: executed.length,
    blockedRuns: results.filter((item) => item.status === 'blocked').length,
    realRuns: real.length,
    realPassedRuns: real.filter((item) => item.status === 'passed').length,
    realCompletePassRate: rate(real.filter((item) => item.status === 'passed').length, real.length),
    realFirstAttemptPassRate: rate(real.filter((item) => item.firstAttemptPassed).length, real.length),
    repairAttemptRate: rate(repairAttempted.length, real.length),
    repairRecoveryRate: rate(repairAttempted.filter((item) => item.recovered).length, repairAttempted.length),
    endToEndPassRate: rate(endToEnd.filter((item) => item.status === 'passed').length, endToEnd.length),
    adjudicatorOnlyPassRate: rate(adjudicatorOnly.filter((item) => item.status === 'passed').length, adjudicatorOnly.length),
    acceptancePassRate: rate(acceptance.filter((item) => item.status === 'passed').length, acceptance.length),
    developmentPassRate: rate(development.filter((item) => item.status === 'passed').length, development.length),
    classificationOnlyRuns: results.filter((item) => coverage(item) === 'classification_only').length,
    faultInjectionPassRate: rate(faultInjection.filter((item) => item.status === 'passed').length, faultInjection.length),
    mockRuns: results.filter((item) => item.mode === 'mock').length,
    passedRuns: results.filter((item) => item.status === 'passed').length,
    completePassRate: rate(real.filter((item) => item.status === 'passed').length, real.length),
    replyFormatSuccessRate: rate(real.filter((item) => !item.parseFailure).length, real.length),
    livelinessTargetRate: rate(group.filter((item) => item.assertions.find((assertion) => assertion.id === 'liveliness-count')?.passed).length, group.length),
    multiSpeakerRate: rate(multiSpeakerEligible.filter((item) => item.assertions.find((assertion) => assertion.id === 'multi-speaker-experience')?.passed).length, multiSpeakerEligible.length),
    outfitRecallRate: categoryMetric(results, 'outfit', true, 'outfit'),
    outfitFalsePositiveRate: 1 - categoryMetric(results, 'outfit', false, 'outfit'),
    scheduleRecallRate: categoryMetric(results, 'schedule', true, 'schedule'),
    scheduleFalsePositiveRate: 1 - categoryMetric(results, 'schedule', false, 'schedule'),
    locationRecallRate: categoryMetric(results, 'location', true, 'location'),
    locationFalsePositiveRate: 1 - categoryMetric(results, 'location', false, 'location'),
    multiStateCommitRate: rate(multi.filter((item) => item.status === 'passed').length, multi.length),
    databaseCommitRate: rate(real.filter((item) => !item.databaseState.receipts.some((receipt) => receipt.status === 'failed')).length, real.length),
    averageDurationMs: rate(durations.reduce((sum, value) => sum + value, 0), durations.length),
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    averageModelCalls: rate(results.reduce((sum, item) => sum + item.modelCalls.length, 0), results.length),
    failuresByType,
    byCategory,
  }
}
