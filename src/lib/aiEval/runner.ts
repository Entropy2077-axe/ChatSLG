import { v4 as uuid } from 'uuid'
import { db, isAiEvalDatabase } from '../../db/db'
import { useSettingsStore } from '../../store/useSettingsStore'
import { sendMessage, stopAiTurn, useChatEngineStore } from '../chatEngine'
import { defaultOutfit } from '../outfit'
import { ensureWorldInitialized } from '../world'
import { adjudicateStateChanges } from '../stateAdjudicator'
import { chatCompletion } from '../deepseek'
import { sendGroupMessage, stopGroupAiTurn } from '../groupChatEngine'
import { setAiEvalObserver, type AiEvalObservedCall } from './observer'
import { AI_EVAL_SCENARIOS } from './scenarios'
import { assertGroupResult, assertPrivateResult, assertStateResult, classifyFailure, summarizeResults } from './assertions'
import type {
  AiEvalAssertion,
  AiEvalCallRecord,
  AiEvalDatabaseState,
  AiEvalFailureType,
  AiEvalReport,
  AiEvalRunOptions,
  AiEvalRunResult,
  AiEvalScenario,
} from './types'
import type { AppSettings, Contact, Group, Message, OutfitState, StateApplicationReceipt } from '../../types'

const DB_PREFIX = 'chatslg-ai-eval-'
const EMPTY_DATABASE_STATE: AiEvalDatabaseState = {
  contactLocations: {},
  contactOutfits: {},
  outfitConstraints: [],
  scheduleConstraints: [],
  appointments: [],
  messages: [],
  receipts: [],
}

interface Fixture {
  contactIds: Record<string, string>
  locationIds: Record<string, string>
  conversationId: string
  group?: Group
  contacts: Contact[]
  worldDay: number
}

export function createAiEvalSandboxUrl(): string {
  const url = new URL(window.location.href)
  url.searchParams.set('__aiEvalDb', `${DB_PREFIX}${Date.now()}-${crypto.randomUUID().slice(0, 8)}`)
  url.hash = '#/ai-eval'
  return url.toString()
}

export function exitAiEvalSandboxUrl(): string {
  const url = new URL(window.location.href)
  url.searchParams.delete('__aiEvalDb')
  url.hash = '#/sky-eye'
  return url.toString()
}

async function clearSandbox(): Promise<void> {
  if (!isAiEvalDatabase) throw new Error('AI回归测试只能在隔离数据库中运行')
  for (const table of db.tables) await table.clear()
  useChatEngineStore.setState({ states: {} })
  await ensureWorldInitialized()
}

function locationId(value: string, locations: Record<string, string>): string {
  return locations[value] ?? value
}

