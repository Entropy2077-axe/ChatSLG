import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { chatCompletion, coalesceConsecutiveRoles, type ChatMessage } from './deepseek'
import { extractJsonObject, parseAiResponse, parseRawPrivateDraft, serializePrivateTurn } from './aiProtocol'
import { formatSpeechSamplesForScene, buildRawChatPrompt, buildJsonConversionPrompt, customPersonalityTraitsLine } from './prompt'
import { retrieveWorldbookTrace } from './worldbook'
import { isModuleEnabled } from '../features'
import { CONTEXT_WINDOW_SIZE, activeUpcomingPlansText, maybeUpdateMemory, recentMemoriesText, socialMemoriesText } from './memory'
import { activeIntentPrompt, activeIntents, markIntentsUsed } from './intent'
import { describeCurrentTime, ageFromBirthday } from './time'
import { displayName } from './contact'
import { previewForMessage } from './messagePreview'
import { recentSocialEventsText } from './socialEvents'
import { recentSharedOriginalContext } from './sharedRecentContext'
import { useChatUiStore } from '../store/useChatUiStore'
import { enqueueSelfIterationTask } from './selfIteration'
import { USER_WALLET_ID, balanceOf, reserveRedPacket, transferFunds } from './finance'
import { buildLogicContext, formatActionContext, formatLogicContext } from './logicContext'
import { adjudicateStateChanges } from './stateAdjudicator'
import { reviewTurnLogic } from './turnLogicReviewer'
import { isWorldPhoneAvailable } from './schedule'
import { chatLivelinessRule } from './chatLiveliness'
import { ensureWorldInitialized, resolveSchedule } from './world'
import type { AiBubble, AppSettings, Contact, Message, MessageType, Sticker } from '../types'
import { messagesForAiTurn, recentConversationMessages } from './conversationStats'

/**
 * Per-conversation AI-turn state, deliberately kept in a module-level
 * Zustand store rather than component state. ChatPage used to own this in
 * local refs/useState, which meant navigating away unmounted the component
 * and its cleanup effect aborted the in-flight request and cleared all
 * pending bubble-reveal timers — the conversation would just stop mid-reply
 * the moment you left the screen. Living here, generation keeps running
 * (and messages keep landing in IndexedDB) no matter which page is mounted;
 * ChatPage just subscribes to this store for its conversationId when open.
 */
interface ConversationRuntimeState {
  aiTyping: boolean
  error: string
  typingLabel?: string
}
// Exported as a stable reference — selectors that fall back to this for a
// conversation with no state yet must never construct a fresh object
// literal on the fly (e.g. `s.states[id] ?? { aiTyping: false, error: '' }`),
// since a new reference every call trips React's useSyncExternalStore
// infinite-loop detection and crashes the page.
export const DEFAULT_RUNTIME_STATE: ConversationRuntimeState = { aiTyping: false, error: '', typingLabel: undefined }

interface ChatEngineStore {
  states: Record<string, ConversationRuntimeState>
  patch: (conversationId: string, patch: Partial<ConversationRuntimeState>) => void
}

export const useChatEngineStore = create<ChatEngineStore>((set) => ({
  states: {},
  patch: (conversationId, patch) =>
    set((s) => ({
      states: {
        ...s.states,
        [conversationId]: { ...(s.states[conversationId] ?? DEFAULT_RUNTIME_STATE), ...patch },
      },
    })),
}))

export function getConversationRuntimeState(conversationId: string): ConversationRuntimeState {
  return useChatEngineStore.getState().states[conversationId] ?? DEFAULT_RUNTIME_STATE
}

export function isAnyChatTurnActive(): boolean {
  return Object.values(useChatEngineStore.getState().states).some((state) => state.aiTyping)
}

// Bookkeeping that doesn't need to be reactive — plain module-level maps,
// keyed by conversationId, so they survive regardless of component mounts.
/** How long a mood lasts before expiring back to neutral. */
// Mood expiry is now a user-configurable setting (see ProactiveSettingsPage → mood settings).
// The default is 30 min, stored in AppSettings.moodExpiryMs.
const streamByConversation = new Map<string, string>()
const timersByConversation = new Map<string, ReturnType<typeof setTimeout>[]>()
const abortByConversation = new Map<string, AbortController>()

function getActiveMood(contact: Contact, now: number): string | undefined {
  if (!contact.mood || !contact.mood.text) return undefined
  if (now > contact.mood.expiresAt) return undefined
  return contact.mood.text
}

function clearPending(conversationId: string) {
  timersByConversation.get(conversationId)?.forEach(clearTimeout)
  timersByConversation.set(conversationId, [])
  abortByConversation.get(conversationId)?.abort()
}

function beginTurn(conversationId: string, streamId: string): AbortController {
  clearPending(conversationId)
  streamByConversation.set(conversationId, streamId)
  const controller = new AbortController()
  abortByConversation.set(conversationId, controller)
  return controller
}

function isCurrentTurn(conversationId: string, streamId: string): boolean {
  return streamByConversation.get(conversationId) === streamId
}

