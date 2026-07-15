import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type { Contact, OutfitConstraint, OutfitState, ScheduleConstraint, SystemStatePayload, TimeSlot } from '../types'
import { defaultOutfit } from './outfit'
import { displayName } from './contact'
import { isLeafLocation } from './world'

export const ALL_SLOTS: TimeSlot[] = ['morning', 'day', 'evening', 'night']

export function normalizedSlots(slots?: TimeSlot[]): TimeSlot[] | undefined {
  const result = [...new Set((slots ?? []).filter((slot): slot is TimeSlot => ALL_SLOTS.includes(slot as TimeSlot)))]
  return result.length === 0 || result.length === ALL_SLOTS.length ? undefined : result
}

export function activeInRange(item: { startDay: number; endDay: number; slots?: TimeSlot[] }, day: number, slot: TimeSlot): boolean {
  return item.startDay <= day && day <= item.endDay && (!item.slots?.length || item.slots.includes(slot))
}

export function resolveCurrentOutfit(contact: Contact, constraints: OutfitConstraint[], day: number, slot: TimeSlot): OutfitState {
  const base = contact.defaultOutfit ?? contact.outfit ?? defaultOutfit(contact.createdAt)
  return constraints.filter((item) => activeInRange(item, day, slot)).sort((a, b) => a.createdAt - b.createdAt)
    .reduce<OutfitState>((outfit, item) => ({ ...outfit, ...item.patch, updatedAt: item.createdAt, sourceEventIds: item.sourceEventIds }), { ...base })
}

export function resolveScheduleConstraint(constraints: ScheduleConstraint[], day: number, slot: TimeSlot): ScheduleConstraint | undefined {
  const rank = { override: 2, commitment: 3 }
  return constraints.filter((item) => activeInRange(item, day, slot)).sort((a, b) => rank[b.priority] - rank[a.priority] || b.createdAt - a.createdAt)[0]
}

function systemMessage(conversationId: string, payload: SystemStatePayload) {
  return { id: uuid(), conversationId, role: 'system' as const, type: 'systemState' as const, content: payload.kind, systemState: payload, createdAt: Date.now() }
}

export async function addOutfitConstraint(input: Omit<OutfitConstraint, 'id' | 'createdAt' | 'slots'> & { slots?: TimeSlot[] }): Promise<OutfitConstraint> {
  const row: OutfitConstraint = { ...input, id: uuid(), slots: normalizedSlots(input.slots), createdAt: Date.now() }
  const [contact, world] = await Promise.all([db.contacts.get(row.characterId), db.worldState.get('global')])
  if (!contact || !world) throw new Error('联系人或世界不存在')
  const current = activeInRange(row, world.day, world.slot)
  const all = await db.outfitConstraints.where('characterId').equals(row.characterId).toArray()
  const outfit = resolveCurrentOutfit(contact, [...all, row], world.day, world.slot)
  const conversation = await db.conversations.get(row.conversationId)
  await db.transaction('rw', [db.outfitConstraints, db.contacts, db.messages, db.conversations], async () => {
    await db.outfitConstraints.add(row)
    if (current) await db.contacts.update(contact.id, { defaultOutfit: contact.defaultOutfit ?? contact.outfit ?? defaultOutfit(contact.createdAt), outfit })
    if (conversation) {
      await db.messages.add(systemMessage(row.conversationId, { kind: 'outfit', contactId: contact.id, contactName: displayName(contact), startDay: row.startDay, endDay: row.endDay, slots: row.slots, state: current ? 'active' : 'upcoming', patch: row.patch, outfit: current ? outfit : undefined }))
      await db.conversations.update(row.conversationId, { updatedAt: Date.now() })
    }
  })
  return row
}

export async function addScheduleConstraint(input: Omit<ScheduleConstraint, 'id' | 'createdAt' | 'slots'> & { slots?: TimeSlot[] }): Promise<ScheduleConstraint> {
  const row: ScheduleConstraint = { ...input, id: uuid(), slots: normalizedSlots(input.slots), createdAt: Date.now() }
  const [contact, world, location] = await Promise.all([db.contacts.get(row.characterId), db.worldState.get('global'), db.locations.get(row.locationId)])
  if (!contact || !world || !location) throw new Error('日程引用不存在的联系人或地点')
  const current = activeInRange(row, world.day, world.slot)
  const conversation = await db.conversations.get(row.conversationId)
  await db.transaction('rw', [db.scheduleConstraints, db.messages, db.conversations], async () => {
    await db.scheduleConstraints.add(row)
    if (conversation) {
      await db.messages.add(systemMessage(row.conversationId, { kind: 'schedule', contactId: contact.id, contactName: displayName(contact), startDay: row.startDay, endDay: row.endDay, slots: row.slots, state: current ? 'active' : 'upcoming', locationId: row.locationId, locationName: location.name, activity: row.activity, phoneAccess: row.phoneAccess }))
      await db.conversations.update(row.conversationId, { updatedAt: Date.now() })
    }
  })
  return row
}