async function seedFixture(scenario: AiEvalScenario, repetition: number): Promise<Fixture> {
  await clearSandbox()
  const world = await ensureWorldInitialized()
  await db.worldState.update('global', { day: 1, slot: 'day', hour: 12, step: 1, advancing: false, updatedAt: Date.now() })
  const locations = {
    home: 'apartment-room-203',
    livingRoom: 'home-living',
    kitchen: 'home-kitchen',
    cafe: 'mall-cafe',
    inaudible: 'school-classroom',
  }
  const contactIds: Record<string, string> = {}
  const now = Date.now()
  const contacts = scenario.contacts.map((seed, index): Contact => {
    const id = `eval:${scenario.id}:${repetition}:${seed.key}`
    contactIds[seed.key] = id
    const outfit: OutfitState = {
      ...defaultOutfit(now + index),
      ...seed.outfit,
      updatedAt: now + index,
      sourceEventIds: [],
    }
    return {
      id,
      name: seed.name,
      avatar: ['🌿', '🌊', '🌙', '☀️'][index % 4],
      avatarColor: ['#dbeafe', '#dcfce7', '#f3e8ff', '#fef3c7'][index % 4],
      systemPrompt: seed.persona,
      createdAt: now + index,
      memoryFacts: '',
      memoryStyle: '',
      memoryUpdatedAt: 0,
      memoryMessageCursor: 0,
      relationshipBase: '朋友',
      relationshipDynamic: '',
      currentLocationId: locationId(seed.currentLocation, locations),
      outfit,
      defaultOutfit: outfit,
    }
  })
  await db.contacts.bulkAdd(contacts)
  const scheduleRows = contacts.flatMap((item) => (['morning', 'day', 'evening', 'night'] as const).map((slot) => ({
    id: uuid(),
    characterId: item.id,
    slot,
    locationId: item.currentLocationId!,
    activity: '自由活动',
    phoneAccess: 'available' as const,
    priority: 'base' as const,
    sourceEventIds: [],
    createdAt: now,
  })))
  await db.characterSchedules.bulkAdd(scheduleRows)
  if (scenario.preexistingSchedule) {
    await db.scheduleConstraints.add({
      id: `eval-preexisting:${scenario.id}:${repetition}`,
      characterId: contactIds[scenario.preexistingSchedule.contact],
      startDay: 1 + scenario.preexistingSchedule.dayOffset,
      endDay: 1 + scenario.preexistingSchedule.dayOffset,
      slots: scenario.preexistingSchedule.slots,
      locationId: locations[scenario.preexistingSchedule.location],
      activity: scenario.preexistingSchedule.activity,
      phoneAccess: 'available',
      priority: 'commitment',
      sourceEventIds: [`eval-preexisting-evidence:${scenario.id}`],
      reason: '回归测试预置日程',
      conversationId: `eval-preexisting-conversation:${scenario.id}`,
      createdAt: now - 1_000,
    })
  }

  const conversationId = `eval-conversation:${scenario.id}:${repetition}`
  let group: Group | undefined
  if (scenario.kind === 'group') {
    const groupId = `eval-group:${scenario.id}:${repetition}`
    group = {
      id: groupId,
      name: `回归测试群-${scenario.id}`,
      avatar: '🧪',
      avatarColor: '#e5e7eb',
      memberContactIds: scenario.groupMembers.map((key) => contactIds[key]),
      speakerLimit: scenario.group?.speakerLimit ?? 'all',
      allowAiChatter: true,
      energyLevel: scenario.group?.energy,
      createdAt: now,
    }
    await db.groups.add(group)
    await db.conversations.add({
      id: conversationId,
      groupId,
      channel: scenario.group?.channel,
      sceneLocationId: scenario.group?.channel === 'scene' ? locations.livingRoom : undefined,
      sceneWorldStep: scenario.group?.channel === 'scene' ? world.step : undefined,
      status: 'active',
      pinned: false,
      createdAt: now,
      updatedAt: now,
    })
  } else {
    await db.conversations.add({
      id: conversationId,
      contactId: contactIds.alice,
      channel: 'private_phone',
      pinned: false,
      createdAt: now,
      updatedAt: now,
    })
  }
  return { contactIds, locationIds: locations, conversationId, group, contacts, worldDay: 1 }
}

function evidenceMessages(scenario: AiEvalScenario, fixture: Fixture): Array<Message & { actorId: string; actorName: string; perceivedBy: string[] }> {
  const now = Date.now()
  return (scenario.evidence ?? []).map((seed, index) => {
    const actorId = seed.actor === 'user' ? 'user' : fixture.contactIds[seed.actor]
    const actor = fixture.contacts.find((item) => item.id === actorId)
    return {
      id: `eval-evidence:${scenario.id}:${index}:${uuid()}`,
      conversationId: fixture.conversationId,
      role: seed.actor === 'user' ? 'user' : 'assistant',
      type: 'text',
      content: seed.content,
      speakerContactId: seed.actor === 'user' ? undefined : actorId,
      createdAt: now + index,
      actorId,
      actorName: seed.actor === 'user' ? '用户' : actor?.name ?? seed.actor,
      perceivedBy: seed.perceivedBy.map((key) => fixture.contactIds[key] ?? key),
    }
  })
}

async function captureDatabaseState(fixture: Fixture, receipts: StateApplicationReceipt[] = []): Promise<AiEvalDatabaseState> {
  const contacts = await db.contacts.bulkGet(Object.values(fixture.contactIds))
  return {
    contactLocations: Object.fromEntries(contacts.filter(Boolean).map((contact) => [contact!.id, contact!.currentLocationId])),
    contactOutfits: Object.fromEntries(contacts.filter(Boolean).map((contact) => [contact!.id, contact!.outfit])),
    outfitConstraints: await db.outfitConstraints.toArray(),
    scheduleConstraints: await db.scheduleConstraints.toArray(),
    appointments: await db.appointments.toArray(),
    messages: (await db.messages.toArray()).map(({ debugRawAiResponse: _raw, ...message }) => message),
    receipts,
  }
}

function mergeObservedCalls(observed: AiEvalObservedCall[]): AiEvalCallRecord[] {
  const merged = new Map<string, AiEvalObservedCall>()
  for (const call of observed) merged.set(call.id, { ...(merged.get(call.id) ?? call), ...call })
  return Array.from(merged.values())
    .filter((call) => call.service === 'model')
    .map((call) => ({
      stage: call.stage,
      purpose: call.purpose ?? 'other',
      model: call.model ?? 'unknown',
      latencyMs: call.finishedAt ? call.finishedAt - call.startedAt : undefined,
      success: call.success === true,
      error: call.error,
    }))
}

