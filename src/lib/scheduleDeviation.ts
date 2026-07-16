import { extractJsonObject } from './aiProtocol'
import { chatCompletion } from './deepseek'
import { effectiveScheduleAdherence, type ScheduleAdherence } from './world'
import type { AppSettings, CharacterSchedule } from '../types'

export interface ScheduleDeviationEvidence {
  id: string
  kind: 'persona' | 'lifeState' | 'weather' | 'diary' | 'event' | 'appointment' | 'recentDeviation'
  content: string
}

export interface ScheduleDeviationProposal {
  characterId: string
  scheduleId: string
  targetLocationId: string
  activity: string
  reason: string
  evidenceIds: string[]
}

export interface ScheduleDeviationCandidate {
  proposal: ScheduleDeviationProposal
  schedule: CharacterSchedule
  evidence: ScheduleDeviationEvidence[]
  stepsSinceLastDeviation?: number
}

export interface ScheduleDeviationVerdict {
  characterId: string
  scheduleId: string
  allow: boolean
  adherence: ScheduleAdherence
  impact: 'low' | 'moderate' | 'high' | 'critical'
  confidence: number
  evidenceIds: string[]
  explanation: string
}

const IMPACT_RANK = { low: 0, moderate: 1, high: 2, critical: 3 } as const
const MINIMUM: Record<ScheduleAdherence, { impact: number; confidence: number; cooldown: number }> = {
  optional: { impact: 0, confidence: .72, cooldown: 4 },
  normal: { impact: 1, confidence: .85, cooldown: 8 },
  required: { impact: 2, confidence: .95, cooldown: 8 },
}

function rejected(candidate: ScheduleDeviationCandidate, explanation: string): ScheduleDeviationVerdict {
  return {
    characterId: candidate.proposal.characterId,
    scheduleId: candidate.schedule.id,
    allow: false,
    adherence: effectiveScheduleAdherence(candidate.schedule),
    impact: 'low',
    confidence: 0,
    evidenceIds: [],
    explanation,
  }
}

