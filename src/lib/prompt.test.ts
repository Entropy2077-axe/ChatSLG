import { describe, expect, it } from 'vitest'
import { buildRawChatPrompt, parsePersonaGeneration } from './prompt'

const slots = ['morning', 'day', 'evening', 'night'] as const
const schedule = Array.from({ length: 7 }, (_, dayOfWeek) => slots.map((slot) => ({
  dayOfWeek, slot, locationId: 'home-living', activity: `${dayOfWeek}-${slot}`,
  phoneAccess: 'available', adherence: slot === 'night' ? 'optional' : 'normal',
}))).flat()

describe('persona schedule parsing', () => {
  it('accepts one complete 7 by 4 world-week schedule', () => {
    const parsed = parsePersonaGeneration(JSON.stringify({ name: '测试角色', persona: '稳定人设', worldSchedule: schedule }))
    expect(parsed?.worldSchedule).toHaveLength(28)
    expect(parsed?.worldSchedule[3].adherence).toBe('optional')
  })

  it('rejects incomplete or duplicate coverage', () => {
    expect(parsePersonaGeneration(JSON.stringify({ name: '测试角色', persona: '稳定人设', worldSchedule: schedule.slice(1) }))).toBeNull()
    expect(parsePersonaGeneration(JSON.stringify({ name: '测试角色', persona: '稳定人设', worldSchedule: [...schedule.slice(1), schedule[1]] }))).toBeNull()
  })
})

describe('private chat logical grounding prompt', () => {
  it('distinguishes requests and tentative wishes from completed actions without removing persona agency', () => {
    const prompt = buildRawChatPrompt({
      name: '林夏',
      persona: '面对安全合理的明确请求会配合，也会坚持真实边界。',
      relationshipBase: '朋友',
      stylePrompt: '自然聊天',
      recentContext: '',
      stickerNames: [],
    })
    expect(prompt).toContain('先识别最新话语是在请求、邀请、提问，还是陈述已经发生的事实')
    expect(prompt).toContain('如果人设硬事实明确表示会配合这类请求，就必须按人设清楚接受并落实')
    expect(prompt).toContain('如果人设或情境确有理由拒绝')
    expect(prompt).toContain('现有硬事实没有写明缺失或不可用时')
    expect(prompt).toContain('不得临时编造“我没有这件东西”')
    expect(prompt).toContain('一条消息里有多个并列请求或约定时，逐项理解和回应')
    expect(prompt).toContain('“要不/也许/有时候想/以后再说”只是试探、愿望或建议')
  })
})
