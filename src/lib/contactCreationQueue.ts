import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { useSettingsStore } from '../store/useSettingsStore'
import {
  useContactCreationStore,
  type ContactCreationInput,
  type ContactCreationJob,
} from '../store/useContactCreationStore'
import { chatCompletion } from './deepseek'
import { pickAvatarCategory } from './avatarCategory'
import { randomAnimeAvatar, searchPexelsPhoto } from './photoSearch'
import { archivePexelsImage } from './mediaAssets'
import { buildPersonaGenerationPrompt, parsePersonaGeneration } from './prompt'
import { ensureWorldInitialized, formatLocationTree } from './world'
import { retrieveWorldbookContext } from './worldbook'
import { randomAvatarColor } from './colors'
import { employmentPatch } from './career'
import { setPairedContactRelation } from './contactRelations'
import { rememberInitialContactRelation } from './memory'

const PERSONA_TIMEOUT_MS = 120_000
const AVATAR_TIMEOUT_MS = 15_000
const queueRuntimeGlobal = globalThis as typeof globalThis & { __chatSlgContactQueueRuntime?: { workerRunning: boolean } }
const queueRuntime = queueRuntimeGlobal.__chatSlgContactQueueRuntime ?? { workerRunning: false }
queueRuntimeGlobal.__chatSlgContactQueueRuntime = queueRuntime

function cloneInput(input: ContactCreationInput): ContactCreationInput {
  return structuredClone(input)
}

export async function enqueueContactCreation(input: ContactCreationInput): Promise<string> {
  const contactCount = await db.contacts.count()
  const state = useContactCreationStore.getState()
  const unfinished = state.jobs.filter((job) => !['completed', 'failed'].includes(job.status)).length
  if (contactCount + unfinished >= 12) throw new Error('每个世界最多创建12个角色（包含创建队列）')
  const now = Date.now()
  const job: ContactCreationJob = {
    id: uuid(),
    status: 'queued',
    input: cloneInput(input),
    draft: null,
    error: '',
    createdAt: now,
    updatedAt: now,
  }
  state.addJob(job)
  void runQueue()
  return job.id
}

export function retryContactCreation(id: string) {
  const job = useContactCreationStore.getState().jobs.find((item) => item.id === id)
  if (!job || job.status !== 'failed') return
  useContactCreationStore.getState().updateJob(id, { status: 'queued', error: '', draft: null })
  void runQueue()
}

async function withTimeout<T>(promise: Promise<T>, controller: AbortController): Promise<T> {
  const timeout = globalThis.setTimeout(() => controller.abort(), PERSONA_TIMEOUT_MS)
  try {
    return await promise
  } catch (error) {
    if (controller.signal.aborted) throw new Error('模型响应超时，任务已释放，可以重试')
    throw error
  } finally {
    globalThis.clearTimeout(timeout)
  }
}

async function withOptionalStepTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = globalThis.setTimeout(() => reject(new Error('头像匹配超时')), AVATAR_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout)
  }
}

function fallbackBirthday(ageText: string) {
  const ages = [...ageText.matchAll(/\d+/g)].map((match) => Number(match[0])).filter(Number.isFinite)
  const age = ages.length ? Math.round(ages.reduce((sum, value) => sum + value, 0) / ages.length) : 25
  return `${new Date().getFullYear() - age}-06-15`
}

