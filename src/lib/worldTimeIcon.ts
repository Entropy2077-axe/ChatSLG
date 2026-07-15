import type { TimeSlot } from '../types'

export function worldTimeIcon(slot?: TimeSlot): string {
  return ({ morning: '🌅', day: '☀️', evening: '🌆', night: '🌙' } as const)[slot ?? 'morning']
}
