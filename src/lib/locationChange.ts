import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type { LocationChangeProposal } from '../types'
import { isLeafLocation } from './world'

export async function applyLocationChangeProposal(proposal: LocationChangeProposal): Promise<string> {
  const [world, contact, location] = await Promise.all([db.worldState.get('global'), db.contacts.get(proposal.characterId), db.locations.get(proposal.locationId)])
  if (!world || proposal.worldVersion !== world.worldVersion) throw new Error('地点变更使用了过期世界版本')
  if (!contact || !location || !await isLeafLocation(location.id)) throw new Error('地点变更引用了非法角色或地点')
  for (const eventId of proposal.sourceEventIds) {
    const event = await db.worldEvents.get(eventId)
    if (!event || !event.participantIds.includes(contact.id)) throw new Error('地点变更缺少角色实际感知的对话事件')
  }
  const eventId = uuid(), now = Date.now()
  await db.transaction('rw', [db.worldState, db.contacts, db.worldEvents], async () => {
    const latest = await db.worldState.get('global')
    if (!latest || latest.worldVersion !== proposal.worldVersion) throw new Error('世界已变化，地点变更取消')
    await db.contacts.update(contact.id, { currentLocationId: location.id })
    await db.worldEvents.add({ id: eventId, type: 'movement', worldStep: latest.step, locationId: location.id, actorId: contact.id, participantIds: [contact.id], content: proposal.reason, visibility: 'private', createdAt: now })
  })
  return eventId
}
