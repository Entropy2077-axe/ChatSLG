import type { AppSettings } from '../types'

export type ChatLiveliness = NonNullable<AppSettings['chatLiveliness']>

export const CHAT_LIVELINESS: Record<ChatLiveliness, { label: string; min: number; max: number }> = {
  quiet: { label: '冷清', min: 1, max: 2 },
  normal: { label: '一般', min: 3, max: 4 },
  lively: { label: '热闹', min: 5, max: 6 },
}

export function chatLivelinessRule(value: AppSettings['chatLiveliness']): string {
  const item = CHAT_LIVELINESS[value ?? 'normal']
  return `本轮总共回复 ${item.min} 到 ${item.max} 条普通聊天消息；自然分句，不要为了凑数灌水。`
}
