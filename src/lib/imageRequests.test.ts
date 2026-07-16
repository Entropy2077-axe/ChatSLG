import { describe, expect, it } from 'vitest'
import { isExplicitImageRequest } from './imageRequests'

describe('image request detection', () => {
  it('detects direct requests for a photo', () => {
    expect(isExplicitImageRequest('给我拍张照片看看')).toBe(true)
    expect(isExplicitImageRequest('发一张穿搭照给我')).toBe(true)
    expect(isExplicitImageRequest('现在自拍一张')).toBe(true)
  })

  it('does not treat unrelated requests as image requests', () => {
    expect(isExplicitImageRequest('给我看看这个计划怎么改')).toBe(false)
    expect(isExplicitImageRequest('下午要不要一起吃饭')).toBe(false)
  })
})
