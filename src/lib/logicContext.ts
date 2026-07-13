import { db } from '../db/db'
import { retrieveWorldbookTrace } from './worldbook'
import { ensureWorldInitialized, formatLocationTree } from './world'
import type {
  Appointment, CharacterSchedule, Contact, ContactMemory, LocationNode,
  Message, PerceivedEvent, PendingPhoneMessage, WorldbookEntry,
} from '../types'
import { outfitText } from './outfit'

export interface CharacterLogicState {
  character: Contact
  currentLocationId: string
  baseSchedule: CharacterSchedule[]
  scheduleOverrides: CharacterSchedule[]
  commitments: Appointment[]
}

export interface LogicContextBundle {
  worldVersion: number
  clock: { day: number; slot: string; hour: number; step: number }
  playerLocationId: string
  locations: LocationNode[]
  locationTreeText: string
  subject: CharacterLogicState
  participants: CharacterLogicState[]
  perceivedEvents: PerceivedEvent[]
  perceivedEventText: string
  recentMessages: Message[]
  memories: ContactMemory[]
  worldbookEntries: WorldbookEntry[]
  worldbookText: string
  pendingMessages: PendingPhoneMessage[]
  appointments: Appointment[]
}

export const MAX_LOGIC_CONTEXT_CHARS = 80_000

function personaText(contact: Contact): string {
  const profile = contact.personaProfile
  return [
    contact.systemPrompt,
    contact.personaConstraints ? `用户明确设定：${contact.personaConstraints}` : '',
    contact.occupation ? `职业：${contact.occupation}` : '',
    `当前衣着（数据库硬状态）：${outfitText(contact.outfit)}`,
    profile?.facts.length ? `稳定事实：${profile.facts.join('；')}` : '',
    profile?.boundaries.length ? `边界：${profile.boundaries.join('；')}` : '',
    profile?.habits.length ? `习惯：${profile.habits.join('；')}` : '',
    profile?.behaviorAnchors.length ? `行为锚点：${profile.behaviorAnchors.join('；')}` : '',
    contact.speechSamples?.length ? `语言样例：${contact.speechSamples.slice(0, 8).join(' / ')}` : '',
  ].filter(Boolean).join('\n')
}

async function characterState(contact: Contact, appointments: Appointment[]): Promise<CharacterLogicState> {
  const schedules = await db.characterSchedules.where('characterId').equals(contact.id).toArray()
  return {
    character: contact,
    currentLocationId: contact.currentLocationId || 'home-living',
    baseSchedule: schedules.filter((item) => item.priority === 'base'),
    scheduleOverrides: schedules.filter((item) => item.priority !== 'base'),
    commitments: appointments.filter((item) => item.participantIds.includes(contact.id) && item.status === 'planned'),
  }
}

export async function buildLogicContext(opts: {
  subjectId: string
  participantIds?: string[]
  conversationId?: string
  query?: string
}): Promise<LogicContextBundle> {
  const world = await ensureWorldInitialized()
  const [subject, locations, appointments, pendingMessages] = await Promise.all([
    db.contacts.get(opts.subjectId), db.locations.where('worldId').equals(world.worldId).sortBy('sortOrder'),
    db.appointments.toArray(), db.pendingPhoneMessages.where('status').equals('pending').toArray(),
  ])
  if (!subject) throw new Error('角色不存在')
  const participantIds = [...new Set((opts.participantIds ?? []).filter((id) => id !== subject.id))]
  const participantContacts = (await db.contacts.bulkGet(participantIds)).filter((item): item is Contact => !!item)
  const [subjectState, participantStates, memories, perceivedEvents, recentMessages, worldbook] = await Promise.all([
    characterState(subject, appointments),
    Promise.all(participantContacts.map((item) => characterState(item, appointments))),
    db.contactMemories.where('contactId').equals(subject.id).toArray(),
    db.perceivedEvents.where('characterId').equals(subject.id).reverse().limit(40).toArray(),
    opts.conversationId ? db.messages.where('conversationId').equals(opts.conversationId).reverse().limit(40).toArray() : Promise.resolve([]),
    retrieveWorldbookTrace(opts.query || subject.name, { maxEntries: 6, maxChars: 5000 }),
  ])
  const activeMemories = memories
    .filter((item) => !item.status || item.status === 'active')
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.importance - a.importance || b.updatedAt - a.updatedAt)
    .slice(0, 20)
  const perceivedWorldEvents = await db.worldEvents.bulkGet(perceivedEvents.map((item) => item.eventId))
  const perceivedEventText = perceivedEvents.map((item, index) => {
    const event = perceivedWorldEvents[index]
    if (!event) return ''
    return item.perception === 'full'
      ? `- [完整听见/${event.id}] ${event.actorId}: ${event.content}`
      : `- [模糊听见/${event.id}] 你只知道${event.locationId ?? '附近'}有人交谈，听不清具体内容。`
  }).filter(Boolean).join('\n')
  return {
    worldVersion: world.worldVersion,
    clock: { day: world.day, slot: world.slot, hour: world.hour, step: world.step },
    playerLocationId: world.playerLocationId,
    locations,
    locationTreeText: formatLocationTree(locations),
    subject: subjectState,
    participants: participantStates,
    perceivedEvents,
    perceivedEventText,
    recentMessages: recentMessages.reverse(),
    memories: activeMemories,
    worldbookEntries: worldbook.matches.map((item) => item.entry),
    worldbookText: worldbook.text,
    pendingMessages: pendingMessages.filter((item) => item.recipientIds.includes(subject.id)),
    appointments,
  }
}