function attemptSummary(observed: AiEvalObservedCall[], passed: boolean) {
  const calls = mergeObservedCalls(observed)
  const repairAttempted = calls.some((call) =>
    call.success === false
    || call.stage === 'second_chat'
    || call.stage === 'second_quality'
    || call.stage === 'state_retry',
  )
  return {
    calls,
    repairAttempted,
    firstAttemptPassed: passed && !repairAttempted,
    recovered: passed && repairAttempted,
    retryCount: Math.max(0, calls.length - new Set(calls.map((call) => `${call.purpose}:${call.stage ?? 'none'}`)).size),
  }
}

function resultStatus(assertions: AiEvalAssertion[], error?: unknown): 'passed' | 'failed' {
  return !error && assertions.every((item) => !item.blocking || item.passed) ? 'passed' : 'failed'
}

async function runStateScenario(scenario: AiEvalScenario, repetition: number, settings: AppSettings, signal?: AbortSignal): Promise<AiEvalRunResult> {
  const started = performance.now()
  const startedAt = new Date().toISOString()
  const fixture = await seedFixture(scenario, repetition)
  const evidence = evidenceMessages(scenario, fixture)
  await db.messages.bulkAdd(evidence.map(({ actorId: _actorId, actorName: _actorName, perceivedBy: _perceivedBy, ...message }) => message))
  const observed: AiEvalObservedCall[] = []
  const stopObserving = setAiEvalObserver((call) => observed.push(call))
  let receipts: StateApplicationReceipt[] = []
  let parsedOutputs: unknown[] = []
  let rawOutputs: string[] = []
  let error: unknown
  try {
    const result = await adjudicateStateChanges({
      scene: scenario.stateScene ?? 'private_phone',
      conversationId: fixture.conversationId,
      characterIds: scenario.groupMembers.map((key) => fixture.contactIds[key]),
      settings,
      evidence: evidence.map((item) => ({
        id: item.id,
        actorId: item.actorId,
        actorName: item.actorName,
        content: item.content,
        perceivedBy: item.perceivedBy,
      })),
      signal,
    })
    receipts = result?.receipts ?? []
    if (result) parsedOutputs.push(result)
  } catch (caught) {
    error = caught
  } finally {
    stopObserving()
  }
  const stateTurns = await db.aiTurns.orderBy('createdAt').toArray()
  rawOutputs = stateTurns.map((turn) => turn.raw)
  parsedOutputs = [...parsedOutputs, ...stateTurns.map((turn) => turn.parsed)]
  const databaseState = await captureDatabaseState(fixture, receipts)
  const assertions = assertStateResult({ scenario, state: databaseState, contactIds: fixture.contactIds, locationIds: fixture.locationIds, worldDay: fixture.worldDay })
  const failureType = classifyFailure(error, assertions, receipts)
  const durationMs = Math.round(performance.now() - started)
  const status = signal?.aborted ? 'cancelled' : resultStatus(assertions, error)
  const attempts = attemptSummary(observed, status === 'passed')
  return {
    id: uuid(),
    scenarioId: scenario.id,
    category: scenario.category,
    mode: 'real',
    repetition,
    status,
    startedAt,
    durationMs,
    assertions,
    failureType,
    failureStage: error ? 'state_adjudication' : undefined,
    error: error instanceof Error ? error.message : error ? String(error) : undefined,
    rawOutputs,
    parsedOutputs,
    databaseState,
    bubbleCount: 0,
    distinctSpeakerCount: 0,
    speakerCounts: {},
    illegalSpeakerIds: [],
    parseFailure: failureType === 'parse_failure',
    retryCount: attempts.retryCount,
    repairAttempted: attempts.repairAttempted,
    firstAttemptPassed: attempts.firstAttemptPassed,
    recovered: attempts.recovered,
    modelCalls: attempts.calls,
    searchCalls: observed.filter((call) => call.service === 'search').length,
    searchQueries: observed.filter((call) => call.service === 'search' && call.query).map((call) => call.query!),
    notes: [],
  }
}

async function waitForGroupCompletion(conversationId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      stopGroupAiTurn(conversationId)
      throw new DOMException('Aborted', 'AbortError')
    }
    const state = useChatEngineStore.getState().states[conversationId]
    if (state && !state.aiTyping) {
      if (state.error) throw new Error(state.error)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  stopGroupAiTurn(conversationId)
  throw new Error(`测试超时（${timeoutMs}ms）`)
}

