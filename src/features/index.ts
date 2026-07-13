const RETIRED_FEATURES = new Set([
  'aiReplyAssist',
  'knowledgeBase',
  'nuwaMode',
  'proactiveChat',
  'lifeSimulation',
  'selfIteration',
  'mindReading',
  // Experimental pre-draft outlining adds a full model call to every group
  // turn. The main group prompt already contains the same planning contract;
  // keep the implementation available for future opt-in experiments, but do
  // not charge every normal conversation for it.
  'storyOutline',
])

/** Retained features are permanent; this hook remains for older call sites. */
export function useModuleEnabled(id: string): boolean {
  return !RETIRED_FEATURES.has(id)
}
/** Non-reactive counterpart used by prompt and rule code. */
export function isModuleEnabled(id: string): boolean {
  return !RETIRED_FEATURES.has(id)
}
