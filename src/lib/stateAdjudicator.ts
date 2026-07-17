import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type { AdminAiTraceStage, AppSettings, OutfitPart, PendingStateIntent, StateApplicationReceipt, TimeSlot } from '../types'
import { chatCompletion, type ChatMessage } from './deepseek'
import { extractJsonObject } from './aiProtocol'
import { buildLogicContext, type LogicContextBundle } from './logicContext'
import { addOutfitConstraint, addScheduleConstraint, normalizedSlots } from './temporaryConstraints'
import { isLeafLocation } from './world'
import { recentConversationMessages } from './conversationStats'
import { outfitText } from './outfit'

export type StateScene = 'private_phone' | 'group_phone' | 'moment' | 'scene'

export interface StateEvidence {
  id: string
  actorId: string
  actorName: string
  content: string
  perceivedBy: string[]
}

export interface StateAdjudicationInput {
  scene: StateScene
  conversationId: string
  characterIds: string[]
  evidence: StateEvidence[]
  settings: AppSettings
  /** Used by the isolated regression runner; normal production callers may omit it. */
  signal?: AbortSignal
  trace?: { turnId: string; stage: AdminAiTraceStage; conversationId?: string }
  /** Present for chat turns. The utility model reviews objective continuity
   * and hard-fact consistency while it is already adjudicating state. */
  replyReview?: {
    draftText: string
    personaFacts: string
  }
  /** false stages the verdict without mutating authoritative state. */
  apply?: boolean
}

export interface StateDecision {
  characterId: string
  evidenceIds: string[]
  outfit?: { shouldChange?: boolean; timing?: 'immediate' | 'future'; patch?: Partial<Record<OutfitPart, string | null>>; startDay?: number; endDay?: number; slots?: TimeSlot[]; reason?: string }
  schedule?: { shouldChange?: boolean; startDay?: number; endDay?: number; slots?: TimeSlot[]; locationId?: string; activity?: string; phoneAccess?: 'available' | 'unavailable'; priority?: 'override' | 'commitment'; participantIds?: string[]; reason?: string }
  location?: { shouldChange?: boolean; locationId?: string; reason?: string }
}

export interface StateAdjudicationResult {
  review: { valid: boolean; reason: string }
  decisions: StateDecision[]
  pendingIntents: PendingStateIntent[]
  worldVersion: number
  day: number
  receipts: StateApplicationReceipt[]
}

export interface StateValidationIssue {
  code: string
  message: string
  characterId?: string
  kind?: 'outfit' | 'schedule' | 'location'
  fatal?: boolean
}

interface ParsedStateAdjudication {
  review: { valid: boolean; reason: string }
  decisions: StateDecision[]
  pendingIntents: PendingStateIntent[]
}

export interface StateAdjudicationParseResult {
  value?: ParsedStateAdjudication
  issues: StateValidationIssue[]
}

const OUTFIT_PARTS: OutfitPart[] = ['head', 'top', 'bottom', 'outerwear', 'footwear', 'accessories']
const SLOTS: TimeSlot[] = ['morning', 'day', 'evening', 'night']
// The configured utility model has an 8K-token window. Reserve roughly 1.5K
// for JSON output and a healthy tokenizer-error margin. This estimator is
// deliberately conservative for CJK text; optional whole turns are removed
// before required evidence is ever touched.
const UTILITY_INPUT_TOKEN_BUDGET = 5_800
const RECENT_TURN_TOKEN_BUDGET = 1_300

function estimateTokens(text: string): number {
  let ascii = 0, nonAscii = 0
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / 3.2 + nonAscii * 1.15)
}

function compactStateContext(bundles: LogicContextBundle[], queryText: string): string {
  const first = bundles[0]
  const parentIds = new Set(first.locations.map((location) => location.parentId).filter(Boolean))
  const requiredLocationIds = new Set([
    first.playerLocationId,
    ...bundles.map((bundle) => bundle.subject.currentLocationId),
    ...bundles.flatMap((bundle) => [...bundle.subject.baseSchedule, ...bundle.subject.scheduleOverrides].map((schedule) => schedule.locationId)),
    ...bundles.flatMap((bundle) => bundle.subject.commitments.map((appointment) => appointment.locationId)),
  ])
  const leafLocations = first.locations.filter((location) => !parentIds.has(location.id))
  const prioritized = [...leafLocations].sort((a, b) => Number(requiredLocationIds.has(b.id) || queryText.includes(b.name) || queryText.includes(b.id)) - Number(requiredLocationIds.has(a.id) || queryText.includes(a.name) || queryText.includes(a.id)))
  const locationLines: string[] = []
  let locationTokens = 0
  for (const location of prioritized) {
    const line = `${location.id}=${location.name}`
    const lineTokens = estimateTokens(line)
    if (locationTokens + lineTokens > 700 && !requiredLocationIds.has(location.id)) continue
    locationLines.push(line)
    locationTokens += lineTokens
  }
  const characterText = bundles.map((bundle) => {
    const state = bundle.subject
    const scheduleLine = (schedule: typeof state.baseSchedule[number]) => `${schedule.priority}:${schedule.effectiveDay !== undefined ? `world-day-${schedule.effectiveDay}` : schedule.dayOfWeek !== undefined ? `world-cycle-day-${schedule.dayOfWeek + 1}` : 'every-world-day'}/${schedule.slot}@${schedule.locationId} ${schedule.activity} phone=${schedule.phoneAccess}`
    return `characterId=${state.character.id}; name=${state.character.name}; location=${state.currentLocationId}
outfit=${outfitText(state.character.outfit)}
base=${state.baseSchedule.filter((item) => item.slot === first.clock.slot).slice(0, 2).map(scheduleLine).join(' | ') || 'none'}
overrides=${state.scheduleOverrides.filter((item) => item.effectiveDay === first.clock.day || item.effectiveDay === first.clock.day + 1).slice(0, 4).map(scheduleLine).join(' | ') || 'none'}
appointments=${state.commitments.filter((item) => item.day <= first.clock.day + 1).slice(0, 4).map((item) => `${item.id}:day${item.day}/${item.slot}@${item.locationId} ${item.description}`).join(' | ') || 'none'}`
  }).join('\n\n')
  return `worldVersion=${first.worldVersion}; day=${first.clock.day}; slot=${first.clock.slot}; hour=${first.clock.hour}; playerLocation=${first.playerLocationId}
合法叶子地点ID（共享一次）：${locationLines.join('；') || '无'}
衣着字段：head头部主体；top上装；bottom下装；outerwear外套；footwear鞋袜；accessories蝴蝶结/发箍/发卡/首饰/围巾/领带/手表/眼镜

${characterText}`
}

