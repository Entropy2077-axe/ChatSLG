import type { CustomPersonalityTrait } from '../types'

export function customTraitsValidationError(traits: CustomPersonalityTrait[]): string | null {
  if (traits.length > 1) return '自定义性格特质只能填写一个'
  const trait = traits[0]
  if (!trait) return null
  return !trait.name.trim() || !trait.meaning.trim() ? '自定义性格特质的名称和含义需要同时填写' : null
}