export function formatStructuredHistoryEvent(
  message: Message,
  kind: MessageType,
): ChatMessage {
  const actor = message.role === 'assistant' ? 'contact' : 'user'
  const attrs =
    kind === 'link' && message.link
      ? [
          ['type', kind],
          ['actor', actor],
          ['label', message.link.label],
          ['app', message.link.app],
          ['data', JSON.stringify(message.link.data ?? {})],
        ]
      : message.finance && ['transfer','redPacket','loanRequest','loanResult','repayment'].includes(kind)
        ? [['type', kind], ['actor', actor], ['amount', message.finance.amount], ['note', message.finance.note ?? ''], ['loanId', message.finance.loanId ?? ''], ['status', message.finance.status ?? '']]
      : kind === 'gift' && message.gift
        ? [
            ['type', kind],
            ['actor', actor],
            ['name', message.gift.name],
            ['icon', message.gift.icon],
          ]
        : kind === 'scheduleChange' && message.scheduleChange
          ? [
              ['type', kind],
              ['actor', actor],
              ['summary', message.scheduleChange.summary],
              ['day', message.scheduleChange.effectiveDay ?? message.scheduleChange.date ?? '旧记录'],
              ['slot', message.scheduleChange.slot ?? '旧记录'],
              ['locationId', message.scheduleChange.locationId ?? message.scheduleChange.location ?? '旧记录'],
            ]
          : [
              ['type', kind],
              ['actor', actor],
              ['content', message.content],
            ]

  const content = `<<HISTORY_EVENT ${attrs
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}="${String(value).replace(/"/g, '\\"')}"`)
    .join(' ')}>>`

  return {
    role: message.role,
    content,
  }
}

function parseAiTurnDebugPayload(opts: {
  mainPrompt: string
  conversionPrompt: string
  rawText: string
  jsonRaw: string
  finalRaw: string
  bubbles: AiBubble[]
  knowledgeQueries: string[]
  mood?: string
  thought?: string
  qualityCheck: { enabled: boolean; repaired: boolean; reason?: string; detectedInvalid?: boolean }
  injectedIntents: ReturnType<typeof activeIntents>
  promptTrace?: import('../types').PromptTrace
}): unknown {
  const { mainPrompt, conversionPrompt, finalRaw, jsonRaw, rawText, bubbles, knowledgeQueries, mood, thought, qualityCheck, injectedIntents, promptTrace } = opts
  const trimmed = finalRaw.trim()
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const text = fenceMatch ? fenceMatch[1].trim() : trimmed
  let conversionParsed: unknown = null
  try {
    conversionParsed = JSON.parse(text)
  } catch {
    const extracted = extractJsonObject(text)
    if (extracted) {
      try {
        conversionParsed = JSON.parse(extracted)
      } catch {
        // fall through
      }
    }
  }
  return {
    mainPrompt,
    conversionPrompt,
    rawText,
    jsonRaw,
    finalRaw,
    conversionParsed,
    parsedBubbles: bubbles,
    qualityCheck,
    mood,
    thought,
    knowledgeQueries,
    injectedIntents,
    memoryUpdate: null,
    promptTrace,
  }
}

/** Admin-only safe stop: cancels network work and unrevealed bubbles for one conversation. */
export function stopAiTurn(conversationId: string): void {
  streamByConversation.set(conversationId, uuid())
  clearPending(conversationId)
  useChatEngineStore.getState().patch(conversationId, { aiTyping: false, typingLabel: undefined, error: '已由管理员停止本轮生成' })
}

function formatRecentConversationForReview(messages: Message[], contact: Contact): string {
  return messages
    .slice(-10)
    .map((m) => {
      const speaker = m.role === 'user' ? 'User' : displayName(contact)
      if (m.type !== 'text') return `${speaker}: [${m.type}: ${m.content}]`
      return `${speaker}: ${m.content}`
    })
    .join('\n')
}

export function buildUserProfileText(settings: AppSettings): string {
  const parts: string[] = [`昵称: ${settings.userNickname || '未设置'}`]
  if (settings.userGender) parts.push(`性别: ${settings.userGender}`)
  const age = ageFromBirthday(settings.userBirthday)
  if (age !== null) parts.push(`年龄: ${age}岁`)
  if (settings.userBio) parts.push(`简介: ${settings.userBio}`)
  if (isModuleEnabled('career') && settings.userOccupation) parts.push(`职业: ${settings.userOccupation} 月薪: ${settings.userMonthlySalary}`)
  return parts.join(' · ')
}

/** Sends a user message and kicks off the AI's reply — safe to call whether or not ChatPage is currently mounted for this conversation. */
export async function sendMessage(
  conversationId: string,
  contact: Contact,
  settings: AppSettings,
  stickers: Sticker[],
  text: string,
): Promise<void> {
  if (!text.trim()) return
  if (!settings.apiKey) {
    useChatEngineStore.getState().patch(conversationId, { error: '还没有配置API Key 请先去"我-设置"里填写' })
    return
  }

  const streamId = uuid()
  const controller = beginTurn(conversationId, streamId)
  useChatEngineStore.getState().patch(conversationId, { aiTyping: true, error: '', typingLabel: displayName(contact) })

  const msg: Message = {
    id: uuid(),
    conversationId,
    role: 'user',
    type: 'text',
    content: text.trim(),
    createdAt: Date.now(),
  }
  await db.messages.add(msg)
  await db.conversations.update(conversationId, { updatedAt: Date.now() })

  const world = await ensureWorldInitialized()
  await db.worldEvents.put({
    id: msg.id, type: 'phone', worldStep: world.step, actorId: 'user',
    participantIds: [contact.id], content: msg.content, visibility: 'private', createdAt: msg.createdAt,
  })
  if (!await isWorldPhoneAvailable(contact.id)) {
    await db.pendingPhoneMessages.add({
      id: uuid(), conversationId, senderId: 'user', recipientIds: [contact.id],
      messageId: msg.id, createdAt: Date.now(), status: 'pending',
    })
    useChatEngineStore.getState().patch(conversationId, { aiTyping: false, typingLabel: undefined })
    return
  }
  await db.perceivedEvents.put({ id: uuid(), eventId: msg.id, characterId: contact.id, perception: 'full', observedAtStep: world.step })

  if (!isCurrentTurn(conversationId, streamId) || controller.signal.aborted) return
  void runAiTurn(conversationId, contact, settings, stickers, streamId, controller, text.trim())
}

/**
 * Kicks off a reply from whatever's already in the conversation history,
 * without inserting a new user-role message first — for background actions
 * that write their own message directly (gifting an item from the
 * warehouse) and then want a
 * real reply out of it instead of just leaving a message sitting there
 * until the user happens to reopen that chat.
 */
export async function triggerAiTurn(
  conversationId: string,
  contact: Contact,
  settings: AppSettings,
  stickers: Sticker[],
  proactiveContext = '',
): Promise<void> {
  const streamId = uuid()
  const controller = beginTurn(conversationId, streamId)
  useChatEngineStore.getState().patch(conversationId, { aiTyping: true, error: '', typingLabel: displayName(contact) })
  await runAiTurn(conversationId, contact, settings, stickers, streamId, controller, '', proactiveContext)
}

export async function regenerateAiTurn(
  conversationId: string,
  contact: Contact,
  settings: AppSettings,
  stickers: Sticker[],
  aiTurnId: string,
): Promise<void> {
  if (!settings.apiKey) {
    useChatEngineStore.getState().patch(conversationId, { error: '还没有配置 API Key，请先去“我 / 设置”里填写' })
    return
  }

  const streamId = uuid()
  const controller = beginTurn(conversationId, streamId)
  useChatEngineStore.getState().patch(conversationId, { aiTyping: true, error: '', typingLabel: displayName(contact) })

  const turnMessages = await messagesForAiTurn(aiTurnId)
  if (turnMessages.length > 0) await db.messages.bulkDelete(turnMessages.map((message) => message.id))
  await db.aiTurns.delete(aiTurnId)
  await db.conversations.update(conversationId, { updatedAt: Date.now() })

  if (!isCurrentTurn(conversationId, streamId) || controller.signal.aborted) return
  await runAiTurn(conversationId, contact, settings, stickers, streamId, controller)
}

async function runAiTurn(
  conversationId: string,
  contact: Contact,
  settings: AppSettings,
  stickers: Sticker[],
  streamId: string,
  controller: AbortController,
  _triggeringUserText = '',
  proactiveContext = '',
): Promise<void> {
  const engine = useChatEngineStore.getState()
  const turnStartedAt = performance.now()
  const now = Date.now()
  const activeMood = getActiveMood(contact, now)
  engine.patch(conversationId, { aiTyping: true, error: '', typingLabel: displayName(contact) })
  console.log(`[chat] 开始生成回复 对方=${displayName(contact)} conversationId=${conversationId}`)
  try {
    const history = await recentConversationMessages(conversationId, Math.max(CONTEXT_WINDOW_SIZE, 40))
    const logicBundle = await buildLogicContext({
      subjectId: contact.id,
      conversationId,
      query: [_triggeringUserText, contact.name].filter(Boolean).join(' '),
    })
    if (!isCurrentTurn(conversationId, streamId)) return
    const logicContextText = formatLogicContext(logicBundle, { includeLocationTree: false, includePersona: false, maxChars: 24_000 })
    const actionContextText = formatActionContext(logicBundle)

    // Notable things that happened outside the chat itself (e.g. the user
    // liked this contact's moment) get mentioned once then cleared, rather
    // than sitting there forever or requiring a proactive-message system.
    const pendingEvents = contact.pendingEvents ?? []
    if (pendingEvents.length > 0) await db.contacts.update(contact.id, { pendingEvents: [] })
    const socialEventsText = await recentSocialEventsText([contact.id], 4)
    const recentEventsText = [pendingEvents.join('；'), socialEventsText].filter(Boolean).join('\n')
    const injectedIntents = isModuleEnabled('intent') ? activeIntents(contact, now) : []
    const injectedIntentText = activeIntentPrompt(injectedIntents)

    // ---- Step 1: build context sections (no JSON protocol) ----
    const authoritativeSchedules = [...logicBundle.subject.baseSchedule, ...logicBundle.subject.scheduleOverrides]
    const currentAuthoritativeSchedule = resolveSchedule(authoritativeSchedules, logicBundle.clock.day, logicBundle.clock.slot as import('../types').TimeSlot)
    const scheduleText = authoritativeSchedules.map((item) => `${item.effectiveDay !== undefined ? `第${item.effectiveDay}天` : `每周${item.dayOfWeek ?? '任意日'}`} ${item.slot}：${item.activity}@${item.locationId}`).join('\n')
    const recentMemories = await recentMemoriesText(contact.id)
    const financeContext = isModuleEnabled('career')
      ? `\n【经济状况】你的可用余额：${await balanceOf(contact.id)}；对方可用余额：${await balanceOf(USER_WALLET_ID)}。未结清借款：${(await db.loans.filter(l => l.status === 'active' && (l.lenderId === contact.id || l.borrowerId === contact.id)).toArray()).map(l => `${l.borrowerId === contact.id ? '你欠对方' : '对方欠你'}${l.outstanding}`).join('；') || '无'}。所有金钱动作必须量力而行，不得凭空造钱。`
      : ''
    const socialMemories = await socialMemoriesText(contact.id)
    const sharedOriginalContext = await recentSharedOriginalContext([contact.id], settings.userNickname, {
      maxMessages: 50,
      maxChars: 8_000,
      excludeConversationId: conversationId,
    })
    const lifeEventText = isModuleEnabled('lifeSimulation')
      ? (await db.lifeEvents.where('contactId').equals(contact.id).reverse().sortBy('occurredAt')).slice(0, 4).map((event) => event.summary).join('；')
      : ''
    const worldbookTrace = isModuleEnabled('worldview') ? await retrieveWorldbookTrace([
      _triggeringUserText, proactiveContext, contact.name, contact.systemPrompt, contact.memoryFacts,
      history.slice(-8).map((m) => m.content).join(' '),
    ].filter(Boolean).join('\n')) : { text: '', matches: [] }
    const worldbookText = worldbookTrace.text
    const relationshipText = `【你和对方的关系】${contact.relationshipBase || '朋友'}${contact.relationshipDynamic ? `；当前关系状态：${contact.relationshipDynamic}` : ''}。这是身份事实，不是数值好感。`
    const userMemoryText = `【你对TA的了解】${contact.memoryFacts || '（刚开始聊）'}`
    const habitText = `【相处习惯】${contact.memoryStyle || '（还没有形成习惯）'}`
    const situationText = `【当前情境】现在: ${describeCurrentTime(new Date())}。对方: ${buildUserProfileText(settings)}。${activeMood ? `你的心情: ${activeMood}。` : ''}【世界日程】${currentAuthoritativeSchedule ? `\n当前: ${currentAuthoritativeSchedule.activity}，地点=${currentAuthoritativeSchedule.locationId}` : '\n当前: 暂无安排'}${scheduleText ? `\n完整有效日程:\n${scheduleText}` : '\n完整有效日程: 暂无'}${activeUpcomingPlansText(contact, new Date()) ? `\n约定: ${activeUpcomingPlansText(contact, new Date())}` : ''}${recentEventsText ? `\n最近: ${recentEventsText}` : ''}`
    const contextSections = buildRawChatPrompt({
      name: contact.name,
      persona: `${contact.systemPrompt}${customPersonalityTraitsLine(contact.customPersonalityTraits, contact.warmth ?? 0)}${isModuleEnabled('career') && contact.occupation ? `\n当前职业：${contact.occupation}，现实月薪：${contact.monthlySalary ?? 0}。工作会真实影响你的作息和日常话题。` : ''}${financeContext}`,
      personaConstraints: contact.personaConstraints,
      personaProfile: contact.personaProfile,
      stylePrompt: settings.globalSystemPrompt,
      selfIterationGlobalText: isModuleEnabled('selfIteration') ? settings.selfIterationGlobalPrompt : undefined,
      selfIterationContactText: isModuleEnabled('selfIteration') ? contact.selfIterationPrompt : undefined,
      relationshipBase: contact.relationshipBase || '朋友',
      personalityTrait: isModuleEnabled('personalityTraits') ? contact.personalityTrait : undefined,
      personalityWarmth: undefined,
      worldviewText: worldbookText || undefined,
      latestUserText: _triggeringUserText,
      recentContext: [
        relationshipText,
        userMemoryText,
        habitText,
        situationText,
        lifeEventText ? `【近期生活】${lifeEventText}` : '',
        proactiveContext,
      ].filter(Boolean).join('\n\n'),
      activeIntentText: injectedIntentText,
      stickerNames: stickers.map((s) => s.name),
      mbti: contact.mbti || undefined,
      recentMemoriesText: recentMemories || undefined,
      speechSamplesText: formatSpeechSamplesForScene(contact.speechSamples, 'private', 3) || undefined,
      replyCountRule: chatLivelinessRule(settings.chatLiveliness),
    })

    const recentHistory = history.slice(-CONTEXT_WINDOW_SIZE)
    const chatMessages: ChatMessage[] = coalesceConsecutiveRoles([
      // Stable persona/style comes first so DeepSeek's prefix cache can match
      // before the per-turn world state and cross-scene records diverge.
      { role: 'system', content: [contextSections, logicContextText, socialMemories, sharedOriginalContext].filter(Boolean).join('\n\n') },
      ...recentHistory.map((m): ChatMessage => {
        if (m.type === 'sticker') return formatStructuredHistoryEvent(m, 'sticker')
        if (m.type === 'link') return formatStructuredHistoryEvent(m, 'link')
        if (m.type === 'gift') return formatStructuredHistoryEvent(m, 'gift')
        if (m.type === 'scheduleChange') return formatStructuredHistoryEvent(m, 'scheduleChange')
        if (['transfer','redPacket','loanRequest','loanResult','repayment'].includes(m.type)) return formatStructuredHistoryEvent(m, m.type)
        return { role: m.role, content: m.content }
      }),
    ])

    // ---- Step 1: main model generates raw text (no JSON) ----
    let rawText = await chatCompletion({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      messages: chatMessages,
      signal: controller.signal,
      purpose: proactiveContext ? 'proactive' : 'chat',
      automatic: !!proactiveContext,
      thinking: 'disabled',
      maxTokens: proactiveContext ? 900 : 1200,
      temperature: 0.9,
      trace: { turnId: streamId, stage: 'first_chat', conversationId },
    })

    if (streamByConversation.get(conversationId) !== streamId) return
    console.log(`[chat] 主模型回复(${rawText.length}字): ${rawText.slice(0, 100)}...`)

    // Ordinary text and finance markers are mechanical, so parse them locally.
    // Only schedule/outfit intent or a malformed draft pays for utility JSON.
    const localTurn = parseRawPrivateDraft(rawText, activeMood)
    const needsUtility = localTurn.bubbles.length === 0
    let conversionPrompt = '本轮使用本地草稿解析，无额外模型调用。'
    let jsonRaw = serializePrivateTurn(localTurn)
    let parsedTurn = localTurn
    if (needsUtility) {
      conversionPrompt = buildJsonConversionPrompt(
        rawText,
        actionContextText,
        formatRecentConversationForReview(recentHistory.slice(-8), contact),
      )
      jsonRaw = await chatCompletion({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.utilityModel,
        messages: [{ role: 'system', content: conversionPrompt }],
        jsonMode: true,
        signal: controller.signal,
        purpose: proactiveContext ? 'proactive' : 'chat',
        automatic: !!proactiveContext,
        skipAutomaticBudgetCheck: !!proactiveContext,
        thinking: 'disabled',
        temperature: 0.1,
        maxTokens: 900,
        trace: { turnId: streamId, stage: 'other', conversationId },
      })
      if (!isCurrentTurn(conversationId, streamId)) return
      const converted = parseAiResponse(jsonRaw)
      if (converted.bubbles.length > 0) parsedTurn = converted
      else jsonRaw = serializePrivateTurn(localTurn)
      console.log(`[chat] 结构动作转换JSON: ${jsonRaw.slice(0, 200)}`)
    }
    let finalRaw = jsonRaw
    let { bubbles, knowledgeQueries, mood: turnMood, thought: turnThought } = parsedTurn
    const qualityCheckDebug = { enabled: true, repaired: false, reason: undefined as string | undefined, detectedInvalid: false }
    const sourceEventId = history.filter((message) => message.role === 'user').at(-1)?.id
    let assistantEvidenceIds: string[] = []
    const runLogicReview = async (stage: 'first_quality' | 'second_quality') => {
      assistantEvidenceIds = bubbles.map(() => uuid())
      return reviewTurnLogic({
        settings, latestUserText: _triggeringUserText, draftText: rawText, signal: controller.signal,
        personaFacts: [
          `角色=${displayName(contact)}`,
          `人设=${contact.systemPrompt.slice(0, 1400)}`,
          contact.personaConstraints ? `硬约束=${contact.personaConstraints.slice(0, 700)}` : '',
          contact.personalityTrait ? `人格特质=${contact.personalityTrait}` : '',
          worldbookText ? `本轮命中世界书=${worldbookText.slice(0, 1000)}` : '',
          sharedOriginalContext ? `相关跨场景事实=${sharedOriginalContext.slice(-1000)}` : '',
        ].filter(Boolean).join('\n'),
        recentContext: formatRecentConversationForReview(recentHistory.slice(-4), contact),
        trace: { turnId: streamId, stage, conversationId },
      })
    }
    let logicReview = bubbles.length > 0 ? await runLogicReview('first_quality') : undefined
    if (streamByConversation.get(conversationId) !== streamId) return
    if (logicReview && !logicReview.valid) {
      qualityCheckDebug.detectedInvalid = true
      qualityCheckDebug.reason = logicReview.reason
      console.warn(`[chat] 逻辑审查要求主模型重写 对方=${displayName(contact)} 原因=${logicReview.reason}`)
      rawText = await chatCompletion({
        apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model,
        messages: coalesceConsecutiveRoles([
          ...chatMessages,
          { role: 'assistant', content: rawText },
          { role: 'user', content: `上一版回复存在客观逻辑错误：${logicReview.reason}\n请依据原始上下文重写完整回复。仍只输出规定的角色纯文本格式，不要解释错误，不要输出JSON。` },
        ]),
        signal: controller.signal, purpose: proactiveContext ? 'proactive' : 'chat', automatic: !!proactiveContext,
        thinking: 'disabled', maxTokens: proactiveContext ? 900 : 1200, temperature: 0.75,
        trace: { turnId: streamId, stage: 'second_chat', conversationId },
      })
      if (streamByConversation.get(conversationId) !== streamId) return
      const rewrittenLocal = parseRawPrivateDraft(rawText, activeMood)
      parsedTurn = rewrittenLocal
      jsonRaw = serializePrivateTurn(rewrittenLocal)
      if (rewrittenLocal.bubbles.length === 0) {
        conversionPrompt = buildJsonConversionPrompt(rawText, actionContextText, formatRecentConversationForReview(recentHistory.slice(-8), contact))
        jsonRaw = await chatCompletion({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.utilityModel, messages: [{ role: 'system', content: conversionPrompt }], jsonMode: true, signal: controller.signal, purpose: 'chat', thinking: 'disabled', temperature: 0.1, maxTokens: 900, trace: { turnId: streamId, stage: 'other', conversationId } })
        const converted = parseAiResponse(jsonRaw)
        if (converted.bubbles.length > 0) parsedTurn = converted
      }
      finalRaw = jsonRaw
      ;({ bubbles, knowledgeQueries, mood: turnMood, thought: turnThought } = parsedTurn)
      qualityCheckDebug.repaired = true
      qualityCheckDebug.detectedInvalid = false
      logicReview = await runLogicReview('second_quality')
      if (!logicReview.valid) throw new Error(`主模型重写后仍未通过逻辑审查：${logicReview.reason || '未知原因'}`)
    }
    knowledgeQueries = []
    console.log(`[chat] 收到回复(${finalRaw.length}字) 解析出${bubbles.length}条气泡 mood=${turnMood || '无'} thought=${turnThought ? '有(' + turnThought.length + '字)' : '无'} 对方=${displayName(contact)}`)
    if (bubbles.length === 0) {
      console.warn(`[chat] 本轮没有正常回复 对方=${displayName(contact)} JSON内容: ${jsonRaw.slice(0, 200)}`)
      engine.patch(conversationId, { error: proactiveContext ? '' : '对方这次没有正常回复 可以再发一条试试', aiTyping: false, typingLabel: undefined })
      return
    }
    const latestWorld = await db.worldState.get('global')
    if (!latestWorld || latestWorld.worldVersion !== logicBundle.worldVersion) throw new Error('地点树已变化，本轮回复已取消，请重新发送')
    const aiTurnId = uuid()
    await db.aiTurns.add({
      id: aiTurnId,
      conversationId,
      raw: finalRaw,
      parsed: parseAiTurnDebugPayload({
        mainPrompt: [contextSections, socialMemories].filter(Boolean).join('\n\n'),
        conversionPrompt,
        rawText,
        jsonRaw,
        finalRaw,
        bubbles,
        knowledgeQueries,
        mood: turnMood,
        thought: turnThought,
        qualityCheck: qualityCheckDebug,
        injectedIntents,
        promptTrace: { sections: [{ label: '世界书', content: worldbookText }, { label: '结构化记忆', content: recentMemories }, { label: '特质规则', content: contact.customPersonalityTraits?.map((trait) => `${trait.name}: ${trait.meaning}`).join('\n') || contact.personalityTrait || '' }, { label: '关系与心情', content: relationshipText }, { label: '日程与当前情境', content: situationText }, { label: '主动话题', content: proactiveContext }].filter((section) => section.content), worldbookMatches: worldbookTrace.matches.map((match) => ({ id: match.entry.id, title: match.entry.title, score: match.score, chars: match.entry.content.length })), memorySummary: recentMemories, traitSummary: contact.customPersonalityTraits?.map((trait) => trait.name).join('、') || contact.personalityTrait, proactiveSource: proactiveContext || undefined },
      }),
      knowledgeQueries,
      logicTrace: {
        worldVersion: logicBundle.worldVersion,
        locationTreeVersion: logicBundle.worldVersion,
        personaSummaries: [contact.systemPrompt.slice(0, 500)],
        schedules: [...logicBundle.subject.baseSchedule, ...logicBundle.subject.scheduleOverrides].map((item) => `${item.priority}/${item.effectiveDay ?? item.dayOfWeek}/${item.slot}@${item.locationId}:${item.activity}`),
        appointmentIds: logicBundle.subject.commitments.map((item) => item.id),
        memoryIds: logicBundle.memories.map((item) => item.id),
        perceivedEventIds: logicBundle.perceivedEvents.map((item) => item.eventId),
        validation: qualityCheckDebug.detectedInvalid && !qualityCheckDebug.repaired ? 'rejected' : 'passed',
        validationReason: qualityCheckDebug.reason,
      },
      createdAt: Date.now(),
    })
    await revealBubbles(
      conversationId,
      contact,
      settings,
      bubbles,
      streamId,
      aiTurnId,
      _triggeringUserText,
      turnMood,
      turnThought,
      finalRaw,
      injectedIntents.map((intent) => intent.id),
      logicBundle.worldVersion,
      sourceEventId,
      logicContextText,
      assistantEvidenceIds,
      turnStartedAt,
    )
  } catch (err) {
    if (streamByConversation.get(conversationId) !== streamId) return
    if (err instanceof DOMException && err.name === 'AbortError') return
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[chat] 生成回复出错 对方=${displayName(contact)}:`, message)
    engine.patch(conversationId, { error: message, aiTyping: false, typingLabel: undefined })
  } finally {
    if (abortByConversation.get(conversationId) === controller) abortByConversation.delete(conversationId)
  }
}

