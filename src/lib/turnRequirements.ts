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

export function privateTurnRequirement(value: AppSettings['chatLiveliness']): TurnRequirement {
  const target = CHAT_LIVELINESS[liveliness(value)]
  return {
    minBubbles: target.min,
    maxBubbles: target.max,
    minimumDistinctSpeakers: 1,
    requiredSpeakerIds: [],
  }
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
  return `上一版回复未满足硬性验收：${issues.join('；')}。请重写完整回复，只输出规定格式，不要解释。`
}
