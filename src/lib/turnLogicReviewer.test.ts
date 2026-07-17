import { describe, expect, it } from 'vitest'
import { deterministicTurnLogicIssue } from './turnLogicReviewer'

const personaFacts = '人设=面对合理、明确的测试请求会自然地明确答应并照做。'

describe('deterministic turn logic review', () => {
  it('rejects rhetorical suspension of a required outfit response', () => {
    expect(deterministicTurnLogicIssue({
      latestUserText: '这礼拜都戴着蝴蝶结吧。',
      draftText: '<thought>有点久</thought>这礼拜都戴蝴蝶结？你认真的吗 一周也太久了吧',
      personaFacts,
    })).toContain('没有明确接受执行')
  })

  it('accepts a clear action commitment and preserves explicit refusals', () => {
    expect(deterministicTurnLogicIssue({
      latestUserText: '这礼拜都戴着蝴蝶结吧。',
      draftText: '行，这礼拜我会戴着',
      personaFacts,
    })).toBeUndefined()
    expect(deterministicTurnLogicIssue({
      latestUserText: '戴上那顶帽子吧。',
      draftText: '不戴，我不喜欢',
      personaFacts,
    })).toBeUndefined()
  })

  it('does not impose the cooperation rule when persona facts do not require it', () => {
    expect(deterministicTurnLogicIssue({
      latestUserText: '换件外套吧。',
      draftText: '你认真的吗',
      personaFacts: '人设=会根据自己的喜好决定是否接受。',
    })).toBeUndefined()
  })

  it('does not mistake a photo outfit description for a current outfit request', () => {
    expect(deterministicTurnLogicIssue({
      latestUserText: '你那张旧照片里穿的黑外套挺好看的。',
      draftText: '哈哈谢谢 那件确实挺百搭的',
      personaFacts,
    })).toBeUndefined()
  })
})
