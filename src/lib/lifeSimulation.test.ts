import { describe, expect, it } from 'vitest'
import { lifeWindows } from './lifeSimulation'
import { rankWorldbookEntries } from './worldbook'
import { customTraitsValidationError } from './contactCreator'

describe('life simulation windows', () => {
  it('uses bounded deterministic windows for long gaps', () => {
    const now = Date.now()
    const first = lifeWindows(now - 30 * 24 * 60 * 60 * 1000, now)
    expect(first.length).toBeLessThanOrEqual(30)
    expect(first).toEqual(lifeWindows(now - 30 * 24 * 60 * 60 * 1000, now))
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
