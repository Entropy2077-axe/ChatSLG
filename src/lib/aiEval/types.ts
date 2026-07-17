import type { AdminAiTraceStage, GroupEnergyLevel, OutfitPart, StateApplicationReceipt, TimeSlot } from '../../types'

export type AiEvalCategory =
  | 'private_reply'
  | 'group_liveliness'
  | 'outfit'
  | 'schedule'
  | 'location'
  | 'multi_state'
  | 'fault_recovery'

export type AiEvalExecutionMode = 'real' | 'mock'
export type AiEvalStatus = 'pending' | 'running' | 'passed' | 'failed' | 'cancelled' | 'blocked'
export type AiEvalSuite = 'development' | 'acceptance'
export type AiEvalCoverage = 'end_to_end' | 'adjudicator_only' | 'fault_injection' | 'classification_only'

export interface AiEvalContactSeed {
  key: string
  name: string
  persona: string
  currentLocation: 'home' | 'livingRoom' | 'cafe' | 'inaudible'
  outfit?: Partial<Record<OutfitPart, string>>
}

export interface AiEvalEvidenceSeed {
  actor: 'user' | string
  content: string
  perceivedBy: string[]
}

export interface AiEvalExpectedState {
  outfit?: 'applied' | 'unchanged' | 'duplicate' | 'rejected' | 'no_write'
  outfitPatch?: Partial<Record<OutfitPart, string>>
  outfitStartDayOffset?: number
  outfitEndDayOffset?: number
  schedule?: 'applied' | 'unchanged' | 'duplicate' | 'rejected' | 'no_write'
  scheduleLocation?: 'livingRoom' | 'cafe' | 'kitchen'
  scheduleDayOffset?: number
  scheduleEndDayOffset?: number
  scheduleSlots?: TimeSlot[]
  location?: 'applied' | 'unchanged' | 'duplicate' | 'rejected' | 'no_write'
  locationTarget?: 'livingRoom' | 'cafe' | 'kitchen'
}

export interface AiEvalScenario {
  id: string
  /** Omitted legacy scenarios belong to the development suite. */
  suite?: AiEvalSuite
  /** Omitted legacy real scenarios use their runner's natural coverage. */
  coverage?: AiEvalCoverage
  category: AiEvalCategory
  description: string
  initialWorldState: string
  contacts: AiEvalContactSeed[]
  groupMembers: string[]
  initialLocations: Record<string, string>
  initialOutfits: Record<string, string>
  initialSchedules: string[]
  inputMessages: string[]
  expectedHardResults: string[]
  forbiddenResults: string[]
  repetitions: number
  timeoutMs: number
  useRealModel: boolean
  kind: 'state' | 'state_e2e' | 'group' | 'private' | 'fault'
  stateScene?: 'private_phone' | 'group_phone' | 'scene'
  evidence?: AiEvalEvidenceSeed[]
  expectedState?: AiEvalExpectedState
  expectedStateByContact?: Record<string, AiEvalExpectedState>
  preexistingSchedule?: {
    contact: string
    location: 'livingRoom' | 'cafe' | 'kitchen'
    dayOffset: number
    slots: TimeSlot[]
    activity: string
  }
  group?: {
    channel: 'group_phone' | 'scene'
    energy: GroupEnergyLevel
    speakerLimit: 2 | 3 | 4 | 5 | 'all'
    mention?: string
    minimumDistinctSpeakers?: number
  }
  private?: {
    liveliness: 'quiet' | 'normal' | 'lively'
    minBubbles: number
    maxBubbles: number
  }
  fault?: AiEvalFaultKind
}

export type AiEvalFaultKind =
  | 'non_json'
  | 'missing_fields'
  | 'wrong_character_id'
  | 'wrong_evidence_id'
  | 'invalid_location_id'
  | 'timeout'
  | 'http_429'
  | 'http_500'
  | 'network_error'
  | 'transaction_error'
  | 'main_ok_state_failed'
  | 'state_ok_commit_failed'
  | 'non_leaf_location'
  | 'stale_world_version'

