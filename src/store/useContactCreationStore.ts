import { create } from 'zustand'
import type { PersonaGenerationResult } from '../lib/prompt'
import type { ContactRelationLabel, TimeSlot } from '../types'

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

type ProgressStep = 'persona' | 'avatar' | 'saving'
type DraftSetter = CreationDraft | null | ((current: CreationDraft | null) => CreationDraft | null)

interface ContactCreationState {
  generating: boolean
  progressStep: ProgressStep | null
  error: string
  creationDraft: CreationDraft | null
  setGenerating: (generating: boolean) => void
  setProgressStep: (progressStep: ProgressStep | null) => void
  setError: (error: string) => void
  setCreationDraft: (value: DraftSetter) => void
  reset: () => void
}

export const useContactCreationStore = create<ContactCreationState>((set) => ({
  generating: false,
  progressStep: null,
  error: '',
  creationDraft: null,
  setGenerating: (generating) => set({ generating }),
  setProgressStep: (progressStep) => set({ progressStep }),
  setError: (error) => set({ error }),
  setCreationDraft: (value) => set((state) => ({
    creationDraft: typeof value === 'function' ? value(state.creationDraft) : value,
  })),
  reset: () => set({ generating: false, progressStep: null, error: '', creationDraft: null }),
}))