export async function adjudicateScheduleDeviations(
  candidates: ScheduleDeviationCandidate[],
  settings: AppSettings,
): Promise<Map<string, ScheduleDeviationVerdict>> {
  const results = new Map<string, ScheduleDeviationVerdict>()
  if (candidates.length === 0) return results

  const valid: ScheduleDeviationCandidate[] = []
  for (const candidate of candidates) {
    const proposal = candidate.proposal
    const evidenceIds = new Set(candidate.evidence.map((item) => item.id))
    if (proposal.scheduleId !== candidate.schedule.id
      || !proposal.reason.trim()
      || !proposal.activity.trim()
      || proposal.evidenceIds.length === 0
      || proposal.evidenceIds.some((id) => !evidenceIds.has(id))) {
      results.set(proposal.characterId, rejected(candidate, '偏离提案缺少可核验依据，或引用了当前角色无法使用的证据。'))
      continue
    }
    valid.push(candidate)
  }
  if (valid.length === 0) return results

  const payload = valid.map((candidate) => ({
    characterId: candidate.proposal.characterId,
    schedule: {
      id: candidate.schedule.id,
      priority: candidate.schedule.priority,
      adherence: effectiveScheduleAdherence(candidate.schedule),
      locationId: candidate.schedule.locationId,
      activity: candidate.schedule.activity,
    },
    proposal: candidate.proposal,
    stepsSinceLastDeviation: candidate.stepsSinceLastDeviation ?? null,
    evidence: candidate.evidence,
  }))

  let raw: string
  try {
    raw = await chatCompletion({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.utilityModel,
      jsonMode: true,
      thinking: 'disabled',
      temperature: 0,
      maxTokens: 1200,
      purpose: 'quality',
      automatic: false,
      messages: [{ role: 'system', content: `你是世界日程偏离的独立语义裁决器。主模型只能提出偏离，不能批准自己。

逐项判断“现有证据是否足以让这个具体角色在当前时段偏离当前日程”。不要做关键词匹配，也不要因为出现某个词就自动放行；要理解证据描述的事实、来源、严重度、时效和与本次偏离的因果关系。未在evidence中出现的事实一律不得补造。人格、习惯和偏好可解释选择倾向，但单独不能证明疾病、事故、外部阻碍或已获准取消责任。

约束尺度：
- optional：理由与证据一致、选择自然即可，轻度影响也可成立。
- normal：至少需要中等且与当下直接相关的影响，单纯“更想这样”“性格懒”通常不足。
- required（包括约定和临时高优先级安排）：只有高或极高影响的已证实情况，或证据明确表明安排已被正式改变，才可偏离。人格偏好不能推翻责任。
- evidenceIds只列你实际用于结论的证据ID。证据即使存在，也不代表它必然支持提案。
- scope固定为current_slot_only，本次裁决不能暗改以后日程。

只输出JSON：{"verdicts":[{"characterId":"原ID","scheduleId":"原ID","allow":true,"impact":"low|moderate|high|critical","confidence":0到1,"evidenceIds":["实际采用的证据ID"],"scope":"current_slot_only","explanation":"简短说明证据为何足够或不足"}]}
每个候选恰好一项，不得漏项，不得增加候选。\n\n候选：${JSON.stringify(payload)}` }],
    })
  } catch {
    for (const candidate of valid) results.set(candidate.proposal.characterId, rejected(candidate, '独立裁决暂时不可用，本次按原日程执行。'))
    return results
  }

  const json = extractJsonObject(raw)
  let rows: unknown[] = []
  try { rows = json ? (JSON.parse(json) as { verdicts?: unknown[] }).verdicts ?? [] : [] } catch { rows = [] }
  for (const candidate of valid) {
    const row = rows.find((item) => item && typeof item === 'object'
      && (item as Record<string, unknown>).characterId === candidate.proposal.characterId
      && (item as Record<string, unknown>).scheduleId === candidate.schedule.id) as Record<string, unknown> | undefined
    if (!row) {
      results.set(candidate.proposal.characterId, rejected(candidate, '独立裁决没有返回对应角色的有效结论。'))
      continue
    }
    const impact = ['low', 'moderate', 'high', 'critical'].includes(String(row.impact)) ? row.impact as ScheduleDeviationVerdict['impact'] : 'low'
    const confidence = Math.max(0, Math.min(1, Number(row.confidence) || 0))
    const allowedEvidence = new Set(candidate.evidence.map((item) => item.id))
    const evidenceIds = [...new Set((Array.isArray(row.evidenceIds) ? row.evidenceIds : []).filter((id): id is string => typeof id === 'string' && allowedEvidence.has(id)))]
    const adherence = effectiveScheduleAdherence(candidate.schedule)
    const threshold = MINIMUM[adherence]
    const cooldownBlocks = candidate.stepsSinceLastDeviation !== undefined
      && candidate.stepsSinceLastDeviation < threshold.cooldown
      && IMPACT_RANK[impact] < IMPACT_RANK.high
    const allow = row.allow === true
      && evidenceIds.length > 0
      && IMPACT_RANK[impact] >= threshold.impact
      && confidence >= threshold.confidence
      && !cooldownBlocks
    results.set(candidate.proposal.characterId, {
      characterId: candidate.proposal.characterId,
      scheduleId: candidate.schedule.id,
      allow,
      adherence,
      impact,
      confidence,
      evidenceIds,
      explanation: cooldownBlocks
        ? '近期已发生过日程偏离；当前证据影响不足以再次突破冷却。'
        : typeof row.explanation === 'string' && row.explanation.trim()
          ? row.explanation.trim().slice(0, 240)
          : allow ? '证据达到当前日程所需门槛。' : '证据未达到当前日程所需门槛。',
    })
  }
  return results
}
