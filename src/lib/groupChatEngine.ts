import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { chatCompletion, coalesceConsecutiveRoles, type ChatMessage } from './deepseek'
import {
  buildGroupJsonConversionPrompt,
  buildGroupRawChatPrompt,
  parseGroupAiResponse,
  parseGroupRawDraft,
  pickSociallyConnectedSpeakers,
  serializeGroupTurn,
  stripSpeakerNamePrefix,
} from './groupChat'
import { extractJsonObject } from './aiProtocol'
import { CONTEXT_WINDOW_SIZE, activeWorldPlansText, maybeUpdateGroupMemory, nonGroupScopedMemoriesText } from './memory'
import { aiRelationshipPrompt } from './contactRelations'
import { isModuleEnabled } from '../features'
import { isWorldPhoneAvailable } from './schedule'
import { displayName } from './contact'
import { previewForMessage } from './messagePreview'
import { buildUserProfileText, useChatEngineStore } from './chatEngine'
import { waitForMessageReveal } from './messagePacing'
import { recentSocialEventsText, recordSocialEvent } from './socialEvents'
import { recentSharedOriginalContext } from './sharedRecentContext'
import { useChatUiStore } from '../store/useChatUiStore'
import { retrieveWorldbookContext } from './worldbook'
import { generateGroupStoryOutline, storyOutlinePromptSection } from './storyOutline'
import { buildLogicContext, formatActionContext, formatLogicContext } from './logicContext'
import { audibilityBetween, ensureWorldInitialized } from './world'
import { adjudicateStateChanges } from './stateAdjudicator'
import { modelWorldTimeText, stripLegacyRealTimePrefixes } from './worldCalendar'
import type { TimeSlot } from '../types'
import { reviewTurnLogic } from './turnLogicReviewer'
import type { AppSettings, Contact, Group, GroupAiBubble, Message, Sticker } from '../types'
import { messagesForAiTurn, recentConversationMessages } from './conversationStats'
import { chatLivelinessRule } from './chatLiveliness'

function globalGroupEnergy(settings: AppSettings): 'cold' | 'normal' | 'lively' {
  return settings.chatLiveliness === 'quiet' ? 'cold' : settings.chatLiveliness === 'lively' ? 'lively' : 'normal'
}

/** Load recent structured memories for each speaker in parallel. */
async function loadSpeakerMemories(speakers: Contact[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const results = await Promise.all(speakers.map(async (s) => {
    const text = await nonGroupScopedMemoriesText(s.id)
    return { id: s.id, text }
  }))
  for (const { id, text } of results) {
    if (text) map.set(id, text)
  }
  return map
}

/**
 * Same background-engine shape as chatEngine.ts (module-level bookkeeping,
 * reuses the same useChatEngineStore keyed by conversationId so ChatPage's
 * aiTyping/error subscription works unchanged for group conversations too)
 * — kept in its own file rather than folded into chatEngine.ts because the
 * group turn genuinely has a different shape (multiple personas per turn,
 * no relationship-dimension updates, a smaller text/sticker-only protocol)
 * and entangling the two would make chatEngine.ts's single-contact
 * assumptions harder to reason about. Memory (facts/style/plans) *is*
 * updated per speaker, via maybeUpdateGroupMemory — see memory.ts.
 */
const streamByConversation = new Map<string, string>()
const abortByConversation = new Map<string, AbortController>()

function clearPending(conversationId: string) {
  abortByConversation.get(conversationId)?.abort()
}

function beginTurn(conversationId: string, streamId: string): AbortController {
  clearPending(conversationId)
  streamByConversation.set(conversationId, streamId)
  const controller = new AbortController()
  abortByConversation.set(conversationId, controller)
  return controller
}

function parseGroupTurnDebugPayload(
  mainPrompt: string,
  rawText: string,
  draftFeedback: string | undefined,
  jsonRaw: string,
  finalRaw: string,
  bubbles: GroupAiBubble[],
  knowledgeQueries: string[],
  turnSummary: string,
  groupVibe: string,
  storyOutline?: string,
): unknown {
  const trimmed = finalRaw.trim()
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const text = fenceMatch ? fenceMatch[1].trim() : trimmed
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? { ...(parsed as Record<string, unknown>), mainPrompt, rawText, draftFeedback, jsonRaw, finalRaw, parsedBubbles: bubbles, storyOutline, promptTrace: { sections: [{ label: '群聊主提示词', content: mainPrompt }] } } : parsed
  } catch {
    const extracted = extractJsonObject(text)
    if (extracted) {
      try {
        const parsed = JSON.parse(extracted)
        return parsed && typeof parsed === 'object' ? { ...(parsed as Record<string, unknown>), mainPrompt, rawText, draftFeedback, jsonRaw, finalRaw, parsedBubbles: bubbles, storyOutline, promptTrace: { sections: [{ label: '群聊主提示词', content: mainPrompt }] } } : parsed
      } catch {
        // fall through
      }
    }
  }
  return { mainPrompt, rawText, draftFeedback, jsonRaw, finalRaw, parsedBubbles: bubbles, knowledgeQueries, turnSummary, groupVibe, storyOutline, promptTrace: { sections: [{ label: '群聊主提示词', content: mainPrompt }] } }
}