async function commitGeneratedContact(job: ContactCreationJob, draft: NonNullable<ContactCreationJob['draft']>) {
  const currentWorld = await ensureWorldInitialized()
  if (currentWorld.worldVersion !== draft.worldVersion) throw new Error('地点树已变化，请重新生成角色')
  if (await db.contacts.count() >= 12) throw new Error('每个世界最多创建12个角色')
  const { parsed, values, finalAvatar, avatarPhotographer, avatarPhotographerUrl } = draft
  const { input } = job
  const id = uuid()
  const now = Date.now()
  await db.transaction('rw', db.contacts, db.characterSchedules, db.conversations, db.contactRelations, db.contactMemories, async () => {
    await db.contacts.add({
      id,
      name: parsed.name,
      realName: (input.mode === 'nuwa' ? input.realName : '') || parsed.realName || parsed.name,
      nickname: (input.mode === 'nuwa' ? input.nickname : '') || (input.mode === 'nuwa' ? parsed.nickname : parsed.name) || parsed.name,
      gender: values.gender || parsed.personaProfile?.facts.find((fact) => fact.includes('性别')) || '',
      birthday: (input.mode === 'nuwa' ? input.birthday : '') || parsed.birthday || fallbackBirthday(values.ageRange),
      avatar: finalAvatar,
      avatarColor: randomAvatarColor(),
      avatarPhotographer,
      avatarPhotographerUrl,
      systemPrompt: parsed.persona,
      personaConstraints: input.extra || undefined,
      creatorProfile: { personalityTendencies: values.tags, age: values.ageRange, gender: values.gender, relationship: values.relationship, occupation: values.occupation, hobbies: values.hobbies, notes: input.extra },
      customPersonalityTraits: input.mode === 'nuwa' ? input.customTraits : undefined,
      personaProfile: parsed.personaProfile,
      speechSamples: parsed.speechSamples,
      outfit: { ...parsed.outfit, updatedAt: now, sourceEventIds: [] },
      createdAt: now,
      memoryFacts: '',
      memoryStyle: '',
      memoryUpdatedAt: 0,
      memoryMessageCursor: 0,
      relationshipBase: values.relationship || '朋友',
      relationshipDynamic: '',
      personalityTrait: input.mode === 'nuwa' ? '无' : (values.personalityTrait || '无'),
      mbti: parsed.mbti || undefined,
      currentLocationId: parsed.worldSchedule.find((item) => item.slot === draft.worldSlot && item.dayOfWeek === (currentWorld.day - 1) % 7)?.locationId || draft.playerLocationId,
      ...(values.occupation ? employmentPatch(values.occupation, parsed.monthlySalary ?? 6000, currentWorld.day) : { occupation: '' }),
    })
    await db.characterSchedules.bulkAdd(parsed.worldSchedule.map((item) => ({
      id: uuid(), characterId: id, dayOfWeek: item.dayOfWeek, slot: item.slot,
      locationId: item.locationId, activity: item.activity, phoneAccess: item.phoneAccess, adherence: item.adherence,
      priority: 'base' as const, sourceEventIds: [], createdAt: now,
    })))
    await db.conversations.add({ id: uuid(), contactId: id, channel: 'private_phone', pinned: false, createdAt: now, updatedAt: now })
    for (const row of values.relationRows) {
      await setPairedContactRelation(id, row.targetContactId, row.label)
      await rememberInitialContactRelation({ fromContactId: id, toContactId: row.targetContactId, label: row.label, now })
    }
  })
  return id
}