export type AiEvalFailureType =
  | 'model_missed'
  | 'parse_failure'
  | 'validation_rejected'
  | 'database_commit_failure'
  | 'request_failure'
  | 'timeout'
  | 'tool_failure'
  | 'none'

export interface AiEvalAssertion {
  id: string
  label: string
  passed: boolean
  expected?: unknown
  actual?: unknown
  blocking: boolean
}

export interface AiEvalCallRecord {
  stage?: AdminAiTraceStage
  purpose: string
  model: string
  latencyMs?: number
  success: boolean
  error?: string
}

export interface AiEvalDatabaseState {
  contactLocations: Record<string, string | undefined>
  contactOutfits: Record<string, unknown>
  outfitConstraints: unknown[]
  scheduleConstraints: unknown[]
  appointments: unknown[]
  messages: unknown[]
  receipts: StateApplicationReceipt[]
}

export interface AiEvalRunResult {
  id: string
  scenarioId: string
  category: AiEvalCategory
  mode: AiEvalExecutionMode
  repetition: number
  status: Exclude<AiEvalStatus, 'pending' | 'running'>
  startedAt: string
  durationMs: number
  assertions: AiEvalAssertion[]
  failureType: AiEvalFailureType
  failureStage?: string
  error?: string
  rawOutputs: string[]
  parsedOutputs: unknown[]
  databaseState: AiEvalDatabaseState
  bubbleCount: number
  distinctSpeakerCount: number
  speakerCounts: Record<string, number>
  illegalSpeakerIds: string[]
  parseFailure: boolean
  retryCount: number
  repairAttempted: boolean
  firstAttemptPassed: boolean
  recovered: boolean
  modelCalls: AiEvalCallRecord[]
  searchCalls: number
  searchQueries: string[]
  notes: string[]
}

export interface AiEvalSummary {
  totalRuns: number
  executedRuns: number
  blockedRuns: number
  realRuns: number
  realPassedRuns: number
  realCompletePassRate: number
  realFirstAttemptPassRate: number
  repairAttemptRate: number
  repairRecoveryRate: number
  endToEndPassRate: number
  adjudicatorOnlyPassRate: number
  acceptancePassRate: number
  developmentPassRate: number
  classificationOnlyRuns: number
  faultInjectionPassRate: number
  mockRuns: number
  passedRuns: number
  completePassRate: number
  replyFormatSuccessRate: number
  livelinessTargetRate: number
  multiSpeakerRate: number
  outfitRecallRate: number
  outfitFalsePositiveRate: number
  scheduleRecallRate: number
  scheduleFalsePositiveRate: number
  locationRecallRate: number
  locationFalsePositiveRate: number
  multiStateCommitRate: number
  databaseCommitRate: number
  averageDurationMs: number
  p50DurationMs: number
  p95DurationMs: number
  averageModelCalls: number
  failuresByType: Record<string, number>
  byCategory: Record<string, { runs: number; passed: number; rate: number }>
}

export interface AiEvalReport {
  schemaVersion: 2
  generatedAt: string
  codeVersion: string
  databaseName: string
  isolated: boolean
  model: string
  utilityModel: string
  randomSeed: null
  randomSeedNote: string
  summary: AiEvalSummary
  scenarios: AiEvalScenario[]
  results: AiEvalRunResult[]
  confirmedIssues: string[]
  unconfirmedIssues: string[]
  coreLogicModified: boolean
}

export interface AiEvalRunOptions {
  scenarioIds?: string[]
  category?: AiEvalCategory
  suite?: AiEvalSuite
  failedResultIds?: string[]
  repetitionOverride?: number
  signal?: AbortSignal
  maxModelCalls?: number
  onProgress?: (completed: number, total: number, result?: AiEvalRunResult) => void
}