export function parseStateAdjudication(raw: string): StateAdjudicationParseResult {
  const json = extractJsonObject(raw)
  if (!json) return { issues: [{ code: 'non_json', message: '状态模型没有返回可解析JSON', fatal: true }] }
  try {
    const parsed = JSON.parse(json) as { replyReview?: { valid?: unknown; reason?: unknown }; decisions?: unknown; pendingIntents?: unknown }
    const issues: StateValidationIssue[] = []
    if (!parsed.replyReview || typeof parsed.replyReview.valid !== 'boolean' || typeof parsed.replyReview.reason !== 'string') {
      issues.push({ code: 'missing_reply_review', message: 'replyReview.valid/reason缺失或类型错误', fatal: true })
    }
    if (!Array.isArray(parsed.decisions)) issues.push({ code: 'missing_decisions', message: 'decisions必须是数组', fatal: true })
    const decisions = (Array.isArray(parsed.decisions) ? parsed.decisions : []).flatMap((item) => {
      if (!item || typeof item !== 'object') {
        issues.push({ code: 'invalid_decision', message: 'decision不是对象', fatal: true })
        return []
      }
      const value = item as StateDecision & { sourceEventIds?: string[]; outfitChange?: StateDecision['outfit']; scheduleChange?: StateDecision['schedule']; locationChange?: StateDecision['location'] }
      if (typeof value.characterId !== 'string' || !value.characterId.trim()) {
        issues.push({ code: 'missing_character', message: 'decision缺少characterId', fatal: true })
        return []
      }
      const normalized = {
        ...value,
        evidenceIds: Array.isArray(value.evidenceIds) ? value.evidenceIds : Array.isArray(value.sourceEventIds) ? value.sourceEventIds : [],
        outfit: value.outfit ?? value.outfitChange,
        schedule: value.schedule ?? value.scheduleChange,
        location: value.location ?? value.locationChange,
      }
      for (const kind of ['outfit', 'schedule', 'location'] as const) {
        if (!normalized[kind] || typeof normalized[kind]?.shouldChange !== 'boolean') {
          issues.push({ code: 'missing_dimension', message: `${value.characterId}.${kind}.shouldChange缺失`, characterId: value.characterId, kind })
        }
      }
      return [normalized]
    })
    const pendingIntents = (Array.isArray(parsed.pendingIntents) ? parsed.pendingIntents : []).flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const value = item as Partial<PendingStateIntent>
      if (typeof value.characterId !== 'string' || !['outfit', 'schedule', 'location'].includes(String(value.kind)) || typeof value.summary !== 'string') return []
      return [{
        id: typeof value.id === 'string' && value.id ? value.id : uuid(),
        characterId: value.characterId,
        kind: value.kind!, summary: value.summary.trim().slice(0, 180),
        sourceEventIds: Array.isArray(value.sourceEventIds) ? value.sourceEventIds.filter((id): id is string => typeof id === 'string') : [],
        locationId: typeof value.locationId === 'string' ? value.locationId : undefined,
        outfitPatch: value.outfitPatch,
        startDay: Number.isInteger(value.startDay) ? value.startDay : undefined,
        endDay: Number.isInteger(value.endDay) ? value.endDay : undefined,
        slots: value.slots?.filter((slot): slot is TimeSlot => SLOTS.includes(slot)),
        createdAt: Date.now(),
      }]
    })
    return {
      value: {
        review: {
        valid: parsed.replyReview?.valid !== false,
        reason: typeof parsed.replyReview?.reason === 'string' ? parsed.replyReview.reason.trim().slice(0, 240) : '',
        },
        decisions,
        pendingIntents,
      },
      issues,
    }
  } catch {
    return { issues: [{ code: 'invalid_json', message: '状态模型返回的JSON格式无效', fatal: true }] }
  }
}

export interface StateValidationContext {
  characterIds: string[]
  evidence: StateEvidence[]
  day: number
  validLocations: Array<{ id: string; name: string }>
  recentText: string
  pendingIntents: PendingStateIntent[]
}

function containsExplicitRefusal(text: string, kind: 'outfit' | 'schedule' | 'location'): boolean {
  const generic = /(?:^|[，。！？,.!?\s])(?:不行|不了|不要|拒绝|算了|没空|no|nope|can't|cannot|won't|will not)(?:$|[，。！？,.!?\s])/i
  if (generic.test(text)) return true
  if (kind === 'outfit') return /不(?:穿|戴|换)|别让我(?:穿|戴|换)/.test(text)
  return /不(?:去|走|出发)|别(?:去|走|出发)/.test(text)
}

function containsTentativeIntent(text: string, kind: 'outfit' | 'schedule' | 'location'): boolean {
  const tentative = /要不|不如|要不要|也许|可能|或许|有时候|有时|改天|回头|以后再说|再看看|考虑(?:一下)?|(?:^|[，。！？,.!?\s])想(?:去|走|穿|戴|换)|\b(?:maybe|perhaps|might|could|what if|should we|someday)\b/i
  if (!tentative.test(text)) return false
  const explicitNow = kind === 'outfit'
    ? /现在(?:就)?(?:穿|戴|换)|这就(?:穿|戴|换)|马上(?:穿|戴|换)|已经(?:穿|戴|换)|(?:穿|戴|换)(?:上|好|完|了)/.test(text)
    : /现在(?:就)?(?:去|走|出发)|这就(?:去|走|出发)|马上(?:去|走|出发)|已经(?:到|去|出发)|正在(?:去|走|前往)|(?:走|出发)(?:吧|了)|我(?:现在)?去(?:了|啦)/.test(text)
  return !explicitNow
}

function hasImmediateLocationCommitment(characterId: string, ownTurnText: string, evidence: StateEvidence[]): boolean {
  if (/现在(?:就)?(?:去|走|出发)|这就(?:去|走|出发)|马上(?:去|走|出发)|已经(?:到|去|出发)|正在(?:去|走|前往)|走{2,}|(?:走|出发)(?:吧|了)|我(?:现在)?去(?:了|啦)/.test(ownTurnText)) return true
  const userText = evidence.filter((event) => event.actorId === 'user' && event.perceivedBy.includes(characterId)).map((event) => event.content).join('\n')
  if (/有时候|有时|也许|可能|或许|想(?:去|走)|改天|回头|以后|明天|明晚|今晚|稍后|等会|待会|\b(?:maybe|perhaps|might|someday|tomorrow|later)\b/i.test(userText)) return false
  const currentRequest = /现在|这就|马上|走[,，！!]?|别.{0,12}(?:待|留).{0,8}(?:去|走)|(?:去|走).{0,12}(?:吧|呗)|\bgo now\b/i.test(userText)
  const accepted = /(?:^|[，。！？,.!?\s])(?:(?:好|行|可以|成)(?:啊|呀|的|吧)?|没问题|走吧|去吧)(?:$|[，。！？,.!?\s])|我(?:也)?(?:陪你)?去/.test(ownTurnText)
  return currentRequest && accepted && !containsTentativeIntent(ownTurnText, 'location')
}

function imageOnlyOutfitEvidence(text: string): boolean {
  const imageContext = /照片|图片|自拍|旧照|相册|画面|回忆(?:里|中)|photo|picture|selfie|album/i
  const realAction = /(?:现在|刚刚|已经|这就|马上)?\s*(?:穿上|换上|脱掉|摘下|戴上|换掉)|(?:put on|take off|changed into|wearing now)/i
  return imageContext.test(text) && !realAction.test(text)
}

function chineseNumber(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value)
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  return digits[value]
}