/** Admin-only safe stop for a group generation and its queued bubbles. */
export function stopGroupAiTurn(conversationId: string): void {
  streamByConversation.set(conversationId, uuid())
  clearPending(conversationId)
  useChatEngineStore.getState().patch(conversationId, { aiTyping: false, typingLabel: undefined, error: '已由管理员停止本轮群聊生成' })
}

function parseCompressedGroupMemory(raw: string): string | null {
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) text = fenceMatch[1].trim()
  try {
    const parsed = JSON.parse(text)
    return typeof parsed?.memory === 'string' && parsed.memory.trim() ? parsed.memory.trim() : null
  } catch {
    return null
  }
}

async function updateGroupMemoryAndVibe(opts: {
  group: Group
  aiTurnId: string
  settings: AppSettings
  turnSummary: string
  groupVibe: string
  logicContextText: string
  clock: { day: number; slot: TimeSlot; hour: number }
}): Promise<void> {
  const { group, aiTurnId, settings } = opts
  const timeLabel = modelWorldTimeText(opts.clock).split('；')[0]
  const turnSummary = opts.turnSummary.trim()
  const nextTurnCount = (group.memoryTurnCount ?? 0) + 1
  const appendedMemory = turnSummary
    ? [group.memory?.trim() ?? '', `[${timeLabel}] ${turnSummary}`].filter(Boolean).join('\n')
    : (group.memory ?? '')
  const patch: Partial<Group> = {
    memory: appendedMemory,
    vibe: opts.groupVibe.trim() || group.vibe || '',
    memoryTurnCount: nextTurnCount,
  }

  if (nextTurnCount % 5 === 0 && appendedMemory.trim()) {
    try {
      const raw = await chatCompletion({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.utilityModel,
        jsonMode: true,
        messages: [
          {
            role: 'system',
            content: `【不可裁剪的ChatSLG逻辑上下文】\n${opts.logicContextText}\n\n你是群聊记忆压缩器。把群"${group.name}"的群聊记忆按时间线压缩，保留重要事件、固定梗、关系变化、长期氛围，不要保留流水账，不得让角色获得未感知的信息。输出JSON: {"memory":"..."}`,
          },
          {
            role: 'user',
            content: appendedMemory.slice(-5000),
          },
        ],
        purpose: 'memory',
        automatic: true,
      })
      const compressed = parseCompressedGroupMemory(raw)
      if (compressed) patch.memory = compressed
    } catch {
      // best-effort; keep appended memory if compression fails
    }
  }

  await db.groups.update(group.id, patch)
  const turn = await db.aiTurns.get(aiTurnId)
  if (turn?.parsed && typeof turn.parsed === 'object') {
    await db.aiTurns.update(aiTurnId, {
      parsed: { ...(turn.parsed as Record<string, unknown>), groupMemoryUpdate: patch },
    })
  }
}

function messageLabel(message: Message, contactById: Map<string, Contact>, userNickname: string): string {
  if (message.role === 'user') return userNickname || '我'
  const speaker = message.speakerContactId ? contactById.get(message.speakerContactId) : undefined
  return speaker ? displayName(speaker) : '某人'
}

function messageBody(message: Message): string {
  if (message.type === 'sticker') return `[表情: ${message.content}]`
  if (message.type === 'link') return `[链接: ${message.content}]`
  if (message.type === 'gift') return `[礼物: ${message.content}]`
  if (message.type === 'scheduleChange') return `[日程: ${message.content}]`
  return message.content
}

function formatGroupHistoryMessage(
  message: Message,
  contactById: Map<string, Contact>,
  messageById: Map<string, Message>,
  userNickname: string,
): ChatMessage {
  const speakerLabel = messageLabel(message, contactById, userNickname)
  const parts: string[] = []
  if (message.mentions?.length) {
    const names = message.mentions.map((id) => contactById.get(id)).filter((c): c is Contact => !!c).map(displayName)
    if (names.length > 0) parts.push(`@${names.join(' @')}`)
  }
  if (message.replyToMessageId) {
    const replied = messageById.get(message.replyToMessageId)
    if (replied) parts.push(`replying to ${messageLabel(replied, contactById, userNickname)}: "${messageBody(replied)}"`)
  }
  parts.push(messageBody(message))
  return { role: message.role, content: `${speakerLabel}: ${parts.join(' | ')}` }
}

function targetedContextText(
  latestUserMessage: Message | undefined,
  contactById: Map<string, Contact>,
  messageById: Map<string, Message>,
  userNickname: string,
): string {
  if (!latestUserMessage) return ''
  const lines: string[] = []
  if (latestUserMessage.mentions?.length) {
    const names = latestUserMessage.mentions.map((id) => contactById.get(id)).filter((c): c is Contact => !!c).map(displayName)
    if (names.length > 0) lines.push(`User explicitly @mentioned: ${names.join(', ')}`)
  }
  if (latestUserMessage.replyToMessageId) {
    const replied = messageById.get(latestUserMessage.replyToMessageId)
    if (replied) {
      lines.push(`User is replying to ${messageLabel(replied, contactById, userNickname)}: "${messageBody(replied)}"`)
    }
  }
  return lines.join('\n')
}

