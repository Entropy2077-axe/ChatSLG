import Dexie from 'dexie'
import { db } from '../db/db'
import type { Conversation, Message } from '../types'

export interface ConversationMessageStats {
  lastMessage?: Message
  unread: number
}

function conversationTimeRange(conversationId: string) {
  return db.messages
    .where('[conversationId+createdAt]')
    .between([conversationId, Dexie.minKey], [conversationId, Dexie.maxKey])
}

export async function recentConversationMessages(conversationId: string, limit: number): Promise<Message[]> {
  const newestFirst = await conversationTimeRange(conversationId).reverse().limit(Math.max(1, limit)).toArray()
  return newestFirst.reverse()
}

export async function messagesForAiTurn(aiTurnId: string): Promise<Message[]> {
  return db.messages.where('debugAiTurnId').equals(aiTurnId).toArray()
}

export async function conversationMessageStats(
  conversations: Array<Pick<Conversation, 'id' | 'lastReadAt'>>,
): Promise<Map<string, ConversationMessageStats>> {
  const rows = await Promise.all(conversations.map(async (conversation) => {
    const since = conversation.lastReadAt ?? 0
    const [lastMessage, unread] = await Promise.all([
      conversationTimeRange(conversation.id).reverse().first(),
      db.messages
        .where('[conversationId+role+createdAt]')
        .between(
          [conversation.id, 'assistant', since],
          [conversation.id, 'assistant', Dexie.maxKey],
          false,
          true,
        )
        .count(),
    ])
    return [conversation.id, { lastMessage, unread }] as const
  }))
  return new Map(rows)
}

export async function totalUnreadForConversations(
  conversations: Array<Pick<Conversation, 'id' | 'lastReadAt'>>,
): Promise<number> {
  const stats = await conversationMessageStats(conversations)
  let total = 0
  for (const value of stats.values()) total += value.unread
  return total
}
