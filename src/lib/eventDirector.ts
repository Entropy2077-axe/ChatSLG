import { v4 as uuid } from 'uuid'
import { chatCompletion } from './deepseek'
import { extractJsonObject } from './aiProtocol'
import { resolveSchedule } from './world'
import type {
  Appointment, AppSettings, CharacterSchedule, Contact, ContactRelationLink,
  LocationNode, TimeSlot, WorldEvent,
} from '../types'
import type { WorldWeatherSnapshot } from './worldWeather'

export type DirectedEventKind = 'seasonal' | 'weather' | 'story'

export interface DirectedEventCandidate {
  key: string
  kind: DirectedEventKind
  worldDay: number
  worldSlot: TimeSlot
  locationId?: string
  participantIds: string[]
  visibility: 'scene' | 'public'
  importance: number
  premise: string
}

export interface PreparedDirectedEvent extends DirectedEventCandidate {
  id: string
  summary: string
}

export interface EventDirectorInput {
  seed: string
  worldId: string
  day: number
  slot: TimeSlot
  step: number
  playerLocationId: string
  weather: WorldWeatherSnapshot
  contacts: Contact[]
  locations: LocationNode[]
  schedules: CharacterSchedule[]
  appointments: Appointment[]
  relations: ContactRelationLink[]
  recentEvents: WorldEvent[]
}

const GENERAL_COOLDOWN_STEPS = 12
const SOCIAL_COOLDOWN_STEPS = 20
const PAIR_REPEAT_WINDOW_STEPS = 120

function hash01(text: string): number {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  hash ^= hash >>> 16
  return (hash >>> 0) / 4294967296
}

function directedEvents(events: WorldEvent[]): WorldEvent[] {
  return events.filter((event) => !!event.directedEventKey && ['seasonal', 'weather', 'story'].includes(event.type))
}

function pairKey(ids: string[]): string {
  return [...ids].sort().join(':')
}

function predictedLocation(contact: Contact, schedules: CharacterSchedule[], day: number, slot: TimeSlot): string | undefined {
  return resolveSchedule(schedules.filter((item) => item.characterId === contact.id), day, slot)?.locationId ?? contact.currentLocationId
}

function seasonalCandidate(input: EventDirectorInput, existingKeys: Set<string>): DirectedEventCandidate | null {
  if (input.slot !== 'morning' || input.weather.calendar.seasonDay !== 1) return null
  const key = `season:${input.weather.calendar.year}:${input.weather.calendar.season}`
  if (existingKeys.has(key)) return null
  return {
    key, kind: 'seasonal', worldDay: input.day, worldSlot: input.slot,
    participantIds: [], visibility: 'public', importance: 3,
    premise: `${input.weather.calendar.season}的第一天，季节交替已经能从公共环境中被自然察觉。只描写一个安静、具体的换季迹象，不制造节庆、灾害或重大社会活动。`,
  }
}

function appointmentCandidate(input: EventDirectorInput, existingKeys: Set<string>, stepsSinceLast: number): DirectedEventCandidate | null {
  if (stepsSinceLast < 8) return null
  const appointment = input.appointments
    .filter((item) => item.status === 'planned' && item.day === input.day && item.slot === input.slot)
    .sort((a, b) => a.id.localeCompare(b.id))
    .find((item) => !existingKeys.has(`appointment:${item.id}`) && item.participantIds.every((id) => {
      if (id === 'user') return input.playerLocationId === item.locationId
      const contact = input.contacts.find((row) => row.id === id)
      return !!contact && predictedLocation(contact, input.schedules, input.day, input.slot) === item.locationId
    }))
  if (!appointment) return null
  return {
    key: `appointment:${appointment.id}`, kind: 'story', worldDay: input.day, worldSlot: input.slot,
    locationId: appointment.locationId, participantIds: [...new Set(appointment.participantIds)],
    visibility: 'scene', importance: 3,
    premise: `已确认约定“${appointment.description}”正在${appointment.locationId}成行。生成一个不改变约定结果、不制造迟到失约、只影响现场气氛的微小插曲。`,
  }
}

function weatherCandidate(input: EventDirectorInput, existingKeys: Set<string>, stepsSinceLast: number): DirectedEventCandidate | null {
  if (stepsSinceLast < GENERAL_COOLDOWN_STEPS) return null
  if (input.weather.label !== '雷雨' && input.weather.label !== '大雪') return null
  if (hash01(`${input.seed}:weather-event:${input.day}:${input.slot}`) >= 0.42) return null
  const key = `weather:${input.weather.calendar.year}:${input.day}:${input.weather.kind}`
  if (existingKeys.has(key)) return null
  return {
    key, kind: 'weather', worldDay: input.day, worldSlot: input.slot,
    participantIds: [], visibility: 'public', importance: 2,
    premise: `${input.weather.label}使公共环境出现一个短暂、可观察的小变化。不得升级成受伤、灾害、停电、封路或财产损失。`,
  }
}