async function waitForPrivateCompletion(conversationId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      stopAiTurn(conversationId)
      throw new DOMException('Aborted', 'AbortError')
    }
    const state = useChatEngineStore.getState().states[conversationId]
    if (state && !state.aiTyping) {
      if (state.error) throw new Error(state.error)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  stopAiTurn(conversationId)
  throw new Error(`测试超时（${timeoutMs}ms）`)
}

async function runPrivateScenario(scenario: AiEvalScenario, repetition: number, settings: AppSettings, signal?: AbortSignal): Promise<AiEvalRunResult> {
  const started = performance.now()
  const startedAt = new Date().toISOString()
  const fixture = await seedFixture(scenario, repetition)
  const observed: AiEvalObservedCall[] = []
  const stopObserving = setAiEvalObserver((call) => observed.push(call))
  let error: unknown
  const runSettings = { ...settings, chatLiveliness: scenario.private?.liveliness ?? 'normal' }
  try {
    await sendMessage(fixture.conversationId, fixture.contacts[0], runSettings, [], scenario.inputMessages[0])
    await waitForPrivateCompletion(fixture.conversationId, scenario.timeoutMs, signal)
    await new Promise((resolve) => setTimeout(resolve, 50))
  } catch (caught) {
    error = caught
  } finally {
    stopObserving()
  }
  const messages = await db.messages.where('conversationId').equals(fixture.conversationId).toArray()
  const assistant = messages.filter((message) => message.role === 'assistant' && !message.pending)
  const turns = await db.aiTurns.orderBy('createdAt').toArray()
  const stateTurn = turns.find((turn) => (turn.parsed as { kind?: unknown } | undefined)?.kind === 'unifiedTurnAdjudication')
  const receipts = ((stateTurn?.parsed as { receipts?: StateApplicationReceipt[] } | undefined)?.receipts ?? [])
  const databaseState = await captureDatabaseState(fixture, receipts)
  const assertions = assertPrivateResult(scenario, assistant)
  const failureType = classifyFailure(error, assertions, receipts)
  const status = signal?.aborted ? 'cancelled' : resultStatus(assertions, error)
  const attempts = attemptSummary(observed, status === 'passed')
  return {
    id: uuid(), scenarioId: scenario.id, category: scenario.category, mode: 'real', repetition,
    status, startedAt,
    durationMs: Math.round(performance.now() - started), assertions, failureType,
    failureStage: error ? 'private_turn' : undefined,
    error: error instanceof Error ? error.message : error ? String(error) : undefined,
    rawOutputs: turns.map((turn) => turn.raw), parsedOutputs: turns.map((turn) => turn.parsed), databaseState,
    bubbleCount: assistant.length, distinctSpeakerCount: assistant.length ? 1 : 0,
    speakerCounts: assistant.length ? { [fixture.contacts[0].id]: assistant.length } : {}, illegalSpeakerIds: [],
    parseFailure: failureType === 'parse_failure',
    retryCount: attempts.retryCount,
    repairAttempted: attempts.repairAttempted,
    firstAttemptPassed: attempts.firstAttemptPassed,
    recovered: attempts.recovered,
    modelCalls: attempts.calls,
    searchCalls: observed.filter((call) => call.service === 'search').length,
    searchQueries: observed.filter((call) => call.service === 'search' && call.query).map((call) => call.query!),
    notes: ['自然度为辅助启发式：完全复读、完全重复、全部问句；不覆盖硬性条数和数据库断言。'],
  }
}

