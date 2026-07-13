import { db } from '../db/db'
import { audibilityBetween, ensureWorldInitialized, isLeafLocation } from './world'

export async function ensureActiveSceneConversation(): Promise<string> {
  const world = await ensureWorldInitialized()
  if (!await isLeafLocation(world.playerLocationId)) throw new Error('当前位置不是可进入的叶子地点')
  const location = await db.locations.get(world.playerLocationId)
  if (!location) throw new Error('当前位置不存在')
  const contacts = await db.contacts.toArray()
  const clearMemberIds: string[] = []
  for (const contact of contacts) {
    if (!contact.currentLocationId) continue
    if (await audibilityBetween(location.id, contact.currentLocationId) === 'clear') clearMemberIds.push(contact.id)
  }
  const groupId = `scene-group:${world.step}:${location.id}`
  const conversationId = `scene:${world.step}:${location.id}`
  const now = Date.now()
  await db.groups.put({
    id: groupId, name: `${location.name} · 现场`, avatar: '📍', avatarColor: '#e5e7eb',
    memberContactIds: clearMemberIds, speakerLimit: 'all', allowAiChatter: true,
    energyLevel: 'normal', createdAt: now, momentSharing: 'private',
  })
  const existing = await db.conversations.get(conversationId)
  await db.conversations.put({
    ...existing,
    id: conversationId, groupId, channel: 'scene', sceneLocationId: location.id,
    sceneWorldStep: world.step, status: 'active', pinned: false,
    createdAt: existing?.createdAt ?? now, updatedAt: existing?.updatedAt ?? now,
  })
  return conversationId
}
