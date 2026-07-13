import type { OutfitState } from '../types'

export const OUTFIT_FIELDS = [
  ['head', '💇 发型/头饰'], ['top', '👕 上装'], ['bottom', '👖 下装'],
  ['outerwear', '🧥 外套'], ['footwear', '👟 鞋袜'], ['accessories', '✨ 配饰'],
] as const

export function defaultOutfit(now = Date.now()): OutfitState {
  return { head: '自然发型', top: '日常上装', bottom: '日常下装', outerwear: '无', footwear: '日常鞋袜', accessories: '无', updatedAt: now, sourceEventIds: [] }
}

export function outfitText(outfit?: OutfitState): string {
  const value = outfit ?? defaultOutfit(0)
  return OUTFIT_FIELDS.map(([key, label]) => `${label}: ${value[key]}`).join('；')
}
