import { describe, expect, it } from 'vitest'
import { parseStateAdjudication, recoverDeterministicStateMisses, validateStateAdjudication, type StateValidationContext } from './stateAdjudicator'

const context = (evidence: StateValidationContext['evidence']): StateValidationContext => ({
  characterIds: ['alice'],
  evidence,
  day: 4,
  validLocations: [{ id: 'living', name: '客厅' }, { id: 'cafe', name: '咖啡厅' }],
  recentText: '',
  pendingIntents: [],
})

const falseDimensions = {
  outfit: { shouldChange: false },
  schedule: { shouldChange: false },
  location: { shouldChange: false },
}

function parsedDecision(overrides: Record<string, unknown>) {
  const result = parseStateAdjudication(JSON.stringify({
    replyReview: { valid: true, reason: '' },
    decisions: [{ characterId: 'alice', evidenceIds: ['a1'], ...falseDimensions, ...overrides }],
    pendingIntents: [],
  }))
  expect(result.value).toBeTruthy()
  return result
}

describe('state adjudication parsing and deterministic validation', () => {
  it('reports non-json and missing state dimensions as structured issues', () => {
    expect(parseStateAdjudication('not-json').issues[0]).toMatchObject({ code: 'non_json', fatal: true })
    const result = parseStateAdjudication('{"replyReview":{"valid":true,"reason":""},"decisions":[{"characterId":"alice","evidenceIds":[]}],"pendingIntents":[]}')
    expect(result.issues.filter((issue) => issue.code === 'missing_dimension')).toHaveLength(3)
  })

  it('rejects a state change without the character own current-turn evidence', () => {
    const result = parsedDecision({ location: { shouldChange: true, locationId: 'living', reason: '去客厅' }, evidenceIds: ['u1'] })
    const issues = validateStateAdjudication(result.value!, context([
      { id: 'u1', actorId: 'user', actorName: '用户', content: '你们去客厅吧', perceivedBy: ['alice'] },
    ]))
    expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing_own_evidence', kind: 'location' })]))
  })

  it('rejects photo-only outfit evidence, explicit refusal, and invented legal destinations', () => {
    const photo = parsedDecision({ outfit: { shouldChange: true, timing: 'immediate', patch: { top: '白衬衫' }, reason: '照片里如此' } })
    expect(validateStateAdjudication(photo.value!, context([
      { id: 'a1', actorId: 'alice', actorName: '林夏', content: '这张旧照里我穿着白衬衫', perceivedBy: ['alice'] },
    ]))).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'image_only_outfit' })]))

    const refusal = parsedDecision({ schedule: { shouldChange: true, startDay: 5, endDay: 5, slots: ['evening'], locationId: 'cafe', activity: '喝咖啡', phoneAccess: 'available', priority: 'commitment', reason: '约定' } })
    expect(validateStateAdjudication(refusal.value!, context([
      { id: 'a1', actorId: 'alice', actorName: '林夏', content: '不了，我不去咖啡厅', perceivedBy: ['alice'] },
    ]))).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'explicit_refusal', kind: 'schedule' })]))

    const invented = parsedDecision({ schedule: { shouldChange: true, startDay: 5, endDay: 5, slots: ['evening'], locationId: 'cafe', activity: '见面', phoneAccess: 'available', priority: 'commitment', reason: '约定' } })
    expect(validateStateAdjudication(invented.value!, context([
      { id: 'a1', actorId: 'alice', actorName: '林夏', content: '好，明晚去月球基地', perceivedBy: ['alice'] },
    ]))).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ungrounded_location', kind: 'schedule' })]))
  })

  it('rejects tentative proposals as completed actions but permits an explicit immediate commitment', () => {
    const tentative = parsedDecision({ location: { shouldChange: true, locationId: 'living', reason: '去客厅' } })
    expect(validateStateAdjudication(tentative.value!, context([
      { id: 'a1', actorId: 'alice', actorName: '林夏', content: '要不我也去客厅坐坐', perceivedBy: ['alice'] },
    ]))).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'tentative_intent', kind: 'location' })]))

    const explicit = parsedDecision({ location: { shouldChange: true, locationId: 'living', reason: '现在去客厅' } })
    expect(validateStateAdjudication(explicit.value!, context([
      { id: 'a1', actorId: 'alice', actorName: '林夏', content: '要不现在就去客厅吧，我这就走', perceivedBy: ['alice'] },
    ]))).toEqual([])
  })

  it('requires an immediate anchor before committing a self-initiated location change', () => {
    const decision = parsedDecision({ location: { shouldChange: true, locationId: 'living', reason: '陪用户去客厅' } })
    expect(validateStateAdjudication(decision.value!, context([
      { id: 'u1', actorId: 'user', actorName: '用户', content: '有时候还挺想去客厅坐坐的', perceivedBy: ['alice'] },
      { id: 'a1', actorId: 'alice', actorName: '林夏', content: '我陪你一起去，顺便聊聊天', perceivedBy: ['alice'] },
    ]))).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'location_not_immediate', kind: 'location' })]))

    const accepted = parsedDecision({ location: { shouldChange: true, locationId: 'living', reason: '接受当前请求' } })
    expect(validateStateAdjudication(accepted.value!, context([
      { id: 'u1', actorId: 'user', actorName: '用户', content: '别在卧室待着了，走，去客厅坐会儿', perceivedBy: ['alice'] },
      { id: 'a1', actorId: 'alice', actorName: '林夏', content: '行，去客厅', perceivedBy: ['alice'] },
    ]))).toEqual([])
  })

  it('keeps an immediate location acceptance grounded when later bubbles cover other state dimensions', () => {
    const accepted = parsedDecision({
      evidenceIds: ['a1', 'a2'],
      location: { shouldChange: true, locationId: 'living', reason: '接受当前请求' },
    })
    expect(validateStateAdjudication(accepted.value!, context([
      { id: 'u1', actorId: 'user', actorName: '用户', content: '走，去客厅吧', perceivedBy: ['alice'] },
      { id: 'a1', actorId: 'alice', actorName: '林夏', content: '行啊，去客厅', perceivedBy: ['alice'] },
      { id: 'a2', actorId: 'alice', actorName: '林夏', content: '明晚咖啡厅见，我会戴蝴蝶结', perceivedBy: ['alice'] },
    ]))).toEqual([])
  })

  it('treats colloquial acceptance as starting the requested move without requiring a second completion sentence', () => {
    const accepted = parsedDecision({
      location: { shouldChange: true, locationId: 'living', reason: '接受当前请求' },
    })
    expect(validateStateAdjudication(accepted.value!, context([
      { id: 'u1', actorId: 'user', actorName: '用户', content: '走，先去客厅。', perceivedBy: ['alice'] },
      { id: 'a1', actorId: 'alice', actorName: '林夏', content: '好嘞，去客厅。', perceivedBy: ['alice'] },
    ]))).toEqual([])
  })

  it('recovers a model location miss only from an unambiguous current request and the character own acceptance', () => {
    const missed = parsedDecision({
      location: { shouldChange: false, locationId: 'living', reason: '模型要求后续执行句' },
    })
    const current = context([
      { id: 'u1', actorId: 'user', actorName: '用户', content: '走，先去客厅；明晚咖啡厅见。', perceivedBy: ['alice'] },
      { id: 'a1', actorId: 'alice', actorName: '林夏', content: '行行行，去客厅。', perceivedBy: ['alice'] },
    ])
    recoverDeterministicStateMisses(missed.value!, current)
    expect(missed.value?.decisions[0].location).toMatchObject({ shouldChange: true, locationId: 'living' })
    expect(missed.value?.decisions[0].evidenceIds).toContain('a1')

    const wish = parsedDecision({
      location: { shouldChange: false, locationId: 'living', reason: '只是愿望' },
    })
    const tentative = context([
      { id: 'u1', actorId: 'user', actorName: '用户', content: '有时候想去客厅。', perceivedBy: ['alice'] },
      { id: 'a1', actorId: 'alice', actorName: '林夏', content: '想去就去呗。', perceivedBy: ['alice'] },
    ])
    recoverDeterministicStateMisses(wish.value!, tentative)
    expect(wish.value?.decisions[0].location?.shouldChange).toBe(false)
  })

  it('anchors tomorrow evening and seven-day outfit constraints while preserving all three dimensions', () => {
    const valid = parsedDecision({
      outfit: { shouldChange: true, timing: 'future', patch: { accessories: '蝴蝶结' }, startDay: 4, endDay: 10, reason: '连续七天' },
      schedule: { shouldChange: true, startDay: 5, endDay: 5, slots: ['evening'], locationId: 'cafe', activity: '见面', phoneAccess: 'available', priority: 'commitment', participantIds: ['user', 'alice'], reason: '明晚约定' },
      location: { shouldChange: true, locationId: 'living', reason: '现在去客厅' },
    })
    expect(validateStateAdjudication(valid.value!, context([
      { id: 'a1', actorId: 'alice', actorName: '林夏', content: '好，现在去客厅；从今天起连续七天戴蝴蝶结，明晚咖啡厅见', perceivedBy: ['alice'] },
    ]))).toEqual([])

    const wrongDay = parsedDecision({
      schedule: { shouldChange: true, startDay: 4, endDay: 4, slots: ['evening'], locationId: 'cafe', activity: '见面', phoneAccess: 'available', priority: 'commitment', reason: '明晚约定' },
    })
    expect(validateStateAdjudication(wrongDay.value!, context([
      { id: 'a1', actorId: 'alice', actorName: '林夏', content: '好，明晚咖啡厅见', perceivedBy: ['alice'] },
    ]))).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'schedule_day_mismatch' })]))
  })
})
