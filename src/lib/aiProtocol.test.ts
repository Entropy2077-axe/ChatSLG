import { describe, expect, it } from 'vitest'
import { parseAiResponse, parseRawPrivateDraft } from './aiProtocol'

describe('per-message private thoughts', () => {
  it('keeps a different thought on every raw private-chat line', () => {
    const parsed = parseRawPrivateDraft('<thought>我有点担心他</thought>你还好吗\n<thought>其实想陪他久一点</thought>要不要再聊会儿\n<mood>🥺</mood>')
    expect(parsed.bubbles).toEqual([
      { type: 'text', content: '你还好吗', thought: '我有点担心他' },
      { type: 'text', content: '要不要再聊会儿', thought: '其实想陪他久一点' },
    ])
  })

  it('reads per-message thoughts from converted JSON', () => {
    const parsed = parseAiResponse(JSON.stringify({ messages: [
      { type: 'text', content: '第一句', thought: '第一个念头' },
      { type: 'text', content: '第二句', thought: '第二个念头' },
    ], mood: '😌' }))
    expect(parsed.bubbles.map((bubble) => bubble.thought)).toEqual(['第一个念头', '第二个念头'])
  })
})