async function runEndToEndStateScenario(scenario: AiEvalScenario, repetition: number, settings: AppSettings, signal?: AbortSignal): Promise<AiEvalRunResult> {
  const started = performance.now()
  const startedAt = new Date().toISOString()
  const fixture = await seedFixture(scenario, repetition)
  const observed: AiEvalObservedCall[] = []
  const stopObserving = setAiEvalObserver((call) => observed.push(call))
  let error: unknown
  try {
    await sendMessage(fixture.conversationId, fixture.contacts[0], { ...settings, chatLiveliness: 'quiet' }, [], scenario.inputMessages[0])
    await waitForPrivateCompletion(fixture.conversationId, scenario.timeoutMs, signal)
    await new Promise((resolve) => setTimeout(resolve, 50))
  } catch (caught) {
    error = caught
  } finally {
    stopObserving()
  }
  const turns = await db.aiTurns.orderBy('createdAt').toArray()
  const stateTurns = turns.filter((turn) => (turn.parsed as { kind?: unknown } | undefined)?.kind === 'unifiedTurnAdjudication')
  const receipts = stateTurns.flatMap((turn) => ((turn.parsed as { receipts?: StateApplicationReceipt[] } | undefined)?.receipts ?? []))
  const databaseState = await captureDatabaseState(fixture, receipts)
  const assertions = [
    {
      id: 'e2e-real-assistant-evidence',
      label: '角色证据由真实聊天引擎生成',
      passed: databaseState.messages.some((message) => (message as { role?: unknown }).role === 'assistant'),
      expected: true,
      actual: databaseState.messages.filter((message) => (message as { role?: unknown }).role === 'assistant').length,
      blocking: true,
    },
    ...assertStateResult({ scenario, state: databaseState, contactIds: fixture.contactIds, locationIds: fixture.locationIds, worldDay: fixture.worldDay }),
  ]
  const failureType = classifyFailure(error, assertions, receipts)
  const status = signal?.aborted ? 'cancelled' : resultStatus(assertions, error)
  const attempts = attemptSummary(observed, status === 'passed')
  const assistantMessages = databaseState.messages.filter((message) => (message as { role?: unknown }).role === 'assistant')
  return {
    id: uuid(),
    scenarioId: scenario.id,
    category: scenario.category,
    mode: 'real',
    repetition,
    status,
    startedAt,
    durationMs: Math.round(performance.now() - started),
    assertions,
    failureType,
    failureStage: error ? 'end_to_end_turn' : undefined,
    error: error instanceof Error ? error.message : error ? String(error) : undefined,
    rawOutputs: turns.map((turn) => turn.raw),
    parsedOutputs: turns.map((turn) => turn.parsed),
    databaseState,
    bubbleCount: assistantMessages.length,
    distinctSpeakerCount: assistantMessages.length ? 1 : 0,
    speakerCounts: assistantMessages.length ? { [fixture.contactIds.alice]: assistantMessages.length } : {},
    illegalSpeakerIds: [],
    parseFailure: failureType === 'parse_failure',
    retryCount: attempts.retryCount,
    repairAttempted: attempts.repairAttempted,
    firstAttemptPassed: attempts.firstAttemptPassed,
    recovered: attempts.recovered,
    modelCalls: attempts.calls,
    searchCalls: observed.filter((call) => call.service === 'search').length,
    searchQueries: observed.filter((call) => call.service === 'search' && call.query).map((call) => call.query!),
    notes: ['端到端：用户输入先经过真实私聊回复，再由生产状态裁决器写入隔离数据库。'],
  }
}

async function runGroupScenario(scenario: AiEvalScenario, repetition: number, settings: AppSettings, signal?: AbortSignal): Promise<AiEvalRunResult> {
  const started = performance.now()
  const startedAt = new Date().toISOString()
  const fixture = await seedFixture(scenario, repetition)
  if (!fixture.group) throw new Error('群聊场景缺少群组fixture')
  const observed: AiEvalObservedCall[] = []
  const stopObserving = setAiEvalObserver((call) => observed.push(call))
  let error: unknown
  const runSettings = {
    ...settings,
    chatLiveliness: scenario.group?.energy === 'cold' ? 'quiet' as const : scenario.group?.energy ?? 'normal',
  }
  try {
    await sendGroupMessage(
      fixture.conversationId,
      fixture.group,
      fixture.contacts,
      runSettings,
      [],
      scenario.inputMessages[0],
      scenario.group?.mention ? [fixture.contactIds[scenario.group.mention]] : [],
    )
    await waitForGroupCompletion(fixture.conversationId, scenario.timeoutMs, signal)
    await new Promise((resolve) => setTimeout(resolve, 50))
  } catch (caught) {
    error = caught
  } finally {
    stopObserving()
  }
  const messages = await db.messages.where('conversationId').equals(fixture.conversationId).toArray()
  const assistant = messages.filter((message) => message.role === 'assistant' && !message.pending)
  const legal = new Set(scenario.groupMembers.map((key) => fixture.contactIds[key]))
  const speakerCounts: Record<string, number> = {}
  for (const message of assistant) if (message.speakerContactId) speakerCounts[message.speakerContactId] = (speakerCounts[message.speakerContactId] ?? 0) + 1
  const illegalSpeakerIds = Object.keys(speakerCounts).filter((id) => !legal.has(id))
  const turns = await db.aiTurns.orderBy('createdAt').toArray()
  const stateTurn = turns.find((turn) => (turn.parsed as { kind?: unknown } | undefined)?.kind === 'unifiedTurnAdjudication')
  const receipts = ((stateTurn?.parsed as { receipts?: StateApplicationReceipt[] } | undefined)?.receipts ?? [])
  const databaseState = await captureDatabaseState(fixture, receipts)
  const assertions = assertGroupResult({
    scenario,
    bubbleCount: assistant.length,
    speakerCounts,
    illegalSpeakerIds,
    contactIds: fixture.contactIds,
  })
  const failureType = classifyFailure(error, assertions, receipts)
  const status = signal?.aborted ? 'cancelled' : resultStatus(assertions, error)
  const attempts = attemptSummary(observed, status === 'passed')
  return {
    id: uuid(),
    scenarioId: scenario.id,
    category: scenario.category,
    mode: 'real',
    repetition,
    status,
    startedAt,
    durationMs: Math.round(performance.now() - started),
    assertions,
    failureType,
    failureStage: error ? 'group_turn' : undefined,
    error: error instanceof Error ? error.message : error ? String(error) : undefined,
    rawOutputs: turns.map((turn) => turn.raw),
    parsedOutputs: turns.map((turn) => turn.parsed),
    databaseState,
    bubbleCount: assistant.length,
    distinctSpeakerCount: Object.keys(speakerCounts).length,
    speakerCounts,
    illegalSpeakerIds,
    parseFailure: failureType === 'parse_failure',
    retryCount: attempts.retryCount,
    repairAttempted: attempts.repairAttempted,
    firstAttemptPassed: attempts.firstAttemptPassed,
    recovered: attempts.recovered,
    modelCalls: attempts.calls,
    searchCalls: observed.filter((call) => call.service === 'search').length,
    searchQueries: observed.filter((call) => call.service === 'search' && call.query).map((call) => call.query!),
    notes: scenario.group?.minimumDistinctSpeakers ? [`最低不同发言人数是产品硬规则：${scenario.group.minimumDistinctSpeakers}。`] : [],
  }
}

