import type { AiBubble, AiResponse, OutfitChangeProposal } from '../types'
import { normalizeMood } from './mood'

export interface ParsedAiTurn {
  bubbles: AiBubble[]
  knowledgeQueries: string[]
  mood?: string
  thought?: string
  outfitChange?: OutfitChangeProposal
}

export function parseAiResponse(raw: string): ParsedAiTurn {
  const trimmedRaw = raw.trim()

  if (!trimmedRaw) {
    return { bubbles: [], knowledgeQueries: [], mood: undefined }
  }

  const jsonResult = tryParseJson(trimmedRaw)
  if (jsonResult) {
    return {
      bubbles: jsonResult.bubbles,
      knowledgeQueries: jsonResult.knowledgeQueries,
      mood: jsonResult.mood,
      thought: jsonResult.thought,
      outfitChange: jsonResult.outfitChange,
    }
  }

  const fallbackBubbles: AiBubble[] = trimmedRaw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((content) => ({ type: 'text', content }))
  return { bubbles: fallbackBubbles, knowledgeQueries: [], mood: undefined }
}

export function parseKnowledgeQueriesField(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const result: string[] = []
  for (const q of raw) {
    if (typeof q === 'string' && q.trim()) result.push(q.trim())
    if (result.length >= 2) break
  }
  return result
}

function tryParseJson(trimmedRaw: string): ParsedAiTurn | null {
  let text = trimmedRaw
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) text = fenceMatch[1].trim()
  if (!text) return null

  let parsed: AiResponse | undefined
  try {
    parsed = JSON.parse(text)
  } catch {
    const extracted = extractJsonObject(text)
    if (!extracted) return null
    try {
      parsed = JSON.parse(extracted)
    } catch {
      return null
    }
  }
  if (!parsed || !Array.isArray(parsed.messages)) return null

  const bubbles: AiBubble[] = []
  for (const m of parsed.messages) {
    if (!m || typeof m !== 'object') continue
    if (m.type === 'text') {
      const content = parseTextBubbleContent(m as unknown as Record<string, unknown>)
      if (content) bubbles.push({ type: 'text', content })
    } else if (m.type === 'link' && typeof m.app === 'string' && typeof m.label === 'string') {
      bubbles.push({ type: 'link', app: m.app, label: m.label, data: m.data })
    } else if (m.type === 'scheduleChange') {
      const scheduleChange = parseScheduleChangeBubble(m as unknown as Record<string, unknown>)
      if (scheduleChange) bubbles.push(scheduleChange)
    } else if (['transfer','redPacket','loanRequest','loanDecision','giftPurchase'].includes(String(m.type))) {
      const fm = m as unknown as Record<string, unknown>
      const amount = Math.round(Number(fm.amount))
      if (Number.isFinite(amount) && amount > 0) bubbles.push({ type: m.type as 'transfer'|'redPacket'|'loanRequest'|'loanDecision'|'giftPurchase', amount, note: typeof fm.note === 'string' ? String(fm.note).slice(0,80) : undefined, loanId: typeof fm.loanId === 'string' ? String(fm.loanId) : undefined, decision: fm.decision === 'accept' ? 'accept' : fm.decision === 'reject' ? 'reject' : undefined, name: typeof fm.name === 'string' ? String(fm.name).slice(0,30) : undefined, icon: typeof fm.icon === 'string' ? String(fm.icon).slice(0,8) : undefined, description: typeof fm.description === 'string' ? String(fm.description).slice(0,80) : undefined })
    }
  }
  const mood = typeof parsed.mood === 'string' && parsed.mood.trim() ? normalizeMood(parsed.mood) : undefined
  const thought = typeof parsed.thought === 'string' && parsed.thought.trim() ? parsed.thought.trim().slice(0, 100) : undefined
  const outfitChange = parseOutfitChange(parsed.outfitChange)
  return { bubbles, knowledgeQueries: [], mood, thought, outfitChange }
}

function parseFinanceMarker(line: string): AiBubble | null {
  let match = line.match(/^\[transfer:(\d+):([^\]]+)\]$/i)
  if (match) return { type: 'transfer', amount: Number(match[1]), note: match[2].trim().slice(0, 80) }
  match = line.match(/^\[redPacket:(\d+):([^\]]+)\]$/i)
  if (match) return { type: 'redPacket', amount: Number(match[1]), note: match[2].trim().slice(0, 80) }
  match = line.match(/^\[loanRequest:(\d+):([^\]]+)\]$/i)
  if (match) return { type: 'loanRequest', amount: Number(match[1]), note: match[2].trim().slice(0, 80) }
  match = line.match(/^\[loanDecision:([^:\]]+):(accept|reject):(\d+)\]$/i)
  if (match) return { type: 'loanDecision', loanId: match[1].trim(), decision: match[2].toLowerCase() as 'accept' | 'reject', amount: Number(match[3]) }
  match = line.match(/^\[giftPurchase:(\d+):([^:\]]+):([^:\]]+):([^\]]+)\]$/i)
  if (match) return { type: 'giftPurchase', amount: Number(match[1]), name: match[2].trim().slice(0, 30), icon: match[3].trim().slice(0, 8), description: match[4].trim().slice(0, 80) }
  return null
}

