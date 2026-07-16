import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { chatCompletion } from './deepseek'
import { extractJsonObject } from './aiProtocol'
import { effectiveScheduleAdherence, ensureWorldInitialized, nextWorldClock, resolveSchedule } from './world'
import { buildLogicContext, formatLogicContext } from './logicContext'
import type { AppSettings, CharacterSchedule, Contact, PendingPhoneMessage, TimeSlot } from '../types'
import { defaultOutfit } from './outfit'
import { activeInRange, refreshConstraintsForWorld } from './temporaryConstraints'
import { isAnyChatTurnActive } from './chatEngine'
import { modelWorldTimeText } from './worldCalendar'
import { settleSalaries } from './finance'
import { settleLifeSimulationForWorldTurn } from './lifeSimulation'
import { isModuleEnabled } from '../features'
import { formatWeatherForModel, weatherForWorld } from './worldWeather'
import { directedEventPrompt, prepareDirectedEvent, type PreparedDirectedEvent } from './eventDirector'
import { adjudicateScheduleDeviations, type ScheduleDeviationCandidate, type ScheduleDeviationEvidence, type ScheduleDeviationProposal, type ScheduleDeviationVerdict } from './scheduleDeviation'

interface TurnCharacter {
  characterId: string
  locationId: string
  activity: string
  diary: string
  learnedFacts?: Array<{ content: string; importance?: number; emotionalWeight?: number; confidence?: number }>
  outfitChange?: { patch: Record<string, string>; sourceScheduleId?: string; reason: string }
  scheduleDecision?: ScheduleDeviationProposal
}

interface TurnPhoneReply {
  conversationId: string
  characterId: string
  messages: string[]
}

interface TurnMoment {
  characterId: string
  content: string
}

interface ParsedWorldTurn {
  worldVersion: number
  characters: TurnCharacter[]
  phoneReplies?: TurnPhoneReply[]
  moments?: TurnMoment[]
  directedEvent?: PreparedDirectedEvent
}

interface WorldTurnIssue {
  code: string
  message: string
  characterId?: string
}

let running: Promise<void> | null = null

function parseWorldTurn(raw: string): ParsedWorldTurn {
  const json = extractJsonObject(raw)
  if (!json) throw new Error('世界回合没有返回有效JSON')
  const parsed = JSON.parse(json) as Partial<ParsedWorldTurn>
  if (!Number.isInteger(parsed.worldVersion) || !Array.isArray(parsed.characters)) throw new Error('世界回合格式不完整')
  return parsed as ParsedWorldTurn
}

function collectFatalWorldTurnIssues(parsed: ParsedWorldTurn, opts: {
  worldVersion: number
  contacts: Contact[]
  locationIds: Set<string>
  schedules: CharacterSchedule[]
  day: number
  slot: TimeSlot
  directedEvent?: PreparedDirectedEvent | null
  deviationVerdicts?: Map<string, ScheduleDeviationVerdict>
}): WorldTurnIssue[] {
  const issues: WorldTurnIssue[] = []
  if (parsed.worldVersion !== opts.worldVersion) issues.push({ code: 'world_version', message: '世界版本不一致' })
  const expected = new Set(opts.contacts.map((item) => item.id))
  const seen = new Set<string>()
  for (const item of parsed.characters ?? []) {
    if (!expected.has(item.characterId)) {
      issues.push({ code: 'unknown_character', characterId: item.characterId, message: `包含未知角色 ${item.characterId}` })
      continue
    }
    if (seen.has(item.characterId)) issues.push({ code: 'duplicate_character', characterId: item.characterId, message: `角色 ${item.characterId} 被重复输出` })
    seen.add(item.characterId)
    if (!opts.locationIds.has(item.locationId)) issues.push({ code: 'invalid_location', characterId: item.characterId, message: `角色 ${item.characterId} 使用了不存在的地点 ${item.locationId}` })
    if (!item.activity?.trim() || !item.diary?.trim()) issues.push({ code: 'empty_required_text', characterId: item.characterId, message: `角色 ${item.characterId} 的活动或日志为空` })
    const resolved = resolveSchedule(opts.schedules.filter((schedule) => schedule.characterId === item.characterId), opts.day, opts.slot)
    if (resolved && (item.locationId !== resolved.locationId || item.activity.trim() !== resolved.activity.trim()) && !opts.deviationVerdicts?.get(item.characterId)?.allow) {
      const verdict = opts.deviationVerdicts?.get(item.characterId)
      issues.push({ code: 'schedule_violation', characterId: item.characterId, message: `角色 ${item.characterId} 偏离${effectiveScheduleAdherence(resolved)}日程的依据未获批准：${verdict?.explanation ?? '没有提交可核验的偏离提案'}。应前往 ${resolved.locationId}` })
    }
  }
  for (const contact of opts.contacts) if (!seen.has(contact.id)) issues.push({ code: 'missing_character', characterId: contact.id, message: `漏掉角色 ${contact.id}` })
  if (opts.directedEvent?.locationId) {
    for (const characterId of opts.directedEvent.participantIds.filter((id) => id !== 'user')) {
      if (parsed.characters.find((item) => item.characterId === characterId)?.locationId !== opts.directedEvent.locationId) {
        issues.push({ code: 'directed_event_location', characterId, message: `稀疏事件参与者 ${characterId} 必须位于事件地点 ${opts.directedEvent.locationId}` })
      }
    }
  }
  return issues
}

