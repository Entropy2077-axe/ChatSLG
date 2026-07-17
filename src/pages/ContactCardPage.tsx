import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { AvatarPicker } from '../components/AvatarPicker'
import { ActionSheet } from '../components/ActionSheet'
import { displayName } from '../lib/contact'
import { activeWorldPlans, activeWorldPlansText, resetMemory } from '../lib/memory'
import { cascadeDeleteContactSocialData } from '../lib/moments'
import { removeContactFromAllGroups } from '../lib/groupChat'
import { normalizeMood } from '../lib/mood'
import { defaultOutfit, OUTFIT_FIELDS } from '../lib/outfit'
import { formatWorldDate, modelWorldTimeText } from '../lib/worldCalendar'
import { RELATIONSHIP_OPTIONS, formatSpeechSamplesForScene, buildRawChatPromptParts, buildJsonConversionPrompt } from '../lib/prompt'
import { useModuleEnabled, isModuleEnabled } from '../features'
import { relationshipLine } from '../lib/relationship'
import { buildUserProfileText } from '../lib/chatEngine'
import { useSettingsStore } from '../store/useSettingsStore'
import type { ContactMemoryScope, ContactRelationLabel } from '../types'
import { PERSONALITY_TRAIT_OPTIONS } from '../types'
import { activeIntentPrompt, activeIntents, clearIntentQueue } from '../lib/intent'
import { uniqueRelationPairs } from '../lib/contactRelations'
import { chatCompletion } from '../lib/deepseek'
import { buildOccupationPrompt, parseOccupation, employmentPatch, OCCUPATION_OPTIONS } from '../lib/career'
import { formatCurrency } from '../lib/wallet'
import { setWalletBalance } from '../lib/finance'
import { resolveSchedule, slotLabel } from '../lib/world'
import { commitScheduleAdaptation, generateScheduleAdaptation } from '../lib/scheduleAdaptation'
import { resolveCurrentOutfit, resolveScheduleConstraint } from '../lib/temporaryConstraints'
import { formatWeatherForModel, weatherForWorld } from '../lib/worldWeather'

function LatestAiTurnJson({ contactId }: { contactId: string }) {
  const latestTurn = useLiveQuery(async () => {
    const conv = await db.conversations.where('contactId').equals(contactId).first()
    if (!conv) return null
    const turns = await db.aiTurns.where('conversationId').equals(conv.id).reverse().sortBy('createdAt')
    return turns[0] ?? null
  }, [contactId])

  if (!latestTurn?.raw) return null
  return (
    <section className="mt-3 bg-white px-4 py-4">
      <h3 className="mb-2 text-xs font-medium text-gray-400">📋 最新AI原始JSON</h3>
      <pre className="whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-2.5 font-mono text-[10px] leading-relaxed text-gray-600">
        {latestTurn.raw}
      </pre>
    </section>
  )
}

const MEMORY_SCOPE_LABELS: Record<ContactMemoryScope, string> = {
  private: '个人结构化记忆',
  group: '群聊记忆',
  interpersonal: '与其他人的记忆',
}