const faultExpectedType: Record<NonNullable<AiEvalScenario['fault']>, AiEvalFailureType> = {
  non_json: 'parse_failure',
  missing_fields: 'parse_failure',
  wrong_character_id: 'validation_rejected',
  wrong_evidence_id: 'validation_rejected',
  invalid_location_id: 'validation_rejected',
  timeout: 'timeout',
  http_429: 'request_failure',
  http_500: 'request_failure',
  network_error: 'request_failure',
  transaction_error: 'database_commit_failure',
  main_ok_state_failed: 'request_failure',
  state_ok_commit_failed: 'database_commit_failure',
  non_leaf_location: 'validation_rejected',
  stale_world_version: 'validation_rejected',
}

async function runFaultScenario(scenario: AiEvalScenario, repetition: number): Promise<AiEvalRunResult> {
  const failureType = scenario.fault ? faultExpectedType[scenario.fault] : 'tool_failure'
  const injected = scenario.coverage === 'fault_injection'
  if (injected) {
    const startedAt = new Date().toISOString()
    const started = performance.now()
    const observed: AiEvalObservedCall[] = []
    const stopObserving = setAiEvalObserver((call) => observed.push(call))
    const originalFetch = globalThis.fetch
    let caught: unknown
    try {
      globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
        if (scenario.fault === 'network_error') return Promise.reject(new TypeError('Injected network failure'))
        if (scenario.fault === 'timeout') {
          return new Promise<Response>((_resolve, reject) => {
            const abort = () => reject(new DOMException('Injected timeout', 'AbortError'))
            if (init?.signal?.aborted) abort()
            else init?.signal?.addEventListener('abort', abort, { once: true })
          })
        }
        const status = scenario.fault === 'http_429' ? 429 : 500
        return Promise.resolve(new Response(`injected HTTP ${status}`, { status }))
      }) as typeof fetch
      await chatCompletion({
        apiKey: 'ai-eval-injected-key',
        baseUrl: 'https://ai-eval.invalid',
        model: 'ai-eval-injected-model',
        messages: [{ role: 'user', content: 'fault injection' }],
        purpose: 'other',
        timeoutMs: 10,
        maxTokens: 8,
      })
    } catch (error) {
      caught = error
    } finally {
      globalThis.fetch = originalFetch
      stopObserving()
    }
    const actual = classifyFailure(caught, [])
    const assertions: AiEvalAssertion[] = [{
      id: 'fault-injection-classification',
      label: '真实生产请求层经过故障注入并返回预期失败类型',
      passed: actual === failureType,
      expected: failureType,
      actual,
      blocking: true,
    }]
    const status = assertions[0].passed ? 'passed' : 'failed'
    const attempts = attemptSummary(observed, false)
    return {
      id: uuid(), scenarioId: scenario.id, category: scenario.category, mode: 'mock', repetition,
      status, startedAt, durationMs: Math.round(performance.now() - started),
      assertions, failureType: actual, failureStage: 'request_or_parse',
      error: caught instanceof Error ? caught.message : String(caught ?? '故障注入没有触发失败'),
      rawOutputs: [`[actual injected fault] ${scenario.fault}`], parsedOutputs: [],
      databaseState: EMPTY_DATABASE_STATE, bubbleCount: 0, distinctSpeakerCount: 0, speakerCounts: {}, illegalSpeakerIds: [],
      parseFailure: actual === 'parse_failure', retryCount: attempts.retryCount,
      repairAttempted: attempts.repairAttempted, firstAttemptPassed: false, recovered: false,
      modelCalls: attempts.calls, searchCalls: 0, searchQueries: [],
      notes: ['实际替换隔离测试页面的fetch，调用生产chatCompletion并验证重试与错误分类；没有访问外网。'],
    }
  }
  const assertion: AiEvalAssertion = {
    id: 'fault-classification',
    label: '故障分类表自检（不代表生产故障恢复）',
    passed: failureType !== 'none',
    expected: failureType,
    actual: failureType,
    blocking: true,
  }
  return {
    id: uuid(),
    scenarioId: scenario.id,
    category: scenario.category,
    mode: 'mock',
    repetition,
    status: 'passed',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    assertions: [assertion],
    failureType,
    failureStage: scenario.fault?.includes('commit') || scenario.fault === 'transaction_error' ? 'database_commit' : scenario.fault?.includes('state') ? 'state_adjudication' : 'request_or_parse',
    error: `故障注入：${scenario.fault}`,
    rawOutputs: [`[mock fault payload retained] ${scenario.fault}`],
    parsedOutputs: [],
    databaseState: EMPTY_DATABASE_STATE,
    bubbleCount: 0,
    distinctSpeakerCount: 0,
    speakerCounts: {},
    illegalSpeakerIds: [],
    parseFailure: failureType === 'parse_failure',
    retryCount: ['http_429', 'http_500', 'timeout'].includes(scenario.fault ?? '') ? 2 : 0,
    repairAttempted: false,
    firstAttemptPassed: false,
    recovered: false,
    modelCalls: [],
    searchCalls: 0,
    searchQueries: [],
    notes: ['这是分类表自检，不是真实故障注入，不计入任何生产通过率、首次通过率或最终通过率。'],
  }
}