export async function sendGroupMessage(
  conversationId: string,
  group: Group,
  members: Contact[],
  settings: AppSettings,
  stickers: Sticker[],
  text: string,
  mentionContactIds: string[] = [],
  replyToMessageId?: string,
): Promise<void> {
  if (!text.trim()) return
  const existingConversation = await db.conversations.get(conversationId)
  if (existingConversation?.channel === 'scene' && existingConversation.sceneLocationId) {
    const allContacts = await db.contacts.toArray()
    const audibleMembers: Contact[] = []
    for (const candidate of allContacts) {
      if (!candidate.currentLocationId) continue
      if (await audibilityBetween(existingConversation.sceneLocationId, candidate.currentLocationId) !== 'none') audibleMembers.push(candidate)
    }
    members = audibleMembers
    group = { ...group, memberContactIds: audibleMembers.map((item) => item.id) }
    await db.groups.update(group.id, { memberContactIds: group.memberContactIds })
  }
  if (!settings.apiKey && !(existingConversation?.channel === 'scene' && members.length === 0)) {
    useChatEngineStore.getState().patch(conversationId, { error: '还没有配置API Key 请先去"我-设置"里填写' })
    return
  }

  const streamId = uuid()
  const controller = beginTurn(conversationId, streamId)
  useChatEngineStore.getState().patch(conversationId, { aiTyping: true, error: '', typingLabel: '群成员' })

  const msg: Message = {
    id: uuid(),
    conversationId,
    role: 'user',
    type: 'text',
    content: text.trim(),
    mentions: mentionContactIds.length > 0 ? Array.from(new Set(mentionContactIds)) : undefined,
    replyToMessageId,
    createdAt: Date.now(),
  }
  await db.messages.add(msg)
  await db.conversations.update(conversationId, { updatedAt: Date.now() })
  const conversation = existingConversation ?? await db.conversations.get(conversationId)
  if (conversation?.channel === 'scene' && conversation.sceneLocationId) {
    const world = await ensureWorldInitialized()
    const eventId = msg.id
    await db.worldEvents.add({ id: eventId, type: 'speech', worldStep: world.step, locationId: conversation.sceneLocationId, actorId: 'user', participantIds: group.memberContactIds, content: text.trim(), visibility: 'scene', createdAt: Date.now() })
    const allContacts = await db.contacts.toArray()
    for (const candidate of allContacts) {
      if (!candidate.currentLocationId) continue
      const heard = await audibilityBetween(conversation.sceneLocationId, candidate.currentLocationId)
      if (heard === 'none') continue
      await db.perceivedEvents.add({ id: uuid(), eventId, characterId: candidate.id, perception: heard === 'clear' ? 'full' : 'muffled', observedAtStep: world.step })
    }
  } else if (conversation?.groupId) {
    const world = await ensureWorldInitialized()
    await db.worldEvents.put({ id: msg.id, type: 'phone', worldStep: world.step, actorId: 'user', participantIds: group.memberContactIds, content: msg.content, visibility: 'private', createdAt: msg.createdAt })
    for (const characterId of group.memberContactIds) await db.perceivedEvents.put({ id: uuid(), eventId: msg.id, characterId, perception: 'full', observedAtStep: world.step })
  }
  if (msg.mentions?.length || msg.replyToMessageId) {
    const mentionedNames = msg.mentions
      ?.map((id) => members.find((member) => member.id === id))
      .filter((member): member is Contact => !!member)
      .map(displayName)
      .join('、')
    await recordSocialEvent({
      type: 'group_targeted_message',
      actorId: 'user',
      relatedContactIds: Array.from(new Set([...(msg.mentions ?? []), ...group.memberContactIds])),
      conversationId,
      groupId: group.id,
      messageId: msg.id,
      summary: mentionedNames
        ? `群聊"${group.name}"里，用户@了${mentionedNames}: ${text.trim()}`
        : `群聊"${group.name}"里，用户回复了一条消息: ${text.trim()}`,
      importance: 2,
    })
  }

  if (conversation?.channel === 'scene' && members.length === 0) {
    useChatEngineStore.getState().patch(conversationId, { aiTyping: false, typingLabel: undefined, error: '' })
    return
  }

  if (streamByConversation.get(conversationId) !== streamId || controller.signal.aborted) return
  void runGroupAiTurn(conversationId, group, members, settings, stickers, streamId, controller)
}

export async function regenerateGroupAiTurn(
  conversationId: string,
  group: Group,
  members: Contact[],
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
  useChatEngineStore.getState().patch(conversationId, { aiTyping: true, error: '', typingLabel: '群成员' })

  const turnMessages = await messagesForAiTurn(aiTurnId)
  if (turnMessages.length > 0) await db.messages.bulkDelete(turnMessages.map((message) => message.id))
  await db.aiTurns.delete(aiTurnId)
  await db.conversations.update(conversationId, { updatedAt: Date.now() })

  if (streamByConversation.get(conversationId) !== streamId || controller.signal.aborted) return
  await runGroupAiTurn(conversationId, group, members, settings, stickers, streamId, controller)
}

