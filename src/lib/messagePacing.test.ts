import { describe, expect, it, vi } from 'vitest'
import { messageRevealDelayMs, waitForMessageReveal } from './messagePacing'

describe('message reveal pacing', () => {
  it('uses a short pause for short messages and caps long-message pauses', () => {
    expect(messageRevealDelayMs('嗯')).toBe(820)
    expect(messageRevealDelayMs('这是一条长度更普通的聊天消息')).toBeGreaterThan(820)
    expect(messageRevealDelayMs('很长'.repeat(100))).toBe(2_500)
  })

  it('releases a queued bubble immediately when its background turn is cancelled', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const waiting = waitForMessageReveal('下一句话', controller.signal)
    controller.abort()
    await expect(waiting).resolves.toBeUndefined()
    vi.useRealTimers()
  })
})
