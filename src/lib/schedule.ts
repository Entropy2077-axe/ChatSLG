import { db } from '../db/db'
import { ensureWorldInitialized, resolveSchedule } from './world'
import { resolveScheduleConstraint } from './temporaryConstraints'

/** Runtime schedule authority. All scheduling is resolved from the fictional
 * world day and one of its four time slots; legacy Contact.schedule fields are
 * intentionally never consulted. */
export async function currentWorldSchedule(contactId: string) {
  const world = await ensureWorldInitialized()
  const [schedules, constraints] = await Promise.all([
    db.characterSchedules.where('characterId').equals(contactId).toArray(),
    db.scheduleConstraints.where('characterId').equals(contactId).toArray(),
  ])
  const constraint = resolveScheduleConstraint(constraints, world.day, world.slot)
  if (constraint) return {
    world,
    schedule: {
      ...constraint,
      id: constraint.id,
      characterId: contactId,
      effectiveDay: world.day,
      slot: world.slot,
      sourceEventIds: constraint.sourceEventIds,
      createdAt: constraint.createdAt,
    },
  }
  return { world, schedule: resolveSchedule(schedules, world.day, world.slot) }
}

export async function isWorldPhoneAvailable(contactId: string): Promise<boolean> {
  const { schedule } = await currentWorldSchedule(contactId)
  return schedule?.phoneAccess !== 'unavailable'
}

export async function describeCurrentWorldSchedule(contactId: string): Promise<string> {
  const { schedule } = await currentWorldSchedule(contactId)
  return schedule ? `现在在${schedule.activity}` : ''
}