function temporalExpectation(text: string, day: number): { day?: number; slot?: TimeSlot; durationDays?: number } {
  const result: { day?: number; slot?: TimeSlot; durationDays?: number } = {}
  if (/后天/.test(text)) result.day = day + 2
  else if (/明晚|明天|tomorrow/i.test(text)) result.day = day + 1
  else if (/今晚|今天|today|tonight/i.test(text)) result.day = day
  if (/明晚|今晚|tomorrow evening|tonight/i.test(text)) result.slot = 'evening'
  const duration = text.match(/连续\s*([一二两三四五六七八九十\d]+)\s*天/)
  if (duration) result.durationDays = chineseNumber(duration[1])
  return result
}

function normalizeLocationMention(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '').replace(/咖啡(?:店|厅)/g, '咖啡')
}

function dimensionChanges(decision: StateDecision, kind: 'outfit' | 'schedule' | 'location'): boolean {
  return decision[kind]?.shouldChange === true
}

export function validateStateAdjudication(value: ParsedStateAdjudication, context: StateValidationContext): StateValidationIssue[] {
  const issues: StateValidationIssue[] = []
  const expectedIds = new Set(context.characterIds)
  const seen = new Set<string>()
  if (!value.review.valid) {
    if (value.decisions.some((decision) => ['outfit', 'schedule', 'location'].some((kind) => dimensionChanges(decision, kind as 'outfit' | 'schedule' | 'location')))) {
      issues.push({ code: 'review_with_changes', message: 'replyReview无效时不得提交状态变化', fatal: true })
    }
    return issues
  }
  for (const decision of value.decisions) {
    if (!expectedIds.has(decision.characterId)) {
      issues.push({ code: 'wrong_character', message: `角色${decision.characterId}不在本轮候选名单`, characterId: decision.characterId })
      continue
    }
    if (seen.has(decision.characterId)) issues.push({ code: 'duplicate_character', message: `角色${decision.characterId}出现重复decision`, characterId: decision.characterId })
    seen.add(decision.characterId)
  }
  for (const characterId of expectedIds) if (!seen.has(characterId)) {
    issues.push({ code: 'missing_character', message: `缺少角色${characterId}的独立decision`, characterId })
  }

  const validLocationIds = new Set(context.validLocations.map((location) => location.id))
  const groundingText = `${context.evidence.map((event) => event.content).join('\n')}\n${context.recentText}\n${JSON.stringify(context.pendingIntents)}`
  const timeText = context.evidence.map((event) => event.content).join('\n')
  const expectedTime = temporalExpectation(timeText, context.day)

  for (const decision of value.decisions) {
    if (!expectedIds.has(decision.characterId)) continue
    const referenced = context.evidence.filter((event) => decision.evidenceIds.includes(event.id))
    const ownEvidence = referenced.filter((event) => event.actorId === decision.characterId)
    const latestOwnText = context.evidence.filter((event) => event.actorId === decision.characterId).at(-1)?.content ?? ''
    const ownTurnText = context.evidence.filter((event) => event.actorId === decision.characterId).map((event) => event.content).join('\n')
    for (const kind of ['outfit', 'schedule', 'location'] as const) {
      if (!dimensionChanges(decision, kind)) continue
      const issue = (code: string, message: string) => issues.push({ code, message, characterId: decision.characterId, kind })
      if (ownEvidence.length === 0) {
        issue('missing_own_evidence', `${decision.characterId}.${kind}没有引用该角色本人本轮发言`)
        continue
      }
      if (containsExplicitRefusal(latestOwnText, kind)) issue('explicit_refusal', `${decision.characterId}.${kind}与角色最新明确拒绝相冲突`)
      if (containsTentativeIntent(latestOwnText, kind)) issue('tentative_intent', `${decision.characterId}.${kind}只有试探、愿望或建议，没有明确执行`)
      if (kind === 'location' && !hasImmediateLocationCommitment(decision.characterId, ownTurnText, context.evidence)) {
        issue('location_not_immediate', `${decision.characterId}.location没有“现在执行”或对当前行动请求的明确承接`)
      }
      if (kind === 'outfit') {
        if (ownEvidence.every((event) => imageOnlyOutfitEvidence(event.content))) issue('image_only_outfit', `${decision.characterId}.outfit只有照片或回忆画面证据`)
        if (decision.outfit?.timing === 'future' && expectedTime.durationDays) {
          const expectedEnd = context.day + expectedTime.durationDays - 1
          if (decision.outfit.startDay !== context.day || decision.outfit.endDay !== expectedEnd) {
            issue('outfit_date_mismatch', `${decision.characterId}.outfit连续${expectedTime.durationDays}天应为第${context.day}天至第${expectedEnd}天`)
          }
        }
      } else {
        const locationId = decision[kind]?.locationId
        if (!locationId || !validLocationIds.has(locationId)) issue('invalid_location', `${decision.characterId}.${kind}引用了非法地点ID`)
        else {
          const location = context.validLocations.find((candidate) => candidate.id === locationId)!
          const normalizedGrounding = normalizeLocationMention(groundingText)
          if (!groundingText.includes(location.id) && !normalizedGrounding.includes(normalizeLocationMention(location.name))) {
            issue('ungrounded_location', `${decision.characterId}.${kind}的目标地点${location.name}没有出现在本轮证据或待确认提案中`)
          }
        }
        if (kind === 'schedule') {
          if (expectedTime.day !== undefined && decision.schedule?.startDay !== expectedTime.day) {
            issue('schedule_day_mismatch', `${decision.characterId}.schedule应从世界第${expectedTime.day}天开始`)
          }
          if (expectedTime.slot && !decision.schedule?.slots?.includes(expectedTime.slot)) {
            issue('schedule_slot_mismatch', `${decision.characterId}.schedule应包含${expectedTime.slot}时段`)
          }
        }
      }
    }
  }
  return issues
}

function sanitizeStateDecisions(
  value: ParsedStateAdjudication | undefined,
  issues: StateValidationIssue[],
  characterIds: string[],
): StateDecision[] {
  if (!value || issues.some((issue) => issue.fatal)) return []
  const invalid = new Set(issues.flatMap((issue) => issue.characterId && issue.kind ? [`${issue.characterId}:${issue.kind}`] : []))
  const seen = new Set<string>()
  return value.decisions
    .filter((decision) => {
      if (!characterIds.includes(decision.characterId) || seen.has(decision.characterId)) return false
      seen.add(decision.characterId)
      return true
    })
    .map((decision) => ({
      ...decision,
      outfit: invalid.has(`${decision.characterId}:outfit`) ? { shouldChange: false } : decision.outfit,
      schedule: invalid.has(`${decision.characterId}:schedule`) ? { shouldChange: false } : decision.schedule,
      location: invalid.has(`${decision.characterId}:location`) ? { shouldChange: false } : decision.location,
    }))
}

