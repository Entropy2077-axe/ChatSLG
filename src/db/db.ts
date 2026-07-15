import Dexie, { type Table } from 'dexie'
import type {
  AiTurnDebug,
  Contact,
  ContactMemory,
  ContactRelationLink,
  Conversation,
  Group,
  InventoryItem,
  Message,
  Moment,
  MomentComment,
  MomentLike,
  SavedWorldview,
  WorldbookEntry,
  SimulationState, ContactLifeState, LifeEvent, AiUsageRecord,
  SocialEvent, GroupPlan, AdminLogRecord, AdminAiTrace, SaveSlot, SavedPersona,
  WalletAccount, WalletTransaction, Loan, JobListing, InterviewSession,
  WorldState, LocationNode, AcousticEdge, CharacterSchedule, Appointment,
  WorldEvent, PerceivedEvent, CharacterDiary, PendingPhoneMessage,
  WorldMapRecord, OutfitConstraint, ScheduleConstraint,
} from '../types'

export class ChatSLGDB extends Dexie {
  contacts!: Table<Contact, string>
  conversations!: Table<Conversation, string>
  messages!: Table<Message, string>
  inventory!: Table<InventoryItem, string>
  moments!: Table<Moment, string>
  momentComments!: Table<MomentComment, string>
  momentLikes!: Table<MomentLike, string>
  contactRelations!: Table<ContactRelationLink, string>
  groups!: Table<Group, string>
  savedWorldviews!: Table<SavedWorldview, string>
  worldbookEntries!: Table<WorldbookEntry, string>
  simulationState!: Table<SimulationState, string>
  contactLifeStates!: Table<ContactLifeState, string>
  lifeEvents!: Table<LifeEvent, string>
  aiUsageRecords!: Table<AiUsageRecord, string>
  aiTurns!: Table<AiTurnDebug, string>
  socialEvents!: Table<SocialEvent, string>
  contactMemories!: Table<ContactMemory, string>
  walletAccounts!: Table<WalletAccount, string>
  walletTransactions!: Table<WalletTransaction, string>
  loans!: Table<Loan, string>
  jobListings!: Table<JobListing, string>
  interviews!: Table<InterviewSession, string>
  groupPlans!: Table<GroupPlan, string>
  adminLogs!: Table<AdminLogRecord, string>
  adminAiTraces!: Table<AdminAiTrace, string>
  saveSlots!: Table<SaveSlot, string>
  savedPersonas!: Table<SavedPersona, string>
  worldState!: Table<WorldState, string>
  locations!: Table<LocationNode, string>
  acousticEdges!: Table<AcousticEdge, string>
  characterSchedules!: Table<CharacterSchedule, string>
  appointments!: Table<Appointment, string>
  worldEvents!: Table<WorldEvent, string>
  perceivedEvents!: Table<PerceivedEvent, string>
  characterDiaries!: Table<CharacterDiary, string>
  pendingPhoneMessages!: Table<PendingPhoneMessage, string>
  worldMaps!: Table<WorldMapRecord, string>
  outfitConstraints!: Table<OutfitConstraint, string>
  scheduleConstraints!: Table<ScheduleConstraint, string>