export function ContactCardPage() {
  const { contactId } = useParams()
  const navigate = useNavigate()
  const settings = useSettingsStore()
  const [menuOpen, setMenuOpen] = useState(false)
  const [editingRemark, setEditingRemark] = useState(false)
  const [remarkDraft, setRemarkDraft] = useState('')
  const [clearMemoryConfirm, setClearMemoryConfirm] = useState(false)
  const [pickingAvatar, setPickingAvatar] = useState(false)
  const [pickingRelationshipType, setPickingRelationshipType] = useState(false)
  const [pickingPersonalityTrait, setPickingPersonalityTrait] = useState(false)
  const personalityEnabled = useModuleEnabled('personalityTraits')
  const adminEnabled = useSettingsStore((s) => s.adminModeEnabled)
  const moodEnabled = true
  const careerEnabled = useModuleEnabled('career')
  const lifeSimulationEnabled = useModuleEnabled('lifeSimulation')
  const [assigningCareer, setAssigningCareer] = useState(false)
  const [adaptingSchedule, setAdaptingSchedule] = useState(false)

  const contact = useLiveQuery(() => (contactId ? db.contacts.get(contactId) : undefined), [contactId])
  const conversation = useLiveQuery(
    () => (contactId ? db.conversations.where('contactId').equals(contactId).first() : undefined),
    [contactId],
  )
  const contactWallet = useLiveQuery(() => contactId ? db.walletAccounts.get(contactId) : undefined, [contactId])
  const lifeEvents = useLiveQuery(() => contactId ? db.lifeEvents.where('contactId').equals(contactId).reverse().sortBy('occurredAt') : [], [contactId]) ?? []
  const lifeState = useLiveQuery(() => contactId ? db.contactLifeStates.get(contactId) : undefined, [contactId])
  const socialTimeline = useLiveQuery(async () => {
    if (!contactId) return []
    return (await db.socialEvents.orderBy('createdAt').reverse().limit(80).toArray())
      .filter((event) => event.relatedContactIds.includes(contactId) || event.actorId === contactId || event.targetId === contactId)
      .slice(0, 6)
  }, [contactId]) ?? []
  const structuredMemories = useLiveQuery(
    () => (contactId ? db.contactMemories.where('contactId').equals(contactId).reverse().sortBy('updatedAt') : []),
    [contactId],
  ) ?? []
  const worldState = useLiveQuery(() => db.worldState.get('global'), [])
  const worldMap = useLiveQuery(() => db.worldMaps.get('active'), [])
  const locations = useLiveQuery(() => db.locations.orderBy('sortOrder').toArray(), []) ?? []
  const worldSchedules = useLiveQuery(
    () => (contactId ? db.characterSchedules.where('characterId').equals(contactId).toArray() : []),
    [contactId],
  ) ?? []
  const outfitConstraints = useLiveQuery(() => contactId ? db.outfitConstraints.where('characterId').equals(contactId).toArray() : [], [contactId]) ?? []
  const scheduleConstraints = useLiveQuery(() => contactId ? db.scheduleConstraints.where('characterId').equals(contactId).toArray() : [], [contactId]) ?? []
  const appointments = useLiveQuery(
    () => (contactId ? db.appointments.filter((item) => item.participantIds.includes(contactId)).toArray() : []),
    [contactId],
  ) ?? []
  const diaries = useLiveQuery(
    async () => {
      if (!contactId) return []
      const rows = await db.characterDiaries.where('characterId').equals(contactId).toArray()
      return rows.sort((a, b) => b.worldStep - a.worldStep).slice(0, 20)
    },
    [contactId],
  ) ?? []
  const scheduleDeviations = useLiveQuery(async () => {
    if (!contactId) return []
    return (await db.worldEvents.where('type').equals('scheduleDeviation').toArray())
      .filter((event) => event.actorId === contactId)
      .sort((a, b) => b.worldStep - a.worldStep)
      .slice(0, 5)
  }, [contactId]) ?? []
  const relationLinks = useLiveQuery(
    async () => {
      if (!contactId) return []
      const links = await db.contactRelations
        .filter((link) => link.fromContactId === contactId || link.toContactId === contactId)
        .toArray()
      const otherIds = Array.from(new Set(links.map((link) => (link.fromContactId === contactId ? link.toContactId : link.fromContactId))))
      const contacts = await db.contacts.bulkGet(otherIds)
      const contactById = new Map(contacts.filter((c): c is NonNullable<typeof c> => !!c).map((c) => [c.id, c]))
      return uniqueRelationPairs(links)
        .map((link) => {
          const otherId = link.fromContactId === contactId ? link.toContactId : link.fromContactId
          const other = contactById.get(otherId)
          return other ? { id: link.id, name: displayName(other), label: link.label } : null
        })
        .filter((item): item is { id: string; name: string; label: ContactRelationLabel } => !!item)
    },
    [contactId],
  ) ?? []
  const structuredMemoryGroups = structuredMemories.reduce(
    (acc, memory) => {
      const scope = memory.scope ?? 'private'
      acc[scope].push(memory)
      return acc
    },
    { private: [], group: [], interpersonal: [] } as Record<ContactMemoryScope, typeof structuredMemories>,
  )
  async function assignCareer() {
    if (!contact || !settings.apiKey) return
    const value = window.prompt(`输入职业（例如：${OCCUPATION_OPTIONS.slice(0,6).join('、')}）`, contact.occupation ?? '')?.trim()
    if (!value) return
    setAssigningCareer(true)
    try {
      const raw = await chatCompletion({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.utilityModel, messages: [{ role: 'system', content: buildOccupationPrompt(value, contact.systemPrompt) }, { role: 'user', content: '生成职业资料' }], jsonMode: true, purpose: 'persona' })
      const parsed = parseOccupation(raw)
      if (!parsed) throw new Error('职业资料生成失败')
      await db.contacts.update(contact.id, employmentPatch(value, parsed.monthlySalary, worldState?.day ?? 1))
    } finally { setAssigningCareer(false) }
  }
  async function adaptSchedule() {
    if (!contactId || adaptingSchedule) return
    setAdaptingSchedule(true)
    try {
      const draft = await generateScheduleAdaptation(contactId, settings)
      const summary = draft.schedules.map((item) => `${slotLabel(item.slot)}：${locationById.get(item.locationId)?.name || item.locationId} · ${item.activity} · ${item.adherence === 'required' ? '必须遵守' : item.adherence === 'optional' ? '可自由调整' : '需充分理由方可调整'}`).join('\n')
      if (window.confirm(`确认用以下内容替换基础日程？约定和临时调整不会改变。\n\n${summary}`)) await commitScheduleAdaptation(draft)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err))
    } finally {
      setAdaptingSchedule(false)
    }
  }
  const stickers: import('../types').Sticker[] = []
  if (contact === undefined) return null
  if (contact === null || !contactId) {
    return (
      <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
        <TopBar title="联系人" showBack />
        <p className="px-4 py-10 text-center text-sm text-gray-400">该联系人已被删除</p>
      </div>
    )
  }

  async function handleChat() {
    let conv = conversation
    if (!conv) {
      const now = Date.now()
      conv = { id: uuid(), contactId: contactId!, pinned: false, createdAt: now, updatedAt: now }
      await db.conversations.add(conv)
    }
    navigate(`/chat/${conv.id}`)
  }

  async function handleDelete() {
    if (conversation) {
      await db.messages.where('conversationId').equals(conversation.id).delete()
      await db.conversations.delete(conversation.id)
    }
    await cascadeDeleteContactSocialData(contactId!)
    await removeContactFromAllGroups(contactId!)
    const [appointments, perceptions, diaries, pending, schedules, archives] = await Promise.all([
      db.appointments.filter((item) => item.participantIds.includes(contactId!)).toArray(),
      db.perceivedEvents.where('characterId').equals(contactId!).toArray(),
      db.characterDiaries.where('characterId').equals(contactId!).toArray(),
      db.pendingPhoneMessages.filter((item) => item.recipientIds.includes(contactId!)).toArray(),
      db.characterSchedules.where('characterId').equals(contactId!).toArray(),
      db.contactArchives.where('contactId').equals(contactId!).toArray(),
    ])
    await db.transaction('rw', [db.appointments, db.perceivedEvents, db.characterDiaries, db.pendingPhoneMessages, db.characterSchedules, db.contactArchives], async () => {
      await db.appointments.bulkDelete(appointments.map((item) => item.id))
      await db.perceivedEvents.bulkDelete(perceptions.map((item) => item.id))
      await db.characterDiaries.bulkDelete(diaries.map((item) => item.id))
      await db.pendingPhoneMessages.bulkDelete(pending.map((item) => item.id))
      await db.characterSchedules.bulkDelete(schedules.map((item) => item.id))
      await db.contactArchives.bulkDelete(archives.map((item) => item.id))
    })
    await db.contacts.delete(contactId!)
    navigate('/contacts', { replace: true })
  }

  async function saveRemark() {
    await db.contacts.update(contactId!, { remark: remarkDraft.trim() })
    setEditingRemark(false)
  }

  const activePlans = activeWorldPlans(contact.upcomingPlans ?? [], worldState?.day ?? 1, worldState?.slot ?? 'morning')
  const visibleActiveIntents = activeIntents(contact, Date.now(), 10)
  const usedIntents = (contact.intentQueue ?? [])
    .filter((intent) => intent.status === 'used')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5)
  const hasMemory = contact.memoryFacts || contact.memoryStyle || activePlans.length > 0 || structuredMemories.length > 0 || relationLinks.length > 0
  const locationById = new Map(locations.map((location) => [location.id, location]))
  const currentLocation = contact.currentLocationId ? locationById.get(contact.currentLocationId) : undefined
  const currentWorldSchedule = worldState ? resolveSchedule(worldSchedules, worldState.day, worldState.slot) : undefined
  const currentOutfit = worldState ? resolveCurrentOutfit(contact, outfitConstraints, worldState.day, worldState.slot) : (contact.outfit ?? defaultOutfit(contact.createdAt))
  const currentTemporarySchedule = worldState ? resolveScheduleConstraint(scheduleConstraints, worldState.day, worldState.slot) : undefined
  const upcomingOutfit = outfitConstraints.filter((item) => !worldState || item.startDay > worldState.day).sort((a, b) => a.startDay - b.startDay)[0]
  const slotOrder = { morning: 0, day: 1, evening: 2, night: 3 } as const
  const todayLaterSchedules = worldState ? scheduleConstraints.filter((item) => item.startDay <= worldState.day && item.endDay >= worldState.day && (item.slots ?? []).some((slot) => slotOrder[slot] > slotOrder[worldState.slot])).sort((a, b) => Math.min(...(a.slots ?? []).map((slot) => slotOrder[slot])) - Math.min(...(b.slots ?? []).map((slot) => slotOrder[slot]))) : []
  const futureSchedules = scheduleConstraints.filter((item) => !worldState || item.startDay > worldState.day).sort((a, b) => a.startDay - b.startDay)

  // Admin-mode-only: shows exactly what would be sent as the system prompt
  // right now, for debugging persona/relationship issues. Mirrors
  // chatEngine.ts's runAiTurn data-gathering, but must NOT replicate its
  // pendingEvents-clearing side effect — this is a read-only preview, not
  // an actual turn, so pendingEvents here is read straight off the live
  // contact instead of going through the "read once then clear" flow.
  const now = new Date()
  const previewClock = worldState ?? { day: 1, slot: 'morning' as const, hour: 8 }
  const previewWeather = formatWeatherForModel(weatherForWorld(worldMap?.seed ?? worldState?.worldId ?? 'default-world', previewClock.day, previewClock.slot))
  const previewPlansText = activeWorldPlansText(contact, previewClock.day, previewClock.slot)
  const pendingEvents = contact.pendingEvents ?? []
  const previewActiveIntents = isModuleEnabled('intent') ? activeIntents(contact, now.getTime()) : []
  // ---- admin-mode prompt preview (two-step pipeline) ----
  const mainModelPromptParts = adminEnabled
    ? buildRawChatPromptParts({
        name: contact.name,
        persona: contact.systemPrompt,
        personaConstraints: contact.personaConstraints,
        personaProfile: contact.personaProfile,
        stylePrompt: settings.globalSystemPrompt,
        selfIterationGlobalText: isModuleEnabled('selfIteration') ? settings.selfIterationGlobalPrompt : undefined,
        selfIterationContactText: isModuleEnabled('selfIteration') ? contact.selfIterationPrompt : undefined,
        personalityTrait: personalityEnabled ? contact.personalityTrait : undefined,
        worldviewText: isModuleEnabled('worldview') ? '【运行时按当前对话检索世界书条目；此预览不固定命中结果】' : undefined,
        latestUserText: '【预览】这里会放入用户本轮最新消息',
        recentContext: [
          `【你和对方的关系】${relationshipLine(contact.relationshipBase || '朋友', contact.relationshipDynamic || '')}`,
          `【你对TA的了解】${contact.memoryFacts || '（刚开始聊）'}`,
          `【相处习惯】${contact.memoryStyle || '（还没有形成习惯）'}`,
          `【当前情境】现在: ${modelWorldTimeText(previewClock)}。季节与天气: ${previewWeather}。对方: ${buildUserProfileText(settings)}。${contact.mood?.text ? `你的心情: ${contact.mood.text}。` : ''}【世界日程】${currentWorldSchedule ? `\n当前: ${currentWorldSchedule.activity}，地点=${currentWorldSchedule.locationId}` : '\n当前: 暂无安排'}${previewPlansText ? `\n约定: ${previewPlansText}` : ''}${pendingEvents.length > 0 ? `\n最近: ${pendingEvents.join('；')}` : ''}`,
        ].filter(Boolean).join('\n\n'),
        activeIntentText: activeIntentPrompt(previewActiveIntents),
        stickerNames: stickers.map((s) => s.name),
        mbti: contact.mbti || undefined,
        speechSamplesText: formatSpeechSamplesForScene(contact.speechSamples, 'private', 3) || undefined,
      })
    : null
  const conversionPrompt = adminEnabled
    ? buildJsonConversionPrompt('【AI的原始回复文字会放在这里】')
    : ''

  return (
    <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="联系人名片" showBack />
      <div className="flex-1 overflow-y-auto">

      <section className="mt-3 flex flex-col items-center gap-1 bg-white px-4 py-8">
        <button onClick={() => setPickingAvatar(true)}>
          <Avatar avatar={contact.avatar} color={contact.avatarColor} size={80} />
        </button>
        <h2 className="mt-1 text-lg font-medium text-gray-900">{displayName(contact)}</h2>
        {contact.remark && <p className="text-xs text-gray-400">本名 {contact.name}</p>}
        {contact.avatarPhotographer && (
          <p className="text-[11px] text-gray-300">
            头像照片来自 Pexels ·{' '}
            {contact.avatarPhotographerUrl ? (
              <a href={contact.avatarPhotographerUrl} target="_blank" rel="noreferrer" className="underline">
                {contact.avatarPhotographer}
              </a>
            ) : (
              contact.avatarPhotographer
            )}
          </p>
        )}
      </section>

      {lifeSimulationEnabled && <section className="mt-3 bg-white px-4 py-4"><h3 className="mb-2 text-xs font-medium text-gray-400">🌙 生活回顾</h3>{lifeState && <p className="mb-2 text-xs text-gray-500">此刻：{lifeState.location} · {lifeState.activity} · 精力 {lifeState.energy}{lifeState.weatherLabel ? ` · ${lifeState.weatherLabel}` : ''}</p>}{lifeEvents.filter((event) => event.visibility !== 'private').length === 0 ? <p className="text-sm text-gray-400">最近没有适合分享的生活动态</p> : <div className="space-y-2">{lifeEvents.filter((event) => event.visibility !== 'private').slice(0, 10).map((event) => <div key={event.id} className="rounded-lg bg-gray-50 px-3 py-2"><p className="text-sm text-gray-700">{event.summary}</p><p className="mt-0.5 text-[10px] text-gray-400">{event.worldDay ? `${formatWorldDate(event.worldDay)}${event.worldSlot ? ` · ${slotLabel(event.worldSlot)}` : ''}` : '旧版生活记录'}{event.weatherLabel ? ` · ${event.weatherLabel}` : ''} · {event.type === 'summary' ? '阶段回顾' : '生活事件'}</p></div>)}</div>}</section>}

      <div className="mt-3 bg-white">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-b border-gray-100 px-4 py-3 text-xs text-gray-500"><p>性别：{contact.gender || contact.creatorProfile?.gender || '未填写'}</p><p>真名：{contact.realName || contact.name}</p><p>网名：{contact.nickname || contact.name}</p><p>生日：{contact.birthday || '未填写'}</p></div>
        <button
          onClick={() => {
            setRemarkDraft(contact.remark ?? '')
            setEditingRemark(true)
          }}
          className="flex w-full items-center justify-between border-b border-gray-100 px-4 py-3.5 text-left active:bg-gray-50"
        >
          <span className="text-[15px] text-gray-900">备注</span>
          <span className="text-sm text-gray-400">{contact.remark || '未设置'}</span>
        </button>
        <button
          onClick={() => setPickingRelationshipType(true)}
          className="flex w-full items-center justify-between border-b border-gray-100 px-4 py-3.5 text-left active:bg-gray-50"
        >
          <span className="text-[15px] text-gray-900">关系定位</span>
          <span className="text-sm text-gray-400">{contact.relationshipBase || '未设置'}</span>
        </button>
        <button
          onClick={() => navigate(`/contact/${contact.id}/archives`)}
          className="flex w-full items-center justify-between border-b border-gray-100 px-4 py-3.5 text-left active:bg-gray-50"
        >
          <span className="text-[15px] text-gray-900">联系人自动存档</span>
          <span className="text-sm text-gray-400">按世界时段查看 ›</span>
        </button>
        {personalityEnabled && (
          <button
            onClick={() => setPickingPersonalityTrait(true)}
            className="flex w-full items-center justify-between px-4 py-3.5 text-left active:bg-gray-50"
          >
            <span className="text-[15px] text-gray-900">性格特质</span>
            <span className="text-right text-sm text-gray-400">{contact.personalityTrait || '无'}</span>
          </button>
        )}
        {moodEnabled && (
          <div className="flex w-full items-center justify-between px-4 py-3.5">
            <span className="text-[15px] text-gray-900">心情</span>
            <span className="text-sm text-gray-400">
              {contact.mood?.text && Date.now() < contact.mood.expiresAt ? normalizeMood(contact.mood.text) : '暂无'}
            </span>
          </div>
        )}
        <div className="flex w-full items-center justify-between px-4 py-3.5">
          <span className="text-[15px] text-gray-900">状态</span>
          <span className="text-sm text-gray-400">
            {(currentWorldSchedule?.phoneAccess === 'unavailable' ? '🔕 ' : '📱 ') +
              (currentWorldSchedule?.activity || '空闲')}
          </span>
        </div>
        <div className="flex w-full items-center justify-between px-4 py-3.5">
          <span className="text-[15px] text-gray-900">当前位置</span>
          <span className="text-sm text-gray-400">{currentLocation?.name || '未设置'}</span>
        </div>
        <div className="flex w-full items-center justify-between px-4 py-3.5">
          <span className="text-[15px] text-gray-900">职业</span>
          <span className="text-sm text-gray-400">{contact.occupation || '未填写'}</span>
        </div>
        {careerEnabled && <button onClick={assignCareer} disabled={assigningCareer} className="flex w-full items-center justify-between px-4 py-3.5 text-left active:bg-gray-50 disabled:opacity-50"><span className="text-[15px] text-gray-900">职业</span><span className="text-sm text-gray-400">{assigningCareer?'生成中…':contact.occupation?`${contact.occupation} · 月薪 ${formatCurrency(contact.monthlySalary??0,settings)}`:'赋予职业'}</span></button>}
        {careerEnabled && <button onClick={adminEnabled ? async()=>{const raw=prompt('设定该AI的钱包余额',String(contactWallet?.balance??0));if(raw!==null&&Number.isFinite(Number(raw))&&Number(raw)>=0)await setWalletBalance(contact.id,Number(raw))}:undefined} className="flex w-full items-center justify-between px-4 py-3.5 text-left"><span className="text-[15px] text-gray-900">钱包</span><span className="text-sm text-gray-400">{formatCurrency(contactWallet?.balance??0,settings)}{adminEnabled?' · 点击设定':''}</span></button>}
      </div>

      <section className="mt-3 bg-white px-4 py-4">
        <div className="mb-3 flex items-center justify-between"><h3 className="text-xs font-medium text-gray-400">当前衣着</h3><span className="text-[10px] text-violet-600">{outfitConstraints.some((item) => worldState && item.startDay <= worldState.day && item.endDay >= worldState.day) ? '当前临时约束' : '默认衣着'}</span></div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">{OUTFIT_FIELDS.map(([key, label]) => <div key={key}><p className="text-[11px] text-gray-400">{label}</p><p className="mt-0.5 text-sm text-gray-700">{currentOutfit[key]}</p></div>)}</div>
        {upcomingOutfit && <p className="mt-3 text-xs text-violet-600">即将生效：第{upcomingOutfit.startDay}–{upcomingOutfit.endDay}天{upcomingOutfit.slots?.length ? ` · ${upcomingOutfit.slots.map(slotLabel).join('、')}` : ' · 全天'}</p>}
      </section>

      <section className="mt-3 bg-white px-4 py-4">
        <h3 className="mb-2 text-xs font-medium text-gray-400">最近社交动态</h3>
        {socialTimeline.length === 0 ? <p className="text-sm text-gray-400">暂时还没有公开互动。</p> : <div className="space-y-2">{socialTimeline.map((event) => <button key={event.id} type="button" onClick={() => event.groupId ? navigate(`/group/${event.groupId}`) : event.momentId ? navigate(`/phone/moments?focus=${event.momentId}`) : event.conversationId ? navigate(`/chat/${event.conversationId}`) : undefined} className="block w-full border-l-2 border-[#07c160] pl-2 text-left"><p className="text-sm text-gray-700">{event.summary}</p><p className="mt-0.5 text-[10px] text-gray-400">{new Date(event.createdAt).toLocaleString()}</p></button>)}</div>}
      </section>

      <section className="mt-3 bg-white px-4 py-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-medium text-gray-400">AI记忆（随聊天自动积累）</h3>
          {hasMemory && (
            <button onClick={() => setClearMemoryConfirm(true)} className="text-xs text-gray-400 underline">
              清空记忆
            </button>
          )}
        </div>
        {hasMemory ? (
          <div className="space-y-2 text-sm leading-relaxed text-gray-600">
            <p>
              <span className="text-xs text-gray-400">了解到的信息 </span>
              {contact.memoryFacts || '暂无'}
            </p>
            <p>
              <span className="text-xs text-gray-400">相处状态 </span>
              {contact.memoryStyle || '暂无'}
            </p>
            {activePlans.length > 0 && (
              <div>
                <span className="text-xs text-gray-400">和你的约定 </span>
                <ul className="mt-1 space-y-0.5">
                  {activePlans.map((p) => (
                    <li key={p.id}>{p.worldDay ? `[${formatWorldDate(p.worldDay)}${p.worldSlot ? ` · ${slotLabel(p.worldSlot)}` : ''}] ${p.text}` : p.text}</li>
                  ))}
                </ul>
              </div>
            )}
            {relationLinks.length > 0 && (
              <div>
                <span className="text-xs text-gray-400">已知朋友关系 </span>
                <ul className="mt-1 space-y-0.5">
                  {relationLinks.map((link) => (
                    <li key={link.id}>{link.name} 是TA的{link.label}</li>
                  ))}
                </ul>
              </div>
            )}
            {(['private', 'group', 'interpersonal'] as ContactMemoryScope[]).map((scope) => {
              const memories = structuredMemoryGroups[scope].slice(0, 8)
              if (memories.length === 0) return null
              return (
                <div key={scope}>
                  <span className="text-xs text-gray-400">{MEMORY_SCOPE_LABELS[scope]} </span>
                  <ul className="mt-1 space-y-1">
                    {memories.map((memory) => (
                      <li key={memory.id} className="rounded-lg bg-gray-50 px-2.5 py-1.5">
                        <p>{memory.content}</p>
                        {memory.tags.length > 0 && (
                          <p className="mt-0.5 text-[11px] text-gray-400">
                            {memory.tags.slice(0, 4).map((tag) => `#${tag}`).join(' ')}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-gray-400">还没有形成记忆 多聊几句之后会自己记住一些关于你的事</p>
        )}
      </section>

      <section className="mt-3 bg-white px-4 py-4">
        <div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-medium text-gray-400">世界日程</h3><button onClick={() => void adaptSchedule()} disabled={adaptingSchedule} className="text-xs text-violet-600 disabled:opacity-50">{adaptingSchedule ? '适配中…' : '重新适配基础日程'}</button></div>
        {currentTemporarySchedule && <p className="mb-2 rounded-lg bg-violet-50 px-2.5 py-2 text-xs text-violet-700">当前临时约束 · 第{currentTemporarySchedule.startDay}–{currentTemporarySchedule.endDay}天 · {locationById.get(currentTemporarySchedule.locationId)?.name || currentTemporarySchedule.locationId} · {currentTemporarySchedule.activity}</p>}
        {todayLaterSchedules.length > 0 && <div className="mb-2 rounded-lg bg-blue-50 px-2.5 py-2 text-xs text-blue-700"><p className="font-medium">今日稍后</p>{todayLaterSchedules.map((item) => <p key={item.id} className="mt-1">{item.slots?.map(slotLabel).join('/') || '全天'} · {locationById.get(item.locationId)?.name || item.locationId} · {item.activity}</p>)}</div>}
        {futureSchedules.length > 0 && <div className="mb-2 text-xs text-violet-600"><p className="font-medium">未来日程</p>{futureSchedules.map((item) => <p key={item.id} className="mt-1">第{item.startDay}–{item.endDay}天 · {item.slots?.map(slotLabel).join('/') || '全天'} · {item.activity}</p>)}</div>}
        {worldSchedules.length === 0 ? (
          <p className="text-sm text-gray-400">暂无日程。角色不会凭空移动。</p>
        ) : (
          <div className="space-y-2">
            {(['morning', 'day', 'evening', 'night'] as const).map((slot) => {
              const rows = worldSchedules
                .filter((item) => item.slot === slot)
                .sort((a, b) => ({ commitment: 3, override: 2, base: 1 }[b.priority] - { commitment: 3, override: 2, base: 1 }[a.priority]))
              if (rows.length === 0) return null
              return (
                <div key={slot} className="rounded-lg bg-gray-50 px-3 py-2">
                  <p className="text-xs font-medium text-gray-500">{slotLabel(slot)}</p>
                  {rows.map((item) => (
                    <p key={item.id} className="mt-1 text-sm text-gray-700">
                      {locationById.get(item.locationId)?.name || `未知地点 ${item.locationId}`} · {item.activity}
                      <span className="ml-1 text-[10px] text-gray-400">
                        {item.priority === 'commitment' ? '约定' : item.priority === 'override' ? '临时调整' : '基础日程'}
                        {item.effectiveDay !== undefined ? ` · 第${item.effectiveDay}天` : ''}
                        {item.effectiveDay === undefined && item.dayOfWeek !== undefined ? ` · 世界周第${item.dayOfWeek + 1}日` : ''}
                        {` · ${item.priority !== 'base' || item.adherence === 'required' ? '必须遵守' : item.adherence === 'optional' ? '可自由调整' : '需充分理由方可调整'}`}
                        {item.phoneAccess === 'unavailable' ? ' · 不便看手机' : ' · 可看手机'}
                      </span>
                    </p>
                  ))}
                </div>
              )
            })}
          </div>
        )}
        {appointments.filter((item) => item.status === 'proposed').length > 0 && (
          <div className="mt-3 border-t border-gray-100 pt-3">
            <h4 className="mb-1 text-xs font-medium text-amber-600">待其他角色确认</h4>
            {appointments.filter((item) => item.status === 'proposed').map((item) => <p key={item.id} className="text-sm text-gray-600">{formatWorldDate(item.day)} · {slotLabel(item.slot)} · {locationById.get(item.locationId)?.name || item.locationId} · {item.description}</p>)}
          </div>
        )}
        {appointments.filter((item) => item.status === 'planned').length > 0 && (
          <div className="mt-3 border-t border-gray-100 pt-3">
            <h4 className="mb-1 text-xs font-medium text-gray-400">已确认约定</h4>
            {appointments.filter((item) => item.status === 'planned').map((item) => (
              <p key={item.id} className="text-sm text-gray-600">
                {formatWorldDate(item.day)} · {slotLabel(item.slot)} · {locationById.get(item.locationId)?.name || item.locationId} · {item.description}
              </p>
            ))}
          </div>
        )}
        {scheduleDeviations.length > 0 && (
          <div className="mt-3 border-t border-gray-100 pt-3">
            <h4 className="mb-1 text-xs font-medium text-gray-400">最近日程偏离</h4>
            {scheduleDeviations.map((event) => (
              <div key={event.id} className="mb-2 rounded-lg bg-amber-50 px-2.5 py-2 text-xs text-amber-900">
                <p>{event.plannedLocationId ? `${locationById.get(event.plannedLocationId)?.name || event.plannedLocationId} → ` : ''}{locationById.get(event.actualLocationId ?? event.locationId ?? '')?.name || event.actualLocationId || event.locationId} · {event.deviationReason || event.content}</p>
                <p className="mt-1 text-[10px] text-amber-700">{event.worldDay ? formatWorldDate(event.worldDay) : `世界步${event.worldStep}`} · {event.worldSlot ? slotLabel(event.worldSlot) : ''} · 裁决影响 {event.deviationImpact ?? '未知'} · 置信度 {Math.round((event.adjudicationConfidence ?? 0) * 100)}%</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-3 bg-white px-4 py-4">
        <h3 className="mb-2 text-xs font-medium text-gray-400">生活日志</h3>
        {diaries.length === 0 ? (
          <p className="text-sm text-gray-400">推进时间后，这里会出现该角色独立生成且可追溯的日志。</p>
        ) : (
          <div className="space-y-2">
            {diaries.map((diary) => (
              <div key={diary.id} className="rounded-lg bg-gray-50 px-3 py-2">
                <p className="text-sm leading-relaxed text-gray-700">{diary.content}</p>
                <p className="mt-1 text-[10px] text-gray-400">
                  {formatWorldDate(diary.day)} · {slotLabel(diary.slot)} · {locationById.get(diary.locationId)?.name || diary.locationId} · {diary.activity}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {adminEnabled && (
        <section className="mt-3 bg-white px-4 py-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-medium text-gray-400">AI 内部意图</h3>
            {(contact.intentQueue ?? []).length > 0 && (
              <button onClick={() => clearIntentQueue(contactId!)} className="text-xs text-gray-400 underline">
                清空内部意图
              </button>
            )}
          </div>

          <div className="space-y-3 text-sm text-gray-600">
            <div>
              <p className="mb-1 text-xs text-gray-400">Active</p>
              {visibleActiveIntents.length === 0 ? (
                <p className="text-gray-400">暂无</p>
              ) : (
                <ul className="space-y-1">
                  {visibleActiveIntents.map((intent) => (
                    <li key={intent.id} className="rounded-lg bg-gray-50 px-2.5 py-2">
                      <p>{intent.text}</p>
                      <p className="mt-0.5 text-[11px] text-gray-400">
                        {intent.kind} / {intent.confidence} / {new Date(intent.createdAt).toLocaleString()}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <p className="mb-1 text-xs text-gray-400">Used 最近 5 条</p>
              {usedIntents.length === 0 ? (
                <p className="text-gray-400">暂无</p>
              ) : (
                <ul className="space-y-1">
                  {usedIntents.map((intent) => (
                    <li key={intent.id} className="rounded-lg bg-gray-50 px-2.5 py-2">
                      <p>{intent.text}</p>
                      <p className="mt-0.5 text-[11px] text-gray-400">
                        {intent.kind} / {intent.confidence} / {new Date(intent.createdAt).toLocaleString()}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      )}

      {adminEnabled && (
        <LatestAiTurnJson contactId={contactId!} />
      )}

      {adminEnabled && (
        <section className="mt-3 bg-white px-4 py-4">
          <h3 className="mb-2 text-xs font-medium text-gray-400">提示词预览（管理员模式）</h3>

          <div className="space-y-4">
            {/* Step 1: main model */}
            <div className="rounded-lg border-2 border-gray-800">
              <div className="border-b border-gray-200 bg-gray-100 px-3 py-1.5">
                <span className="text-xs font-bold text-gray-800">{`📤 发给主模型（${settings.model}）`}</span>
                <span className="ml-2 text-[10px] text-gray-400">生成自然语言回复 + 括号想法</span>
              </div>
              <div className="p-3">
                <div className="space-y-3">
                  <div className="rounded-lg border border-gray-200 bg-white">
                    <div className="border-b border-gray-100 px-3 py-2">
                      <p className="text-xs font-bold text-gray-900">逻辑</p>
                      <p className="mt-0.5 text-[10px] text-gray-400">身份、记忆、地点、日程、心情、关系等硬前提，优先级最高</p>
                    </div>
                    <pre className="whitespace-pre-wrap break-words p-3 font-sans text-[11px] leading-relaxed text-gray-700">
                      {mainModelPromptParts?.logic}
                    </pre>
                  </div>

                  <div className="rounded-lg border border-gray-200 bg-gray-50">
                    <div className="border-b border-gray-100 px-3 py-2">
                      <p className="text-xs font-bold text-gray-700">感觉</p>
                      <p className="mt-0.5 text-[10px] text-gray-400">在逻辑正确后再优化文笔、节奏、情绪和聊天感</p>
                    </div>
                    <pre className="whitespace-pre-wrap break-words p-3 font-sans text-[11px] leading-relaxed text-gray-600">
                      {mainModelPromptParts?.feeling}
                    </pre>
                  </div>
                </div>
              </div>
            </div>

            {/* Step 2: utility model */}
            <div className="rounded-lg border-2 border-gray-800">
              <div className="border-b border-gray-200 bg-gray-100 px-3 py-1.5">
                <span className="text-xs font-bold text-gray-800">{`📥 发给多功能模型（${settings.utilityModel}）`}</span>
                <span className="ml-2 text-[10px] text-gray-400">原始文字 → JSON（提取mood/thought/表情包）</span>
              </div>
              <div className="p-3">
                <pre className="whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-gray-700">
                  {conversionPrompt}
                </pre>
              </div>
            </div>
          </div>
        </section>
      )}

      <div className="mt-3 flex flex-col gap-2 bg-white px-4 py-4">
        <button onClick={handleChat} className="w-full rounded-lg bg-gray-900 py-2.5 text-sm text-white">
          发消息
        </button>
        <button onClick={() => setMenuOpen(true)} className="w-full rounded-lg bg-gray-100 py-2.5 text-sm text-red-500">
          删除联系人
        </button>
      </div>
      </div>

      {menuOpen && (
        <ActionSheet
          onClose={() => setMenuOpen(false)}
          options={[{ label: '确认删除该联系人及聊天记录', onSelect: handleDelete, danger: true }]}
        />
      )}

      {pickingRelationshipType && (
        <ActionSheet
          onClose={() => setPickingRelationshipType(false)}
          options={RELATIONSHIP_OPTIONS.map((label) => ({
            label,
            onSelect: () => db.contacts.update(contactId!, { relationshipBase: label }),
          }))}
        />
      )}

      {pickingPersonalityTrait && (
        <ActionSheet
          onClose={() => setPickingPersonalityTrait(false)}
          options={PERSONALITY_TRAIT_OPTIONS.map((opt) => ({
            label: opt.value,
            onSelect: () => db.contacts.update(contactId!, { personalityTrait: opt.value }),
          }))}
        />
      )}

      {clearMemoryConfirm && (
        <ActionSheet
          onClose={() => setClearMemoryConfirm(false)}
          options={[
            {
              label: '确认清空对方对你的记忆',
              onSelect: () => resetMemory(contactId!),
              danger: true,
            },
          ]}
        />
      )}

      {pickingAvatar && (
        <AvatarPicker
          onSelect={(avatar, photographer) =>
            db.contacts.update(contactId!, {
              avatar,
              avatarPhotographer: photographer?.name,
              avatarPhotographerUrl: photographer?.url,
            })
          }
          onClose={() => setPickingAvatar(false)}
          pexelsApiKey={settings.pexelsApiKey}
        />
      )}

      {editingRemark && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/30 p-8">
          <div className="w-full rounded-2xl bg-white p-4">
            <h2 className="mb-3 text-center text-[15px] font-medium text-gray-900">设置备注</h2>
            <input
              value={remarkDraft}
              onChange={(e) => setRemarkDraft(e.target.value)}
              placeholder="给TA起个只有你看得到的称呼"
              maxLength={20}
              className="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setEditingRemark(false)}
                className="flex-1 rounded-lg bg-gray-100 py-2 text-sm text-gray-600"
              >
                取消
              </button>
              <button onClick={saveRemark} className="flex-1 rounded-lg bg-gray-900 py-2 text-sm text-white">
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