async function repairWorldTurnJson(raw: string, settings: AppSettings): Promise<string> {
  if (raw.length > 4_200) throw new Error('世界回合原文过长，不适合在8K窗口内同时读取并重写格式')
  return chatCompletion({
    apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.utilityModel,
    jsonMode: true, thinking: 'disabled', temperature: 0, maxTokens: 2400, purpose: 'other',
    messages: [{ role: 'system', content: `你只修复JSON格式，不改变任何角色ID、地点ID、活动、日志、事实、朋友圈或手机回复的语义。删除Markdown围栏和解释，补齐必要的引号、逗号、括号与数组。顶层必须是worldVersion、characters、phoneReplies、moments；不要生成encounters或新增事件。只输出修复后的JSON。\n\n原文：\n${raw}` }],
  })
}

function sanitizeOptionalWorldTurn(parsed: ParsedWorldTurn, contacts: Contact[], pending: PendingPhoneMessage[]): void {
  const expected = new Set(contacts.map((item) => item.id))
  parsed.phoneReplies = (parsed.phoneReplies ?? []).filter((reply) =>
    expected.has(reply.characterId)
    && !!reply.conversationId
    && Array.isArray(reply.messages)
    && pending.some((item) => item.conversationId === reply.conversationId && item.recipientIds.includes(reply.characterId)),
  )
  parsed.moments = (parsed.moments ?? []).filter((moment) => expected.has(moment.characterId) && !!moment.content?.trim()).slice(0, 3)
}

async function filterGroundedMoments(parsed: ParsedWorldTurn, settings: AppSettings): Promise<TurnMoment[]> {
  const moments = (parsed.moments ?? []).slice(0, 3)
  if (moments.length === 0) return []
  const candidates = moments.map((moment, index) => {
    const character = parsed.characters.find((item) => item.characterId === moment.characterId)
    return { index, characterId: moment.characterId, activity: character?.activity ?? '', diary: character?.diary ?? '', content: moment.content }
  })
  const raw = await chatCompletion({
    apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.utilityModel,
    jsonMode: true, thinking: 'disabled', temperature: 0, maxTokens: 400, purpose: 'moments',
    messages: [{ role: 'system', content: `你只判断朋友圈内容是否能由该角色本时段活动和日志直接支持。不得按文采偏好删帖，不得改写。只输出JSON：{"keepIndices":[0]}。如果文案虚构了日志中不存在的人物、地点、经历或结果就删除；合理心情和简短感想可以保留。\n\n候选：${JSON.stringify(candidates)}` }],
  })
  const json = extractJsonObject(raw)
  if (!json) return []
  try {
    const keep = new Set((JSON.parse(json) as { keepIndices?: unknown[] }).keepIndices?.filter((value): value is number => Number.isInteger(value)) ?? [])
    return moments.filter((_, index) => keep.has(index))
  } catch {
    return []
  }
}

async function filterGroundedPhoneReplies(parsed: ParsedWorldTurn, pending: PendingPhoneMessage[], settings: AppSettings): Promise<TurnPhoneReply[]> {
  const replies = parsed.phoneReplies ?? []
  if (replies.length === 0) return []
  const relevantPending = replies.flatMap((reply) => pending.filter((item) => item.conversationId === reply.conversationId && item.recipientIds.includes(reply.characterId)))
  const sourceMessages = await db.messages.bulkGet([...new Set(relevantPending.map((item) => item.messageId))])
  const sourceById = new Map(sourceMessages.filter((message): message is NonNullable<typeof message> => !!message).map((message) => [message.id, message.content]))
  const candidates = replies.map((reply, index) => ({
    index, characterId: reply.characterId, conversationId: reply.conversationId, messages: reply.messages.slice(0, 5).map((message) => message.slice(0, 300)),
    pendingMessages: pending.filter((item) => item.conversationId === reply.conversationId && item.recipientIds.includes(reply.characterId)).slice(-3).map((item) => (sourceById.get(item.messageId) ?? '').slice(0, 500)).filter(Boolean),
  }))
  const keep = new Set<number>()
  for (let offset = 0; offset < candidates.length; offset += 4) {
    const batch = candidates.slice(offset, offset + 4)
    const raw = await chatCompletion({
      apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.utilityModel,
      jsonMode: true, thinking: 'disabled', temperature: 0, maxTokens: 300, purpose: 'other',
      messages: [{ role: 'system', content: `你只检查手机回复是否确实回应对应待收消息，并且没有明显答非所问、混淆发言人或凭空声称不存在的约定。不要改写。只输出JSON：{"keepIndices":[原始index]}。简短自然回复可以保留。\n\n候选：${JSON.stringify(batch)}` }],
    })
    const json = extractJsonObject(raw)
    if (!json) continue
    try {
      for (const value of (JSON.parse(json) as { keepIndices?: unknown[] }).keepIndices ?? []) if (Number.isInteger(value)) keep.add(Number(value))
    } catch {
      // A failed optional batch drops only that batch's automatic replies.
    }
  }
  return replies.filter((_, index) => keep.has(index))
}