  constructor() {
    super('chatslg-db')
    this.version(1).stores({
      contacts: 'id, name, createdAt',
      conversations: 'id, contactId, updatedAt, pinned',
      messages: 'id, conversationId, createdAt',
      stickers: 'id, &name, createdAt',
    })
    this.version(2).stores({
      locations: 'id, &name',
      tasks: 'id, contactId, date',
    })
    // Map/schedule feature was removed — drop the tables it created.
    this.version(3).stores({
      locations: null,
      tasks: null,
    })
    this.version(4).stores({
      todos: 'id, done, createdAt',
      inventory: 'id, acquiredAt',
    })
    this.version(5).stores({
      moments: 'id, contactId, createdAt',
      momentComments: 'id, momentId, authorContactId',
      momentLikes: 'id, momentId, likerId',
      contactRelations: 'id, fromContactId, toContactId',
    })
    // Group chats: conversations gain an optional groupId (mutually
    // exclusive with contactId) alongside a new groups table.
    this.version(6).stores({
      groups: 'id, createdAt',
      conversations: 'id, contactId, groupId, updatedAt, pinned',
    })
    // Knowledge base (see lib/knowledgeBase.ts). Schedule itself is NOT a
    // new table — a contact's weekly pattern/overrides are plain fields on
    // Contact (same shape as pendingEvents/upcomingPlans), unrelated to the
    // old version(2)/(3) locations+tasks map/calendar system that was
    // deleted; don't confuse the two.
    this.version(7).stores({
      knowledgeEntries: 'id, fetchedAt',
    })
    this.version(8).stores({
      savedWorldviews: 'id, createdAt',
    })
    this.version(9).stores({
      aiTurns: 'id, conversationId, createdAt',
    })
    // Commission system removed — drop the table.
    this.version(10).stores({
      commissions: null,
    })
    // 5-dimension relationship → single warmth.
    this.version(11).upgrade(async (tx) => {
      const contacts = await tx.table('contacts').toArray()
      for (const c of contacts) {
        const rel = (c as Record<string, unknown>).relationship as Record<string, number> | undefined
        if (!rel || typeof rel.affection !== 'number') continue
        const warmth = Math.round(rel.affection * 0.7 + (rel.familiarity ?? 0) * 0.3 - (rel.friction ?? 0) * 0.5 - 10)
        const clamped = Math.max(-100, Math.min(100, warmth))
        const base =
          typeof (c as Record<string, unknown>).relationshipType === 'string'
            ? (c as Record<string, unknown>).relationshipType as string
            : '朋友'
        await tx.table('contacts').update(c.id, {
          warmth: clamped,
          relationshipBase: base,
          relationshipDynamic: '',
        })
      }
    })
    this.version(12).stores({
      socialEvents: 'id, type, actorId, targetId, createdAt, *relatedContactIds',
    })
    // Structured per-item memory table (see lib/memory.ts).
    this.version(13).stores({
      contactMemories: 'id, contactId, kind, category, createdAt',
    })
    // Structured memories gain optional scope/group/related-contact metadata.
    // Existing rows remain valid; missing scope is treated as private.
    this.version(14).stores({
      contactMemories: 'id, contactId, scope, groupId, kind, category, createdAt, *relatedContactIds',
    })
    // Dynamic relationship fields and social-event expiry are optional fields,
    // so no data migration is needed; this version records the schema step.
    this.version(15).stores({
      contactRelations: 'id, fromContactId, toContactId, lastInteractionAt',
      socialEvents: 'id, type, actorId, targetId, createdAt, expiresAt, *relatedContactIds',
    }).upgrade(async (tx) => {
      const events = await tx.table('socialEvents').toArray()
      for (const event of events) {
        if (event.expiresAt) continue
        const importance = typeof event.importance === 'number' ? event.importance : 1
        const days = importance >= 3 ? 14 : importance === 2 ? 7 : 3
        await tx.table('socialEvents').update(event.id, { expiresAt: event.createdAt + days * 24 * 60 * 60 * 1000 })
      }
    })
    // AI-to-AI relations are a symmetric social contract. Normalize legacy
    // one-way rows so every prompt can safely read either contact's view.
    this.version(16).stores({
      contactRelations: 'id, pairId, fromContactId, toContactId, lastInteractionAt',
    }).upgrade(async (tx) => {
      const table = tx.table('contactRelations')
      const rows = await table.toArray() as Array<Record<string, unknown>>
      const handled = new Set<string>()
      for (const row of rows) {
        const from = row.fromContactId as string
        const to = row.toContactId as string
        if (!from || !to) continue
        const key = [from, to].sort().join(':')
        if (handled.has(key)) continue
        handled.add(key)
        const pair = rows.filter((candidate) =>
          (candidate.fromContactId === from && candidate.toContactId === to) || (candidate.fromContactId === to && candidate.toContactId === from),
        )
        const pairId = (pair.find((item) => typeof item.pairId === 'string')?.pairId as string | undefined) || crypto.randomUUID()
        const rank = (label: unknown) => ['恋人', '家人', '暧昧对象', '好朋友', '损友', '前辈/同事', '点头之交', '普通朋友'].indexOf(String(label))
        const primary = [...pair].sort((a, b) => rank(b.label) - rank(a.label))[0]
        for (const item of pair) await table.update(item.id as string, { pairId, label: primary.label })
        if (!pair.some((item) => item.fromContactId === to && item.toContactId === from)) {
          await table.add({ ...primary, id: crypto.randomUUID(), pairId, fromContactId: to, toContactId: from })
        }
      }
    })
    this.version(17).stores({
      walletAccounts: '&ownerId, updatedAt',
      walletTransactions: 'id, &idempotencyKey, kind, fromOwnerId, toOwnerId, createdAt',
      loans: 'id, lenderId, borrowerId, status, createdAt',
      jobListings: 'id, status, createdAt',
      interviews: 'id, jobId, status, updatedAt',
    })
    // 待办功能整体移除，显式删除旧表。
    this.version(18).stores({ todos: null })
    this.version(19).stores({
      worldbookEntries: 'id, enabled, alwaysInclude, priority, updatedAt, *keywords',
    })
    this.version(20).stores({
      simulationState: 'id, lastSimulatedAt',
      contactLifeStates: '&contactId, updatedAt',
      lifeEvents: 'id, contactId, occurredAt, visibility, importance, *participantContactIds',
      aiUsageRecords: 'id, purpose, automatic, success, createdAt',
    })
    this.version(21).stores({
      groupPlans: 'id, groupId, status, scheduledAt, createdAt',
    })
    this.version(22).stores({
      adminLogs: 'id, level, createdAt',
      adminAiTraces: 'id, purpose, model, createdAt',
      saveSlots: 'id, &slot, updatedAt',
    })
    this.version(23).stores({
      savedPersonas: 'id, nickname, realName, updatedAt',
    })
    this.version(24).stores({
      worldState: '&id, worldVersion, step',
      locations: 'id, worldId, parentId, sortOrder, kind',
      acousticEdges: 'id, worldId, fromLocationId, toLocationId',
      characterSchedules: 'id, characterId, slot, priority, locationId, effectiveDay',
      appointments: 'id, status, day, slot, locationId, *participantIds',
      worldEvents: 'id, worldStep, type, actorId, locationId, *participantIds',
      perceivedEvents: 'id, eventId, characterId, observedAtStep',
      characterDiaries: 'id, characterId, worldStep, day, slot',
      pendingPhoneMessages: 'id, conversationId, status, createdAt, *recipientIds',
    })
    this.version(25).stores({
      conversations: 'id, contactId, groupId, updatedAt, pinned, channel, status, archivedAtStep, archiveDay, archiveSlot, archiveLocationId',
      worldMaps: '&id, worldId, mode, seed',
    }).upgrade(async (tx) => {
      const world = await tx.table('worldState').get('global') as { step?: number } | undefined
      const currentStep = world?.step ?? 0
      const conversations = await tx.table('conversations').toArray() as Array<Record<string, unknown>>
      const slots = ['morning', 'day', 'evening', 'night']
      for (const conversation of conversations) {
        if (conversation.channel !== 'scene') continue
        const step = Number(conversation.sceneWorldStep ?? 0)
        if (step < currentStep) await tx.table('conversations').update(conversation.id, { status: 'archived', archiveDay: Math.floor(step / 4) + 1, archiveSlot: slots[step % 4], archiveLocationId: conversation.sceneLocationId, archivedAtStep: step })
        else await tx.table('conversations').update(conversation.id, { status: 'active' })
      }
    })
    this.version(26).stores({
      knowledgeEntries: null,
      stickers: null,
    }).upgrade(async (tx) => {
      const conversations = await tx.table('conversations').toArray() as Array<Record<string, unknown>>
      for (const conversation of conversations) {
        if (conversation.channel || conversation.sceneLocationId) continue
        await tx.table('conversations').update(conversation.id, { channel: conversation.groupId ? 'group_phone' : 'private_phone' })
      }
      const messages = await tx.table('messages').toArray() as Array<Record<string, unknown>>
      for (const message of messages) {
        if (message.type === 'sticker') await tx.table('messages').update(message.id, { type: 'text', content: `[历史表情] ${String(message.content || '')}`, image: undefined })
        if (message.type === 'image') {
          const image = message.image as { caption?: string } | undefined
          await tx.table('messages').update(message.id, { type: 'text', content: `[历史图片] ${image?.caption || String(message.content || '')}`.trim(), image: undefined })
        }
      }
    })
    this.version(27).stores({
      messages: 'id, conversationId, createdAt, debugAiTurnId, [conversationId+createdAt], [conversationId+role+createdAt]',
      aiTurns: 'id, conversationId, createdAt, [conversationId+createdAt]',
      perceivedEvents: 'id, eventId, characterId, observedAtStep, [characterId+observedAtStep]',
      contactMemories: 'id, contactId, scope, groupId, kind, category, createdAt, updatedAt, [contactId+updatedAt], *relatedContactIds',
      lifeEvents: 'id, contactId, occurredAt, visibility, importance, [contactId+occurredAt], *participantContactIds',
      groupPlans: 'id, groupId, status, scheduledAt, createdAt, [groupId+createdAt]',
      momentComments: 'id, momentId, authorContactId, createdAt, [momentId+createdAt]',
    })
    this.version(28).stores({
      outfitConstraints: 'id, characterId, startDay, endDay, createdAt, [characterId+startDay]',
      scheduleConstraints: 'id, characterId, startDay, endDay, priority, createdAt, [characterId+startDay]',
    }).upgrade(async (tx) => {
      const contacts = await tx.table('contacts').toArray() as Array<Record<string, unknown>>
      for (const contact of contacts) {
        if (contact.defaultOutfit || !contact.id || !contact.outfit || typeof contact.outfit !== 'object') continue
        await tx.table('contacts').update(contact.id as string, { defaultOutfit: contact.outfit })
      }
    })
  }
}

export const db = new ChatSLGDB()