export async function refreshConstraintsForWorld(day: number, slot: TimeSlot): Promise<void> {
  const [contacts, outfits, schedules] = await Promise.all([db.contacts.toArray(), db.outfitConstraints.toArray(), db.scheduleConstraints.toArray()])
  for (const contact of contacts) {
    const outfit = resolveCurrentOutfit(contact, outfits.filter((item) => item.characterId === contact.id), day, slot)
    await db.contacts.update(contact.id, { defaultOutfit: contact.defaultOutfit ?? contact.outfit ?? defaultOutfit(contact.createdAt), outfit })
  }
  for (const item of outfits.filter((item) => item.endDay < day && !item.expiredNotified)) {
    const contact = contacts.find((value) => value.id === item.characterId); if (!contact) continue
    await db.transaction('rw', [db.outfitConstraints, db.messages], async () => { await db.messages.add(systemMessage(item.conversationId, { kind: 'outfitRestored', contactId: contact.id, contactName: displayName(contact), startDay: item.startDay, endDay: item.endDay, state: 'restored' })); await db.outfitConstraints.update(item.id, { expiredNotified: true }) })
  }
  for (const item of schedules.filter((item) => item.endDay < day && !item.expiredNotified)) {
    const contact = contacts.find((value) => value.id === item.characterId); if (!contact) continue
    await db.transaction('rw', [db.scheduleConstraints, db.messages], async () => { await db.messages.add(systemMessage(item.conversationId, { kind: 'scheduleRestored', contactId: contact.id, contactName: displayName(contact), startDay: item.startDay, endDay: item.endDay, state: 'restored' })); await db.scheduleConstraints.update(item.id, { expiredNotified: true }) })
  }
}

export function validRange(startDay: number, endDay: number, currentDay: number): boolean { return Number.isInteger(startDay) && Number.isInteger(endDay) && startDay >= currentDay && endDay >= startDay }

export async function commitOutfitProposal(conversationId: string, proposal: { characterId: string; worldVersion: number; patch: Record<string, string>; sourceEventIds: string[]; reason: string; accepted?: boolean; startDay?: number; endDay?: number; slots?: TimeSlot[] }): Promise<void> {
  const world = await db.worldState.get('global')
  const startDay = proposal.startDay ?? world?.day ?? 0, endDay = proposal.endDay ?? startDay
  if (!world || proposal.worldVersion !== world.worldVersion || proposal.accepted !== true || !proposal.sourceEventIds.length || !validRange(startDay, endDay, world.day)) throw new Error('衣着约束缺少明确同意、真实来源或有效时间范围')
  const allowed = new Set(['head', 'top', 'bottom', 'outerwear', 'footwear', 'accessories'])
  const patch = Object.fromEntries(Object.entries(proposal.patch).filter(([key, value]) => allowed.has(key) && typeof value === 'string' && value.trim()).map(([key, value]) => [key, value.trim().slice(0, 80)]))
  if (!Object.keys(patch).length) throw new Error('衣着约束没有有效变更部位')
  await addOutfitConstraint({ characterId: proposal.characterId, startDay, endDay, slots: proposal.slots, patch, sourceEventIds: proposal.sourceEventIds, reason: proposal.reason.trim().slice(0, 160), conversationId })
}

export async function commitScheduleProposal(conversationId: string, proposal: { characterId: string; worldVersion: number; startDay: number; endDay: number; slots?: TimeSlot[]; locationId: string; activity: string; phoneAccess: 'available' | 'unavailable'; priority: 'override' | 'commitment'; sourceEventIds: string[]; reason: string; accepted?: boolean }): Promise<void> {
  const world = await db.worldState.get('global')
  if (!world || proposal.worldVersion !== world.worldVersion || proposal.accepted !== true || !proposal.sourceEventIds.length || !validRange(proposal.startDay, proposal.endDay, world.day) || !proposal.activity.trim() || !await isLeafLocation(proposal.locationId)) throw new Error('日程约束缺少明确同意、真实来源、合法地点或有效时间范围')
  await addScheduleConstraint({ ...proposal, activity: proposal.activity.trim().slice(0, 120), reason: proposal.reason.trim().slice(0, 160), slots: proposal.slots, conversationId })
}