/** Fast path for the main model's plain-text draft. Ordinary chat and finance
 * markers can be parsed locally, preserving the main model's wording and
 * avoiding a second paid model call whose only job was mechanical JSON. */
export function parseRawPrivateDraft(raw: string, fallbackMood: string = '😌'): ParsedAiTurn {
  const moodMatch = raw.match(/<mood>\s*([^<]+?)\s*<\/mood>/i)
  const thoughtMatch = raw.match(/<thought>\s*([\s\S]*?)\s*<\/thought>/i)
  const body = raw
    .replace(/<mood>[\s\S]*?<\/mood>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .trim()
  const bubbles: AiBubble[] = []
  for (const sourceLine of body.split(/\r?\n/)) {
    let line = sourceLine.trim().replace(/^[-•]\s*/, '')
    if (!line) continue
    if ((line.startsWith('“') && line.endsWith('”')) || (line.startsWith('"') && line.endsWith('"'))) {
      line = line.slice(1, -1).trim()
    }
    if (!line) continue
    const finance = parseFinanceMarker(line)
    if (finance) bubbles.push(finance)
    else bubbles.push({ type: 'text', content: line })
  }
  return {
    bubbles,
    knowledgeQueries: [],
    mood: normalizeMood(moodMatch?.[1], normalizeMood(fallbackMood)),
    thought: thoughtMatch?.[1]?.trim().slice(0, 100),
  }
}

export function rawPrivateDraftNeedsUtility(raw: string, latestUserText: string): boolean {
  if (!/<mood>[\s\S]*?<\/mood>/i.test(raw) || !/<thought>[\s\S]*?<\/thought>/i.test(raw)) return true
  const text = `${latestUserText}\n${raw}`
  const scheduleIntent = /(约|见面|碰面|一起去|一起吃|改期|日程|安排|明天|后天|周[一二三四五六日天]|几点|上午|下午|晚上|今晚)/.test(text)
  const outfitIntent = /(穿上|脱下|换上|换掉|衣服|外套|裤子|裙子|鞋子|帽子|围巾|配饰)/.test(text)
  return scheduleIntent || outfitIntent
}

export function serializePrivateTurn(parsed: ParsedAiTurn): string {
  return JSON.stringify({
    messages: parsed.bubbles,
    mood: parsed.mood,
    thought: parsed.thought,
    ...(parsed.outfitChange ? { outfitChange: parsed.outfitChange } : {}),
  })
}

export function parseOutfitChange(raw: unknown): OutfitChangeProposal | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>, patch: Record<string, string> = {}
  if (value.patch && typeof value.patch === 'object') for (const key of ['head', 'top', 'bottom', 'outerwear', 'footwear', 'accessories']) {
    const part = (value.patch as Record<string, unknown>)[key]
    if (typeof part === 'string' && part.trim()) patch[key] = part.trim().slice(0, 80)
  }
  const sourceEventIds = Array.isArray(value.sourceEventIds) ? value.sourceEventIds.filter((item): item is string => typeof item === 'string' && !!item.trim()).slice(0, 8) : []
  if (!Number.isInteger(Number(value.worldVersion)) || !Object.keys(patch).length || !sourceEventIds.length || typeof value.characterId !== 'string' || typeof value.reason !== 'string') return undefined
  return { characterId: value.characterId, worldVersion: Number(value.worldVersion), patch, reasonType: value.reasonType === 'schedule_change' ? 'schedule_change' : 'conversation_event', sourceEventIds, sourceScheduleId: typeof value.sourceScheduleId === 'string' ? value.sourceScheduleId : undefined, reason: value.reason.slice(0, 160) }
}

function parseTextBubbleContent(m: Record<string, unknown>): string {
  const content = typeof m.content === 'string' ? m.content : typeof m.text === 'string' ? m.text : ''
  return content.trim()
}

function parseScheduleChangeBubble(m: Record<string, unknown>): AiBubble | null {
  const worldVersion = Number(m.worldVersion)
  const effectiveDay = Number(m.effectiveDay)
  const slot = m.slot
  const locationId = typeof m.locationId === 'string' ? m.locationId.trim() : ''
  const phoneAccess = m.phoneAccess
  const activity = typeof m.activity === 'string' ? m.activity.trim() : ''
  const summary = typeof m.summary === 'string' ? m.summary.trim() : ''
  const priority = m.priority
  const reason = typeof m.reason === 'string' ? m.reason.trim() : ''

  if (!Number.isInteger(worldVersion) || !Number.isInteger(effectiveDay) || effectiveDay < 1) return null
  if (!['morning', 'day', 'evening', 'night'].includes(String(slot))) return null
  if (phoneAccess !== 'available' && phoneAccess !== 'unavailable') return null
  if (priority !== 'override' && priority !== 'commitment') return null
  if (!locationId || !activity || !summary || !reason) return null

  return {
    type: 'scheduleChange', worldVersion, effectiveDay,
    slot: slot as 'morning' | 'day' | 'evening' | 'night', locationId,
    phoneAccess, activity, summary, priority, reason,
  }
}

export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

export function typingDelayMs(bubble: AiBubble): number {
  if (bubble.type === 'text') {
    const len = bubble.content.length
    return Math.min(300 + len * 80, 3500)
  }
  return 700
}