async function revealBubbles(
  conversationId: string,
  contact: Contact,
  settings: AppSettings,
  bubbles: AiBubble[],
  streamId: string,
  aiTurnId: string,
  _triggeringUserText: string,
  turnMood?: string,
  turnThought?: string,
  finalRaw?: string,
  injectedIntentIds: string[] = [],
  logicWorldVersion?: number,
  sourceEventId?: string,
  logicContextText?: string,
  assistantEvidenceIds: string[] = [],
  turnStartedAt = performance.now(),
): Promise<void> {
  if (logicWorldVersion !== undefined) {
    const latestWorld = await db.worldState.get('global')
    if (!latestWorld || latestWorld.worldVersion !== logicWorldVersion) {
      useChatEngineStore.getState().patch(conversationId, { error: '地点树已变化，本轮回复已取消', aiTyping: false, typingLabel: undefined })
      return
    }
  }

  const preparedMessages: Message[] = []
  for (const [i, bubble] of bubbles.entries()) {

      let finance: Message['finance']
      if (bubble.type === 'transfer') {
        try { const tx = await transferFunds({ from: contact.id, to: USER_WALLET_ID, amount: bubble.amount, kind: 'transfer', note: bubble.note, idempotencyKey: `ai:${streamId}:${i}` }); finance = { transactionId: tx.id, amount: tx.amount, note: bubble.note, status: 'completed' } } catch (err) { console.warn('[finance] AI转账被拒绝', err); continue }
      } else if (bubble.type === 'redPacket') {
        try { const tx = await reserveRedPacket(contact.id, bubble.amount, bubble.note); finance = { transactionId: tx.id, amount: tx.amount, note: bubble.note, status: 'pending' } } catch (err) { console.warn('[finance] AI红包被拒绝', err); continue }
      } else if (bubble.type === 'loanRequest') {
        const loanId = uuid(); await db.loans.add({ id: loanId, lenderId: USER_WALLET_ID, borrowerId: contact.id, principal: bubble.amount, outstanding: bubble.amount, note: bubble.note, status: 'pending', createdAt: Date.now() }); finance = { loanId, amount: bubble.amount, note: bubble.note, status: 'pending' }
      } else if (bubble.type === 'loanDecision' && bubble.loanId) {
        const loan = await db.loans.get(bubble.loanId)
        if (!loan || loan.status !== 'pending' || loan.borrowerId !== USER_WALLET_ID || loan.lenderId !== contact.id) continue
        if (bubble.decision === 'accept') { try { await transferFunds({ from: contact.id, to: USER_WALLET_ID, amount: loan.principal, kind: 'loan', note: loan.note, idempotencyKey: `loan:${loan.id}` }); await db.loans.update(loan.id,{status:'active',resolvedAt:Date.now()}); finance={loanId:loan.id,amount:loan.principal,note:loan.note,status:'accepted'} } catch { await db.loans.update(loan.id,{status:'rejected',resolvedAt:Date.now()}); finance={loanId:loan.id,amount:loan.principal,status:'rejected'} } } else { await db.loans.update(loan.id,{status:'rejected',resolvedAt:Date.now()}); finance={loanId:loan.id,amount:loan.principal,status:'rejected'} }
      } else if (bubble.type === 'giftPurchase') {
        if (!bubble.name) continue
        try { const tx = await transferFunds({ from: contact.id, amount: bubble.amount, kind: 'purchase', note: `送给用户：${bubble.name}`, idempotencyKey: `ai-gift:${streamId}:${i}` }); finance = { transactionId: tx.id, amount: tx.amount, note: bubble.description, status: 'completed' } } catch (err) { console.warn('[finance] AI购买礼物被拒绝', err); continue }
      }

      let content: string
      if (bubble.type === 'text') content = bubble.content
      else if (bubble.type === 'scheduleChange') content = bubble.summary
      else if (bubble.type === 'link') content = bubble.label
      else if (bubble.type === 'giftPurchase') content = bubble.name || '礼物'
      else content = bubble.note || (bubble.type === 'loanDecision' ? '借款决定' : '资金互动')

      const msg: Message = {
        id: assistantEvidenceIds[i] ?? uuid(),
        conversationId,
        role: 'assistant',
        type: bubble.type === 'loanDecision' ? 'loanResult' : bubble.type === 'giftPurchase' ? 'gift' : bubble.type,
        content,
        link: bubble.type === 'link' ? { app: bubble.app, label: bubble.label, data: bubble.data } : undefined,
        scheduleChange:
          bubble.type === 'scheduleChange'
            ? {
                effectiveDay: bubble.effectiveDay,
                slot: bubble.slot,
                locationId: bubble.locationId,
                phoneAccess: bubble.phoneAccess,
                activity: bubble.activity,
                summary: bubble.summary,
                priority: bubble.priority,
                sourceEventIds: sourceEventId ? [sourceEventId] : [],
              }
            : undefined,
        finance,
        gift: bubble.type === 'giftPurchase' ? { name: bubble.name || '礼物', icon: bubble.icon || '🎁', description: bubble.description } : undefined,
        debugAiTurnId: aiTurnId,
        debugParsedBubble: bubble,
        debugRawAiResponse: i === bubbles.length - 1 ? (finalRaw || '') : undefined,
        thought: turnThought && i === bubbles.length - 1 ? turnThought : undefined,
        pending: true,
         createdAt: Date.now() + i,
       }
      if (turnThought && i === bubbles.length - 1) {
        console.log(`[chat] 想法已存入消息: ${turnThought}`)
      }
    preparedMessages.push(msg)
  }

  if (preparedMessages.length === 0) {
    useChatEngineStore.getState().patch(conversationId, { error: '结构动作未通过本地校验', aiTyping: false, typingLabel: undefined })
    return
  }
  await db.transaction('rw', db.messages, db.conversations, async () => {
    await db.messages.bulkAdd(preparedMessages)
    await db.conversations.update(conversationId, { updatedAt: preparedMessages.at(-1)!.createdAt })
  })
  const visibleAt = performance.now()
  useChatEngineStore.getState().patch(conversationId, { typingLabel: '正在同步状态' })
  const stateStartedAt = performance.now()
  try {
    await adjudicateStateChanges({
      scene: 'private_phone',
      conversationId,
      characterIds: [contact.id],
      settings,
      evidence: [
        ...(sourceEventId && _triggeringUserText ? [{ id: sourceEventId, actorId: 'user', actorName: '用户', content: _triggeringUserText, perceivedBy: [contact.id] }] : []),
        ...preparedMessages.map((message) => ({ id: message.id, actorId: contact.id, actorName: displayName(contact), content: message.content, perceivedBy: [contact.id] })),
      ],
      trace: { turnId: streamId, stage: 'state', conversationId },
    })
    await Promise.all(preparedMessages.map((message) => db.messages.update(message.id, { pending: false })))
  } catch (error) {
    // A pending bubble is only a preview. If authoritative state cannot be
    // committed, remove it so the visible conversation never claims a turn
    // that the world model failed to finish.
    await db.messages.bulkDelete(preparedMessages.map((message) => message.id))
    await db.conversations.update(conversationId, { updatedAt: Date.now() })
    throw error
  }
  const unlockedAt = performance.now()
  console.info(`[回合耗时｜私聊] 首次显示=${Math.round(visibleAt - turnStartedAt)}ms；状态裁决与提交=${Math.round(unlockedAt - stateStartedAt)}ms；解锁=${Math.round(unlockedAt - turnStartedAt)}ms`)
  useChatEngineStore.getState().patch(conversationId, { aiTyping: false, typingLabel: undefined })
  if (streamByConversation.get(conversationId) === streamId) streamByConversation.delete(conversationId)

  const lastMessage = preparedMessages.at(-1)!
  if (useChatUiStore.getState().activeConversationId !== conversationId) {
    useChatUiStore.getState().showNotification({
      id: uuid(), conversationId, contactName: displayName(contact), contactAvatar: contact.avatar,
      contactAvatarColor: contact.avatarColor, preview: previewForMessage(lastMessage),
    })
  }
  if (injectedIntentIds.length > 0) await markIntentsUsed(contact.id, injectedIntentIds)
  if (turnMood) {
    await db.contacts.update(contact.id, { mood: { text: turnMood, expiresAt: Date.now() + settings.moodExpiryMs } })
  }
  if (_triggeringUserText && isModuleEnabled('selfIteration')) {
    enqueueSelfIterationTask({
      conversationId,
      contactId: contact.id,
      contactName: contact.name,
      latestUserText: _triggeringUserText,
      latestAssistantText: bubbles
        .map((bubble) => (bubble.type === 'text' ? bubble.content : `[${bubble.type}] ${'name' in bubble ? bubble.name : 'label' in bubble ? bubble.label : 'summary' in bubble ? bubble.summary : 'query' in bubble ? bubble.query : bubble.note ?? bubble.amount}`))
        .join('\n'),
    })
  }

  // Memory extraction is intentionally after visible reply persistence and
  // typing-state completion; it must never delay the paid response appearing.
  void maybeUpdateMemory(contact.id, conversationId, settings, logicContextText).then(async (memoryUpdate) => {
    if (!memoryUpdate) return
    const turn = await db.aiTurns.get(aiTurnId)
    const parsed = turn?.parsed && typeof turn.parsed === 'object'
      ? { ...(turn.parsed as Record<string, unknown>), memoryUpdate }
      : { memoryUpdate }
    await db.aiTurns.update(aiTurnId, { parsed })
  }).catch(() => undefined)
}