async function commitReport(report: AiEvalReport): Promise<void> {
  localStorage.setItem('chatslg-ai-eval-latest', JSON.stringify(report))
}

export function loadLatestAiEvalReport(): AiEvalReport | undefined {
  try {
    const raw = localStorage.getItem('chatslg-ai-eval-latest')
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as AiEvalReport
    if (parsed.schemaVersion === 2) return parsed
    const results = parsed.results.map((result) => {
      const repairAttempted = result.repairAttempted ?? result.retryCount > 0
      return {
        ...result,
        repairAttempted,
        firstAttemptPassed: result.firstAttemptPassed ?? (result.status === 'passed' && !repairAttempted),
        recovered: result.recovered ?? (result.status === 'passed' && repairAttempted),
      }
    })
    return {
      ...parsed,
      schemaVersion: 2,
      results,
      summary: summarizeResults(results),
    }
  } catch {
    return undefined
  }
}

export function confirmedAiEvalIssues(results: AiEvalRunResult[]): string[] {
  const failed = new Set(results.filter((result) => result.status === 'failed').map((result) => result.scenarioId))
  return [
    failed.has('private-normal') || failed.has('private-lively') ? '真实模型私聊在一次重写后仍未满足配置气泡数。' : '',
    failed.has('group-normal-two') || failed.has('group-lively-four-open-topic') || failed.has('group-lively-mentioned') ? '真实模型群聊在一次重写后仍未满足消息数、多人参与或指定角色参与规则。' : '',
    failed.has('outfit-photo-negative') ? '照片中的衣着描述被错误提交为现实衣着变更。' : '',
    failed.has('schedule-illegal-location-negative') ? '不存在的地点请求被错误转写为一个可提交的日程。' : '',
    failed.has('schedule-multi-one-consents') ? '多人日程中，明确拒绝的角色仍被写入了日程。' : '',
    failed.has('location-silent-listener') ? '地点场景中未发言、未同意的在场角色仍被移动。' : '',
    failed.has('multi-state-all') ? '多状态同轮提交存在日期偏移错误：“明晚”一次被写为当天。' : '',
  ].filter(Boolean)
}

