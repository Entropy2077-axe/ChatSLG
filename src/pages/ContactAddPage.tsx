import { useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { AvatarPicker } from '../components/AvatarPicker'
import { useSettingsStore } from '../store/useSettingsStore'
import { useContactCreationStore, type ContactCreationInput, type GenerateValues, type RelationRow } from '../store/useContactCreationStore'
import { useModuleEnabled } from '../features'
import { randomAvatarColor } from '../lib/colors'
import { AVATAR_EMOJIS } from '../lib/avatarEmojis'
import { pickRandomTrait } from '../lib/randomTraits'
import { setPairedContactRelation } from '../lib/contactRelations'
import { rememberInitialContactRelation } from '../lib/memory'
import { displayName } from '../lib/contact'
import { OCCUPATION_OPTIONS, employmentPatch } from '../lib/career'
import { customTraitsValidationError } from '../lib/contactCreator'
import { ensureWorldInitialized } from '../lib/world'
import { OUTFIT_FIELDS } from '../lib/outfit'
import { enqueueContactCreation } from '../lib/contactCreationQueue'
import { CONTACT_RELATION_LABELS, HOBBY_TAG_OPTIONS, PERSONALITY_TRAIT_OPTIONS, type ContactRelationLabel, type CustomPersonalityTrait } from '../types'
import {
  AGE_RANGE_OPTIONS,
  GENDER_OPTIONS,
  PERSONALITY_TAG_OPTIONS,
  RELATIONSHIP_OPTIONS,
} from '../lib/prompt'

/** Contact creation has a few real async phases (persona LLM call, then optional photo fetch, then db writes) — reflect actual state transitions rather than a fake time-based animation. */
const PROGRESS_LABELS: Record<'persona' | 'avatar' | 'saving', string> = {
  persona: '正在为TA设计人设…',
  avatar: '正在匹配头像…',
  saving: '创建中…',
}
const PROGRESS_PERCENT: Record<'persona' | 'avatar' | 'saving', number> = {
  persona: 30,
  avatar: 70,
  saving: 95,
}

export function ContactAddPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const settings = useSettingsStore()
  const existingContacts = useLiveQuery(() => db.contacts.toArray(), []) ?? []
  const savedPersonas = useLiveQuery(() => db.savedPersonas.orderBy('updatedAt').reverse().toArray(), []) ?? []
  const worldLocations = useLiveQuery(() => db.locations.orderBy('sortOrder').toArray(), []) ?? []

  const [tags, setTags] = useState<string[]>([])
  const [customTag, setCustomTag] = useState('')
  const [ageRange, setAgeRange] = useState('')
  const [gender, setGender] = useState('')
  const personalityEnabled = useModuleEnabled('personalityTraits')
  const creatorMode = settings.contactCreatorMode ?? 'standard'
  const nuwaEnabled = creatorMode === 'nuwa'
  const [relationship, setRelationship] = useState('')
  const [personalityTrait, setPersonalityTrait] = useState('')
  const [hobbies, setHobbies] = useState<string[]>([])
  const [extra, setExtra] = useState('')
  const careerEnabled = true
  const [occupation, setOccupation] = useState('')
  const [customOccupation, setCustomOccupation] = useState('')
  const [avatar, setAvatar] = useState(AVATAR_EMOJIS[Math.floor(Math.random() * AVATAR_EMOJIS.length)])
  const [avatarManuallySet, setAvatarManuallySet] = useState(false)
  const [pickingAvatar, setPickingAvatar] = useState(false)
  const jobs = useContactCreationStore((state) => state.jobs)
  const updateJob = useContactCreationStore((state) => state.updateJob)
  const updateDraft = useContactCreationStore((state) => state.updateDraft)
  const removeJob = useContactCreationStore((state) => state.removeJob)
  const selectedJob = jobs.find((job) => job.id === searchParams.get('job'))
  const creationDraft = selectedJob?.draft ?? null
  const generating = selectedJob?.status === 'saving'
  const progressStep = selectedJob?.status === 'persona' || selectedJob?.status === 'avatar' || selectedJob?.status === 'saving' ? selectedJob.status : null
  const [formError, setFormError] = useState('')
  const error = selectedJob?.error || formError
  const setCreationDraft = (updater: ((draft: NonNullable<typeof creationDraft>) => NonNullable<typeof creationDraft>) | null) => {
    if (!selectedJob) return
    if (updater === null) removeJob(selectedJob.id)
    else updateDraft(selectedJob.id, updater)
  }
  const [relationRows, setRelationRows] = useState<RelationRow[]>([])
  const [customTraits, setCustomTraits] = useState<CustomPersonalityTrait[]>([])
  const [customTendencies, setCustomTendencies] = useState('')
  const [customAge, setCustomAge] = useState('')
  const [customGender, setCustomGender] = useState('')
  const [customRelationship, setCustomRelationship] = useState('')
  const [customHobbies, setCustomHobbies] = useState('')
  const [customRealName, setCustomRealName] = useState('')
  const [customNickname, setCustomNickname] = useState('')
  const [customBirthday, setCustomBirthday] = useState('')
  const [personaPickerOpen, setPersonaPickerOpen] = useState(false)
  const [personaPage, setPersonaPage] = useState(0)

  function returnToContacts() {
    if ((location.state as { returnToContacts?: boolean } | null)?.returnToContacts) navigate(-1)
    else navigate('/contacts', { replace: true })
  }

  function fallbackBirthday(ageText: string) {
    const ages = [...ageText.matchAll(/\d+/g)].map((m) => Number(m[0])).filter(Number.isFinite)
    const age = ages.length ? Math.round(ages.reduce((sum, value) => sum + value, 0) / ages.length) : 25
    const now = new Date()
    return `${now.getFullYear() - age}-06-15`
  }

  function personaSnapshot() {
    return {
      personalityTendencies: nuwaEnabled ? customTendencies.split(/[、,，]+/).map((item) => item.trim()).filter(Boolean) : tags,
      age: nuwaEnabled ? customAge : ageRange,
      gender: nuwaEnabled ? customGender : gender,
      relationship: nuwaEnabled ? customRelationship : relationship,
      occupation: nuwaEnabled ? customOccupation : occupation,
      hobbies: nuwaEnabled ? customHobbies.split(/[、,，]+/).map((item) => item.trim()).filter(Boolean) : hobbies,
      notes: extra.trim(),
    }
  }

  async function saveCurrentPersona() {
    const now = Date.now()
    const profile = personaSnapshot()
    await db.savedPersonas.add({ id: uuid(), name: customNickname.trim() || customRealName.trim(), nickname: customNickname.trim() || undefined, realName: customRealName.trim() || undefined, birthday: customBirthday.trim() || undefined, profile, personaConstraints: extra.trim() || undefined, customPersonalityTraits: customTraits, createdAt: now, updatedAt: now })
    setPersonaPage(0)
  }

  function applySavedPersona(saved: import('../types').SavedPersona) {
    const profile = saved.profile
    setCustomTendencies(profile.personalityTendencies.join('、')); setCustomAge(profile.age); setCustomGender(profile.gender); setCustomRelationship(profile.relationship); setCustomOccupation(profile.occupation); setCustomHobbies(profile.hobbies.join('、')); setExtra(saved.personaConstraints || profile.notes || ''); setCustomTraits((saved.customPersonalityTraits || []).slice(0, 1).map((trait) => ({ id: uuid(), name: trait.name, meaning: trait.meaning }))); setCustomRealName(saved.realName || ''); setCustomNickname(saved.nickname || ''); setCustomBirthday(saved.birthday || ''); setPersonaPickerOpen(false)
  }

  function addRelationRow() {
    const taken = new Set(relationRows.map((r) => r.targetContactId))
    const firstAvailable = existingContacts.find((c) => !taken.has(c.id))
    if (!firstAvailable) return
    setRelationRows((prev) => [
      ...prev,
      { key: uuid(), targetContactId: firstAvailable.id, label: CONTACT_RELATION_LABELS[0] },
    ])
  }

  function updateRelationRow(key: string, patch: Partial<RelationRow>) {
    setRelationRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }

  function removeRelationRow(key: string) {
    setRelationRows((prev) => prev.filter((r) => r.key !== key))
  }

  function toggleTag(tag: string) {
    setTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))
  }

  function addCustomTag() {
    const trimmed = customTag.trim()
    if (!trimmed || tags.includes(trimmed)) return
    setTags((prev) => [...prev, trimmed])
    setCustomTag('')
  }

  function addRandomTrait() {
    setTags((prev) => [...prev, pickRandomTrait(prev)])
  }

  async function handleGenerate(overrides?: GenerateValues) {
    if (!settings.apiKey) {
      setFormError('还没有配置 API Key，请先去手机桌面的“设置”App 填写')
      return
    }
    if (nuwaEnabled) {
      const traitError = customTraitsValidationError(customTraits)
      if (traitError) { setFormError(traitError); return }
      if (relationRows.some((row) => !row.targetContactId || !row.label.trim())) { setFormError('联系人关系不能留空'); return }
    }
    setFormError('')
    try {
      const values = overrides ?? { tags: nuwaEnabled ? customTendencies.split(/[、,，]+/).map((x) => x.trim()).filter(Boolean) : tags, ageRange: nuwaEnabled ? customAge : ageRange, gender: nuwaEnabled ? customGender : gender, relationship: nuwaEnabled ? customRelationship : relationship, personalityTrait, hobbies: nuwaEnabled ? customHobbies.split(/[、,，]+/).map((x) => x.trim()).filter(Boolean) : hobbies, occupation: nuwaEnabled ? customOccupation.trim() : (occupation === '自定义' ? customOccupation.trim() : occupation), relationRows }
      const input: ContactCreationInput = {
        mode: nuwaEnabled ? 'nuwa' : 'standard',
        values,
        extra: extra.trim(),
        avatar,
        avatarManuallySet,
        realName: customRealName.trim(),
        nickname: customNickname.trim(),
        birthday: customBirthday.trim(),
        customTraits: structuredClone(customTraits),
      }
      await enqueueContactCreation(input)
      returnToContacts()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    }
  }

  async function confirmCreation() {
    if (!creationDraft || !selectedJob || generating) return
    updateJob(selectedJob.id, { status: 'saving', error: '' })
    try {
      const { parsed, values, finalAvatar, avatarPhotographer, avatarPhotographerUrl } = creationDraft
      const input = selectedJob.input
      const currentWorld = await ensureWorldInitialized()
      if (currentWorld.worldVersion !== creationDraft.worldVersion) throw new Error('地点树已变化，请重新生成人设和日程后再创建')
      if (await db.contacts.count() >= 12) throw new Error('每个世界最多创建12个角色')
      const id = uuid()
      const now = Date.now()
      const chosenOccupation = values.occupation
      await db.transaction('rw', db.contacts, db.characterSchedules, db.conversations, async () => {
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
        schedule: parsed.schedule,
        scheduleOverrides: [],
        mbti: parsed.mbti || undefined,
        currentLocationId: parsed.worldSchedule.find((item) => item.slot === creationDraft.worldSlot)?.locationId || creationDraft.playerLocationId,
        ...(chosenOccupation ? employmentPatch(chosenOccupation, parsed.monthlySalary ?? 6000) : { occupation: '' }),
        })
        await db.characterSchedules.bulkAdd(parsed.worldSchedule.map((item) => ({
          id: uuid(), characterId: id, dayOfWeek: item.dayOfWeek, slot: item.slot,
          locationId: item.locationId, activity: item.activity, phoneAccess: item.phoneAccess,
          priority: 'base' as const, sourceEventIds: [], createdAt: now,
        })))
        await db.conversations.add({ id: uuid(), contactId: id, channel: 'private_phone', pinned: false, createdAt: now, updatedAt: now })
      })
      for (const row of values.relationRows) {
        await setPairedContactRelation(id, row.targetContactId, row.label)
        await rememberInitialContactRelation({
          fromContactId: id,
          toContactId: row.targetContactId,
          label: row.label,
          now,
        })
      }
      updateJob(selectedJob.id, { status: 'completed' })
      removeJob(selectedJob.id)
      returnToContacts()
    } catch (err) {
      updateJob(selectedJob.id, { status: 'ready', error: err instanceof Error ? err.message : String(err) })
    }
  }

  function updateCustomTrait(patch: Partial<CustomPersonalityTrait>) {
    setCustomTraits((prev) => [{ ...(prev[0] ?? { id: uuid(), name: '', meaning: '' }), ...patch }])
  }


  function completelyRandom() {
    const pick = <T,>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)]
    const randomRows: RelationRow[] = existingContacts.filter(() => Math.random() < 0.35).map((contact) => ({ key: uuid(), targetContactId: contact.id, label: pick(CONTACT_RELATION_LABELS) }))
    const randomOccupation = careerEnabled ? pick(OCCUPATION_OPTIONS) : ''
    const values = { tags: [pick(PERSONALITY_TAG_OPTIONS), pick(PERSONALITY_TAG_OPTIONS)].filter((v, i, a) => a.indexOf(v) === i), ageRange: pick(AGE_RANGE_OPTIONS), gender: pick(GENDER_OPTIONS.filter((x) => x !== '不限')), relationship: pick(RELATIONSHIP_OPTIONS), personalityTrait: personalityEnabled ? pick(PERSONALITY_TRAIT_OPTIONS.filter((x) => x.value !== '无')).value : '', hobbies: [...HOBBY_TAG_OPTIONS].sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 4)), occupation: randomOccupation, relationRows: randomRows }
    setTags(values.tags); setAgeRange(values.ageRange); setGender(values.gender); setRelationship(values.relationship); setPersonalityTrait(values.personalityTrait); setHobbies(values.hobbies); setOccupation(randomOccupation); setRelationRows(randomRows)
    void handleGenerate(values)
  }

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="添加联系人" showBack />

      <div className="mt-3 flex-1 overflow-y-auto bg-white px-4 py-4">
        <div className="mb-4 grid grid-cols-2 rounded-xl bg-gray-100 p-1" aria-label="角色创建模式">
          <button type="button" onClick={() => settings.setSettings({ contactCreatorMode: 'standard' })} className={`rounded-lg py-2 text-sm ${!nuwaEnabled ? 'bg-white font-medium text-gray-900 shadow-sm' : 'text-gray-500'}`}>标准模式</button>
          <button type="button" onClick={() => settings.setSettings({ contactCreatorMode: 'nuwa' })} className={`rounded-lg py-2 text-sm ${nuwaEnabled ? 'bg-purple-600 font-medium text-white shadow-sm' : 'text-gray-500'}`}>女娲模式</button>
        </div>
        {!nuwaEnabled && <button type="button" onClick={completelyRandom} disabled={generating} className="mb-4 w-full rounded-lg bg-gray-900 py-3 text-sm font-medium text-white transition active:scale-[.98] disabled:opacity-50">🎲 完全随机创建</button>}
        {nuwaEnabled && <p className="mb-4 text-xs text-purple-600">女娲模式已开启：以下角色属性全部自由填写，并作为不可改写的人设约束。</p>}
        <p className="mb-4 text-xs text-gray-400">
          描述一下你想认识的这个人 名字会由对方自己来定 确认添加后就正式加上了 之后不能再改TA的性格设定
        </p>

        {nuwaEnabled && <div className="mb-4 grid grid-cols-2 gap-2"><button type="button" onClick={() => void saveCurrentPersona()} className="rounded-lg bg-gray-900 py-2.5 text-sm text-white">保存当前人设</button><button type="button" onClick={() => { setPersonaPage(0); setPersonaPickerOpen(true) }} className="rounded-lg border border-gray-300 bg-white py-2.5 text-sm text-gray-800">使用已保存的人设</button></div>}
        <label className="mb-1 block text-xs text-gray-400">头像</label>
        <button
          onClick={() => setPickingAvatar(true)}
          className="mb-1 flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2"
        >
          <Avatar avatar={avatar} size={44} />
          <span className="text-sm text-gray-500">点击选择</span>
        </button>
        <p className="mb-4 text-xs text-gray-400">
          不手动选的话 系统会按性格自动配一张动漫头像/风景照/网图人像/宠物照
        </p>

        {!nuwaEnabled && <><label className="mb-2 block text-xs font-medium text-gray-400">性格倾向（可多选，也可以自己填）</label>
        <div className="mb-2 flex flex-wrap gap-2">
          {PERSONALITY_TAG_OPTIONS.map((tag) => (
            <button
              key={tag}
              onClick={() => toggleTag(tag)}
              className={`rounded-full px-3 py-1.5 text-xs ${
                tags.includes(tag) ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
              }`}
            >
              {tag}
            </button>
          ))}
          {tags
            .filter((t) => !PERSONALITY_TAG_OPTIONS.includes(t))
            .map((tag) => (
              <button
                key={tag}
                onClick={() => toggleTag(tag)}
                className="rounded-full bg-gray-900 px-3 py-1.5 text-xs text-white"
              >
                {tag} ×
              </button>
            ))}
        </div>
        <div className="mb-4 flex gap-2">
          <input
            value={customTag}
            onChange={(e) => setCustomTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addCustomTag()
              }
            }}
            placeholder="自定义一个性格标签"
            className="flex-1 rounded-lg border border-gray-200 px-3 py-1.5 text-xs"
          />
          <button onClick={addCustomTag} className="rounded-lg bg-gray-100 px-3 py-1.5 text-xs text-gray-600">
            添加
          </button>
          <button onClick={addRandomTrait} className="rounded-lg bg-gray-100 px-3 py-1.5 text-xs text-gray-600">
            🎲 随机词条
          </button>
        </div>

        <label className="mb-2 block text-xs font-medium text-gray-400">年龄段</label>
        <div className="mb-4 flex flex-wrap gap-2">
          {AGE_RANGE_OPTIONS.map((v, index) => (
            <button
              key={`age-${v}-${index}`}
              onClick={() => setAgeRange(ageRange === v ? '' : v)}
              className={`rounded-full px-3 py-1.5 text-xs ${
                ageRange === v ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
              }`}
            >
              {v}
            </button>
          ))}
        </div>

        <label className="mb-2 block text-xs font-medium text-gray-400">性别</label>
        <div className="mb-4 flex flex-wrap gap-2">
          {GENDER_OPTIONS.map((v, index) => (
            <button
              key={`gender-${v}-${index}`}
              onClick={() => setGender(v === '不限' ? '' : v)}
              className={`rounded-full px-3 py-1.5 text-xs ${
                gender === v || (v === '不限' && !gender) ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
              }`}
            >
              {v}
            </button>
          ))}
        </div>

        <label className="mb-2 block text-xs font-medium text-gray-400">关系定位</label>
        <div className="mb-4 flex flex-wrap gap-2">
          {RELATIONSHIP_OPTIONS.map((v, index) => (
            <button
              key={`relationship-${v}-${index}`}
              onClick={() => setRelationship(relationship === v ? '' : v)}
              className={`rounded-full px-3 py-1.5 text-xs ${
                relationship === v ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
              }`}
            >
              {v}
            </button>
          ))}
        </div>

        {personalityEnabled && (
          <>
            <label className="mb-2 block text-xs font-medium text-gray-400">性格特质</label>
            <div className="mb-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  const traits = PERSONALITY_TRAIT_OPTIONS.filter((o) => o.value !== '无')
                  const pick = traits[Math.floor(Math.random() * traits.length)]
                  setPersonalityTrait(pick.value)
                }}
                className="rounded-full bg-gray-100 px-3 py-1.5 text-xs text-gray-600"
              >
                🎲 随机
              </button>
              {PERSONALITY_TRAIT_OPTIONS.map((opt, index) => (
                <button
                  key={`trait-${opt.value}-${index}`}
                  type="button"
                  onClick={() => setPersonalityTrait(personalityTrait === opt.value ? '' : opt.value)}
                  className={`rounded-full px-3 py-1.5 text-xs ${
                    personalityTrait === opt.value ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
                  }`}
                  title={opt.description}
                >
                  {opt.value}
                </button>
          ))}
            </div>
          </>
        )}

        {careerEnabled && <div className="mb-4"><label className="mb-2 block text-xs font-medium text-gray-400">职业（必选）</label><div className="flex flex-wrap gap-2"><button type="button" onClick={()=>setOccupation(OCCUPATION_OPTIONS[Math.floor(Math.random()*OCCUPATION_OPTIONS.length)])} className="rounded-full bg-gray-100 px-3 py-1.5 text-xs text-gray-600">🎲 随机</button>{[...OCCUPATION_OPTIONS,'自定义'].map((v, index)=><button key={`occupation-${v}-${index}`} type="button" onClick={()=>setOccupation(v)} className={`rounded-full px-3 py-1.5 text-xs ${occupation===v?'bg-gray-900 text-white':'bg-gray-100 text-gray-600'}`}>{v}</button>)}</div>{occupation==='自定义'&&<input value={customOccupation} onChange={e=>setCustomOccupation(e.target.value)} placeholder="输入职业" className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"/>}</div>}

        {/* 兴趣爱好（可选） */}
        <div className="mb-4">
          <label className="mb-2 block text-xs font-medium text-gray-400">兴趣爱好（可选）</label>
          <div className="flex flex-wrap gap-2">
            {HOBBY_TAG_OPTIONS.map((hobby, index) => (
              <button
                key={`hobby-${hobby}-${index}`}
                type="button"
                onClick={() =>
                  setHobbies(
                    hobbies.includes(hobby)
                      ? hobbies.filter((h) => h !== hobby)
                      : [...hobbies, hobby],
                  )
                }
                className={`rounded-full px-3 py-1.5 text-xs ${
                  hobbies.includes(hobby) ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
                }`}
              >
                {hobby}
              </button>
            ))}
          </div>
        </div></>}

        {nuwaEnabled && <div className="mb-4 grid grid-cols-2 gap-2 rounded-xl border border-gray-200 p-3"><label className="col-span-2 text-xs font-medium text-gray-500">身份资料（可留空，由 AI 补全）</label><input value={customRealName} onChange={(e) => setCustomRealName(e.target.value)} placeholder="真名" className="rounded-lg border border-gray-200 px-3 py-2 text-sm"/><input value={customNickname} onChange={(e) => setCustomNickname(e.target.value)} placeholder="网名" className="rounded-lg border border-gray-200 px-3 py-2 text-sm"/><input value={customBirthday} onChange={(e) => setCustomBirthday(e.target.value)} placeholder="出生年月日 YYYY-MM-DD" className="col-span-2 rounded-lg border border-gray-200 px-3 py-2 text-sm"/></div>}

        {nuwaEnabled && <div className="mb-4 space-y-3"><div><label className="mb-1 block text-xs font-medium text-gray-400">性格倾向</label><input value={customTendencies} onChange={(e) => setCustomTendencies(e.target.value)} placeholder="例如：慢热、敏感、有主见（顿号分隔）" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"/></div><div className="grid grid-cols-2 gap-2"><div><label className="mb-1 block text-xs text-gray-400">年龄</label><input value={customAge} onChange={(e) => setCustomAge(e.target.value)} placeholder="例如：24岁" className="w-full rounded-lg border px-3 py-2 text-sm"/></div><div><label className="mb-1 block text-xs text-gray-400">性别</label><input value={customGender} onChange={(e) => setCustomGender(e.target.value)} placeholder="自由填写" className="w-full rounded-lg border px-3 py-2 text-sm"/></div></div><div><label className="mb-1 block text-xs text-gray-400">关系定位</label><input value={customRelationship} onChange={(e) => setCustomRelationship(e.target.value)} placeholder="与用户是什么关系" className="w-full rounded-lg border px-3 py-2 text-sm"/></div>{careerEnabled && <div><label className="mb-1 block text-xs text-gray-400">职业</label><input value={customOccupation} onChange={(e) => setCustomOccupation(e.target.value)} placeholder="自由填写职业" className="w-full rounded-lg border px-3 py-2 text-sm"/></div>}<div><label className="mb-1 block text-xs text-gray-400">兴趣爱好</label><input value={customHobbies} onChange={(e) => setCustomHobbies(e.target.value)} placeholder="多个兴趣用顿号分隔" className="w-full rounded-lg border px-3 py-2 text-sm"/></div></div>}

        {nuwaEnabled && <section className="mb-4"><label className="mb-2 block text-xs font-medium text-gray-500">自定义性格特质（最多一个）</label><div className="rounded-xl border border-gray-200 p-3"><div className="flex gap-2"><input value={customTraits[0]?.name ?? ''} onChange={(e) => updateCustomTrait({ name: e.target.value })} placeholder="特质名称" className="w-1/3 rounded-lg border px-2 py-1.5 text-sm"/><input value={customTraits[0]?.meaning ?? ''} onChange={(e) => updateCustomTrait({ meaning: e.target.value })} placeholder="特质含义与行为表现" className="flex-1 rounded-lg border px-2 py-1.5 text-sm"/></div>{customTraits.length > 0 && <button type="button" onClick={() => setCustomTraits([])} className="mt-2 text-xs text-gray-400">清空特质</button>}</div></section>}

        {existingContacts.length > 0 && (
          <>
            <div className="mb-2 flex items-center justify-between">
              <label className="block text-xs font-medium text-gray-400">TA与其他联系人的关系（可选）</label>
              <button
                onClick={addRelationRow}
                disabled={relationRows.length >= existingContacts.length}
                className="text-xs text-[#aa3bff] disabled:opacity-40"
              >
                + 添加关系
              </button>
            </div>
            <div className="mb-4 space-y-2">
              {relationRows.map((row) => (
                <div key={row.key} className="flex items-center gap-2">
                  <select
                    value={row.targetContactId}
                    onChange={(e) => updateRelationRow(row.key, { targetContactId: e.target.value })}
                    className="flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
                  >
                    {existingContacts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {displayName(c)}
                      </option>
                    ))}
                  </select>
                  {nuwaEnabled ? <input value={row.label} onChange={(e) => updateRelationRow(row.key, { label: e.target.value })} placeholder="自定义关系" className="flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-xs"/> : <select
                    value={row.label}
                    onChange={(e) =>
                      updateRelationRow(row.key, { label: e.target.value as ContactRelationLabel })
                    }
                    className="flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
                  >
                    {CONTACT_RELATION_LABELS.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>}
                  <button onClick={() => removeRelationRow(row.key)} className="shrink-0 text-xs text-gray-300">
                    删除
                  </button>
                </div>
              ))}
              {relationRows.length === 0 && (
                <p className="text-xs text-gray-400">不设置的话TA和其他联系人之间默认没有关系 不会互相在朋友圈下面互动</p>
              )}
            </div>
          </>
        )}

        <label className="mb-2 block text-xs font-medium text-gray-400">补充说明（可选）</label>
        <textarea
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          placeholder="比如职业、爱好、说话口头禅、你们认识的契机…"
          rows={4}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
        />

        {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
      </div>

      <div className="sticky bottom-0 border-t border-gray-100 bg-white p-3">
        {generating && progressStep && (
          <div className="mb-2">
            <p className="mb-1 text-center text-xs text-gray-400">{PROGRESS_LABELS[progressStep]}</p>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
              <div
                className="h-full rounded-full bg-gray-900 transition-all duration-500"
                style={{ width: `${PROGRESS_PERCENT[progressStep]}%` }}
              />
            </div>
          </div>
        )}
        <button
          onClick={() => void handleGenerate()}
          disabled={generating || !!creationDraft || (careerEnabled && (nuwaEnabled ? !customOccupation.trim() : (!occupation || (occupation === '自定义' && !customOccupation.trim()))))}
          className="w-full rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-40"
        >
          {generating ? '正在生成…' : '生成人设预览'}
        </button>
      </div>

      {creationDraft && <div className="absolute inset-0 z-40 flex flex-col bg-[#f4f4f6]"><TopBar title="确认角色"/><div className="min-h-0 flex-1 overflow-y-auto p-4"><section className="rounded-2xl bg-white p-4"><div className="flex items-center gap-3"><Avatar avatar={creationDraft.finalAvatar} size={56}/><div className="flex-1"><label className="text-[11px] text-gray-400">姓名</label><input value={creationDraft.parsed.name} onChange={(event) => setCreationDraft((draft) => draft ? { ...draft, parsed: { ...draft.parsed, name: event.target.value } } : draft)} className="w-full border-b border-gray-200 py-1 text-lg font-medium"/></div></div><label className="mt-4 block text-xs text-gray-400">职业（硬约束）</label><input value={creationDraft.values.occupation} onChange={(event) => setCreationDraft((draft) => draft ? { ...draft, values: { ...draft.values, occupation: event.target.value } } : draft)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"/><label className="mt-4 block text-xs text-gray-400">完整人设</label><textarea value={creationDraft.parsed.persona} onChange={(event) => setCreationDraft((draft) => draft ? { ...draft, parsed: { ...draft.parsed, persona: event.target.value } } : draft)} rows={8} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm leading-relaxed"/><h3 className="mt-4 text-xs text-gray-400">六部位初始衣着（确认后成为硬状态）</h3><div className="mt-2 grid grid-cols-2 gap-2">{OUTFIT_FIELDS.map(([key, label]) => <label key={key} className="text-[11px] text-gray-500">{label}<input value={creationDraft.parsed.outfit[key]} onChange={(event) => setCreationDraft((draft) => draft ? { ...draft, parsed: { ...draft.parsed, outfit: { ...draft.parsed.outfit, [key]: event.target.value } } } : draft)} className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-xs"/></label>)}</div><h3 className="mt-4 text-xs text-gray-400">基础日程（仅叶子地点）</h3><div className="mt-2 space-y-2">{creationDraft.parsed.worldSchedule.map((item, index) => <div key={`${item.slot}-${index}`} className="grid grid-cols-[62px_1fr] gap-2 rounded-xl bg-gray-50 p-2"><span className="pt-2 text-xs text-gray-500">{{morning:'早晨',day:'白天',evening:'傍晚',night:'夜晚'}[item.slot]}</span><div className="space-y-1"><select value={item.locationId} onChange={(event) => setCreationDraft((draft) => draft ? { ...draft, parsed: { ...draft.parsed, worldSchedule: draft.parsed.worldSchedule.map((row, rowIndex) => rowIndex === index ? { ...row, locationId: event.target.value } : row) } } : draft)} className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs">{worldLocations.filter((location) => !worldLocations.some((child) => child.parentId === location.id)).map((location) => <option key={location.id} value={location.id}>{location.name} · {location.id}</option>)}</select><input value={item.activity} onChange={(event) => setCreationDraft((draft) => draft ? { ...draft, parsed: { ...draft.parsed, worldSchedule: draft.parsed.worldSchedule.map((row, rowIndex) => rowIndex === index ? { ...row, activity: event.target.value } : row) } } : draft)} className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs"/></div></div>)}</div></section>{error && <p className="mt-3 text-xs text-red-500">{error}</p>}</div><div className="grid grid-cols-2 gap-2 border-t bg-white p-3"><button onClick={() => setCreationDraft(null)} disabled={generating} className="rounded-lg border border-gray-300 py-2.5 text-sm">返回修改</button><button onClick={() => void confirmCreation()} disabled={generating || !creationDraft.parsed.name.trim() || !creationDraft.parsed.persona.trim() || !creationDraft.values.occupation.trim()} className="rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-40">{generating ? '写入中…' : '确认创建'}</button></div></div>}

      {personaPickerOpen && <div className="absolute inset-0 z-30 flex items-center bg-black/30 p-4"><div className="w-full rounded-2xl bg-white p-4"><div className="mb-3 flex items-center justify-between"><h2 className="font-medium">已保存的人设</h2><button type="button" onClick={() => setPersonaPickerOpen(false)} className="text-sm text-gray-500">关闭</button></div><div className="space-y-2">{savedPersonas.slice(personaPage * 5, personaPage * 5 + 5).map((saved, index) => <button key={saved.id} type="button" onClick={() => applySavedPersona(saved)} className="flex w-full items-center justify-between rounded-xl bg-gray-50 px-3 py-3 text-left"><span className="text-sm text-gray-900">{saved.nickname || saved.realName || `未命名人设${personaPage * 5 + index + 1}`}</span><span className="text-xs text-gray-400">使用</span></button>)}{savedPersonas.length === 0 && <p className="py-6 text-center text-sm text-gray-400">还没有保存的人设</p>}</div><div className="mt-4 flex items-center justify-between"><button type="button" disabled={personaPage === 0} onClick={() => setPersonaPage((page) => page - 1)} className="text-sm text-gray-600 disabled:text-gray-300">上一页</button><span className="text-xs text-gray-400">{personaPage + 1} / {Math.max(1, Math.ceil(savedPersonas.length / 5))}</span><button type="button" disabled={(personaPage + 1) * 5 >= savedPersonas.length} onClick={() => setPersonaPage((page) => page + 1)} className="text-sm text-gray-600 disabled:text-gray-300">下一页</button></div></div></div>}
      {pickingAvatar && (
        <AvatarPicker
          onSelect={(a) => {
            setAvatar(a)
            setAvatarManuallySet(true)
          }}
          onClose={() => setPickingAvatar(false)}
        />
      )}
    </div>
  )
}
