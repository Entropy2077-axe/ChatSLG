import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { chatCompletion } from './deepseek'
import { extractJsonObject } from './aiProtocol'
import { ensureWorldInitialized, nextWorldClock, resolveSchedule } from './world'
import { buildLogicContext, formatLogicContext } from './logicContext'
import type { AppSettings, CharacterSchedule, Contact, PendingPhoneMessage, TimeSlot } from '../types'
import { defaultOutfit } from './outfit'

interface TurnCharacter {
  characterId: string
  locationId: string
  activity: string
  diary: string
  learnedFacts?: Array<{ content: string; importance?: number; emotionalWeight?: number; confidence?: number }>
  outfitChange?: { patch: Record<string, string>; sourceScheduleId: string; reason: string }
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

interface TurnEncounter {
  participantIds: string[]
  locationId: string
  summary: string
}

interface ParsedWorldTurn {
  worldVersion: number
  characters: TurnCharacter[]
  phoneReplies?: TurnPhoneReply[]
  moments?: TurnMoment[]
  encounters?: TurnEncounter[]
}

let running: Promise<void> | null = null

function parseWorldTurn(raw: string): ParsedWorldTurn {
  const json = extractJsonObject(raw)
  if (!json) throw new Error('世界回合没有返回有效JSON')
  const parsed = JSON.parse(json) as Partial<ParsedWorldTurn>
  if (!Number.isInteger(parsed.worldVersion) || !Array.isArray(parsed.characters)) throw new Error('世界回合格式不完整')
  return parsed as ParsedWorldTurn
}

export function validateWorldTurn(parsed: ParsedWorldTurn, opts: {
  worldVersion: number
  contacts: Contact[]
  locationIds: Set<string>
  schedules: CharacterSchedule[]
  day: number
  slot: TimeSlot
  pending: PendingPhoneMessage[]
}): void {
  const { worldVersion, contacts, locationIds, schedules, day, slot, pending } = opts
  if (parsed.worldVersion !== worldVersion) throw new Error('地点树已更新，请重新生成本回合')
  const expected = new Set(contacts.map((item) => item.id))
  const seen = new Set<string>()
  for (const item of parsed.characters) {
    if (!expected.has(item.characterId) || seen.has(item.characterId)) throw new Error('世界回合包含重复或未知角色')
    if (!locationIds.has(item.locationId)) throw new Error(`角色引用了不存在的地点: ${item.locationId}`)
    if (!item.activity?.trim() || !item.diary?.trim()) throw new Error('角色活动或日志为空')
    const resolved = resolveSchedule(schedules.filter((schedule) => schedule.characterId === item.characterId), day, slot)
    if (resolved && item.locationId !== resolved.locationId) throw new Error(`角色 ${item.characterId} 违反了${resolved.priority}日程`)
    if (item.outfitChange) {
      if (!resolved || item.outfitChange.sourceScheduleId !== resolved.id) throw new Error('换装提案没有引用当前最高优先级日程')
      const keys = Object.keys(item.outfitChange.patch ?? {})
      if (!keys.length || keys.some((key) => !['head', 'top', 'bottom', 'outerwear', 'footwear', 'accessories'].includes(key)) || keys.some((key) => typeof item.outfitChange!.patch[key] !== 'string' || !item.outfitChange!.patch[key].trim()) || !item.outfitChange.reason?.trim()) throw new Error('换装提案格式无效')
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
  for (const encounter of parsed.encounters ?? []) {
    const participantIds = [...new Set(encounter.participantIds ?? [])]
    if (participantIds.length < 2 || !locationIds.has(encounter.locationId) || !encounter.summary?.trim()) throw new Error('相遇事件格式无效')
    for (const id of participantIds) {
      if (!expected.has(id) || parsed.characters.find((item) => item.characterId === id)?.locationId !== encounter.locationId) throw new Error('相遇事件包含不在同一地点的角色')
    }
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
      return
    }
    if (!settings.apiKey) throw new Error('请先在设置中配置 API Key')
    const bundles = await Promise.all(contacts.map((contact) => buildLogicContext({
      subjectId: contact.id, participantIds: contacts.map((item) => item.id), query: '推进世界时间，结算全部角色的日程、约定、日志、消息和朋友圈',
    })))
    const locations = bundles[0].locations
    const scheduleMap = new Map(bundles.flatMap((bundle) => [...bundle.subject.baseSchedule, ...bundle.subject.scheduleOverrides]).map((item) => [item.id, item]))
    const schedules = [...scheduleMap.values()]
    const appointments = bundles[0].appointments.filter((item) => item.status === 'planned')
    const pendingMap = new Map(bundles.flatMap((bundle) => bundle.pendingMessages).map((item) => [item.id, item]))
    const pending = [...pendingMap.values()]
    const memories = new Map(bundles.map((bundle) => [bundle.subject.character.id, bundle.memories.slice(0, 6)]))
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
从:第${world.day}天/${world.slot}/${world.hour}:00
到:第${next.day}天/${next.slot}/${next.hour}:00
用户位置:${world.playerLocationId}

【角色硬状态】
${roster}

【待回复手机消息】
${pendingText}

输出格式:
{"worldVersion":${world.worldVersion},"characters":[{"characterId":"必须逐个覆盖全部角色","locationId":"合法叶子地点ID","activity":"当前活动","diary":"第一人称或贴合角色的本时段真实日志","learnedFacts":[{"content":"本时段值得长期记住的事实","importance":0.6,"emotionalWeight":0.3,"confidence":0.9}],"outfitChange":{"patch":{"outerwear":"确实换上的外套"},"sourceScheduleId":"当前实际采用的日程ID","reason":"为什么该日程确实需要换装"}}],"encounters":[{"participantIds":["至少两个同地点角色ID"],"locationId":"合法且参与者实际所在地点","summary":"共同发生的可感知事件"}],"phoneReplies":[{"conversationId":"只可使用上面的待回复会话","characterId":"回复角色ID","messages":["短消息"]}],"moments":[{"characterId":"角色ID","content":"必须来自该角色本轮日志的动态"}]}

硬规则:
- 每个角色恰好一项，不能漏、不能重复、不能创建新角色或地点。
- commitment高于override，override高于base；有明确约定必须优先赴约。
- 初始日程是低优先级生活惯例，没有约定时可在合理范围内变化，但地点必须存在。
- 角色只能记住自己参与的事情；不要让不在场角色知道别处发生的细节。
- 衣着是硬状态。只有睡觉、上班、运动或外出等当前日程确实需要换装时才输出outfitChange；只写变化部位并引用当前采用的日程ID，没有必要时省略。
- 最多3条朋友圈；没有值得发的内容可以空数组。`
    const raw = await chatCompletion({
      apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model,
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: '推进到下一时段' }],
      jsonMode: true, purpose: 'other', automatic: false,
    })
    const parsed = parseWorldTurn(raw)
    const parentIds = new Set(locations.map((item) => item.parentId).filter((id): id is string => !!id))
    const leafLocationIds = new Set(locations.filter((item) => !parentIds.has(item.id)).map((item) => item.id))
    validateWorldTurn(parsed, {
      worldVersion: world.worldVersion, contacts, locationIds: leafLocationIds,
      schedules, day: next.day, slot: next.slot, pending,
    })
    const now = Date.now()
    const eventIds = new Map<string, string>()
    await db.transaction('rw', [db.worldState, db.contacts, db.characterDiaries, db.worldEvents, db.contactMemories, db.messages, db.conversations, db.pendingPhoneMessages, db.moments, db.appointments, db.aiTurns, db.perceivedEvents], async () => {
      const latestWorld = await db.worldState.get('global')
      if (!latestWorld || latestWorld.worldVersion !== world.worldVersion || latestWorld.step !== world.step) throw new Error('世界已变化，本回合已整体取消')
      const encounterEventIds = new Map<string, string[]>()
      for (const encounter of parsed.encounters ?? []) {
        const encounterId = uuid()
        await db.worldEvents.add({ id: encounterId, type: 'encounter', worldStep: next.step, locationId: encounter.locationId, actorId: encounter.participantIds[0], participantIds: [...new Set(encounter.participantIds)], content: encounter.summary.trim(), visibility: 'scene', createdAt: now })
        for (const characterId of new Set(encounter.participantIds)) {
          const ids = encounterEventIds.get(characterId) ?? []; ids.push(encounterId); encounterEventIds.set(characterId, ids)
          await db.perceivedEvents.add({ id: uuid(), eventId: encounterId, characterId, perception: 'full', observedAtStep: next.step })
        }
      }
      for (const result of parsed.characters) {
        const eventId = uuid()
        eventIds.set(result.characterId, eventId)
        await db.contacts.update(result.characterId, { currentLocationId: result.locationId })
        await db.worldEvents.add({ id: eventId, type: 'log', worldStep: next.step, locationId: result.locationId, actorId: result.characterId, participantIds: [result.characterId], content: result.diary.trim(), visibility: 'private', createdAt: now })
        const sourceEventIds = [eventId, ...(encounterEventIds.get(result.characterId) ?? [])]
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
    await maybeArchiveMemories(next.step)
  })().finally(() => { running = null })
  return running
}