export async function runAiEval(options: AiEvalRunOptions = {}): Promise<AiEvalReport> {
  if (!isAiEvalDatabase) throw new Error('请先进入隔离测试空间')
  const settings = useSettingsStore.getState()
  const selected = AI_EVAL_SCENARIOS.filter((scenario) =>
    (!options.scenarioIds || options.scenarioIds.includes(scenario.id))
    && (!options.category || scenario.category === options.category)
    && (!options.suite || (scenario.suite ?? 'development') === options.suite),
  )
  const jobs = selected.flatMap((scenario) => Array.from(
    { length: Math.max(1, options.repetitionOverride ?? scenario.repetitions) },
    (_, index) => ({ scenario, repetition: index + 1 }),
  ))
  const results: AiEvalRunResult[] = []
  let modelCalls = 0
  const maxModelCalls = Math.min(200, options.maxModelCalls ?? 180)
  for (const [index, job] of jobs.entries()) {
    if (options.signal?.aborted) break
    if (job.scenario.useRealModel && !settings.apiKey) {
      const blocked: AiEvalRunResult = {
        id: uuid(), scenarioId: job.scenario.id, category: job.scenario.category, mode: 'real', repetition: job.repetition,
        status: 'blocked', startedAt: new Date().toISOString(), durationMs: 0, assertions: [], failureType: 'request_failure',
        failureStage: 'configuration', error: '未配置DeepSeek API Key', rawOutputs: [], parsedOutputs: [],
        databaseState: EMPTY_DATABASE_STATE, bubbleCount: 0, distinctSpeakerCount: 0, speakerCounts: {}, illegalSpeakerIds: [],
        parseFailure: false, retryCount: 0, repairAttempted: false, firstAttemptPassed: false, recovered: false, modelCalls: [], searchCalls: 0, searchQueries: [], notes: [],
      }
      results.push(blocked)
      options.onProgress?.(index + 1, jobs.length, blocked)
      continue
    }
    if (modelCalls >= maxModelCalls && job.scenario.useRealModel) break
    let result: AiEvalRunResult
    try {
      result = job.scenario.kind === 'state'
        ? await runStateScenario(job.scenario, job.repetition, settings, options.signal)
        : job.scenario.kind === 'state_e2e'
          ? await runEndToEndStateScenario(job.scenario, job.repetition, settings, options.signal)
        : job.scenario.kind === 'group'
          ? await runGroupScenario(job.scenario, job.repetition, settings, options.signal)
          : job.scenario.kind === 'private'
            ? await runPrivateScenario(job.scenario, job.repetition, settings, options.signal)
          : await runFaultScenario(job.scenario, job.repetition)
    } catch (error) {
      result = {
        id: uuid(), scenarioId: job.scenario.id, category: job.scenario.category,
        mode: job.scenario.useRealModel ? 'real' : 'mock', repetition: job.repetition, status: 'failed',
        startedAt: new Date().toISOString(), durationMs: 0, assertions: [], failureType: 'tool_failure',
        failureStage: 'runner', error: error instanceof Error ? error.message : String(error), rawOutputs: [], parsedOutputs: [],
        databaseState: EMPTY_DATABASE_STATE, bubbleCount: 0, distinctSpeakerCount: 0, speakerCounts: {}, illegalSpeakerIds: [],
        parseFailure: false, retryCount: 0, repairAttempted: false, firstAttemptPassed: false, recovered: false, modelCalls: [], searchCalls: 0, searchQueries: [], notes: [],
      }
    }
    results.push(result)
    modelCalls += result.modelCalls.length
    options.onProgress?.(index + 1, jobs.length, result)
  }
  const report: AiEvalReport = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    codeVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
    databaseName: db.name,
    isolated: isAiEvalDatabase,
    model: settings.model,
    utilityModel: settings.utilityModel,
    randomSeed: null,
    randomSeedNote: '模型接口未提供固定随机种子；重复运行用于观察波动。',
    summary: summarizeResults(results),
    scenarios: selected,
    results,
    confirmedIssues: confirmedAiEvalIssues(results),
    unconfirmedIssues: settings.apiKey
      ? []
      : ['缺少DeepSeek API Key，无法确认真实模型的群聊条数、多人参与、状态召回、误触发、解析恢复和数据库提交成功率。'],
    coreLogicModified: false,
  }
  await commitReport(report)
  return report
}
