import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_STYLE_PROMPT } from '../lib/prompt'
import { INITIAL_WALLET_BALANCE } from '../lib/wallet'
import type { AppSettings } from '../types'

interface SettingsState extends AppSettings {
  setSettings: (patch: Partial<AppSettings>) => void
}

const envKey = import.meta.env.VITE_DEEPSEEK_API_KEY ?? ''
const envBaseUrl = import.meta.env.VITE_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const envPexelsKey = import.meta.env.VITE_PEXELS_API_KEY ?? ''

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      apiKey: envKey,
      baseUrl: envBaseUrl,
      model: 'deepseek-v4-pro',
      utilityModel: 'deepseek-v4-flash',
      globalSystemPrompt: DEFAULT_STYLE_PROMPT,
      chatLiveliness: 'normal',
      userNickname: '我',
      userAvatar: '🙂',
      userGender: '',
      userBirthday: '',
      userBio: '',
      walletBalance: INITIAL_WALLET_BALANCE,
      userOccupation: '',
      userMonthlySalary: 0,
      jobBabyMode: false,
      momentsCoverPhoto: '',
      momentsLastReadAt: 0,
      proactiveDailyCap: 3,
      proactiveProbability: 0.25,
      proactiveSilenceThresholdMs: 45 * 60 * 1000,
      proactiveCooldownMs: 6 * 60 * 60 * 1000,
      proactiveMomentsMax: 3,
      proactiveTickIntervalMs: 5 * 60 * 1000,
      automaticAiDailyCap: 0,
      worldview: '',
      worldbookMigrationCompleted: false,
      pexelsApiKey: envPexelsKey,
      themeMode: 'light',
      topInsetAdjustmentPx: 0,
      chatBackground: '',
      currencyIconMode: 'coin',
      animationsEnabled: true,
      customCurrencyEmoji: '💎',
      moodExpiryMs: 30 * 60 * 1000,
      selfIterationGlobalPrompt: '',
      adminModeEnabled: false,
      contactCreatorMode: 'standard',
      setSettings: (patch) => set(patch),
    }),
    {
      name: 'chatslg-settings',
      version: 10,
      migrate: (persisted, version) => {
        const next = persisted as Partial<SettingsState>
        if (typeof next.userOccupation !== 'string') next.userOccupation = ''
        if (typeof next.userMonthlySalary !== 'number') next.userMonthlySalary = 0
        if (typeof next.jobBabyMode !== 'boolean') next.jobBabyMode = false
        if (typeof next.selfIterationGlobalPrompt !== 'string') {
          next.selfIterationGlobalPrompt = ''
        }
        if (typeof next.topInsetAdjustmentPx !== 'number') next.topInsetAdjustmentPx = 0
        if (typeof next.worldbookMigrationCompleted !== 'boolean') next.worldbookMigrationCompleted = false
        if (typeof next.automaticAiDailyCap !== 'number') next.automaticAiDailyCap = 0
        if (typeof next.animationsEnabled !== 'boolean') next.animationsEnabled = true
        if (version < 9) {
          next.contactCreatorMode = 'standard'
          delete (next as Record<string, unknown>).enabledModules
        }
        if (!['quiet', 'normal', 'lively'].includes(String(next.chatLiveliness))) next.chatLiveliness = 'normal'
        return next
      },
    },
  ),
)
