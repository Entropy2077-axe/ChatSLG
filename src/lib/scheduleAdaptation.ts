import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { extractJsonObject } from './aiProtocol'
import { chatCompletion } from './deepseek'
import { buildLogicContext, formatLogicContext } from './logicContext'
import type { AppSettings, CharacterSchedule, TimeSlot } from '../types'

export interface ScheduleAdaptationDraft {
  worldVersion: number
  characterId: string
  schedules: Array<Pick<CharacterSchedule, 'slot' | 'locationId' | 'activity' | 'phoneAccess' | 'dayOfWeek' | 'adherence'>>
}

export async function generateScheduleAdaptation(characterId: string, settings: AppSettings): Promise<ScheduleAdaptationDraft> {
  if (!settings.apiKey) throw new Error('请先在设置中配置 API Key')
  const bundle = await buildLogicContext({ subjectId: characterId, query: '根据职业、人设和地点树重新适配基础日程' })
  const context = formatLogicContext(bundle)
  const raw = await chatCompletion({
    apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model, jsonMode: true, purpose: 'other',
    messages: [{ role: 'system', content: `${context}\n\n你只负责提出新的基础日程草稿，不改变当前状态、约定或临时日程。四个时段各输出一项，作为每天都适用的兜底日程；地点ID只能使用地点树中标为leaf-enterable的叶子地点。每项必须给出adherence：required=通常不可自行偏离，normal=需充分理由，optional=可自由调整。工作、课程和明确责任不能只因角色懒散而标成optional。只输出JSON:{"worldVersion":${bundle.worldVersion},"characterId":"${characterId}","schedules":[{"slot":"morning|day|evening|night","locationId":"合法叶子ID","activity":"活动","phoneAccess":"available|unavailable","adherence":"required|normal|optional"}]}` }, { role: 'user', content: '重新适配基础日程草稿' }],
  })
  const json = extractJsonObject(raw)
  if (!json) throw new Error('日程模型没有返回有效JSON')
  const parsed = JSON.parse(json) as Partial<ScheduleAdaptationDraft>
  if (parsed.worldVersion !== bundle.worldVersion || parsed.characterId !== characterId || !Array.isArray(parsed.schedules)) throw new Error('日程草稿格式或世界版本无效')
  const slots = new Set<TimeSlot>()
  const parentIds = new Set(bundle.locations.map((item) => item.parentId).filter(Boolean))
  const locationIds = new Set(bundle.locations.filter((item) => !parentIds.has(item.id)).map((item) => item.id))
  const schedules = parsed.schedules.map((item) => {
    if (!['morning', 'day', 'evening', 'night'].includes(item.slot) || slots.has(item.slot) || !locationIds.has(item.locationId) || !item.activity?.trim() || !['available', 'unavailable'].includes(item.phoneAccess) || !['required', 'normal', 'optional'].includes(item.adherence ?? '')) throw new Error('日程草稿包含重复时段、非法地点、空活动或无效约束强度')
    slots.add(item.slot)
    return { slot: item.slot, locationId: item.locationId, activity: item.activity.trim(), phoneAccess: item.phoneAccess, adherence: item.adherence }
  })
  if (slots.size !== 4) throw new Error('基础日程必须完整覆盖四个时段')
  await db.aiTurns.add({
    id: uuid(), conversationId: `schedule-adaptation:${characterId}`, raw, parsed, knowledgeQueries: [],
    logicTrace: {
      worldVersion: bundle.worldVersion, locationTreeVersion: bundle.worldVersion,
      personaSummaries: [bundle.subject.character.systemPrompt.slice(0, 500)],
      schedules: [...bundle.subject.baseSchedule, ...bundle.subject.scheduleOverrides].map((item) => `${item.priority}/${item.slot}@${item.locationId}`),
      appointmentIds: bundle.subject.commitments.map((item) => item.id), memoryIds: bundle.memories.map((item) => item.id),
      perceivedEventIds: bundle.perceivedEvents.map((item) => item.eventId), validation: 'passed',
    }, createdAt: Date.now(),
  })
  return { worldVersion: bundle.worldVersion, characterId, schedules }
}

export async function commitScheduleAdaptation(draft: ScheduleAdaptationDraft): Promise<void> {
  const world = await db.worldState.get('global')
  if (!world || world.worldVersion !== draft.worldVersion) throw new Error('地点树已变化，请重新生成日程')
  const oldBase = await db.characterSchedules.where('characterId').equals(draft.characterId).filter((item) => item.priority === 'base').toArray()
  const locations = await db.locations.toArray(), parentIds = new Set(locations.map((item) => item.parentId).filter(Boolean))
  const leafIds = new Set(locations.filter((item) => !parentIds.has(item.id)).map((item) => item.id))
  if (draft.schedules.some((item) => !leafIds.has(item.locationId))) throw new Error('日程草稿包含非叶子地点')
  const now = Date.now()
  await db.transaction('rw', db.worldState, db.characterSchedules, async () => {
    const latest = await db.worldState.get('global')
    if (!latest || latest.worldVersion !== draft.worldVersion) throw new Error('地点树已变化，请重新生成日程')
    await db.characterSchedules.bulkDelete(oldBase.map((item) => item.id))
    await db.characterSchedules.bulkAdd(draft.schedules.map((item) => ({ ...item, id: uuid(), characterId: draft.characterId, priority: 'base', sourceEventIds: [], createdAt: now })))
  })
}