export function formatLogicContext(bundle: LogicContextBundle, opts: { includeLocationTree?: boolean; maxChars?: number } = {}): string {
  const state = bundle.subject
  const scheduleLine = (item: CharacterSchedule) => `${item.priority}:${item.dayOfWeek ?? `第${item.effectiveDay}天`}/${item.slot}@${item.locationId} ${item.activity} 手机${item.phoneAccess}`
  const treeSection = opts.includeLocationTree === false ? '' : `\n【完整有效地点树——只能引用这些地点ID】\n${bundle.locationTreeText}\n`
  const mandatory = `【ChatSLG不可违背的世界硬状态】
世界版本:${bundle.worldVersion}
当前时间:第${bundle.clock.day}天 ${String(bundle.clock.hour).padStart(2, '0')}:00(${bundle.clock.slot})
用户位置:${bundle.playerLocationId}
你的精确位置:${state.currentLocationId}
${treeSection}

【完整稳定人设】
${personaText(state.character)}

【基础日程】
${state.baseSchedule.map(scheduleLine).join('\n') || '暂无'}

【高优先级日程与约定】
${state.scheduleOverrides.map(scheduleLine).join('\n') || '暂无'}
${state.commitments.map((item) => `commitment:第${item.day}天/${item.slot}@${item.locationId} ${item.description}`).join('\n') || ''}

【规则】
- 数据库硬状态高于记忆和自然语言。不得声称自己在另一个地点，除非同时输出可验证的结构化地点变更。
- 日程或约会只能使用上面地点树里的ID；不得创造地点、角色或未经确认的共同经历。
- commitment高于override，override高于base。普通聊天不能重写base。
- 不在你的感知和记忆中的信息，你不知道。`
  const maxChars = opts.maxChars ?? MAX_LOGIC_CONTEXT_CHARS
  if (mandatory.length > maxChars) {
    throw new Error(`强制逻辑上下文已达${mandatory.length}字符，超过${maxChars}字符限制。请精简地点描述或角色人设后重试；系统不会省略地点树、日程、约定或人设边界。`)
  }
  const perceived = `\n\n【你实际感知到的场景事件】\n${bundle.perceivedEventText || '暂无'}`
  const memoryLines = bundle.memories.map((item) => `- [${item.category}/${item.kind}] ${item.content}`)
  let result = mandatory
  if (result.length + perceived.length <= maxChars) result += perceived
  const memoryHeader = '\n\n【你实际知道的独立记忆】\n'
  const keptMemories: string[] = []
  for (const line of memoryLines) {
    if (result.length + memoryHeader.length + keptMemories.join('\n').length + line.length + 1 > maxChars) break
    keptMemories.push(line)
  }
  if (keptMemories.length) result += memoryHeader + keptMemories.join('\n')
  return result
}
