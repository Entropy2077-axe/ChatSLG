import { describe, expect, it } from 'vitest'
import { isExplicitImageRequest, reviewImageRequest } from './imageRequests'
import type { AppSettings, Contact, ImageRequestTask } from '../types'

describe('image request detection', () => {
  it('detects direct requests for a photo', () => {
    expect(isExplicitImageRequest('给我拍张照片看看')).toBe(true)
    expect(isExplicitImageRequest('发一张穿搭照给我')).toBe(true)
    expect(isExplicitImageRequest('现在自拍一张')).toBe(true)
    expect(isExplicitImageRequest('发送一张图片')).toBe(true)
    expect(isExplicitImageRequest('传个相片过来')).toBe(true)
  })

  it('does not treat unrelated requests as image requests', () => {
    expect(isExplicitImageRequest('给我看看这个计划怎么改')).toBe(false)
    expect(isExplicitImageRequest('下午要不要一起吃饭')).toBe(false)
  })

  it('turns a concrete historical-photo introduction into an image action locally', async () => {
    const task = { id: 'task', conversationId: 'conv', contactId: 'c', requestMessageId: 'm', userRequest: '发张照片给我看看', status: 'pending', userTurnCount: 0, createdAt: 1, updatedAt: 1 } as ImageRequestTask
    const review = await reviewImageRequest({
      task,
      latestUserText: task.userRequest,
      assistantText: '这张是之前周末在公园拍的，穿着白色上衣站在樱花树下面，头发被风吹得有点乱。',
      contact: { id: 'c', name: 'C' } as Contact,
      settings: {} as AppSettings,
      trace: { turnId: 'turn', conversationId: 'conv' },
    })
    expect(review).toMatchObject({ decision: 'accept', kind: 'selfie', outfitSource: 'scene' })
    expect(review.scene).toContain('白色上衣')
  })
})