export function validateWorldTurn(parsed: ParsedWorldTurn, opts: {
  worldVersion: number
  contacts: Contact[]
  locationIds: Set<string>
  schedules: CharacterSchedule[]
  day: number
  slot: TimeSlot
  pending: PendingPhoneMessage[]
  deviationVerdicts?: Map<string, ScheduleDeviationVerdict>
}): void {
  const { worldVersion, contacts, locationIds, schedules, day, slot, pending, deviationVerdicts } = opts
  if (parsed.worldVersion !== worldVersion) throw new Error('地点树已更新，请重新生成本回合')
  const expected = new Set(contacts.map((item) => item.id))
  const seen = new Set<string>()
  for (const item of parsed.characters) {
    if (!expected.has(item.characterId) || seen.has(item.characterId)) throw new Error('世界回合包含重复或未知角色')
    if (!locationIds.has(item.locationId)) throw new Error(`角色引用了不存在的地点: ${item.locationId}`)
    if (!item.activity?.trim() || !item.diary?.trim()) throw new Error('角色活动或日志为空')
    const resolved = resolveSchedule(schedules.filter((schedule) => schedule.characterId === item.characterId), day, slot)
    if (resolved && (item.locationId !== resolved.locationId || item.activity.trim() !== resolved.activity.trim()) && !deviationVerdicts?.get(item.characterId)?.allow) throw new Error(`角色 ${item.characterId} 的日程偏离未通过独立裁决`)
    if (item.outfitChange) {
      const allowed = new Set(['head', 'top', 'bottom', 'outerwear', 'footwear', 'accessories'])
      const patch = Object.fromEntries(Object.entries(item.outfitChange.patch ?? {}).flatMap(([key, value]) => allowed.has(key) && typeof value === 'string' && value.trim() ? [[key, value.trim().slice(0, 80)]] : []))
      // Clothing is an optional cosmetic side effect of the world turn. The
      // deterministic scheduler already knows the winning schedule, so never
      // abort the whole time advance merely because the model omitted/copied
      // a schedule id or returned an invalid clothing patch.
      if (!resolved || !Object.keys(patch).length || !item.outfitChange.reason?.trim()) delete item.outfitChange
      else item.outfitChange = { patch, sourceScheduleId: resolved.id, reason: item.outfitChange.reason.trim().slice(0, 160) }
    }
    seen.add(item.characterId)
  }
  if (seen.size !== expected.size) throw new Error('世界回合漏掉了角色')
  for (const reply of parsed.phoneReplies ?? []) {
    if (!expected.has(reply.characterId) || !reply.conversationId || !Array.isArray(reply.messages)) throw new Error('手机回复格式无效')
    if (!pending.some((item) => item.conversationId === reply.conversationId && item.recipientIds.includes(reply.characterId))) throw new Error('手机回复没有对应的待回复消息')
  }
  for (const moment of parsed.moments ?? []) {
    if (!expected.has(moment.characterId) || !moment.content?.trim()) throw new Error('朋友圈格式无效')
  }
}

async function maybeArchiveMemories(step: number): Promise<void> {
  if (step === 0 || step % 8 !== 0) return
  const contacts = await db.contacts.toArray()
  for (const contact of contacts) {
    const active = (await db.contactMemories.where('contactId').equals(contact.id).toArray())
      .filter((item) => (!item.status || item.status === 'active') && !item.pinned && item.kind !== 'character_promise' && item.kind !== 'open_thread' && item.importance < .8)
      .sort((a, b) => a.importance - b.importance || a.updatedAt - b.updatedAt)
    const totalActive = await db.contactMemories.where('contactId').equals(contact.id).filter((item) => !item.status || item.status === 'active').count()
    if (totalActive <= 60 || active.length < 8) continue
    const covered = active.slice(0, Math.min(20, totalActive - 50))
    const summary = covered.map((item) => item.content).join('；').slice(0, 900)
    const now = Date.now()
    await db.transaction('rw', db.contactMemories, async () => {
      for (const item of covered) await db.contactMemories.update(item.id, { status: 'summarized', updatedAt: now })
      await db.contactMemories.add({
        id: uuid(), contactId: contact.id, scope: 'private', category: '重要事件', kind: 'general',
        content: `较早经历摘要：${summary}`, tags: ['归档摘要'], importance: .55, emotionalWeight: .3,
        confidence: .9, sourceMessageIds: [], sourceEventIds: covered.flatMap((item) => item.sourceEventIds ?? []),
        status: 'active', pinned: false, createdAt: now, updatedAt: now, usageCount: 0,
      })
    })
  }
}

