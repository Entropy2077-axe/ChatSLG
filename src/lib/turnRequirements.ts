import type { AppSettings, GroupAiBubble } from '../types'
import { CHAT_LIVELINESS, type ChatLiveliness } from './chatLiveliness'

export interface TurnRequirement {
  minBubbles: number
  maxBubbles: number
  minimumDistinctSpeakers: number
  requiredSpeakerIds: string[]
}

export interface TurnRequirementResult {
  valid: boolean
  issues: string[]
}

function liveliness(value: AppSettings['chatLiveliness']): ChatLiveliness {
  return value ?? 'normal'
}

function requestedStateDimensionCount(text: string): number {
  if (!text.trim()) return 0
  const segments = text.split(/[；;。！？!?\n]/).filter(Boolean)
  const hasOutfitRequest = segments.some((segment) => /(?:穿|戴|换|脱|摘|套上|外套|衣服|裙|鞋|帽|配饰|蝴蝶结)/.test(segment))
  const hasFutureSchedule = segments.some((segment) =>
    /(?:明天|明儿|明晚|后天|今晚|改天|稍后|等会|待会|下周|周[一二三四五六日天])/.test(segment)
    && /(?:见|碰头|约|安排|去|到|咖啡|吃|玩)/.test(segment),
  )
  const hasImmediateLocation = segments.some((segment) =>
    /(?:现在|马上|这就|先|走)[^；;。！？!?\n]{0,20}(?:去|到|前往|客厅|卧室|房间|厨房|餐厅)/.test(segment),
  )
  return [hasOutfitRequest, hasFutureSchedule, hasImmediateLocation].filter(Boolean).length
}

export function privateTurnRequirement(value: AppSettings['chatLiveliness'], latestUserText = ''): TurnRequirement {
  const target = CHAT_LIVELINESS[liveliness(value)]
  const requestParts = requestedStateDimensionCount(latestUserText)
  return {
    minBubbles: target.min,
    maxBubbles: Math.max(target.max, requestParts),
    minimumDistinctSpeakers: 1,
    requiredSpeakerIds: [],
  }
}

export function turnRequirementReplyCountRule(requirement: TurnRequirement): string {
  return requirement.minBubbles === requirement.maxBubbles
    ? `本轮必须恰好回复 ${requirement.minBubbles} 条普通聊天消息；自然分句，不要用重复内容灌水。`
    : `本轮总共回复 ${requirement.minBubbles} 到 ${requirement.maxBubbles} 条普通聊天消息；自然分句，不要为了凑数灌水。`
}

export function groupTurnRequirement(
  value: AppSettings['chatLiveliness'],
  availableSpeakerIds: string[],
  requiredSpeakerIds: string[] = [],
): TurnRequirement {
  const mode = liveliness(value)
  const target = CHAT_LIVELINESS[mode]
  const minimum = mode === 'quiet' ? 1 : mode === 'lively' ? 3 : 2
  const available = new Set(availableSpeakerIds)
  return {
    minBubbles: target.min,
    maxBubbles: target.max,
    minimumDistinctSpeakers: Math.min(minimum, available.size),
    requiredSpeakerIds: [...new Set(requiredSpeakerIds.filter((id) => available.has(id)))],
  }
}

export function validatePrivateTurn(bubbleCount: number, requirement: TurnRequirement): TurnRequirementResult {
  const issues: string[] = []
  if (bubbleCount < requirement.minBubbles) issues.push(`消息数不足：需要至少${requirement.minBubbles}条，实际${bubbleCount}条`)
  if (bubbleCount > requirement.maxBubbles) issues.push(`消息数过多：最多${requirement.maxBubbles}条，实际${bubbleCount}条`)
  return { valid: issues.length === 0, issues }
}

export function validateGroupTurn(
  bubbles: GroupAiBubble[],
  speakerIdsByIndex: string[],
  requirement: TurnRequirement,
): TurnRequirementResult {
  const issues = validatePrivateTurn(bubbles.length, requirement).issues
  const participating = new Set(
    bubbles
      .map((bubble) => speakerIdsByIndex[bubble.speakerIndex - 1])
      .filter((id): id is string => !!id),
  )
  if (participating.size < requirement.minimumDistinctSpeakers) {
    issues.push(`不同发言人数不足：需要至少${requirement.minimumDistinctSpeakers}人，实际${participating.size}人`)
  }
  const missing = requirement.requiredSpeakerIds.filter((id) => !participating.has(id))
  if (missing.length) issues.push(`被@或被回复的指定角色没有发言：${missing.join('、')}`)
  return { valid: issues.length === 0, issues }
}

export function turnRepairInstruction(issues: string[]): string {
  return `上一版回复未满足硬性验收：${issues.join('；')}。必须逐项改正，不能换个说法保留同一错误；如果问题是无证据编造障碍、物品缺失或能力缺失，删除该障碍并依据现有硬事实直接回应。请重写完整回复，只输出规定格式，不要解释。`
}