async function processJob(job: ContactCreationJob) {
  const store = useContactCreationStore.getState()
  store.updateJob(job.id, { status: 'persona', error: '' })
  try {
    const settings = useSettingsStore.getState()
    if (!settings.apiKey) throw new Error('还没有配置 API Key，请先去手机桌面的“设置”App 填写')
    if (await db.contacts.count() >= 12) throw new Error('每个世界最多创建12个角色')
    const { input } = job
    const { values } = input
    const avatarCategory = pickAvatarCategory(values.tags)
    const world = await ensureWorldInitialized()
    const locations = await db.locations.where('worldId').equals(world.worldId).sortBy('sortOrder')
    const [contacts, schedules] = await Promise.all([db.contacts.toArray(), db.characterSchedules.toArray()])
    const contactNames = new Map(contacts.map((contact) => [contact.id, contact.nickname || contact.name]))
    const residentialLocationIds = new Set(locations
      .filter((location) => ['apartment-room', 'dormitory', 'farmhouse'].includes(location.kind) || location.id.startsWith('home-'))
      .map((location) => location.id))
    const occupants = new Map<string, Set<string>>()
    for (const schedule of schedules) {
      if (!residentialLocationIds.has(schedule.locationId)) continue
      const name = contactNames.get(schedule.characterId)
      if (!name) continue
      const names = occupants.get(schedule.locationId) ?? new Set<string>()
      names.add(name)
      occupants.set(schedule.locationId, names)
    }
    const occupancyText = [...occupants.entries()]
      .map(([locationId, names]) => `- ${locationId}: ${[...names].join('、')}`)
      .join('\n')
    const locationTreeText = `${formatLocationTree(locations)}\n\n【现有住宅住户；未列出的独立公寓房间视为空置】\n${occupancyText || '当前尚无AI角色占用住宅。'}`
    const worldbookText = await retrieveWorldbookContext([
      values.tags.join(' '), values.ageRange, values.gender, values.relationship,
      values.personalityTrait, values.hobbies.join(' '), values.occupation, input.extra,
    ].join('\n'), { maxEntries: 8, maxChars: 6500 })
    const controller = new AbortController()
    const raw = await withTimeout(chatCompletion({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      messages: [
        {
          role: 'system',
          content: buildPersonaGenerationPrompt({
            personalityTags: values.tags,
            ageRange: values.ageRange,
            gender: values.gender,
            relationship: values.relationship,
            personalityTrait: values.personalityTrait,
            hobbies: values.hobbies,
            extra: [
              input.extra,
              input.mode === 'nuwa' ? `身份资料（留空项请自然补全）：真名=${input.realName || '未填写'}；网名=${input.nickname || '未填写'}；出生日期=${input.birthday || '未填写'}。` : '',
              worldbookText ? `【创建时必须遵守的世界书】\n${worldbookText}` : '',
            ].filter(Boolean).join('\n\n'),
            occupation: values.occupation,
          }, avatarCategory, locationTreeText),
        },
        { role: 'user', content: '请生成' },
      ],
      jsonMode: true,
      purpose: 'persona',
      signal: controller.signal,
    }), controller)
    const parsed = parsePersonaGeneration(raw)
    if (!parsed) throw new Error('生成结果解析失败，请重试')
    const parentIds = new Set(locations.map((item) => item.parentId).filter(Boolean))
    const leafIds = new Set(locations.filter((item) => !parentIds.has(item.id)).map((item) => item.id))
    if (parsed.worldSchedule.length === 0) throw new Error('角色日程为空，请重新生成')
    if (parsed.worldSchedule.some((item) => !leafIds.has(item.locationId))) throw new Error('角色日程引用了不存在或不可进入的地点，请重试')

    let finalAvatar = input.avatar
    let avatarPhotographer: string | undefined
    let avatarPhotographerUrl: string | undefined
    if (!input.avatarManuallySet) {
      store.updateJob(job.id, { status: 'avatar' })
      try {
        const photo = await withOptionalStepTimeout(avatarCategory === 'anime'
          ? randomAnimeAvatar()
          : searchPexelsPhoto(settings.pexelsApiKey, parsed.avatarKeyword || avatarCategory, 'square'))
        if (photo) {
          finalAvatar = photo.url
          avatarPhotographer = photo.photographer
          avatarPhotographerUrl = photo.photographerUrl
        }
      } catch {
        // Avatar lookup is optional and must never block the queue.
      }
    }
    const draft = {
        parsed,
        values,
        finalAvatar,
        avatarPhotographer,
        avatarPhotographerUrl,
        worldVersion: world.worldVersion,
        worldSlot: world.slot,
        playerLocationId: world.playerLocationId,
      }
    store.updateJob(job.id, { status: 'saving', draft })
    const contactId = await commitGeneratedContact(job, draft)
    if (avatarPhotographer && finalAvatar) await archivePexelsImage({ ownerContactId: contactId, origin: 'avatar', originId: contactId, url: finalAvatar, photographer: avatarPhotographer, photographerUrl: avatarPhotographerUrl })
    store.removeJob(job.id)
  } catch (error) {
    store.updateJob(job.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
  }
}

export async function runQueue() {
  if (queueRuntime.workerRunning) return
  queueRuntime.workerRunning = true
  try {
    while (true) {
      const next = useContactCreationStore.getState().jobs.find((job) => job.status === 'queued')
      if (!next) break
      await processJob(next)
    }
  } finally {
    queueRuntime.workerRunning = false
    // A job may have been queued between the final lookup and releasing the lock.
    if (useContactCreationStore.getState().jobs.some((job) => job.status === 'queued')) void runQueue()
  }
}