async function archiveSceneConversationsForStep(
  step: number,
  day: number,
  slot: TimeSlot,
  now: number,
): Promise<void> {
  const scenes = await db.conversations
    .filter((conversation) => conversation.channel === 'scene'
      && (conversation.status ?? 'active') === 'active'
      && conversation.sceneWorldStep === step)
    .toArray()
  for (const scene of scenes) {
    await db.conversations.update(scene.id, {
      status: 'archived',
      archiveDay: day,
      archiveSlot: slot,
      archiveLocationId: scene.sceneLocationId,
      archivedAtStep: step,
      updatedAt: now,
    })
  }
}

export async function advanceWorldTurn(settings: AppSettings): Promise<void> {
  if (running) return running
  if (isAnyChatTurnActive()) throw new Error('聊天回合仍在处理中，状态提交完成前不能推进世界时间')
  running = (async () => {
    const world = await ensureWorldInitialized()
    const contacts = (await db.contacts.orderBy('createdAt').toArray()).slice(0, 12)
    const next = nextWorldClock(world)
    if (contacts.length === 0) {
      const now = Date.now()
      await db.transaction('rw', [db.worldState, db.conversations], async () => {
        const latestWorld = await db.worldState.get('global')
        if (!latestWorld || latestWorld.worldVersion !== world.worldVersion || latestWorld.step !== world.step) throw new Error('世界已变化，本回合已整体取消')
        await archiveSceneConversationsForStep(world.step, world.day, world.slot, now)
        await db.worldState.put({ ...world, ...next, advancing: false, updatedAt: now })
      })
      await refreshConstraintsForWorld(next.day, next.slot)
      await settleSalaries(next.day).catch((error) => console.error('[world-turn] 世界日工资结算失败，将在下一时段重试', error))
      if (isModuleEnabled('lifeSimulation')) await settleLifeSimulationForWorldTurn(next).catch((error) => console.error('[world-turn] 世界生活状态结算失败，将在下一时段补算', error))
      return
    }
    if (!settings.apiKey) throw new Error('请先在设置中配置 API Key')
    const bundles = await Promise.all(contacts.map((contact) => buildLogicContext({
      subjectId: contact.id, participantIds: contacts.map((item) => item.id), query: '推进世界时间，结算全部角色的日程、约定、日志、消息和朋友圈',
    })))
    const worldMap = await db.worldMaps.get('active')
    const nextWeather = weatherForWorld(worldMap?.seed ?? world.worldId, next.day, next.slot)
    const locations = bundles[0].locations
    const scheduleMap = new Map(bundles.flatMap((bundle) => [...bundle.subject.baseSchedule, ...bundle.subject.scheduleOverrides]).map((item) => [item.id, item]))
    const scheduleConstraints = await db.scheduleConstraints.toArray()
    const temporarySchedules: CharacterSchedule[] = scheduleConstraints.flatMap((constraint) => activeInRange(constraint, next.day, next.slot)
      ? [{ id: constraint.id, characterId: constraint.characterId, effectiveDay: next.day, slot: next.slot, locationId: constraint.locationId, activity: constraint.activity, phoneAccess: constraint.phoneAccess, priority: constraint.priority, sourceEventIds: constraint.sourceEventIds, createdAt: constraint.createdAt }]
      : [])
    const schedules = [...scheduleMap.values(), ...temporarySchedules]
    const appointments = bundles[0].appointments.filter((item) => item.status === 'planned')
    const [relations, recentWorldEvents, lifeStates, recentDiariesByCharacter] = await Promise.all([
      db.contactRelations.toArray(),
      db.worldEvents.where('worldStep').above(Math.max(-1, next.step - 160)).toArray(),
      db.contactLifeStates.toArray(),
      Promise.all(contacts.map(async (contact) => (await db.characterDiaries.where('characterId').equals(contact.id).toArray())
        .sort((a, b) => b.worldStep - a.worldStep).slice(0, 3))),
    ])
    const directedEvent = await prepareDirectedEvent({
      seed: worldMap?.seed ?? world.worldId,
      worldId: world.worldId,
      day: next.day,
      slot: next.slot,
      step: next.step,
      playerLocationId: world.playerLocationId,
      weather: nextWeather,
      contacts,
      locations,
      schedules,
      appointments,
      relations,
      recentEvents: recentWorldEvents,
    }, settings).catch((error) => {
      console.warn('[event-director] 稀疏事件润色失败，本时段保持普通生活', error)
      return null
    })
    const pendingMap = new Map(bundles.flatMap((bundle) => bundle.pendingMessages).map((item) => [item.id, item]))
    const pending = [...pendingMap.values()]
    const memories = new Map(bundles.map((bundle) => [bundle.subject.character.id, bundle.memories.slice(0, 6)]))
    const recentEventById = new Map(recentWorldEvents.map((event) => [event.id, event]))
    const lifeStateById = new Map(lifeStates.map((state) => [state.contactId, state]))
    const evidenceByCharacter = new Map<string, ScheduleDeviationEvidence[]>()
    for (let index = 0; index < contacts.length; index++) {
      const contact = contacts[index]
      const bundle = bundles[index]
      const evidence: ScheduleDeviationEvidence[] = [{
        id: `persona:${contact.id}`, kind: 'persona',
        content: `${contact.name}的人设与稳定倾向：${contact.systemPrompt.slice(0, 900)}`,
      }, {
        id: `weather:${next.day}:${next.slot}`, kind: 'weather', content: formatWeatherForModel(nextWeather),
      }]
      const lifeState = lifeStateById.get(contact.id)
      if (lifeState) evidence.push({
        id: `lifeState:${contact.id}:${lifeState.worldStep ?? lifeState.updatedAt}`, kind: 'lifeState',
        content: `精力${lifeState.energy}/100，压力${lifeState.stress}/100，社交需求${lifeState.socialNeed}/100；当前目标：${lifeState.currentGoal ?? '无'}；处境：${lifeState.situation ?? '无额外记录'}`,
      })
      for (const diary of recentDiariesByCharacter[index]) evidence.push({
        id: diary.id, kind: 'diary', content: `世界日${diary.day}/${diary.slot}：${diary.activity}。${diary.content.slice(0, 500)}`,
      })
      for (const perceived of bundle.perceivedEvents.slice(0, 12)) {
        const event = recentEventById.get(perceived.eventId)
        if (event) evidence.push({ id: event.id, kind: event.type === 'scheduleDeviation' ? 'recentDeviation' : 'event', content: `世界步${event.worldStep}：${event.content.slice(0, 500)}` })
      }
      for (const appointment of appointments.filter((item) => item.participantIds.includes(contact.id) && item.day === next.day && item.slot === next.slot)) {
        evidence.push({ id: appointment.id, kind: 'appointment', content: `当前时段已计划约定：在${appointment.locationId}${appointment.description}` })
      }
      if (directedEvent?.participantIds.includes(contact.id)) evidence.push({ id: directedEvent.id, kind: 'event', content: `本时段确定发生：${directedEvent.summary}；地点${directedEvent.locationId}` })
      evidenceByCharacter.set(contact.id, [...new Map(evidence.map((item) => [item.id, item])).values()])
    }
    const evidenceText = contacts.map((contact) => {
      const resolved = resolveSchedule(schedules.filter((item) => item.characterId === contact.id), next.day, next.slot)
      const scheduleText = resolved ? `当前胜出日程 scheduleId=${resolved.id}; adherence=${effectiveScheduleAdherence(resolved)}; priority=${resolved.priority}; location=${resolved.locationId}; activity=${resolved.activity}` : '当前无可用日程'
      return `角色 ${contact.id}：${scheduleText}\n可引用证据：\n${(evidenceByCharacter.get(contact.id) ?? []).map((item) => `- ${item.id} [${item.kind}] ${item.content}`).join('\n')}`
    }).join('\n\n')
    const mandatoryRoster = bundles.map((bundle, index) => formatLogicContext(bundle, { includeLocationTree: index === 0 })).join('\n\n---\n\n')
    if (mandatoryRoster.length > 180_000) throw new Error('全部角色的强制逻辑上下文过大，请精简地点描述或角色人设后重试；系统不会省略地点树、日程、约定或人设边界')
    let roster = mandatoryRoster
    for (const bundle of bundles) {
      const optionalWorldbook = `\n\n【${bundle.subject.character.name}相关世界书】\n${bundle.worldbookText || '无'}`
      if (roster.length + optionalWorldbook.length > 200_000) break
      roster += optionalWorldbook
    }
    const pendingText = pending.map((item) => `${item.id} conversation=${item.conversationId} recipients=${item.recipientIds.join(',')}`).join('\n') || '无'
    const prompt = `你是ChatSLG世界回合结算器。规则决定事实，你只在规则内演绎。一次结算所有角色，只输出JSON。

世界版本:${world.worldVersion}
从:${modelWorldTimeText(world)}
到:${modelWorldTimeText(next)}
到达时季节与天气:${formatWeatherForModel(nextWeather)}
用户位置:${world.playerLocationId}

【角色硬状态】
${roster}

【待回复手机消息】
${pendingText}

【稀疏事件导演】
${directedEventPrompt(directedEvent)}

【日程偏离可核验证据】
${evidenceText}

输出格式:
{"worldVersion":${world.worldVersion},"characters":[{"characterId":"必须逐个覆盖全部角色","locationId":"合法叶子地点ID","activity":"当前活动","diary":"第一人称或贴合角色的本时段真实日志","scheduleDecision":{"characterId":"同一角色ID","scheduleId":"当前胜出日程ID","targetLocationId":"必须等于本项locationId","activity":"必须等于本项activity","reason":"为什么本时段要偏离","evidenceIds":["上面可引用证据中的真实ID"]},"learnedFacts":[{"content":"本时段值得长期记住的事实","importance":0.6,"emotionalWeight":0.3,"confidence":0.9}],"outfitChange":{"patch":{"outerwear":"确实换上的外套"},"reason":"为什么当前活动确实需要换装"}}],"phoneReplies":[{"conversationId":"只可使用上面的待回复会话","characterId":"回复角色ID","messages":["短消息"]}],"moments":[{"characterId":"角色ID","content":"必须来自该角色本轮日志的动态"}]}

硬规则:
- 每个角色恰好一项，不能漏、不能重复、不能创建新角色或地点。
- commitment高于override，override高于base；有明确约定必须优先赴约。
- 必须先按当前胜出日程行动。遵循日程时locationId和activity必须逐字复制当前胜出日程。只要要改变地点或活动，就必须输出scheduleDecision；提案必须解释本时段的具体偏离并引用可核验证据ID，之后由独立裁决器批准或拒绝。不得把人格描述当成疾病、事故或外部阻碍，也不得自行宣称提案已获批准。地点与活动均不偏离时省略scheduleDecision。
- 到达时的季节与天气是代码确定的硬状态。活动、日志、户外环境和必要衣着必须相容；天气不能自行改变、不能自动取消明确约定，也不要让所有角色机械地谈论天气。
- 角色只能记住自己参与的事情；不要让不在场角色知道别处发生的细节。
- 不要输出encounters或自行新增突发事件；只有【稀疏事件导演】明确给出的事件才确实发生。参与者的activity和diary应自然反映该事件，其他角色不得知道现场细节。
- 衣着是硬状态。只有睡觉、上班、运动或外出等当前活动确实需要换装时才输出outfitChange；只写变化部位和原因，不要输出sourceScheduleId，最高优先级日程由代码自动绑定。没有必要时省略。
- 最多3条朋友圈；没有值得发的内容可以空数组。`
    let raw = await chatCompletion({
      apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model,
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: '推进到下一时段' }],
      jsonMode: true, purpose: 'other', automatic: false,
    })
    const parentIds = new Set(locations.map((item) => item.parentId).filter((id): id is string => !!id))
    const leafLocationIds = new Set(locations.filter((item) => !parentIds.has(item.id)).map((item) => item.id))
    const parseWithUtilityRepair = async (text: string) => {
      try { return parseWorldTurn(text) }
      catch {
        const repaired = await repairWorldTurnJson(text, settings)
        return parseWorldTurn(repaired)
      }
    }
    const adjudicationCache = new Map<string, Promise<Map<string, ScheduleDeviationVerdict>>>()
    const adjudicateParsedTurn = (turn: ParsedWorldTurn): Promise<Map<string, ScheduleDeviationVerdict>> => {
      const candidates: ScheduleDeviationCandidate[] = []
      for (const item of turn.characters ?? []) {
        const schedule = resolveSchedule(schedules.filter((row) => row.characterId === item.characterId), next.day, next.slot)
        if (!schedule || (item.locationId === schedule.locationId && item.activity.trim() === schedule.activity.trim())) continue
        const value = item.scheduleDecision as Partial<ScheduleDeviationProposal> | undefined
        if (!value
          || value.characterId !== item.characterId
          || value.scheduleId !== schedule.id
          || value.targetLocationId !== item.locationId
          || value.activity !== item.activity
          || typeof value.reason !== 'string'
          || !Array.isArray(value.evidenceIds)) continue
        const lastDeviation = recentWorldEvents
          .filter((event) => event.type === 'scheduleDeviation' && event.actorId === item.characterId)
          .sort((a, b) => b.worldStep - a.worldStep)[0]
        candidates.push({
          proposal: {
            characterId: value.characterId, scheduleId: value.scheduleId,
            targetLocationId: value.targetLocationId, activity: value.activity,
            reason: value.reason, evidenceIds: value.evidenceIds.filter((id): id is string => typeof id === 'string'),
          },
          schedule,
          evidence: evidenceByCharacter.get(item.characterId) ?? [],
          stepsSinceLastDeviation: lastDeviation ? next.step - lastDeviation.worldStep : undefined,
        })
      }
      const cacheKey = JSON.stringify(candidates.map((candidate) => candidate.proposal))
      const cached = adjudicationCache.get(cacheKey)
      if (cached) return cached
      const promise = adjudicateScheduleDeviations(candidates, settings)
      adjudicationCache.set(cacheKey, promise)
      return promise
    }
    let parsed: ParsedWorldTurn
    let initialFailure = ''
    try { parsed = await parseWithUtilityRepair(raw) }
    catch (err) {
      initialFailure = err instanceof Error ? err.message : String(err)
      parsed = { worldVersion: world.worldVersion, characters: [] }
    }
    let deviationVerdicts = initialFailure ? new Map<string, ScheduleDeviationVerdict>() : await adjudicateParsedTurn(parsed)
    let fatalIssues = initialFailure
      ? [{ code: 'invalid_json', message: initialFailure }]
      : collectFatalWorldTurnIssues(parsed, { worldVersion: world.worldVersion, contacts, locationIds: leafLocationIds, schedules, day: next.day, slot: next.slot, directedEvent, deviationVerdicts })
    if (fatalIssues.length > 0) {
      const feedback = fatalIssues.map((issue, index) => `${index + 1}. ${issue.message}`).join('\n')
      raw = await chatCompletion({
        apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: '推进到下一时段' },
          { role: 'assistant', content: raw },
          { role: 'user', content: `上一版世界回合存在以下权威错误：\n${feedback}\n请依据原始完整上下文重写整个JSON。不要解释，不要输出Markdown，不要输出encounters。` },
        ],
        jsonMode: true, purpose: 'other', automatic: false, thinking: 'disabled', temperature: 0.35,
      })
      parsed = await parseWithUtilityRepair(raw)
      deviationVerdicts = await adjudicateParsedTurn(parsed)
      fatalIssues = collectFatalWorldTurnIssues(parsed, { worldVersion: world.worldVersion, contacts, locationIds: leafLocationIds, schedules, day: next.day, slot: next.slot, directedEvent, deviationVerdicts })
      if (fatalIssues.length > 0) throw new Error(`主模型重写后世界回合仍有权威错误：${fatalIssues.map((issue) => issue.message).join('；')}`)
    }
    sanitizeOptionalWorldTurn(parsed, contacts, pending)
    parsed.phoneReplies = await filterGroundedPhoneReplies(parsed, pending, settings).catch((err) => {
      console.warn('[world-turn] 多功能模型校验手机回复失败，本轮不自动发送手机回复', err)
      return []
    })
    parsed.moments = await filterGroundedMoments(parsed, settings).catch((err) => {
      console.warn('[world-turn] 多功能模型校验朋友圈失败，本轮不自动发布朋友圈', err)
      return []
    })
    parsed.directedEvent = directedEvent ?? undefined
    validateWorldTurn(parsed, {
      worldVersion: world.worldVersion, contacts, locationIds: leafLocationIds,
      schedules, day: next.day, slot: next.slot, pending, deviationVerdicts,
    })
    const now = Date.now()
    const eventIds = new Map<string, string>()
    await db.transaction('rw', [db.worldState, db.contacts, db.characterDiaries, db.worldEvents, db.contactMemories, db.messages, db.conversations, db.pendingPhoneMessages, db.moments, db.appointments, db.aiTurns, db.perceivedEvents], async () => {
      const latestWorld = await db.worldState.get('global')
      if (!latestWorld || latestWorld.worldVersion !== world.worldVersion || latestWorld.step !== world.step) throw new Error('世界已变化，本回合已整体取消')
      const directedEventIds = new Map<string, string[]>()
      if (directedEvent) {
        await db.worldEvents.add({
          id: directedEvent.id,
          type: directedEvent.kind,
          worldStep: next.step,
          worldDay: next.day,
          worldSlot: next.slot,
          locationId: directedEvent.locationId,
          actorId: directedEvent.participantIds.find((id) => id !== 'user') ?? 'world',
          participantIds: [...new Set(directedEvent.participantIds)],
          content: directedEvent.summary,
          visibility: directedEvent.visibility,
          directedEventKey: directedEvent.key,
          importance: directedEvent.importance,
          createdAt: now,
        })
        const perceivers = directedEvent.visibility === 'public'
          ? contacts.map((contact) => contact.id)
          : directedEvent.participantIds.filter((id) => id !== 'user')
        for (const characterId of new Set(perceivers)) {
          await db.perceivedEvents.add({ id: uuid(), eventId: directedEvent.id, characterId, perception: 'full', observedAtStep: next.step })
          if (directedEvent.participantIds.includes(characterId)) directedEventIds.set(characterId, [directedEvent.id])
        }
      }
      for (const result of parsed.characters) {
        const eventId = uuid()
        eventIds.set(result.characterId, eventId)
        await db.contacts.update(result.characterId, { currentLocationId: result.locationId })
        await db.worldEvents.add({ id: eventId, type: 'log', worldStep: next.step, locationId: result.locationId, actorId: result.characterId, participantIds: [result.characterId], content: result.diary.trim(), visibility: 'private', createdAt: now })
        const sourceEventIds = [eventId, ...(directedEventIds.get(result.characterId) ?? [])]
        const resolved = resolveSchedule(schedules.filter((item) => item.characterId === result.characterId), next.day, next.slot)
        const deviationVerdict = deviationVerdicts.get(result.characterId)
        if (resolved && (result.locationId !== resolved.locationId || result.activity.trim() !== resolved.activity.trim()) && deviationVerdict?.allow && result.scheduleDecision) {
          const deviationEventId = uuid()
          await db.worldEvents.add({
            id: deviationEventId, type: 'scheduleDeviation', worldStep: next.step, worldDay: next.day, worldSlot: next.slot,
            locationId: result.locationId, actorId: result.characterId, participantIds: [result.characterId],
            content: `原计划在${resolved.locationId}${resolved.activity}，本时段实际改为在${result.locationId}${result.activity}。${result.scheduleDecision.reason.trim()}`,
            visibility: 'private', importance: deviationVerdict.impact === 'critical' ? .95 : deviationVerdict.impact === 'high' ? .8 : deviationVerdict.impact === 'moderate' ? .55 : .35,
            scheduleId: resolved.id, plannedLocationId: resolved.locationId, actualLocationId: result.locationId,
            deviationReason: result.scheduleDecision.reason.trim().slice(0, 240), deviationImpact: deviationVerdict.impact,
            adjudicationConfidence: deviationVerdict.confidence, evidenceIds: deviationVerdict.evidenceIds,
            adjudicationExplanation: deviationVerdict.explanation, createdAt: now,
          })
          await db.perceivedEvents.add({ id: uuid(), eventId: deviationEventId, characterId: result.characterId, perception: 'full', observedAtStep: next.step })
          sourceEventIds.push(deviationEventId)
        }
        if (result.outfitChange) {
          const contact = contacts.find((item) => item.id === result.characterId)!
          const outfitEventId = uuid()
          await db.contacts.update(result.characterId, { outfit: { ...defaultOutfit(contact.createdAt), ...contact.outfit, ...result.outfitChange.patch, updatedAt: now, sourceEventIds: [eventId] } })
          await db.worldEvents.add({ id: outfitEventId, type: 'outfit', worldStep: next.step, locationId: result.locationId, actorId: result.characterId, participantIds: [result.characterId], content: result.outfitChange.reason.trim(), visibility: 'private', createdAt: now })
          await db.perceivedEvents.add({ id: uuid(), eventId: outfitEventId, characterId: result.characterId, perception: 'full', observedAtStep: next.step })
          sourceEventIds.push(outfitEventId)
        }
        await db.characterDiaries.add({ id: uuid(), characterId: result.characterId, worldStep: next.step, day: next.day, slot: next.slot, locationId: result.locationId, activity: result.activity.trim(), content: result.diary.trim(), sourceEventIds, createdAt: now })
        for (const fact of result.learnedFacts ?? []) {
          if (!fact.content?.trim()) continue
          await db.contactMemories.add({ id: uuid(), contactId: result.characterId, scope: 'private', category: '四季日常', kind: 'world_state', content: fact.content.trim(), tags: ['世界回合'], importance: Math.max(0, Math.min(1, fact.importance ?? .5)), emotionalWeight: Math.max(0, Math.min(1, fact.emotionalWeight ?? .3)), confidence: Math.max(0, Math.min(1, fact.confidence ?? .9)), sourceMessageIds: [], sourceEventIds, status: 'active', pinned: false, createdAt: now, updatedAt: now, usageCount: 0 })
        }
      }
      for (const reply of parsed.phoneReplies ?? []) {
        const conversation = await db.conversations.get(reply.conversationId)
        if (!conversation || (conversation.contactId !== reply.characterId && !conversation.groupId)) continue
        for (const content of reply.messages.filter((item) => item.trim()).slice(0, 5)) {
          await db.messages.add({ id: uuid(), conversationId: reply.conversationId, role: 'assistant', type: 'text', content: content.trim(), speakerContactId: conversation.groupId ? reply.characterId : undefined, createdAt: now })
        }
        await db.conversations.update(reply.conversationId, { updatedAt: now })
        const queued = pending.filter((item) => item.conversationId === reply.conversationId && item.recipientIds.includes(reply.characterId))
        for (const item of queued) {
          await db.pendingPhoneMessages.update(item.id, { status: 'delivered' })
          await db.perceivedEvents.add({ id: uuid(), eventId: item.messageId, characterId: reply.characterId, perception: 'full', observedAtStep: next.step })
        }
      }
      for (const moment of (parsed.moments ?? []).slice(0, 3)) {
        const sourceEventId = eventIds.get(moment.characterId)
        if (!sourceEventId) throw new Error('朋友圈缺少对应角色日志事件')
        await db.moments.add({ id: uuid(), contactId: moment.characterId, content: moment.content.trim(), sourceEventIds: [sourceEventId], createdAt: now })
      }
      for (const appointment of appointments.filter((item) => item.day === next.day && item.slot === next.slot)) {
        const participantsHere = appointment.participantIds.every((id) => id === 'user' ? world.playerLocationId === appointment.locationId : parsed.characters.find((item) => item.characterId === id)?.locationId === appointment.locationId)
        await db.appointments.update(appointment.id, { status: participantsHere ? 'fulfilled' : 'missed', resolvedAt: now })
      }
      await archiveSceneConversationsForStep(world.step, world.day, world.slot, now)
      await db.aiTurns.add({
        id: uuid(), conversationId: `world-turn:${next.step}`, raw, parsed, knowledgeQueries: [],
        logicTrace: {
          worldVersion: world.worldVersion, locationTreeVersion: world.worldVersion,
          personaSummaries: contacts.map((contact) => contact.systemPrompt.slice(0, 500)),
          schedules: schedules.map((item) => `${item.characterId}/${item.priority}/${item.effectiveDay ?? item.dayOfWeek}/${item.slot}@${item.locationId}`),
          appointmentIds: appointments.map((item) => item.id),
          memoryIds: [...memories.values()].flat().map((item) => item.id),
          perceivedEventIds: [], validation: 'passed',
        },
        createdAt: now,
      })
      await db.worldState.put({ ...world, ...next, advancing: false, updatedAt: now })
    })
    await refreshConstraintsForWorld(next.day, next.slot)
    await settleSalaries(next.day).catch((error) => console.error('[world-turn] 世界日工资结算失败，将在下一时段重试', error))
    if (isModuleEnabled('lifeSimulation')) await settleLifeSimulationForWorldTurn(next).catch((error) => console.error('[world-turn] 世界生活状态结算失败，将在下一时段补算', error))
    await maybeArchiveMemories(next.step)
  })().finally(() => { running = null })
  return running
}
