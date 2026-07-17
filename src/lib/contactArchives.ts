import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type { ContactArchiveSnapshot, TimeSlot, WorldState } from '../types'

const MAX_SNAPSHOTS_PER_CONTACT = 120

type ArchiveClock = Pick<WorldState, 'worldVersion' | 'step' | 'day' | 'slot'>

export async function archiveContactSnapshot(
  contactId: string,
  clock: ArchiveClock,
  reason: ContactArchiveSnapshot['reason'],
): Promise<void> {
  const [contact, schedules, memories, lifeState] = await Promise.all([
    db.contacts.get(contactId),
    db.characterSchedules.where('characterId').equals(contactId).toArray(),
    db.contactMemories.where('contactId').equals(contactId).toArray(),
    db.contactLifeStates.get(contactId),
  ])
  if (!contact) return

  const existing = await db.contactArchives
    .where('[contactId+worldStep]')
    .equals([contactId, clock.step])
    .first()
  const row: ContactArchiveSnapshot = {
    id: existing?.id ?? uuid(),
    contactId,
    worldVersion: clock.worldVersion,
    worldStep: clock.step,
    worldDay: clock.day,
    worldSlot: clock.slot as TimeSlot,
    reason,
    createdAt: Date.now(),
    snapshot: structuredClone({ contact, schedules, memories, lifeState }),
  }
  await db.contactArchives.put(row)

  const all = await db.contactArchives.where('contactId').equals(contactId).sortBy('worldStep')
  if (all.length > MAX_SNAPSHOTS_PER_CONTACT) {
    await db.contactArchives.bulkDelete(all.slice(0, all.length - MAX_SNAPSHOTS_PER_CONTACT).map((item) => item.id))
  }
}

export async function archiveContactsForTimeSlice(clock: ArchiveClock): Promise<void> {
  const ids = await db.contacts.toCollection().primaryKeys()
  for (const contactId of ids) {
    await archiveContactSnapshot(String(contactId), clock, 'time_slice')
  }
}

