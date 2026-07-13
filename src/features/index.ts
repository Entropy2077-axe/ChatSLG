const RETIRED_FEATURES = new Set([
  'aiReplyAssist',
  'knowledgeBase',
  'nuwaMode',
  'proactiveChat',
  'lifeSimulation',
  'selfIteration',
  'mindReading',
])

/** Retained features are permanent; this hook remains for older call sites. */
export function useModuleEnabled(id: string): boolean {
  return !RETIRED_FEATURES.has(id)
}
/** Non-reactive counterpart used by prompt and rule code. */
export function isModuleEnabled(id: string): boolean {
  return !RETIRED_FEATURES.has(id)
}