async function runGroupAiTurn(
  conversationId: string,
  group: Group,
  members: Contact[],
  settings: AppSettings,
  stickers: Sticker[],
  streamId: string,
  controller: AbortController,
): Promise<void> {
  const engine = useChatEngineStore.getState()
  const turnStartedAt = performance.now()
  engine.patch(conversationId, { aiTyping: true, error: '', typingLabel: '群成员' })
  console.log(`[group] 开始生成回复 群=${group.name} conversationId=${conversationId}`)
  try {
    if (members.length === 0) {
      engine.patch(conversationId, { error: '这个群里已经没有成员了', aiTyping: false, typingLabel: undefined })
      return
    }

    const contactById = new Map(members.map((c) => [c.id, c]))

    const history = await recentConversationMessages(conversationId, Math.max(CONTEXT_WINDOW_SIZE, 60))
    const messageById = new Map(history.map((m) => [m.id, m]))
    const latestUserMessage = [...history].reverse().find((m) => m.role === 'user')
    const preferredSpeakerIds = new Set(latestUserMessage?.mentions ?? [])
    const replied = latestUserMessage?.replyToMessageId ? messageById.get(latestUserMessage.replyToMessageId) : undefined
    if (replied?.role === 'assistant' && replied.speakerContactId) preferredSpeakerIds.add(replied.speakerContactId)
    const runtimeConversation = await db.conversations.get(conversationId)
    const speakerPool = runtimeConversation?.channel === 'scene'
      ? members
      : (await Promise.all(members.map(async (member) => ({ member, available: await isWorldPhoneAvailable(member.id) })))).filter((row) => row.available).map((row) => row.member)
    const speakers = await pickSociallyConnectedSpeakers(speakerPool, Array.from(preferredSpeakerIds), group.speakerLimit ?? 3)
    if (speakers.length === 0) {
      engine.patch(conversationId, { aiTyping: false, typingLabel: undefined, error: '' })
      return
    }
    console.log(`[group] 本轮发言人: ${speakers.map((s) => s.name).join('、')}`)
    const targetContext = targetedContextText(latestUserMessage, contactById, messageById, settings.userNickname)
    const recentEventsText = await recentSocialEventsText(members.map((m) => m.id), 4)
    const sharedOriginalContext = await recentSharedOriginalContext(members.map((m) => m.id), settings.userNickname, {
      maxMessages: 60,
      maxChars: 10_000,
      excludeConversationId: conversationId,
    })
    const worldbookText = isModuleEnabled('worldview') ? await retrieveWorldbookContext([group.name, group.vibe, targetContext, history.slice(-10).map((m) => m.content).join(' '), members.map((m) => `${m.name} ${m.systemPrompt}`).join(' ')].filter(Boolean).join('\n')) : ''
    const logicBundles = await Promise.all(speakers.map((speaker) => buildLogicContext({
      subjectId: speaker.id,
      participantIds: speakers.map((item) => item.id),
      conversationId,
      query: [group.name, targetContext].filter(Boolean).join(' '),
    })))
    const logicContextText = logicBundles
      .map((bundle) => formatLogicContext(bundle, { includeLocationTree: false, includePersona: false, maxChars: 24_000 }))
      .join('\n\n')
    if (logicContextText.length > 72_000) throw new Error('参与角色的逻辑上下文过大，请精简日程或记忆后重试')
    const actionContextText = logicBundles.map((bundle) => formatActionContext(bundle)).join('\n\n---\n\n')
    const speakerStateTextMap = new Map(logicBundles.map((bundle) => {
      const schedules = [...bundle.subject.baseSchedule, ...bundle.subject.scheduleOverrides]
      const priority = { commitment: 3, override: 2, base: 1 }
      const current = schedules
        .filter((item) => item.slot === bundle.clock.slot && (item.effectiveDay === bundle.clock.day || item.effectiveDay === undefined))
        .sort((a, b) => priority[b.priority] - priority[a.priority] || b.createdAt - a.createdAt)[0]
      return [bundle.subject.character.id, current ? `${current.activity}，地点=${current.locationId}，手机${current.phoneAccess}` : '当前无明确日程']
    }))

    const speakerMemoriesMap = await loadSpeakerMemories(speakers)
    const aiRelationshipText = await aiRelationshipPrompt(members)
    const existingConversation = runtimeConversation
    let scenePresenceText: string | undefined
    if (existingConversation?.channel === 'scene' && existingConversation.sceneLocationId) {
      const [sceneLocation, locations] = await Promise.all([
        db.locations.get(existingConversation.sceneLocationId), db.locations.toArray(),
      ])
      const locationNames = new Map(locations.map((location) => [location.id, location.name]))
      scenePresenceText = members.map((member) => {
        const locationName = locationNames.get(member.currentLocationId ?? '') ?? member.currentLocationId ?? '未知地点'
        return `${displayName(member)}：真实位置=${locationName}${member.currentLocationId === existingConversation.sceneLocationId ? '（正在现场）' : `（可听到${sceneLocation?.name ?? '现场'}）`}`
      }).join('\n')
    }
    const systemPrompt = buildGroupRawChatPrompt({
      stylePrompt: settings.globalSystemPrompt,
      groupName: group.name,
      allMembers: members,
      speakers,
      stickerNames: stickers.map((s) => s.name),
      groupMemoryText: stripLegacyRealTimePrefixes(group.memory ?? ''),
      groupVibeText: group.vibe,
      allowAiChatter: group.allowAiChatter ?? true,
      energyLevel: globalGroupEnergy(settings),
      scenePresenceText,
      replyCountRule: chatLivelinessRule(settings.chatLiveliness),
      currentTimeText: modelWorldTimeText(logicBundles[0].clock),
      worldDay: logicBundles[0].clock.day,
      worldSlot: logicBundles[0].clock.slot,
      userProfileText: buildUserProfileText(settings),
      targetedContextText: targetContext,
      recentEventsText: recentEventsText || undefined,
      worldviewText: worldbookText || undefined,
      selfIterationGlobalText: isModuleEnabled('selfIteration') ? settings.selfIterationGlobalPrompt : undefined,
      speakerMemoriesMap,
      aiRelationshipText,
      speakerStateTextMap,
    })

    const recentHistory = history.slice(-CONTEXT_WINDOW_SIZE)
    let storyOutline = ''
    if (isModuleEnabled('storyOutline')) {
      const speakerPremises = speakers
        .map((speaker, i) => {
          const recentMemo = speakerMemoriesMap.get(speaker.id)
          return `发言人${i + 1}: ${displayName(speaker)}
人设: ${speaker.systemPrompt || '自由发挥'}
关系: ${speaker.relationshipBase || '朋友'}${speaker.relationshipDynamic ? `（${speaker.relationshipDynamic}）` : ''}
记忆: ${speaker.memoryFacts || '暂无'}
相处习惯: ${speaker.memoryStyle || '暂无'}
当前状态: ${speakerStateTextMap.get(speaker.id) || '没有特别安排'}
约定: ${activeWorldPlansText(speaker, logicBundles[0].clock.day, logicBundles[0].clock.slot) || '无'}${recentMemo ? `\n最近记忆碎片:\n${recentMemo}` : ''}`
        })
        .join('\n\n')
      const premiseText = [
        `【群名】${group.name}`,
        `【群成员】\n${members.map((m) => `- ${displayName(m)}`).join('\n')}`,
        group.memory ? `【群聊记忆】\n${stripLegacyRealTimePrefixes(group.memory)}` : '',
        group.vibe ? `【群聊氛围】\n${group.vibe}` : '',
        `【当前时间】${modelWorldTimeText(logicBundles[0].clock)}`,
        `【用户资料】${buildUserProfileText(settings)}`,
        targetContext ? `【本轮定向上下文】\n${targetContext}` : '',
        recentEventsText ? `【最近发生的事】\n${recentEventsText}` : '',
        worldbookText ? `【世界书命中】\n${worldbookText}` : '',
        `【发言人逻辑前提】\n${speakerPremises}`,
      ].filter(Boolean).join('\n\n')
      try {
        storyOutline = await generateGroupStoryOutline({
          settings,
          groupName: group.name,
          members,
          speakers,
          premiseText,
          history: recentHistory,
          allowAiChatter: group.allowAiChatter ?? true,
          energyLevel: globalGroupEnergy(settings),
          signal: controller.signal,
        })
        if (storyOutline) console.log(`[story-outline][group] 群=${group.name}\n${storyOutline}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`[story-outline][group] 生成失败 群=${group.name}: ${message}`)
      }
      if (streamByConversation.get(conversationId) !== streamId) return
    }

    const outlineSection = storyOutlinePromptSection(storyOutline)
    // Group history needs an explicit "who said this" label per line — unlike
    // 1:1 chat where the single assistant persona is implicit from the system
    // prompt, a group turn's assistant block can contain several different
    // people, and role:"assistant" alone can't distinguish them across turns.
    const chatMessages: ChatMessage[] = coalesceConsecutiveRoles([
      { role: 'system', content: [systemPrompt, logicContextText, sharedOriginalContext, outlineSection].filter(Boolean).join('\n\n') },
      ...recentHistory.map((m): ChatMessage => formatGroupHistoryMessage(m, contactById, messageById, settings.userNickname)),
    ])
    let rawText = await chatCompletion({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      messages: chatMessages,
      signal: controller.signal,
      purpose: 'chat',
      thinking: 'disabled',
      temperature: 0.9,
      maxTokens: 1800,
      trace: { turnId: streamId, stage: 'first_chat', conversationId },
    })

    if (streamByConversation.get(conversationId) !== streamId) return
    console.log(`[group] 主模型群聊草稿(${rawText.length}字): ${rawText.slice(0, 160)}...`)
    let draftFeedback: string | undefined
    let localDraft = parseGroupRawDraft(rawText, speakers)
    if (!localDraft.valid) draftFeedback = `格式已交给多功能模型修复：${localDraft.reason || '草稿格式不完整'}`

    let parsedTurn = localDraft
    parsedTurn.groupVibe = group.vibe || '自然、轻松的日常群聊。'
    let jsonRaw = serializeGroupTurn(parsedTurn)
    if (!localDraft.valid) {
      jsonRaw = await chatCompletion({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.utilityModel,
        messages: [{ role: 'system', content: buildGroupJsonConversionPrompt(rawText, speakers, stickers.map((s) => s.name), actionContextText) }],
        jsonMode: true,
        signal: controller.signal,
        thinking: 'disabled',
        temperature: 0.1,
        maxTokens: 1400,
        trace: { turnId: streamId, stage: 'other', conversationId },
      })
      if (streamByConversation.get(conversationId) !== streamId) return
      const converted = parseGroupAiResponse(jsonRaw, speakers.length)
      if (converted.bubbles.length > 0) parsedTurn = { ...converted, valid: true }
    }
    let finalRaw = jsonRaw
    let { bubbles, knowledgeQueries, turnSummary, groupVibe } = parsedTurn
    let assistantEvidenceIds: string[] = []
    const runLogicReview = async (stage: 'first_quality' | 'second_quality') => {
      assistantEvidenceIds = bubbles.map(() => uuid())
      return reviewTurnLogic({
        settings,
        latestUserText: latestUserMessage?.content ?? '',
        draftText: rawText,
        personaFacts: [
          ...speakers.map((speaker) => `${displayName(speaker)}(${speaker.id})：${speaker.systemPrompt.slice(0, 700)}${speaker.personaConstraints ? `；硬约束=${speaker.personaConstraints.slice(0, 350)}` : ''}`),
          targetContext ? `本轮定向关系=${targetContext.slice(0, 700)}` : '',
          worldbookText ? `命中世界书=${worldbookText.slice(0, 800)}` : '',
        ].filter(Boolean).join('\n'),
        recentContext: recentHistory.slice(-4).map((message) => formatGroupHistoryMessage(message, contactById, messageById, settings.userNickname).content).join('\n'),
        signal: controller.signal,
        trace: { turnId: streamId, stage, conversationId },
      })
    }
    let logicReview = bubbles.length > 0 ? await runLogicReview('first_quality') : undefined
    if (streamByConversation.get(conversationId) !== streamId) return
    if (logicReview && !logicReview.valid) {
      draftFeedback = logicReview.reason
      console.warn(`[group] 逻辑审查要求主模型重写 群=${group.name} 原因=${draftFeedback}`)
      rawText = await chatCompletion({
        apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model,
        messages: coalesceConsecutiveRoles([
          ...chatMessages,
          { role: 'assistant', content: rawText },
          { role: 'user', content: `上一版群聊回复存在客观逻辑错误：${draftFeedback}\n请依据原始上下文重写完整群聊草稿。不要解释，不要输出JSON；每行仍严格使用 <人名>（想法）[心情]“消息内容”。` },
        ]),
        signal: controller.signal, purpose: 'chat', thinking: 'disabled', temperature: 0.75, maxTokens: 1800,
        trace: { turnId: streamId, stage: 'second_chat', conversationId },
      })
      if (streamByConversation.get(conversationId) !== streamId) return
      localDraft = parseGroupRawDraft(rawText, speakers)
      parsedTurn = localDraft
      parsedTurn.groupVibe = group.vibe || '自然、轻松的日常群聊。'
      jsonRaw = serializeGroupTurn(parsedTurn)
      if (!localDraft.valid) {
        jsonRaw = await chatCompletion({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.utilityModel, messages: [{ role: 'system', content: buildGroupJsonConversionPrompt(rawText, speakers, stickers.map((s) => s.name), actionContextText) }], jsonMode: true, signal: controller.signal, thinking: 'disabled', temperature: 0.1, maxTokens: 1400, trace: { turnId: streamId, stage: 'other', conversationId } })
        const converted = parseGroupAiResponse(jsonRaw, speakers.length)
        if (converted.bubbles.length > 0) parsedTurn = { ...converted, valid: true }
      }
      finalRaw = jsonRaw
      ;({ bubbles, knowledgeQueries, turnSummary, groupVibe } = parsedTurn)
      logicReview = await runLogicReview('second_quality')
      if (!logicReview.valid) throw new Error(`主模型重写后仍未通过群聊逻辑审查：${logicReview.reason || '未知原因'}`)
    }
    knowledgeQueries = []
    console.log(`[group] 收到回复(${finalRaw.length}字) 解析出${bubbles.length}条气泡 群=${group.name}`)
    if (bubbles.length === 0) {
      console.warn(`[group] 本轮没有人回复 群=${group.name} 原始内容: ${rawText.slice(0, 200)}`)
      engine.patch(conversationId, { error: '群里这次没有人回复 可以再发一条试试', aiTyping: false, typingLabel: undefined })
      return
    }
    const latestWorld = await db.worldState.get('global')
    if (!latestWorld || latestWorld.worldVersion !== logicBundles[0].worldVersion) throw new Error('地点树已变化，本轮回复已取消，请重新发送')
    const aiTurnId = uuid()
    await db.aiTurns.add({
      id: aiTurnId,
      conversationId,
      raw: finalRaw,
      parsed: parseGroupTurnDebugPayload(systemPrompt, rawText, draftFeedback, jsonRaw, finalRaw, bubbles, knowledgeQueries, turnSummary, groupVibe, storyOutline),
      knowledgeQueries,
      logicTrace: {
        worldVersion: logicBundles[0].worldVersion,
        locationTreeVersion: logicBundles[0].worldVersion,
        personaSummaries: speakers.map((speaker) => speaker.systemPrompt.slice(0, 500)),
        schedules: logicBundles.flatMap((bundle) => [...bundle.subject.baseSchedule, ...bundle.subject.scheduleOverrides].map((item) => `${item.characterId}/${item.priority}/${item.effectiveDay ?? item.dayOfWeek}/${item.slot}@${item.locationId}`)),
        appointmentIds: [...new Set(logicBundles.flatMap((bundle) => bundle.subject.commitments.map((item) => item.id)))],
        memoryIds: logicBundles.flatMap((bundle) => bundle.memories.map((item) => item.id)),
        perceivedEventIds: [...new Set(logicBundles.flatMap((bundle) => bundle.perceivedEvents.map((item) => item.eventId)))],
        validation: draftFeedback ? 'rejected' : 'passed',
        validationReason: draftFeedback || undefined,
      },
      createdAt: Date.now(),
    })
    // Legacy free-form group plan cards are intentionally not committed.
    // Authoritative appointments require a legal locationId, worldVersion,
    // explicit participant consent and source events; a natural-language
    // candidate alone cannot mutate the world.
    void updateGroupMemoryAndVibe({ group, aiTurnId, settings, turnSummary, groupVibe, logicContextText, clock: logicBundles[0].clock })
    await revealGroupBubbles(conversationId, group, members, speakers, bubbles, streamId, settings, aiTurnId, turnSummary, logicContextText, logicBundles[0].worldVersion, assistantEvidenceIds, latestUserMessage, controller.signal, turnStartedAt)
  } catch (err) {
    if (streamByConversation.get(conversationId) !== streamId) return
    if (err instanceof DOMException && err.name === 'AbortError') return
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[group] 生成回复出错 群=${group.name}:`, message)
    engine.patch(conversationId, { error: message, aiTyping: false, typingLabel: undefined })
  } finally {
    if (abortByConversation.get(conversationId) === controller) abortByConversation.delete(conversationId)
  }
}

async function revealGroupBubbles(
  conversationId: string,
  group: Group,
  members: Contact[],
  speakers: Contact[],
  bubbles: GroupAiBubble[],
  streamId: string,
  settings: AppSettings,
  aiTurnId: string,
  turnSummary: string,
  logicContextText: string,
  logicWorldVersion: number,
  assistantEvidenceIds: string[] = [],
  latestUserMessage?: Message,
  signal: AbortSignal = new AbortController().signal,
  turnStartedAt = performance.now(),
): Promise<void> {
  const latestWorld = await db.worldState.get('global')
  if (!latestWorld || latestWorld.worldVersion !== logicWorldVersion) {
    useChatEngineStore.getState().patch(conversationId, { error: '地点树已变化，本轮回复已取消', aiTyping: false, typingLabel: undefined })
    return
  }
  const now = Date.now()
  const messages = bubbles.flatMap((bubble, index) => {
    const speaker = speakers[bubble.speakerIndex - 1]
    if (!speaker) return []
    const content = bubble.type === 'text'
      ? stripSpeakerNamePrefix(bubble.content, members.map((member) => member.name))
      : ''
    if (!content) return []
    return [{
      id: assistantEvidenceIds[index] ?? uuid(), conversationId, role: 'assistant' as const, type: bubble.type,
      content, speakerContactId: speaker.id, debugAiTurnId: aiTurnId,
      debugParsedBubble: bubble, thought: bubble.thought, pending: true, createdAt: now + index,
    } satisfies Message]
  })
  if (messages.length === 0) {
    useChatEngineStore.getState().patch(conversationId, { error: '群聊草稿没有可显示内容', aiTyping: false, typingLabel: undefined })
    return
  }
  const firstMessage = messages[0]
  await db.transaction('rw', db.messages, db.conversations, async () => {
    await db.messages.add(firstMessage)
    await db.conversations.update(conversationId, { updatedAt: firstMessage.createdAt })
  })
  const conversation = await db.conversations.get(conversationId)
  const visibleAt = performance.now()
  const nextSpeaker = messages[1] ? members.find((member) => member.id === messages[1].speakerContactId) : undefined
  useChatEngineStore.getState().patch(conversationId, { typingLabel: nextSpeaker ? displayName(nextSpeaker) : '群成员' })
  const stateStartedAt = performance.now()
  const revealedMessages = [firstMessage]
  const stateTask = (async () => {
    const listenerIds = conversation?.channel === 'scene' && conversation.sceneLocationId
      ? (await Promise.all(speakers.map(async (speaker) => ({ id: speaker.id, heard: speaker.currentLocationId ? await audibilityBetween(conversation.sceneLocationId!, speaker.currentLocationId) : 'none' })))).filter((item) => item.heard === 'clear').map((item) => item.id)
      : speakers.map((speaker) => speaker.id)
    await adjudicateStateChanges({
      scene: conversation?.channel === 'scene' ? 'scene' : 'group_phone',
      conversationId,
      characterIds: speakers.map((speaker) => speaker.id),
      settings,
      evidence: [
        ...(latestUserMessage ? [{ id: latestUserMessage.id, actorId: 'user', actorName: '用户', content: latestUserMessage.content, perceivedBy: listenerIds }] : []),
        ...messages.map((message) => {
          const speaker = speakers.find((candidate) => candidate.id === message.speakerContactId)
          return { id: message.id, actorId: speaker?.id ?? '', actorName: speaker ? displayName(speaker) : '角色', content: message.content, perceivedBy: Array.from(new Set([...(speaker ? [speaker.id] : []), ...listenerIds])) }
        }),
      ],
      trace: { turnId: streamId, stage: 'state', conversationId },
    })
  })().catch((error) => { console.error('[state] 群聊状态裁决失败，聊天仍会正常提交', error); return null })
  const notifyMessage = (message: Message) => {
    if (conversation?.channel === 'scene' || useChatUiStore.getState().activeConversationId === conversationId) return
    const speaker = members.find((member) => member.id === message.speakerContactId)
    useChatUiStore.getState().showNotification({
      id: uuid(), conversationId, contactName: group.name, contactAvatar: group.avatar,
      contactAvatarColor: group.avatarColor,
      preview: previewForMessage(message, speaker ? displayName(speaker) : undefined),
    })
  }
  const revealTask = (async () => {
    notifyMessage(firstMessage)
    for (let index = 1; index < messages.length; index++) {
      await waitForMessageReveal(messages[index - 1].content, signal)
      if (signal.aborted || streamByConversation.get(conversationId) !== streamId) return false
      const message = messages[index]
      await db.transaction('rw', db.messages, db.conversations, async () => {
        await db.messages.add(message)
        await db.conversations.update(conversationId, { updatedAt: message.createdAt })
      })
      revealedMessages.push(message)
      notifyMessage(message)
      const followingMessage = messages[index + 1]
      if (followingMessage) {
        const followingSpeaker = members.find((member) => member.id === followingMessage.speakerContactId)
        useChatEngineStore.getState().patch(conversationId, { typingLabel: followingSpeaker ? displayName(followingSpeaker) : '群成员' })
      }
    }
    useChatEngineStore.getState().patch(conversationId, { typingLabel: undefined })
    return true
  })()
  const [, revealResult] = await Promise.allSettled([stateTask, revealTask])
  if (revealResult.status === 'rejected') {
    await db.messages.bulkDelete(revealedMessages.map((message) => message.id))
    await db.conversations.update(conversationId, { updatedAt: Date.now() })
    throw revealResult.reason
  }
  await Promise.all(revealedMessages.map((message) => db.messages.update(message.id, { pending: false })))
  if (!revealResult.value) return
  const lastMessage = messages.at(-1)!
  const lastSpeaker = members.find((member) => member.id === lastMessage.speakerContactId)
  const unlockedAt = performance.now()
  console.info(`[回合耗时｜群聊] 首次显示=${Math.round(visibleAt - turnStartedAt)}ms；状态裁决与提交=${Math.round(unlockedAt - stateStartedAt)}ms；解锁=${Math.round(unlockedAt - turnStartedAt)}ms`)
  useChatEngineStore.getState().patch(conversationId, { aiTyping: false, typingLabel: undefined })
  if (streamByConversation.get(conversationId) === streamId) streamByConversation.delete(conversationId)

  // Side effects run after the complete paid turn is already visible.
  void Promise.all(messages.map(async (message, index) => {
    const speaker = members.find((member) => member.id === message.speakerContactId)
    const bubble = bubbles[index]
    if (speaker?.id && bubble?.mood) {
      await db.contacts.update(speaker.id, { mood: { text: bubble.mood, expiresAt: Date.now() + settings.moodExpiryMs } })
    }
    if (conversation?.channel === 'scene' && conversation.sceneLocationId && speaker?.id) {
      const world = await ensureWorldInitialized()
      const eventId = uuid()
      const allContacts = await db.contacts.toArray()
      const heardRows = await Promise.all(allContacts.filter((candidate) => candidate.currentLocationId).map(async (candidate) => ({
        candidate,
        heard: await audibilityBetween(conversation.sceneLocationId!, candidate.currentLocationId!),
      })))
      const perceived = heardRows.filter((row) => row.heard !== 'none')
      await db.worldEvents.add({
        id: eventId, type: 'speech', worldStep: world.step, locationId: conversation.sceneLocationId,
        actorId: speaker.id, participantIds: perceived.filter((row) => row.heard === 'clear').map((row) => row.candidate.id),
        content: message.content, visibility: 'scene', createdAt: message.createdAt,
      })
      await db.perceivedEvents.bulkAdd(perceived.map((row) => ({
        id: uuid(), eventId, characterId: row.candidate.id,
        perception: row.heard === 'clear' ? 'full' as const : 'muffled' as const,
        observedAtStep: world.step,
      })))
    }
  })).catch(() => undefined)
  void maybeUpdateGroupMemory(group.id, conversationId, members, settings, logicContextText)
  if (turnSummary.trim()) {
    void recordSocialEvent({
      type: 'group_turn', actorId: lastSpeaker?.id ?? 'user', relatedContactIds: group.memberContactIds,
      conversationId, groupId: group.id, messageId: lastMessage.id,
      summary: `群聊“${group.name}”刚聊到：${turnSummary.trim()}`, importance: 2,
    })
  }
}
