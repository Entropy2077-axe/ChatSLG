import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type { OutfitChangeProposal } from '../types'
import { defaultOutfit } from './outfit'

export async function applyOutfitChangeProposal(proposal: OutfitChangeProposal): Promise<string> {
  const [world, contact] = await Promise.all([db.worldState.get('global'), db.contacts.get(proposal.characterId)])
  if (!world || proposal.worldVersion !== world.worldVersion) throw new Error('衣着提案使用了过期世界版本')
  if (!contact) throw new Error('衣着提案引用了不存在的角色')
  const allowed = new Set(['head', 'top', 'bottom', 'outerwear', 'footwear', 'accessories'])
  const patch = Object.fromEntries(Object.entries(proposal.patch).filter(([key, value]) => allowed.has(key) && typeof value === 'string' && value.trim()).map(([key, value]) => [key, String(value).trim().slice(0, 80)]))
  if (!Object.keys(patch).length) throw new Error('衣着提案没有有效变化')
  if (proposal.reasonType === 'conversation_event') {
    for (const eventId of proposal.sourceEventIds) {
      const [event, perceived] = await Promise.all([db.worldEvents.get(eventId), db.perceivedEvents.filter((item) => item.eventId === eventId && item.characterId === contact.id && item.perception === 'full').first()])
      if (!event || !perceived) throw new Error('衣着提案引用了角色未完整感知的事件')
    }
  } else {
    const schedule = proposal.sourceScheduleId ? await db.characterSchedules.get(proposal.sourceScheduleId) : undefined
    if (!schedule || schedule.characterId !== contact.id) throw new Error('换装提案缺少有效日程来源')
  }
  const eventId = uuid(), now = Date.now()
  await db.transaction('rw', [db.worldState, db.contacts, db.worldEvents, db.perceivedEvents], async () => {
    const latest = await db.worldState.get('global')
    if (!latest || latest.worldVersion !== proposal.worldVersion) throw new Error('世界已变化，衣着更新取消')
    await db.contacts.update(contact.id, { outfit: { ...defaultOutfit(contact.createdAt), ...contact.outfit, ...patch, updatedAt: now, sourceEventIds: [...proposal.sourceEventIds] } })
    await db.worldEvents.add({ id: eventId, type: 'outfit', worldStep: world.step, locationId: contact.currentLocationId, actorId: contact.id, participantIds: [contact.id], content: proposal.reason, visibility: 'private', createdAt: now })
    await db.perceivedEvents.add({ id: uuid(), eventId, characterId: contact.id, perception: 'full', observedAtStep: world.step })
  })
  return eventId
}
