import { chatCompletion } from './deepseek'
import { extractJsonObject } from './aiProtocol'
import type { AppSettings, AdminAiTraceStage } from '../types'

export interface TurnLogicReviewInput {
  settings: AppSettings
  latestUserText: string
  draftText: string
  personaFacts: string
  recentContext?: string
  signal?: AbortSignal
  trace: { turnId: string; stage: AdminAiTraceStage; conversationId: string }
}

export async function reviewTurnLogic(input: TurnLogicReviewInput): Promise<{ valid: boolean; reason: string }> {
  const prompt = `你是ChatSLG的小型逻辑审查器。只判断可验证的客观逻辑，不续写、不润色、不按个人文风偏好挑错。
检查：是否回答最新话语；是否混淆人物身份、说话人、指代、时间、地点、因果；是否违反给出的人设硬事实；是否把未来安排当成已经发生；是否忽略用户明确纠正。
必须正确区分请求/邀请、提问、愿望/假设和“已经发生”的事实。把“穿上吧/走，去某处/这几天戴着吧”误解成用户声称角色已经做过，进而回复“我没做/你发错人了”，属于客观语义错误。
人设事实若明确写了角色会接受某类安全、合理请求，草稿却在没有任何现有边界或障碍证据时临时编造理由拒绝，也属于违反人设硬事实。反之，人设没有承诺配合、存在真实边界，或请求不安全/不可行时，角色完全可以拒绝。
最新话语包含多个并列请求或约定时，必须逐项检查草稿有没有理解并回应；只接第一项、漏掉后续项目，或无视人设承诺而随意拒绝其中一项，均为无效。
用户只表达“有时候想/也许/改天”之类愿望或假设时，草稿可以讨论或提出建议，但不能直接把它升级成角色此刻已经开始的现实行动。
角色若接受“现在执行”的动作，回复必须清楚表达现在开始执行；“要不/也许/有时候想/以后再说”只表示试探、愿望或建议，不能假装动作已经完成。
简短、冷淡、口语化、基于真实人设或边界的拒绝都不是错误。只有存在上述明确逻辑问题才valid=false，并用一句人能看懂的话说明主模型应修正什么。
只输出JSON：{"valid":true,"reason":""}

【最新用户话语】
${input.latestUserText || '后台事件'}

【主模型草稿】
${input.draftText}

【本轮相关硬事实】
${input.personaFacts || '无'}

【必要近期上下文】
${input.recentContext || '无'}`
  const raw = await chatCompletion({
    apiKey: input.settings.apiKey, baseUrl: input.settings.baseUrl, model: input.settings.utilityModel,
    jsonMode: true, thinking: 'disabled', temperature: 0, maxTokens: 260, purpose: 'quality',
    messages: [{ role: 'system', content: prompt }], signal: input.signal, trace: input.trace,
  })
  const json = extractJsonObject(raw)
  if (!json) return { valid: false, reason: '逻辑审查模型没有返回有效JSON' }
  try {
    const parsed = JSON.parse(json) as { valid?: unknown; reason?: unknown }
    return { valid: parsed.valid === true, reason: typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 240) : '' }
  } catch {
    return { valid: false, reason: '逻辑审查模型返回格式无效' }
  }
}
