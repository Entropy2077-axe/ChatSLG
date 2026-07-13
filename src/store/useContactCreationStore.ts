import { create } from 'zustand'
import type { PersonaGenerationResult } from '../lib/prompt'
import type { ContactRelationLabel, CustomPersonalityTrait, TimeSlot } from '../types'

export interface RelationRow {
  key: string
  targetContactId: string
  label: ContactRelationLabel
}

export interface GenerateValues {
  tags: string[]
  ageRange: string
  gender: string
  relationship: string
  personalityTrait: string
  hobbies: string[]
  occupation: string
  relationRows: RelationRow[]
}

export interface ContactCreationInput {
  mode: 'standard' | 'nuwa'
  values: GenerateValues
  extra: string
  avatar: string
  avatarManuallySet: boolean
  realName: string
  nickname: string
  birthday: string
  customTraits: CustomPersonalityTrait[]
}

export interface CreationDraft {
  parsed: PersonaGenerationResult
  values: GenerateValues
  finalAvatar: string
  avatarPhotographer?: string
  avatarPhotographerUrl?: string
  worldVersion: number
  worldSlot: TimeSlot
  playerLocationId: string
}

export type ContactCreationStatus = 'queued' | 'persona' | 'avatar' | 'ready' | 'saving' | 'completed' | 'failed'

export interface ContactCreationJob {
  id: string
  status: ContactCreationStatus
  input: ContactCreationInput
  draft: CreationDraft | null
  error: string
  createdAt: number
  updatedAt: number
}

type JobPatch = Partial<Omit<ContactCreationJob, 'id' | 'createdAt'>>

interface ContactCreationState {
  jobs: ContactCreationJob[]
  addJob: (job: ContactCreationJob) => void
  updateJob: (id: string, patch: JobPatch) => void
  updateDraft: (id: string, updater: (draft: CreationDraft) => CreationDraft) => void
  removeJob: (id: string) => void
  clearCompleted: () => void
}

function createContactCreationStore() {
  return create<ContactCreationState>((set) => ({
  jobs: [],
  addJob: (job) => set((state) => ({ jobs: [...state.jobs, job] })),
  updateJob: (id, patch) => set((state) => ({
    jobs: state.jobs.map((job) => job.id === id ? { ...job, ...patch, updatedAt: Date.now() } : job),
  })),
  updateDraft: (id, updater) => set((state) => ({
    jobs: state.jobs.map((job) => job.id === id && job.draft
      ? { ...job, draft: updater(job.draft), updatedAt: Date.now() }
      : job),
  })),
  removeJob: (id) => set((state) => ({ jobs: state.jobs.filter((job) => job.id !== id) })),
  clearCompleted: () => set((state) => ({ jobs: state.jobs.filter((job) => job.status !== 'completed') })),
  }))
}

type ContactCreationStore = ReturnType<typeof createContactCreationStore>
const globalStore = globalThis as typeof globalThis & { __chatSlgContactCreationStore?: ContactCreationStore }

// Vite/HMR and extension-normalized dynamic imports can evaluate this module more than once.
// A single global instance keeps active background jobs attached to the app instead of silently
// replacing the queue while a request is in flight.
export const useContactCreationStore = globalStore.__chatSlgContactCreationStore ?? createContactCreationStore()
globalStore.__chatSlgContactCreationStore = useContactCreationStore
