import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type { AdminAiTraceStage, AppSettings, OutfitPart, PendingStateIntent, TimeSlot } from '../types'
import { chatCompletion } from './deepseek'
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

function parseAdjudication(raw: string): { review: { valid: boolean; reason: string }; decisions: StateDecision[]; pendingIntents: PendingStateIntent[] } {
  const json = extractJsonObject(raw)
  if (!json) return { review: { valid: false, reason: '多功能模型没有返回可解析JSON' }, decisions: [], pendingIntents: [] }
  try {
    const parsed = JSON.parse(json) as { replyReview?: { valid?: unknown; reason?: unknown }; decisions?: unknown; pendingIntents?: unknown }
    const decisions = (Array.isArray(parsed.decisions) ? parsed.decisions : []).flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const value = item as StateDecision & { sourceEventIds?: string[]; outfitChange?: StateDecision['outfit']; scheduleChange?: StateDecision['schedule']; locationChange?: StateDecision['location'] }
      if (typeof value.characterId !== 'string') return []
      return [{
        ...value,
        evidenceIds: Array.isArray(value.evidenceIds) ? value.evidenceIds : Array.isArray(value.sourceEventIds) ? value.sourceEventIds : [],
        outfit: value.outfit ?? value.outfitChange,
        schedule: value.schedule ?? value.scheduleChange,
        location: value.location ?? value.locationChange,
      }]
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
      review: {
        valid: parsed.replyReview?.valid !== false,
        reason: typeof parsed.replyReview?.reason === 'string' ? parsed.replyReview.reason.trim().slice(0, 240) : '',
      },
      decisions,
      pendingIntents,
    }
  } catch {
    return { review: { valid: false, reason: '多功能模型返回的JSON格式无效' }, decisions: [], pendingIntents: [] }
  }
}

