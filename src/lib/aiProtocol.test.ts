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

  it('keeps an image placeholder at its exact position in a raw turn', () => {
    const parsed = parseRawPrivateDraft('<thought>先答应他</thought>行啊\n<thought>现在拍一张</thought>[image:mirror_selfie:portrait:normal:卧室镜子前的随手自拍]\n<thought>有点害羞</thought>不许笑我\n<mood>😊</mood>')
    expect(parsed.bubbles.map((bubble) => bubble.type)).toEqual(['text', 'image', 'text'])
    expect(parsed.bubbles[1]).toMatchObject({ type: 'image', kind: 'mirror_selfie', aspectRatio: 'portrait', sensitive: false, scene: '卧室镜子前的随手自拍' })
  })

  it('accepts legacy pipe separators and removes smart quotes from the scene', () => {
    const parsed = parseRawPrivateDraft('<thought>现在发给他</thought>[image:selfie|portrait|private:“卧室里的自拍”]\n<mood>😳</mood>')
    expect(parsed.bubbles).toEqual([{ type: 'image', kind: 'selfie', aspectRatio: 'portrait', sensitive: true, scene: '卧室里的自拍', thought: '现在发给他' }])
  })

  it('extracts an image marker embedded beside ordinary text', () => {
    const parsed = parseRawPrivateDraft('<thought>现在给他拍</thought>好呀 [image:selfie:portrait:normal:窗边自拍] 给你\n<mood>😊</mood>')
    expect(parsed.bubbles.map((bubble) => bubble.type)).toEqual(['text', 'image', 'text'])
    expect(parsed.bubbles[1]).toMatchObject({ type: 'image', scene: '窗边自拍' })
  })
})
