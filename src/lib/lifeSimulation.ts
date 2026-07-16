import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type { Contact, ContactLifeState, LifeEvent, LifeEventType, TimeSlot, WorldState } from '../types'
import { ensureWorldInitialized } from './world'
import { weatherForWorld, type WorldWeatherSnapshot } from './worldWeather'

let running: Promise<void> | null = null

type WorldClock = Pick<WorldState, 'day' | 'slot' | 'step'>

export function lifeEventTypeForActivity(activity: string, slot: TimeSlot): LifeEventType {
  if (/上班|工作|值班|开会|授课|上课|营业|接诊|研究|拍摄|采访/.test(activity)) return 'work'
  if (/聚会|约会|见面|聊天|逛|散步|吃饭|娱乐|运动/.test(activity)) return 'social'
  if (slot === 'night' || /睡|休息|洗漱|放松/.test(activity)) return 'routine'
  return 'routine'
}

function nextLifeState(
  contact: Contact,
  current: ContactLifeState | undefined,
  event: LifeEvent,
  location: string,
  weather: WorldWeatherSnapshot,
): ContactLifeState {
  const resting = event.type === 'routine' && event.worldSlot === 'night'
  const outdoorActivity = /户外|散步|跑步|登山|露营|操场|农田|海边|河边/.test(event.details ?? '')
  const severeWeather = weather.kind === 'thunderstorm' || weather.kind === 'heavySnow'
  const energyDelta = (resting ? 12 : event.type === 'work' ? -10 : event.type === 'social' ? -4 : -2) - (outdoorActivity && severeWeather ? 3 : 0)
  const stressDelta = (resting ? -8 : event.type === 'work' ? 7 : event.type === 'social' ? -3 : -1) + (outdoorActivity && severeWeather ? 2 : 0)
  const socialDelta = event.type === 'social' ? -10 : 3
  return {
    contactId: contact.id,
    location,
    activity: event.details || event.type,
    energy: Math.max(0, Math.min(100, (current?.energy ?? 65) + energyDelta)),
    stress: Math.max(0, Math.min(100, (current?.stress ?? 25) + stressDelta)),
    socialNeed: Math.max(0, Math.min(100, (current?.socialNeed ?? 45) + socialDelta)),
    currentGoal: current?.currentGoal || (contact.occupation ? '维持自己的生活节奏' : '处理好最近的日常'),
    situation: event.summary,
    updatedAt: event.occurredAt,
    worldDay: event.worldDay,
    worldSlot: event.worldSlot,
    worldStep: event.worldStep,
    weatherLabel: event.weatherLabel,
  }
}

/** Mirrors the already-validated character diaries from one world turn into
 * the life-state tables. It never advances from device time and is idempotent
 * by world step. */
export async function settleLifeSimulationForWorldTurn(clock: WorldClock): Promise<void> {
  if (running) return running.then(() => settleLifeSimulationForWorldTurn(clock))
  running = (async () => {
    const state = await db.simulationState.get('global')
    if ((state?.lastWorldStep ?? -1) >= clock.step) return
    const afterStep = state?.lastWorldStep ?? -1

    const [diaries, contacts, locations, existingEvents, lifeStates, worldMap] = await Promise.all([
      db.characterDiaries.where('worldStep').above(afterStep).filter((diary) => diary.worldStep <= clock.step).sortBy('worldStep'),
      db.contacts.toArray(),
      db.locations.toArray(),
      db.lifeEvents.filter((event) => event.worldStep !== undefined && event.worldStep > afterStep && event.worldStep <= clock.step).toArray(),
      db.contactLifeStates.toArray(),
      db.worldMaps.get('active'),
    ])
    const contactById = new Map(contacts.map((contact) => [contact.id, contact]))
    const locationNames = new Map(locations.map((location) => [location.id, location.name]))
    const stateByContact = new Map(lifeStates.map((item) => [item.contactId, item]))
    const existingKeys = new Set(existingEvents.map((event) => `${event.contactId}:${event.worldStep}`))
    const now = Date.now()
    const newEvents: LifeEvent[] = []
    const nextStates = new Map<string, ContactLifeState>()

    for (const [index, diary] of diaries.entries()) {
      if (existingKeys.has(`${diary.characterId}:${diary.worldStep}`)) continue
      const contact = contactById.get(diary.characterId)
      if (!contact) continue
      const type = lifeEventTypeForActivity(diary.activity, diary.slot)
      const weather = weatherForWorld(worldMap?.seed ?? 'default-world', diary.day, diary.slot)
      const event: LifeEvent = {
        id: uuid(),
        contactId: diary.characterId,
        type,
        summary: diary.content,
        details: diary.activity,
        participantContactIds: [],
        visibility: type === 'social' ? 'related' : 'private',
        importance: type === 'social' ? 2 : 1,
        occurredAt: now + index,
        worldDay: diary.day,
        worldSlot: diary.slot,
        worldStep: diary.worldStep,
        expiresWorldDay: diary.day + 14,
        weatherLabel: `${weather.label} · 体感${weather.temperature}`,
      }
      newEvents.push(event)
      const nextState = nextLifeState(contact, stateByContact.get(contact.id), event, locationNames.get(diary.locationId) ?? diary.locationId, weather)
      nextStates.set(contact.id, nextState)
      stateByContact.set(contact.id, nextState)
    }

    await db.transaction('rw', db.lifeEvents, db.contactLifeStates, db.simulationState, async () => {
      if (newEvents.length) await db.lifeEvents.bulkAdd(newEvents)
      if (nextStates.size) await db.contactLifeStates.bulkPut([...nextStates.values()])
      const expired = await db.lifeEvents.filter((event) => event.expiresWorldDay !== undefined && event.expiresWorldDay < clock.day).toArray()
      if (expired.length) await db.lifeEvents.bulkDelete(expired.map((event) => event.id))
      await db.simulationState.put({
        id: 'global',
        lastWorldStep: clock.step,
        lastWorldDay: clock.day,
        lastWorldSlot: clock.slot,
        seed: state?.seed || uuid(),
        version: 2,
        lastStatus: `世界第${clock.day}天/${clock.slot}结算 ${newEvents.length} 条生活事件`,
      })
    })
  })().finally(() => { running = null })
  return running
}

/** Backward-compatible manual entry point: settle only the current world step. */
export async function runLifeSimulation(): Promise<void> {
  const world = await ensureWorldInitialized()
  await settleLifeSimulationForWorldTurn(world)
}
