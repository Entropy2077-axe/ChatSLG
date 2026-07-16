import { describe, expect, it } from 'vitest'
import { lifeEventTypeForActivity } from './lifeSimulation'
import { rankWorldbookEntries } from './worldbook'
import { customTraitsValidationError } from './contactCreator'

describe('world-turn life simulation', () => {
  it('classifies activities from the authoritative world slot instead of device hours', () => {
    expect(lifeEventTypeForActivity('在医院值班', 'night')).toBe('work')
    expect(lifeEventTypeForActivity('和朋友一起吃饭', 'evening')).toBe('social')
    expect(lifeEventTypeForActivity('回家休息', 'night')).toBe('routine')
  })
})

describe('worldbook and custom traits', () => {
  it('keeps permanent entries ahead of keyword matches', () => {
    const entry = (id: string, title: string, content: string, alwaysInclude = false) => ({ id, title, content, keywords: id === 'magic' ? ['魔法'] : [], enabled: true, alwaysInclude, priority: 10, createdAt: 1, updatedAt: 1 })
    expect(rankWorldbookEntries([entry('always', '基础规则', '所有人遵守', true), entry('magic', '魔法学院', '学院课程')], '去魔法学院').map((item) => item.entry.id)).toEqual(['always', 'magic'])
  })
  it('allows at most one complete custom trait', () => {
    const trait = { id: 'x', name: '慢热', meaning: '需要时间建立信任' }
    expect(customTraitsValidationError([trait])).toBeNull()
    expect(customTraitsValidationError([{ ...trait, name: '' }])).toContain('名称')
    expect(customTraitsValidationError([trait, { ...trait, id: 'y' }])).toContain('只能填写一个')
  })
})