function samePatch(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

async function markEvidenceConsumed(evidenceIds: string[], kind: 'outfit' | 'schedule' | 'location'): Promise<void> {
  const messages = (await db.messages.bulkGet(evidenceIds)).filter((message): message is NonNullable<typeof message> => !!message)
  for (const message of messages) {
    const consumedStateKinds = [...new Set([...(message.consumedStateKinds ?? []), kind])]
    await db.messages.update(message.id, { consumedStateKinds, stateConsumedAt: Date.now() })
  }
}

async function applyDecision(input: StateAdjudicationInput, decision: StateDecision, worldVersion: number, day: number): Promise<void> {
  if (!input.characterIds.includes(decision.characterId)) return
  const contact = await db.contacts.get(decision.characterId)
  if (!contact) return
  const allowedEvidence = new Set(input.evidence.filter((event) => event.perceivedBy.includes(contact.id) || event.actorId === contact.id).map((event) => event.id))
  const evidenceIds = [...new Set((decision.evidenceIds ?? []).filter((id) => allowedEvidence.has(id)))]
  if (evidenceIds.length === 0) return

  if (decision.outfit?.shouldChange === true && decision.outfit.patch) {
    const patch = Object.fromEntries(OUTFIT_PARTS.flatMap((part) => {
      const value = decision.outfit?.patch?.[part]
      if (value === null) return [[part, '无']]
      if (typeof value !== 'string') return []
      const normalized = value.trim()
      return [[part, normalized ? normalized.slice(0, 80) : '无']]
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
          await addOutfitConstraint({ characterId: contact.id, startDay, endDay, slots, patch, sourceEventIds: evidenceIds, reason: decision.outfit.reason?.trim().slice(0, 160) || '本轮明确改变衣着', conversationId: input.conversationId })
          await markEvidenceConsumed(input.evidence.map((event) => event.id), 'outfit')
        }
      }
    }
  }

  if (decision.schedule?.shouldChange === true && typeof decision.schedule.locationId === 'string' && typeof decision.schedule.activity === 'string' && typeof decision.schedule.reason === 'string') {
    const startDay = Number(decision.schedule.startDay), endDay = Number(decision.schedule.endDay ?? startDay)
    const slots = decision.schedule.slots?.filter((value): value is TimeSlot => SLOTS.includes(value))
    if (Number.isInteger(startDay) && Number.isInteger(endDay) && startDay >= day && endDay >= startDay && slots?.length && await isLeafLocation(decision.schedule.locationId) && ['available', 'unavailable'].includes(String(decision.schedule.phoneAccess)) && ['override', 'commitment'].includes(String(decision.schedule.priority))) {
      const normalized = normalizedSlots(slots)
      const duplicate = await db.scheduleConstraints.where('characterId').equals(contact.id).filter((item) => item.startDay === startDay && item.endDay === endDay && item.locationId === decision.schedule!.locationId && item.activity === decision.schedule!.activity!.trim() && JSON.stringify(item.slots ?? []) === JSON.stringify(normalized ?? [])).first()
      if (!duplicate) {
        await addScheduleConstraint({ characterId: contact.id, startDay, endDay, slots: normalized, locationId: decision.schedule.locationId, activity: decision.schedule.activity.trim().slice(0, 120), phoneAccess: decision.schedule.phoneAccess!, priority: decision.schedule.priority!, sourceEventIds: evidenceIds, reason: decision.schedule.reason.trim().slice(0, 160), conversationId: input.conversationId })
        await markEvidenceConsumed(input.evidence.map((event) => event.id), 'schedule')
      }
    }
  }

  if (decision.location?.shouldChange === true && typeof decision.location.locationId === 'string' && typeof decision.location.reason === 'string' && contact.currentLocationId !== decision.location.locationId && await isLeafLocation(decision.location.locationId)) {
    const latest = await db.worldState.get('global')
    if (!latest || latest.worldVersion !== worldVersion) return
    const movementId = uuid(), now = Date.now()
    await db.transaction('rw', [db.contacts, db.worldEvents, db.perceivedEvents], async () => {
      await db.contacts.update(contact.id, { currentLocationId: decision.location!.locationId })
      await db.worldEvents.add({ id: movementId, type: 'movement', worldStep: latest.step, locationId: decision.location!.locationId, actorId: contact.id, participantIds: [contact.id], content: decision.location!.reason!.trim().slice(0, 160), visibility: 'private', createdAt: now })
      await db.perceivedEvents.add({ id: uuid(), eventId: movementId, characterId: contact.id, perception: 'full', observedAtStep: latest.step })
    })
    await markEvidenceConsumed(input.evidence.map((event) => event.id), 'location')
  }
}

function buildUnifiedPrompt(input: StateAdjudicationInput, stateText: string, recentText: string, evidenceText: string, pending: PendingStateIntent[]): string {
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

【尚未解决的提案账本】
${pending.length ? JSON.stringify(pending.map(({ createdAt: _createdAt, ...item }) => item)) : '无'}

【必要的较近完整对话轮；仅用于指代，不是执行证据】
${recentText || '无'}

【当前轮完整证据；decision.evidenceIds只能引用这里的ID】
${evidenceText}

规则：
- 描述、疑问、建议、玩笑、拒绝和含糊意向不改状态；角色本人明确接受或明确执行才可改变，不能替别人同意。
- 紧跟具体提案的“嗯/好/行/走吧/okay/sure”等无拒绝语义的短回复是明确接受，可结合提案账本确定目标。
- 现在出发才改location；今晚、明天、稍后等只写schedule。未来日程一旦被接受应立即登记，但不能提前移动。
- 穿上、脱下、更换才改outfit。立即执行timing=immediate；未来或持续穿戴timing=future。脱掉写对应字段为“无”。
- 配饰统一写accessories（蝴蝶结、发箍、发卡、首饰、围巾、领带、手表、眼镜）；持续七天戴配饰仍是outfit，不是schedule。
- schedule必须含合法locationId、startDay/endDay、slots、activity、phoneAccess和priority。共同约定写participantIds；每个AI仍需自己的同意证据。
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
  const bundles = await Promise.all(uniqueIds.map((characterId) => buildLogicContext({ subjectId: characterId, participantIds: uniqueIds, conversationId: input.conversationId, query: input.evidence.map((item) => item.content).join('\n').slice(0, 2_000) })))
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
  if (activeEvidence.length === 0) return { review: { valid: true, reason: '' }, decisions: [], pendingIntents: [], worldVersion, day: bundles[0].clock.day }
  const evidenceText = activeEvidence.map((event) => `${event.id} | actorId=${event.actorId} | actor=${event.actorName} | perceivedBy=${event.perceivedBy.join(',')} | ${event.content}`).join('\n')
  const contactRows = await db.contacts.bulkGet(uniqueIds)
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
  prompt = buildUnifiedPrompt(input, stateText, recentConversationText, evidenceText, pendingIntents)
  while (estimateTokens(prompt) > UTILITY_INPUT_TOKEN_BUDGET && packedRecentTurns.length > 0) {
    const previousRecentText = recentConversationText
    packedRecentTurns.shift()
    recentConversationText = packedRecentTurns.join('\n\n') || '无（较早完整对话轮未装入utility上下文）'
    prompt = prompt.replace(previousRecentText, recentConversationText)
  }
  const estimatedInputTokens = estimateTokens(prompt)
  if (estimatedInputTokens > UTILITY_INPUT_TOKEN_BUDGET) throw new Error(`统一裁决必需上下文约${estimatedInputTokens} tokens，超过8K模型的安全输入预算${UTILITY_INPUT_TOKEN_BUDGET}；没有截断当前证据，请减少本轮涉及角色或拆分群聊裁决`)
  const raw = await chatCompletion({ apiKey: input.settings.apiKey, baseUrl: input.settings.baseUrl, model: input.settings.utilityModel, jsonMode: true, thinking: 'disabled', temperature: 0, maxTokens: Math.min(1700, Math.max(900, uniqueIds.length * 360 + 360)), purpose: 'other', messages: [{ role: 'system', content: prompt }, { role: 'user', content: '审查并裁决当前回合。' }], trace: input.trace })
  const adjudication = parseAdjudication(raw)
  const { decisions } = adjudication
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
  await db.aiTurns.add({
    id: uuid(), conversationId: input.conversationId, raw,
    parsed: { kind: 'unifiedTurnAdjudication', scene: input.scene, evidence: input.evidence, review: adjudication.review, decisions, pendingIntents: adjudication.pendingIntents, estimatedInputTokens },
    knowledgeQueries: [],
    logicTrace: {
      worldVersion, locationTreeVersion: worldVersion,
      personaSummaries: bundles.map((bundle) => `${bundle.subject.character.id}:${bundle.subject.character.name}`),
      schedules: bundles.flatMap((bundle) => [...bundle.subject.baseSchedule, ...bundle.subject.scheduleOverrides].map((item) => `${item.characterId}/${item.priority}/${item.effectiveDay ?? item.dayOfWeek}/${item.slot}@${item.locationId}`)),
      appointmentIds: bundles.flatMap((bundle) => bundle.subject.commitments.map((item) => item.id)),
      memoryIds: [], perceivedEventIds: input.evidence.map((item) => item.id),
      validation: adjudication.review.valid ? 'passed' : 'rejected',
      validationReason: adjudication.review.valid ? undefined : adjudication.review.reason,
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
  }
  if (input.apply === false || !result.review.valid) return result
  await commitStateAdjudication(input, result)
  return result
}

export async function commitStateAdjudication(input: StateAdjudicationInput, result: StateAdjudicationResult): Promise<void> {
  const latestWorld = await db.worldState.get('global')
  if (!latestWorld || latestWorld.worldVersion !== result.worldVersion) throw new Error('世界状态已变化，统一裁决结果不能提交')
  const uniqueIds = [...new Set(input.characterIds)]
  const decisions = result.decisions
  const conversation = await db.conversations.get(input.conversationId)
  if (conversation) await db.conversations.update(input.conversationId, { pendingStateIntents: result.pendingIntents })
  for (const decision of decisions) await applyDecision(input, decision, result.worldVersion, result.day)
  const appointmentGroups = new Map<string, { participantIds: string[]; day: number; slot: TimeSlot; locationId: string; description: string; evidenceIds: string[] }>()
  for (const decision of decisions) {
    const schedule = decision.schedule
    if (schedule?.shouldChange !== true || schedule.priority !== 'commitment' || !Number.isInteger(schedule.startDay) || !schedule.slots?.length || !schedule.locationId || !Array.isArray(schedule.participantIds)) continue
    const participantIds = [...new Set(schedule.participantIds.filter((id) => id === 'user' || uniqueIds.includes(id)))].sort()
    if (participantIds.length < 2 || !participantIds.includes(decision.characterId)) continue
    const matchingAi = participantIds.filter((id) => id !== 'user')
    if (!matchingAi.every((id) => decisions.some((candidate) => candidate.characterId === id && candidate.schedule?.shouldChange === true && candidate.schedule.startDay === schedule.startDay && candidate.schedule.locationId === schedule.locationId && candidate.schedule.slots?.includes(schedule.slots![0])))) continue
    const key = `${schedule.startDay}/${schedule.slots[0]}/${schedule.locationId}/${participantIds.join(',')}`
    appointmentGroups.set(key, { participantIds, day: schedule.startDay!, slot: schedule.slots[0], locationId: schedule.locationId, description: schedule.activity || schedule.reason || '共同约定', evidenceIds: [...new Set(decision.evidenceIds ?? [])] })
  }
  for (const appointment of appointmentGroups.values()) {
    const duplicate = await db.appointments.filter((item) => item.status === 'planned' && item.day === appointment.day && item.slot === appointment.slot && item.locationId === appointment.locationId && [...item.participantIds].sort().join(',') === appointment.participantIds.join(',')).first()
    if (!duplicate) await db.appointments.add({ id: uuid(), ...appointment, status: 'planned', sourceEventIds: appointment.evidenceIds, createdAt: Date.now() })
  }
}