function samePatch(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

function canonicalizeOutfitValue(value: string): string {
  const colors = '黑白红蓝绿黄灰紫粉棕橙'
  return value.replace(new RegExp(`^([${colors}])(?![色${colors}])`), '$1色')
}

async function markEvidenceConsumed(evidenceIds: string[], kind: 'outfit' | 'schedule' | 'location'): Promise<void> {
  const messages = (await db.messages.bulkGet(evidenceIds)).filter((message): message is NonNullable<typeof message> => !!message)
  for (const message of messages) {
    const consumedStateKinds = [...new Set([...(message.consumedStateKinds ?? []), kind])]
    await db.messages.update(message.id, { consumedStateKinds, stateConsumedAt: Date.now() })
  }
}

async function applyDecision(input: StateAdjudicationInput, decision: StateDecision, worldVersion: number, day: number): Promise<StateApplicationReceipt[]> {
  const receipts: StateApplicationReceipt[] = []
  const receipt = (kind: StateApplicationReceipt['kind'], status: StateApplicationReceipt['status'], reason: string, recordIds: string[] = []) => receipts.push({ kind, characterId: decision.characterId, status, reason, recordIds })
  if (!input.characterIds.includes(decision.characterId)) { receipt('schedule', 'rejected', '角色不在本轮可裁决名单中'); return receipts }
  const contact = await db.contacts.get(decision.characterId)
  if (!contact) { receipt('schedule', 'rejected', '联系人不存在'); return receipts }
  const allowedEvidence = new Set(input.evidence.filter((event) => event.perceivedBy.includes(contact.id) || event.actorId === contact.id).map((event) => event.id))
  const evidenceIds = [...new Set((decision.evidenceIds ?? []).filter((id) => allowedEvidence.has(id)))]
  if (evidenceIds.length === 0) {
    for (const kind of ['outfit', 'schedule', 'location'] as const) if (decision[kind]?.shouldChange) receipt(kind, 'rejected', '没有引用本轮中该角色真实感知的证据ID')
    return receipts
  }
  const ownEvidence = new Set(input.evidence.filter((event) => event.actorId === contact.id).map((event) => event.id))
  if (!evidenceIds.some((id) => ownEvidence.has(id))) {
    for (const kind of ['outfit', 'schedule', 'location'] as const) if (decision[kind]?.shouldChange) receipt(kind, 'rejected', '状态变化没有引用该角色本人本轮发言')
    return receipts
  }

  if (decision.outfit?.shouldChange === true && decision.outfit.patch) {
    const patch = Object.fromEntries(OUTFIT_PARTS.flatMap((part) => {
      const value = decision.outfit?.patch?.[part]
      if (value === null) return [[part, '无']]
      if (typeof value !== 'string') return []
      const normalized = value.trim()
      return [[part, normalized ? canonicalizeOutfitValue(normalized).slice(0, 80) : '无']]
    })) as Record<string, string>
    const currentPatch = Object.fromEntries(Object.keys(patch).map((key) => [key, String(contact.outfit?.[key as OutfitPart] ?? '')]))
    if (Object.keys(patch).length > 0 && !samePatch(patch, currentPatch)) {
      const immediate = decision.outfit.timing !== 'future'
      const startDay = immediate ? day : Number(decision.outfit.startDay)
      const endDay = immediate ? day : Number(decision.outfit.endDay ?? startDay)
      if (startDay >= day && endDay >= startDay) {
        // An outfit action performed in the current conversation is already
        // true now and remains so for the rest of this world-day. At the first
        // turn of the next day refreshConstraintsForWorld resolves back to the
        // immutable defaultOutfit saved at character creation.
        const slots = immediate ? undefined : normalizedSlots(decision.outfit.slots?.filter((value): value is TimeSlot => SLOTS.includes(value)))
        const duplicate = await db.outfitConstraints.where('characterId').equals(contact.id).filter((item) => item.startDay === startDay && item.endDay === endDay && JSON.stringify(item.slots ?? []) === JSON.stringify(slots ?? []) && samePatch(item.patch as Record<string, string>, patch)).first()
        if (!duplicate) {
          const row = await addOutfitConstraint({ characterId: contact.id, startDay, endDay, slots, patch, sourceEventIds: evidenceIds, reason: decision.outfit.reason?.trim().slice(0, 160) || '本轮明确改变衣着', conversationId: input.conversationId })
          await markEvidenceConsumed(input.evidence.map((event) => event.id), 'outfit')
          receipt('outfit', 'applied', '衣着约束已写入数据库', [row.id])
        } else receipt('outfit', 'duplicate', '相同衣着约束已经存在', [duplicate.id])
      } else receipt('outfit', 'rejected', '衣着约束日期范围无效')
    } else receipt('outfit', Object.keys(patch).length === 0 ? 'rejected' : 'duplicate', Object.keys(patch).length === 0 ? '衣着变更没有有效部位' : '角色当前已经是目标衣着')
  }

  if (decision.schedule?.shouldChange === true) {
    if (typeof decision.schedule.locationId !== 'string' || !decision.schedule.locationId) receipt('schedule', 'rejected', '日程缺少合法locationId')
    else if (typeof decision.schedule.activity !== 'string' || !decision.schedule.activity.trim()) receipt('schedule', 'rejected', '日程缺少activity')
    else if (typeof decision.schedule.reason !== 'string' || !decision.schedule.reason.trim()) receipt('schedule', 'rejected', '日程缺少reason')
    else {
    const startDay = Number(decision.schedule.startDay), endDay = Number(decision.schedule.endDay ?? startDay)
    const slots = decision.schedule.slots?.filter((value): value is TimeSlot => SLOTS.includes(value))
    const invalidReason = !Number.isInteger(startDay) || !Number.isInteger(endDay) || startDay < day || endDay < startDay ? '日程日期范围无效'
      : !slots?.length ? '日程缺少有效时段slots'
      : !await isLeafLocation(decision.schedule.locationId) ? '日程地点不是合法叶子地点ID'
      : !['available', 'unavailable'].includes(String(decision.schedule.phoneAccess)) ? '日程phoneAccess无效'
      : !['override', 'commitment'].includes(String(decision.schedule.priority)) ? '日程priority无效'
      : ''
    if (!invalidReason) {
      const normalized = normalizedSlots(slots)
      const duplicate = await db.scheduleConstraints.where('characterId').equals(contact.id).filter((item) => item.startDay === startDay && item.endDay === endDay && item.locationId === decision.schedule!.locationId && item.activity === decision.schedule!.activity!.trim() && JSON.stringify(item.slots ?? []) === JSON.stringify(normalized ?? [])).first()
      if (!duplicate) {
        const row = await addScheduleConstraint({ characterId: contact.id, startDay, endDay, slots: normalized, locationId: decision.schedule.locationId, activity: decision.schedule.activity.trim().slice(0, 120), phoneAccess: decision.schedule.phoneAccess!, priority: decision.schedule.priority!, sourceEventIds: evidenceIds, reason: decision.schedule.reason.trim().slice(0, 160), conversationId: input.conversationId })
        await markEvidenceConsumed(input.evidence.map((event) => event.id), 'schedule')
        receipt('schedule', 'applied', '日程约束已写入数据库', [row.id])
      } else receipt('schedule', 'duplicate', '相同日程约束已经存在', [duplicate.id])
    } else receipt('schedule', 'rejected', invalidReason)
    }
  }

  if (decision.location?.shouldChange === true) {
    if (typeof decision.location.locationId !== 'string' || !decision.location.locationId) receipt('location', 'rejected', '地点变更缺少locationId')
    else if (typeof decision.location.reason !== 'string' || !decision.location.reason.trim()) receipt('location', 'rejected', '地点变更缺少reason')
    else if (contact.currentLocationId === decision.location.locationId) receipt('location', 'duplicate', '角色已经在目标地点')
    else if (!await isLeafLocation(decision.location.locationId)) receipt('location', 'rejected', '目标地点不是合法叶子地点')
    else {
    const latest = await db.worldState.get('global')
    if (!latest || latest.worldVersion !== worldVersion) { receipt('location', 'rejected', '世界状态版本已经变化'); return receipts }
    const movementId = uuid(), now = Date.now()
    await db.transaction('rw', [db.contacts, db.worldEvents, db.perceivedEvents], async () => {
      await db.contacts.update(contact.id, { currentLocationId: decision.location!.locationId })
      await db.worldEvents.add({ id: movementId, type: 'movement', worldStep: latest.step, locationId: decision.location!.locationId, actorId: contact.id, participantIds: [contact.id], content: decision.location!.reason!.trim().slice(0, 160), visibility: 'private', createdAt: now })
      await db.perceivedEvents.add({ id: uuid(), eventId: movementId, characterId: contact.id, perception: 'full', observedAtStep: latest.step })
    })
    await markEvidenceConsumed(input.evidence.map((event) => event.id), 'location')
    receipt('location', 'applied', '角色当前位置已更新', [movementId])
    }
  }
  return receipts
}

function buildUnifiedPrompt(input: StateAdjudicationInput, stateText: string, recentText: string, evidenceText: string, pending: PendingStateIntent[], day: number): string {
  const reviewText = input.replyReview
    ? `【本轮待审查回复】\n${input.replyReview.draftText}\n\n【只与本轮有关的人设硬事实】\n${input.replyReview.personaFacts || '无'}`
    : '【本轮待审查回复】\n无；replyReview.valid固定为true，只做状态裁决。'
  return `你是ChatSLG的统一回合审查器。只输出JSON，不续写、润色或代写角色台词。你同时完成：
1. 客观逻辑审查：回复是否回答最新话语，是否混淆人物身份、指代、时间、因果，是否违反给出的硬事实。只审查可验证逻辑，不因个人文风偏好判错。
2. 衣着、未来日程、当前位置三项独立状态裁决；同一角色可同时改变三项。
3. 保留尚未被角色接受/拒绝的具体提案为pendingIntents，供下一轮解析“好、走吧、那件”等省略。已经执行、接受或拒绝的提案不要继续保留。

场景=${input.scene}

${reviewText}

【权威状态与合法候选ID】
${stateText}
时间锚点：今天=世界第${day}天；今晚=第${day}天/evening；明天或明晚=第${day + 1}天，其中明晚必须是evening；后天=第${day + 2}天。

【尚未解决的提案账本】
${pending.length ? JSON.stringify(pending.map(({ createdAt: _createdAt, ...item }) => item)) : '无'}

【必要的较近完整对话轮；仅用于指代，不是执行证据】
${recentText || '无'}

【当前轮完整证据；decision.evidenceIds只能引用这里的ID】
${evidenceText}

规则：
- replyReview.valid=true时，必须为每个候选角色恰好输出一个decision，并且outfit/schedule/location三个对象及各自shouldChange布尔值都必须存在；没有变化也要明确false。
- 描述、疑问、建议、玩笑、拒绝和含糊意向不改状态；角色本人明确接受或明确执行才可改变，不能替别人同意。
- 任一shouldChange=true都必须至少引用一条actorId等于该characterId的本轮证据。仅仅出现在perceivedBy中表示听见了，不表示同意。
- 紧跟具体提案的“嗯/好/行/走吧/okay/sure”等无拒绝语义的短回复是明确接受，可结合提案账本确定目标。
- 现在出发才改location；今晚、明天、稍后等只写schedule。未来日程一旦被接受应立即登记，但不能提前移动。
- 穿上、脱下、更换才改outfit。立即执行timing=immediate；未来或持续穿戴timing=future。脱掉写对应字段为“无”。
- 照片、自拍、相册、旧照、画面或回忆中的衣着不代表现实衣着，除非角色另有明确的现实穿脱动作。
- 配饰统一写accessories（蝴蝶结、发箍、发卡、首饰、围巾、领带、手表、眼镜）；持续七天戴配饰仍是outfit，不是schedule。
- schedule必须含合法locationId、startDay/endDay、slots、activity、phoneAccess和priority。共同约定写participantIds；每个AI仍需自己的同意证据。
- schedule/location的目标地点必须由本轮证据、较近对话或待确认提案明确指向；遇到不存在的地点不得擅自替换成另一个合法地点。
- 当前已是目标状态、没有新事实或旧事件已生效时不得重复改变。
- pendingIntent只保存具体且尚未解决的提案，最多6条；必须使用真实characterId和当前证据ID。旧账本仍未解决时可原样保留。
- replyReview.valid=false时decisions必须为空，reason用一句人能看懂的话指出主模型应如何纠正；格式问题不属于这里，本轮输入已经可解析。

JSON协议：
{"replyReview":{"valid":true,"reason":""},"decisions":[{"characterId":"真实ID","evidenceIds":["当前证据ID"],"outfit":{"shouldChange":false,"timing":"immediate|future","patch":{"accessories":"蝴蝶结"},"startDay":1,"endDay":1,"slots":["morning"],"reason":""},"schedule":{"shouldChange":false,"startDay":1,"endDay":1,"slots":["evening"],"locationId":"合法ID","activity":"","phoneAccess":"available","priority":"commitment","participantIds":["user","真实ID"],"reason":""},"location":{"shouldChange":false,"locationId":"合法ID","reason":""}}],"pendingIntents":[{"id":"可沿用旧ID","characterId":"真实ID","kind":"location|outfit|schedule","summary":"待确认提案","sourceEventIds":["证据ID"],"locationId":"可选合法ID","outfitPatch":{"accessories":"可选"},"startDay":1,"endDay":1,"slots":["evening"]}]}`
}

/**
 * Language-independent semantic state gate shared by every social surface.
 * It runs once per completed interaction, never once per sentence. The model
 * judges meaning; deterministic code validates ids, time, consent evidence,
 * leaf locations, duplicates and world-version freshness before any write.
 */
export async function adjudicateStateChanges(input: StateAdjudicationInput): Promise<StateAdjudicationResult | null> {
  if (!input.settings.apiKey || input.characterIds.length === 0 || input.evidence.length === 0) return null
  const uniqueIds = [...new Set(input.characterIds)]
  const query = input.evidence.map((item) => item.content).join('\n').slice(0, 2_000)
  const allContacts = await db.contacts.toArray()
  const mentionedIds = allContacts.filter((contact) => !uniqueIds.includes(contact.id) && [contact.name, contact.nickname, contact.realName].filter(Boolean).some((name) => query.includes(String(name)))).map((contact) => contact.id)
  const contextIds = [...new Set([...uniqueIds, ...mentionedIds])]
  const bundles = await Promise.all(contextIds.map((characterId) => buildLogicContext({ subjectId: characterId, participantIds: contextIds, conversationId: input.conversationId, query })))
  const worldVersion = bundles[0].worldVersion
  if (bundles.some((bundle) => bundle.worldVersion !== worldVersion)) return null
  const queryText = input.evidence.map((item) => item.content).join('\n')
  const stateText = compactStateContext(bundles, queryText)
  const recentMessages = await recentConversationMessages(input.conversationId, 14)
  const [outfitConstraints, scheduleConstraints] = await Promise.all([
    Promise.all(uniqueIds.map((id) => db.outfitConstraints.where('characterId').equals(id).toArray())),
    Promise.all(uniqueIds.map((id) => db.scheduleConstraints.where('characterId').equals(id).toArray())),
  ])
  const consumedEvidenceIds = new Set([
    ...recentMessages.filter((message) => !!message.stateConsumedAt || !!message.consumedStateKinds?.length).map((message) => message.id),
    ...outfitConstraints.flat().flatMap((constraint) => constraint.sourceEventIds),
    ...scheduleConstraints.flat().flatMap((constraint) => constraint.sourceEventIds),
  ])
  // Older constraints often stored only the triggering user-message id. Treat
  // that message and its following assistant bubbles as one settled turn so
  // the assistant's old “好/脱掉了” cannot leak back into future adjudication.
  const turnGroups: Array<typeof recentMessages> = []
  for (const message of recentMessages) {
    if (message.role === 'user' || turnGroups.length === 0) turnGroups.push([])
    turnGroups.at(-1)!.push(message)
  }
  for (const group of turnGroups) if (group.some((message) => consumedEvidenceIds.has(message.id))) {
    for (const message of group) consumedEvidenceIds.add(message.id)
  }
  const activeEvidence = input.evidence.filter((event) => !consumedEvidenceIds.has(event.id))
  if (activeEvidence.length === 0) return { review: { valid: true, reason: '' }, decisions: [], pendingIntents: [], worldVersion, day: bundles[0].clock.day, receipts: [] }
  const evidenceText = activeEvidence.map((event) => `${event.id} | actorId=${event.actorId} | actor=${event.actorName} | perceivedBy=${event.perceivedBy.join(',')} | ${event.content}`).join('\n')
  const contactRows = await db.contacts.bulkGet(contextIds)
  const contactNames = new Map(contactRows.filter((contact): contact is NonNullable<typeof contact> => !!contact).map((contact) => [contact.id, contact.name]))
  // Preserve complete conversational turns. A clipped sentence is especially
  // dangerous here because consent, negation, time and destination often sit
  // at opposite ends of the same message. Pack newest settled turns first and
  // drop only whole older turns when the utility model's small window is full.
  const eligibleTurnTexts = turnGroups
    .map((group) => group
      .filter((message) => message.type !== 'systemState' && !consumedEvidenceIds.has(message.id))
      .map((message) => {
        const actorId = message.role === 'user' ? 'user' : message.speakerContactId ?? (uniqueIds.length === 1 ? uniqueIds[0] : 'unknown')
        const actorName = actorId === 'user' ? '用户' : contactNames.get(actorId) ?? actorId
        return `${message.id} | ${actorName}(${actorId}): ${message.content}`
      })
      .join('\n'))
    .filter(Boolean)
  const packedRecentTurns: string[] = []
  let packedRecentTokens = 0
  for (let index = eligibleTurnTexts.length - 1; index >= 0; index -= 1) {
    const turn = eligibleTurnTexts[index]
    const turnTokens = estimateTokens(turn)
    if (packedRecentTokens + turnTokens > RECENT_TURN_TOKEN_BUDGET) break
    packedRecentTurns.unshift(turn)
    packedRecentTokens += turnTokens
  }
  let recentConversationText = packedRecentTurns.join('\n\n')
  let prompt = `你是ChatSLG统一状态裁决器。你不续写对话，只判断本轮真实事件是否必须改变角色的衣着、未来日程或当前位置。无论输入使用中文、英文、日语或其他语言，都按语义判断。默认全部shouldChange=false，但不得因为回复很短就忽略上下文承接关系。

场景=${input.scene}

【每个候选角色的权威硬状态】
${stateText}

【最近14条对话——只用于解析“走吧、那里、那件衣服”等省略和指代】
${recentConversationText || '无'}

【本轮有序事件】
${evidenceText}

硬规则：
- 衣着、日程、地点是三个独立判断维度，不是三选一。必须对每个角色分别检查三项；同一句话同时满足三项时，outfit/schedule/location可以同时shouldChange=true，代码会连续提交三项修改。
- 描述、建议、问题、假设、玩笑、拒绝、含糊意向不改变状态。角色本人明确接受或明确执行后才允许true；任何角色都不能替另一个角色同意。
- 必须结合相邻事件理解短句承接。“嗯”“好”“行”“可以”“走吧”“okay”“sure”等简短肯定，如果紧跟在一个具体、可立即执行的请求后且没有拖延或拒绝语义，就是明确接受，不得仅因字数少而判false。
- 可以向前读取最近对话来解析当前话语省略的目标。例如上一轮明确说“去客厅”，当前说“走吧”，则当前目的地仍是客厅；上一轮说“穿黑色外套”，当前说“那就穿上吧”，则衣物仍是黑色外套。
- 最近对话只是语义上下文，不是本轮执行凭证。evidenceIds仍然只能使用【本轮有序事件】里的ID；不得因为旧对话曾经出现过一个动作，就在没有当前承接或新增事实时重复执行。
- 在现场场景中，用户提出“去某地吧/走吧”等当前行动，角色随后肯定同意，表示现在开始前往：location.shouldChange=true。若话语包含今晚、明天、稍后等未来时间，则只改schedule。
- “先穿上/换上某件衣物”等当前动作建议后角色肯定同意，视为现在执行：outfit.shouldChange=true，并从请求中提取明确衣物写入对应部位。没有说明款式时也可使用已明确的通用品类，例如outerwear=外套。
- evidenceIds只能引用上面的事件ID，且该角色必须是actor或在perceivedBy中。至少一个证据。
- 衣着只在明确穿上、脱下或更换时改变，只写真实变化部位。当前已经执行的穿脱必须填写timing=immediate，日期和slots交给代码决定；未来才穿填写timing=future及未来day/slots，不能提前声称已穿。
- 照片、图片、自拍、旧照、相册和回忆中的画面只是“图像内容”，绝不是角色此刻现实衣着的证据。“照片里穿着白上衣”“之前在公园拍的这张”“画面中戴着帽子”等描述一律不得触发outfit。只有本轮明确描述角色在现实中正在穿上、脱下或更换，才允许修改当前衣着。
- 脱掉某部位时不能省略该部位：例如脱掉外套必须输出patch.outerwear="无"，摘帽子输出patch.head="无"。也接受null，但优先使用“无”。
- 衣着patch部位必须按此语义选择：head=发型或帽子等头部主体；top=上装；bottom=下装；outerwear=外套；footwear=鞋袜；accessories=蝴蝶结、发箍、发卡、耳饰、项链、围巾、领带、手表、眼镜等配饰。蝴蝶结和发箍即使戴在头发上也优先写accessories，不得漏掉。
- 穿戴要求即使带有“连续七天、每天、今晚”等持续时间，本质仍然是outfit约束，绝不能因为出现日期或时段就改写成schedule。例如“接下来七天戴蝴蝶结”必须是outfit.shouldChange=true、timing=future、patch.accessories="蝴蝶结"、startDay=当前天、endDay=当前天+6、slots省略；schedule.shouldChange=false。
- 日程在具体安排被明确接受后立即写入未来日程；startDay/endDay和slots必须明确。地点必须使用权威硬状态中的合法叶子ID。
- schedule只描述角色在某个时间去合法地点做什么以及是否方便使用手机。纯穿衣、脱衣、佩戴配饰不是日程活动，不得为了满足schedule格式而虚构locationId或phoneAccess。
- 共同约定的schedule填写participantIds；玩家使用user，AI必须使用上方真实characterId。每位AI参与者仍必须分别输出自己的schedule决定，不能由一人代替同意。
- 约在未来时段只改schedule，不改location。只有角色明确现在出发、正在前往或已经到达，location.shouldChange才为true。
- 当前状态与目标相同、没有新增事实或只是重复旧约定时必须false。
- AI角色之间可以互相影响，但每个被改变的角色都必须分别有同意或执行证据。
- 朋友圈是公开事件，同样可形成状态变化，但不得仅因文案为了好看而虚构变化。

多项同时变化示例：角色明确同意“现在去客厅，并从今天起七天戴蝴蝶结，明晚去厨房帮忙做饭”，应在同一个角色decision中输出location.shouldChange=true（客厅）、outfit.shouldChange=true（accessories=蝴蝶结，第当前天至当前天+6）、schedule.shouldChange=true（明晚、厨房、帮忙做饭），三项不得互相吞掉。

只输出JSON：
{"decisions":[{"characterId":"必须逐字使用上方真实ID","evidenceIds":["真实事件ID"],"outfit":{"shouldChange":false,"timing":"immediate|future","patch":{},"startDay":1,"endDay":1,"slots":["morning"],"reason":""},"schedule":{"shouldChange":false,"startDay":1,"endDay":1,"slots":["evening"],"locationId":"合法叶子ID","activity":"","phoneAccess":"available","priority":"commitment","participantIds":["user","角色真实ID"],"reason":""},"location":{"shouldChange":false,"locationId":"合法叶子ID","reason":""}}]}`
  const conversation = await db.conversations.get(input.conversationId)
  const pendingIntents = (conversation?.pendingStateIntents ?? []).filter((item) => uniqueIds.includes(item.characterId)).slice(-6)
  prompt = buildUnifiedPrompt(input, stateText, recentConversationText, evidenceText, pendingIntents, bundles[0].clock.day)
  while (estimateTokens(prompt) > UTILITY_INPUT_TOKEN_BUDGET && packedRecentTurns.length > 0) {
    const previousRecentText = recentConversationText
    packedRecentTurns.shift()
    recentConversationText = packedRecentTurns.join('\n\n') || '无（较早完整对话轮未装入utility上下文）'
    prompt = prompt.replace(previousRecentText, recentConversationText)
  }
  const estimatedInputTokens = estimateTokens(prompt)
  if (estimatedInputTokens > UTILITY_INPUT_TOKEN_BUDGET) throw new Error(`统一裁决必需上下文约${estimatedInputTokens} tokens，超过8K模型的安全输入预算${UTILITY_INPUT_TOKEN_BUDGET}；没有截断当前证据，请减少本轮涉及角色或拆分群聊裁决`)
  const validLocations = (() => {
    const parentIds = new Set(bundles[0].locations.map((location) => location.parentId).filter(Boolean))
    return bundles[0].locations.filter((location) => !parentIds.has(location.id)).map((location) => ({ id: location.id, name: location.name }))
  })()
  const validationContext: StateValidationContext = {
    characterIds: uniqueIds,
    evidence: activeEvidence,
    day: bundles[0].clock.day,
    validLocations,
    recentText: recentConversationText,
    pendingIntents,
  }
  const requestAdjudication = (messages: ChatMessage[], stage: 'state' | 'state_retry') => chatCompletion({
    apiKey: input.settings.apiKey,
    baseUrl: input.settings.baseUrl,
    model: input.settings.utilityModel,
    jsonMode: true,
    thinking: 'disabled',
    temperature: 0,
    maxTokens: Math.min(1700, Math.max(900, uniqueIds.length * 360 + 360)),
    purpose: 'other',
    messages,
    trace: { ...(input.trace ?? { turnId: uuid() }), stage },
    signal: input.signal,
  })
  let raw = await requestAdjudication([{ role: 'system', content: prompt }, { role: 'user', content: '审查并裁决当前回合。' }], 'state')
  let parsedResult = parseStateAdjudication(raw)
  let validationIssues = [
    ...parsedResult.issues,
    ...(parsedResult.value ? validateStateAdjudication(parsedResult.value, validationContext) : []),
  ]
  let firstRaw: string | undefined
  if (validationIssues.length > 0) {
    firstRaw = raw
    const issueText = validationIssues.map((issue) => `- ${issue.message}`).join('\n')
    raw = await requestAdjudication([
      { role: 'system', content: prompt },
      { role: 'assistant', content: firstRaw },
      { role: 'user', content: `上一版状态裁决未通过确定性校验：\n${issueText}\n请重新输出完整JSON。不得解释，不得省略任何候选角色或三个状态维度；没有变化必须明确shouldChange=false。` },
    ], 'state_retry')
    parsedResult = parseStateAdjudication(raw)
    validationIssues = [
      ...parsedResult.issues,
      ...(parsedResult.value ? validateStateAdjudication(parsedResult.value, validationContext) : []),
    ]
  }
  const adjudication = parsedResult.value ?? { review: { valid: true, reason: '' }, decisions: [], pendingIntents: [] }
  const decisions = sanitizeStateDecisions(adjudication, validationIssues, uniqueIds)
  if (validationIssues.length > 0) console.warn('[state] 修复后仍有无效状态维度，已失败关闭', validationIssues.map((issue) => issue.message))
  const sceneLabel = { private_phone: '手机私聊', group_phone: '手机群聊', moment: '朋友圈', scene: '地点群聊' }[input.scene]
  const locationNames = new Map(bundles[0].locations.map((location) => [location.id, location.name]))
  const readableDecisions = decisions.flatMap((decision) => {
    const changes: string[] = []
    if (decision.outfit?.shouldChange) {
      const outfit = Object.entries(decision.outfit.patch ?? {}).map(([part, value]) => `${part}=${value === null || value === '' ? '无' : value}`).join('、')
      if (outfit) changes.push(`衣着：${outfit}${decision.outfit.timing === 'future' ? `（第${decision.outfit.startDay ?? '?'}–${decision.outfit.endDay ?? '?'}天）` : '（立即生效）'}`)
    }
    if (decision.schedule?.shouldChange) changes.push(`日程：第${decision.schedule.startDay ?? '?'}–${decision.schedule.endDay ?? decision.schedule.startDay ?? '?'}天 ${decision.schedule.slots?.join('/') ?? '全天'} → ${locationNames.get(decision.schedule.locationId ?? '') ?? decision.schedule.locationId ?? '未知地点'} · ${decision.schedule.activity ?? ''}`)
    if (decision.location?.shouldChange) changes.push(`地点：前往${locationNames.get(decision.location.locationId ?? '') ?? decision.location.locationId ?? '未知地点'}`)
    return changes.length ? [`${contactNames.get(decision.characterId) ?? decision.characterId}｜${changes.join('；')}`] : []
  })
  console.info(`[状态裁决｜${sceneLabel}] ${readableDecisions.length ? readableDecisions.join(' / ') : '无状态变化'}`)
  const adjudicationTraceId = uuid()
  await db.aiTurns.add({
    id: adjudicationTraceId, conversationId: input.conversationId, raw,
    parsed: { kind: 'unifiedTurnAdjudication', scene: input.scene, evidence: input.evidence, firstRaw, review: adjudication.review, decisions, pendingIntents: adjudication.pendingIntents, validationIssues, estimatedInputTokens },
    logicTrace: {
      worldVersion, locationTreeVersion: worldVersion,
      personaSummaries: bundles.map((bundle) => `${bundle.subject.character.id}:${bundle.subject.character.name}`),
      schedules: bundles.flatMap((bundle) => [...bundle.subject.baseSchedule, ...bundle.subject.scheduleOverrides].map((item) => `${item.characterId}/${item.priority}/${item.effectiveDay ?? item.dayOfWeek}/${item.slot}@${item.locationId}`)),
      appointmentIds: bundles.flatMap((bundle) => bundle.subject.commitments.map((item) => item.id)),
      memoryIds: [], perceivedEventIds: input.evidence.map((item) => item.id),
      validation: adjudication.review.valid && validationIssues.length === 0 ? 'passed' : 'rejected',
      validationReason: validationIssues.length ? validationIssues.map((issue) => issue.message).join('；').slice(0, 500) : adjudication.review.valid ? undefined : adjudication.review.reason,
    },
    createdAt: Date.now(),
  })
  const effectiveReview = input.replyReview ? adjudication.review : { valid: true, reason: '' }
  const result: StateAdjudicationResult = {
    review: effectiveReview,
    decisions: effectiveReview.valid ? decisions : [],
    pendingIntents: adjudication.pendingIntents.filter((item) => uniqueIds.includes(item.characterId)).slice(-6),
    worldVersion,
    day: bundles[0].clock.day,
    receipts: [],
  }
  if (input.apply === false || !result.review.valid) return result
  try {
    result.receipts = await commitStateAdjudication(input, result)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    result.receipts = result.decisions.flatMap((decision) => {
      const failed: StateApplicationReceipt[] = (['outfit', 'schedule', 'location'] as const)
        .filter((kind) => decision[kind]?.shouldChange === true)
        .map((kind) => ({ kind, characterId: decision.characterId, status: 'failed' as const, reason: `数据库事务提交失败：${reason}`, recordIds: [] }))
      if ((decision.schedule?.participantIds?.length ?? 0) > 1) failed.push({ kind: 'appointment', characterId: decision.characterId, status: 'failed', reason: `数据库事务提交失败：${reason}`, recordIds: [] })
      return failed
    })
    console.error('[state] 数据库事务已整体回滚', reason)
  }
  const trace = await db.aiTurns.get(adjudicationTraceId)
  if (trace?.parsed && typeof trace.parsed === 'object') await db.aiTurns.update(adjudicationTraceId, { parsed: { ...(trace.parsed as Record<string, unknown>), receipts: result.receipts } })
  return result
}

export async function commitStateAdjudication(input: StateAdjudicationInput, result: StateAdjudicationResult): Promise<StateApplicationReceipt[]> {
  return await db.transaction('rw', [db.worldState, db.conversations, db.contacts, db.messages, db.outfitConstraints, db.scheduleConstraints, db.locations, db.worldEvents, db.perceivedEvents, db.appointments], async () => {
  const latestWorld = await db.worldState.get('global')
  if (!latestWorld || latestWorld.worldVersion !== result.worldVersion) throw new Error('世界状态已变化，统一裁决结果不能提交')
  const decisions = result.decisions
  const receipts: StateApplicationReceipt[] = []
  const conversation = await db.conversations.get(input.conversationId)
  if (conversation) await db.conversations.update(input.conversationId, { pendingStateIntents: result.pendingIntents })
  for (const decision of decisions) receipts.push(...await applyDecision(input, decision, result.worldVersion, result.day))
  const appointmentGroups = new Map<string, { participantIds: string[]; day: number; slot: TimeSlot; locationId: string; description: string; evidenceIds: string[] }>()
  for (const decision of decisions) {
    const schedule = decision.schedule
    if (schedule?.shouldChange !== true || schedule.priority !== 'commitment' || !Number.isInteger(schedule.startDay) || !schedule.slots?.length || !schedule.locationId || !Array.isArray(schedule.participantIds)) continue
    const knownContacts = new Set((await db.contacts.toCollection().primaryKeys()).map(String))
    const participantIds = [...new Set(schedule.participantIds.filter((id) => id === 'user' || knownContacts.has(id)))].sort()
    if (participantIds.length < 2 || !participantIds.includes(decision.characterId)) continue
    const key = `${schedule.startDay}/${schedule.slots[0]}/${schedule.locationId}/${participantIds.join(',')}`
    const current = appointmentGroups.get(key)
    appointmentGroups.set(key, { participantIds, day: schedule.startDay!, slot: schedule.slots[0], locationId: schedule.locationId, description: current?.description || schedule.activity || schedule.reason || '共同约定', evidenceIds: [...new Set([...(current?.evidenceIds ?? []), ...(decision.evidenceIds ?? [])])] })
  }
  for (const appointment of appointmentGroups.values()) {
    const existing = await db.appointments.filter((item) => ['proposed', 'planned'].includes(item.status) && item.day === appointment.day && item.slot === appointment.slot && item.locationId === appointment.locationId && [...item.participantIds].sort().join(',') === appointment.participantIds.join(',')).first()
    const acceptedThisTurn = decisions.filter((decision) => appointment.participantIds.includes(decision.characterId) && decision.schedule?.shouldChange === true && decision.schedule.startDay === appointment.day && decision.schedule.locationId === appointment.locationId && decision.schedule.slots?.includes(appointment.slot)).map((decision) => decision.characterId)
    const acceptedParticipantIds = [...new Set([...(existing?.acceptedParticipantIds ?? []), ...acceptedThisTurn])]
    const requiredAi = appointment.participantIds.filter((id) => id !== 'user')
    const status = requiredAi.every((id) => acceptedParticipantIds.includes(id)) ? 'planned' as const : 'proposed' as const
    const now = Date.now()
    if (existing) {
      await db.appointments.update(existing.id, { acceptedParticipantIds, conversationIds: [...new Set([...(existing.conversationIds ?? []), input.conversationId])], sourceEventIds: [...new Set([...existing.sourceEventIds, ...appointment.evidenceIds])], status, updatedAt: now })
      receipts.push({ kind: 'appointment', characterId: acceptedThisTurn[0] ?? '', status: status === 'planned' ? 'applied' : 'applied', reason: status === 'planned' ? '共同约定已获得全部AI参与者确认' : '已记录当前角色同意，等待其他参与者确认', recordIds: [existing.id] })
    } else {
      const id = uuid()
      await db.appointments.add({ id, ...appointment, status, acceptedParticipantIds, conversationIds: [input.conversationId], sourceEventIds: appointment.evidenceIds, createdAt: now, updatedAt: now })
      receipts.push({ kind: 'appointment', characterId: acceptedThisTurn[0] ?? '', status: 'applied', reason: status === 'planned' ? '共同约定已确认' : '共同约定已创建，等待其他参与者确认', recordIds: [id] })
    }
  }
  return receipts
  })
}