function socialCandidate(input: EventDirectorInput, existingKeys: Set<string>, stepsSinceLast: number): DirectedEventCandidate | null {
  if (stepsSinceLast < SOCIAL_COOLDOWN_STEPS) return null
  if (hash01(`${input.seed}:social-event-gate:${input.day}:${input.slot}`) >= 0.34) return null
  const contactIds = new Set(input.contacts.map((contact) => contact.id))
  const byId = new Map(input.contacts.map((contact) => [contact.id, contact]))
  const locationByContact = new Map(input.contacts.map((contact) => [contact.id, predictedLocation(contact, input.schedules, input.day, input.slot)]))
  const seenPairs = new Set<string>()
  const recentPairKeys = new Set(directedEvents(input.recentEvents)
    .filter((event) => input.step - event.worldStep <= PAIR_REPEAT_WINDOW_STEPS && event.participantIds.length >= 2)
    .map((event) => pairKey(event.participantIds)))
  const options = input.relations.flatMap((relation) => {
    if (!contactIds.has(relation.fromContactId) || !contactIds.has(relation.toContactId)) return []
    const ids = [relation.fromContactId, relation.toContactId].sort()
    const pair = pairKey(ids)
    if (seenPairs.has(pair) || recentPairKeys.has(pair)) return []
    seenPairs.add(pair)
    const locationId = locationByContact.get(ids[0])
    if (!locationId || locationByContact.get(ids[1]) !== locationId) return []
    const location = input.locations.find((item) => item.id === locationId)
    if (!location) return []
    const affinity = relation.affinity ?? 0
    const familiarity = relation.familiarity ?? 0
    const tension = relation.tension ?? 0
    return [{ ids, pair, location, relation, score: affinity + familiarity * .4 + tension * .25 + hash01(`${input.seed}:${input.step}:${pair}`) * 20 }]
  }).sort((a, b) => b.score - a.score || a.pair.localeCompare(b.pair))
  const chosen = options[0]
  if (!chosen) return null
  const first = byId.get(chosen.ids[0])!, second = byId.get(chosen.ids[1])!
  const key = `social:${input.day}:${input.slot}:${chosen.location.id}:${chosen.pair}`
  if (existingKeys.has(key)) return null
  return {
    key, kind: 'story', worldDay: input.day, worldSlot: input.slot,
    locationId: chosen.location.id, participantIds: chosen.ids, visibility: 'scene', importance: 2,
    premise: `${first.name}和${second.name}按各自日程出现在${chosen.location.name}，关系为${chosen.relation.label}，动态为${chosen.relation.dynamicSummary || '暂无特殊变化'}。生成一个符合当前关系和地点的日常小插曲；不升级关系、不替角色作重大决定，也不创造第三人。`,
  }
}

/** Selects at most one candidate. Season boundaries have first priority;
 * ordinary events share a global cooldown, and social pairs have a longer
 * repeat window. All gates are derived from the world seed. */
export function chooseDirectedEventCandidate(input: EventDirectorInput): DirectedEventCandidate | null {
  const previous = directedEvents(input.recentEvents)
  const existingKeys = new Set(previous.map((event) => event.directedEventKey!))
  const lastStep = previous.reduce((latest, event) => Math.max(latest, event.worldStep), -Infinity)
  const stepsSinceLast = Number.isFinite(lastStep) ? input.step - lastStep : Infinity
  return seasonalCandidate(input, existingKeys)
    ?? appointmentCandidate(input, existingKeys, stepsSinceLast)
    ?? weatherCandidate(input, existingKeys, stepsSinceLast)
    ?? socialCandidate(input, existingKeys, stepsSinceLast)
}

export async function prepareDirectedEvent(input: EventDirectorInput, settings: AppSettings): Promise<PreparedDirectedEvent | null> {
  const candidate = chooseDirectedEventCandidate(input)
  if (!candidate) return null
  const participants = candidate.participantIds.map((id) => {
    if (id === 'user') return { id, name: settings.userNickname || '用户', persona: '玩家本人' }
    const contact = input.contacts.find((item) => item.id === id)
    return contact ? { id, name: contact.name, persona: contact.systemPrompt.slice(0, 500) } : { id, name: id, persona: '' }
  })
  const location = candidate.locationId ? input.locations.find((item) => item.id === candidate.locationId) : undefined
  const raw = await chatCompletion({
    apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.utilityModel || settings.model,
    jsonMode: true, thinking: 'disabled', temperature: .45, maxTokens: 500, purpose: 'other', automatic: false,
    messages: [{ role: 'system', content: `你是ChatSLG稀疏事件润色器。代码已经决定本时段是否发生事件、事件类型、地点和参与者；你只能把给定前提写成一条35到100字的可观察事件摘要。
只输出JSON：{"summary":"..."}。
硬规则：不得添加未列出的角色或地点；不得造成受伤、灾害、犯罪、失踪、财产损失、停电封路、关系突变、重大决定或新的长期承诺；不得改变天气、约定结果和角色位置；不要写后续结果；公共季节/天气事件不得点名角色；语言克制具体，不写空泛抒情，不把普通小事包装成命运转折。

事件类型:${candidate.kind}
世界日与时段:第${candidate.worldDay}天/${candidate.worldSlot}
地点:${location ? `${location.name}(${location.id})` : '公共环境'}
参与者:${JSON.stringify(participants)}
代码前提:${candidate.premise}` }],
  })
  const json = extractJsonObject(raw)
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as { summary?: unknown }
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 140) : ''
    if (summary.length < 15 || /受伤|死亡|失踪|停电|封路|被盗|抢劫|火灾|爆炸|车祸|告白|分手|结婚|辞职|确诊/.test(summary)) return null
    const allowedParticipants = new Set(candidate.participantIds)
    if (input.contacts.some((contact) => summary.includes(contact.name) && !allowedParticipants.has(contact.id))) return null
    return { ...candidate, id: uuid(), summary }
  } catch {
    return null
  }
}

export function directedEventPrompt(event: PreparedDirectedEvent | null): string {
  if (!event) return '本时段没有导演事件。保持普通生活节奏，不要为了制造戏剧性而新增突发事件。'
  return `本时段确定发生一条稀疏事件：eventId=${event.id}；type=${event.kind}；locationId=${event.locationId ?? '公共环境'}；participants=${event.participantIds.join(',') || '公共背景'}；summary=${event.summary}。只有列出的参与者完整知道现场细节；公共背景人人可观察但不要求每个人提及。不得扩写出新的后果、角色或地点。`
}
