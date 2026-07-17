import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type { AdminAiTraceStage, AiUsagePurpose } from '../types'
import { assertAutomaticAiBudget, estimateTokens, recordAiUsage } from './aiUsage'
import { useSettingsStore } from '../store/useSettingsStore'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type ThinkingMode = 'enabled' | 'disabled'

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const MAX_ATTEMPTS = 3

const PURPOSE_DEFAULTS: Record<AiUsagePurpose, { maxTokens: number; temperature: number; timeoutMs: number }> = {
  chat: { maxTokens: 1400, temperature: 0.9, timeoutMs: 90_000 },
  proactive: { maxTokens: 900, temperature: 0.85, timeoutMs: 60_000 },
  memory: { maxTokens: 1400, temperature: 0.2, timeoutMs: 45_000 },
  moments: { maxTokens: 1400, temperature: 0.75, timeoutMs: 60_000 },
  worldbook: { maxTokens: 1600, temperature: 0.45, timeoutMs: 60_000 },
  lifeSimulation: { maxTokens: 900, temperature: 0.35, timeoutMs: 45_000 },
  // Persona JSON includes a complete 7×4 schedule. 2200 tokens truncated it
  // routinely (especially with Nuwa's longer hard constraints).
  persona: { maxTokens: 5600, temperature: 0.65, timeoutMs: 120_000 },
  quality: { maxTokens: 700, temperature: 0.1, timeoutMs: 45_000 },
  other: { maxTokens: 1600, temperature: 0.45, timeoutMs: 60_000 },
}

/**
 * Merges consecutive same-role messages into one. Each AI turn is stored as
 * several separate assistant bubbles, while chat templates expect alternating
 * user/assistant turns. Keeping this normalized measurably improves continuity.
 */
export function coalesceConsecutiveRoles(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []
  for (const message of messages) {
    const last = result[result.length - 1]
    if (last && last.role === message.role) last.content = `${last.content}\n${message.content}`
    else result.push({ ...message })
  }
  return result
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '')
}

function supportsThinkingOption(model: string): boolean {
  return /^deepseek-v4(?:-|$)/i.test(model)
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

function linkedTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason)
  if (parent?.aborted) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout)
      parent?.removeEventListener('abort', abort)
    },
  }
}

async function traceAiCall(opts: {
  purpose: AiUsagePurpose
  model: string
  messages: ChatMessage[]
  output?: string
  error?: string
  inputTokens: number
  outputTokens: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  reasoningTokens?: number
  latencyMs?: number
  finishReason?: string
  turnId?: string
  stage?: AdminAiTraceStage
  conversationId?: string
}) {
  try {
    const includePayload = useSettingsStore.getState().adminModeEnabled
    await db.adminAiTraces.add({
      id: uuid(),
      ...opts,
      messages: includePayload ? opts.messages : [],
      output: includePayload ? opts.output : undefined,
      createdAt: Date.now(),
    })
    const count = await db.adminAiTraces.count()
    if (count > 500) {
      const staleIds = await db.adminAiTraces.orderBy('createdAt').limit(count - 500).primaryKeys()
      if (staleIds.length) await db.adminAiTraces.bulkDelete(staleIds)
    }
  } catch {
    // Diagnostics must never make a paid reply fail.
  }
}

export async function listModels(apiKey: string, baseUrl: string): Promise<string[]> {
  const { signal, cleanup } = linkedTimeoutSignal(undefined, 20_000)
  try {
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/models`, {
      signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) throw new Error(`拉取模型失败: HTTP ${res.status}`)
    const json = await res.json()
    const list = (json?.data ?? []) as { id: string }[]
    return list.map((model) => model.id).sort()
  } finally {
    cleanup()
  }
}

export async function testConnection(
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<{ ok: boolean; message: string }> {
  const { signal, cleanup } = linkedTimeoutSignal(undefined, 20_000)
  try {
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/chat/completions`, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '你好' }],
        max_tokens: 8,
        ...(supportsThinkingOption(model) ? { thinking: { type: 'disabled' } } : {}),
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      return { ok: false, message: `HTTP ${res.status}: ${text.slice(0, 200)}` }
    }
    return { ok: true, message: '连接成功' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    cleanup()
  }
}

export interface ChatCompletionOptions {
  apiKey: string
  baseUrl: string
  model: string
  messages: ChatMessage[]
  signal?: AbortSignal
  jsonMode?: boolean
  purpose?: AiUsagePurpose
  automatic?: boolean
  /** Complete an already-started automatic turn even if its first call consumed the last budget slot. */
  skipAutomaticBudgetCheck?: boolean
  maxTokens?: number
  temperature?: number
  thinking?: ThinkingMode
  timeoutMs?: number
  trace?: { turnId: string; stage: AdminAiTraceStage; conversationId?: string }
}

export async function chatCompletion(opts: ChatCompletionOptions): Promise<string> {
  const purpose = opts.purpose ?? 'other'
  const automatic = opts.automatic ?? false
  if (automatic && !opts.skipAutomaticBudgetCheck) await assertAutomaticAiBudget()

  const defaults = PURPOSE_DEFAULTS[purpose]
  const inputTokens = opts.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  const startedAt = performance.now()
  let lastError: unknown

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const { signal, cleanup } = linkedTimeoutSignal(opts.signal, opts.timeoutMs ?? defaults.timeoutMs)
    try {
      const res = await fetch(`${normalizeBaseUrl(opts.baseUrl)}/v1/chat/completions`, {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
          ...(supportsThinkingOption(opts.model)
            ? { thinking: { type: opts.thinking ?? 'disabled' } }
            : {}),
          temperature: opts.temperature ?? defaults.temperature,
          max_tokens: opts.maxTokens ?? defaults.maxTokens,
        }),
      })

      if (!res.ok) {
        const text = await res.text()
        const error = new Error(`API请求失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
        if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS - 1) {
          lastError = error
          cleanup()
          await wait(300 * 2 ** attempt + Math.round(Math.random() * 180), opts.signal)
          continue
        }
        throw error
      }

      const json = await res.json()
      const choice = json?.choices?.[0]
      const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : ''
      const content = choice?.message?.content
      if (finishReason === 'insufficient_system_resource' && attempt < MAX_ATTEMPTS - 1) {
        lastError = new Error('推理服务资源暂时不足')
        cleanup()
        await wait(300 * 2 ** attempt + Math.round(Math.random() * 180), opts.signal)
        continue
      }
      if (finishReason && finishReason !== 'stop') {
        const labels: Record<string, string> = {
          length: '回复达到输出上限，请重试或精简上下文',
          content_filter: '回复被内容安全策略中止',
          insufficient_system_resource: '推理服务资源暂时不足',
        }
        throw new Error(labels[finishReason] ?? `API返回未正常结束: ${finishReason}`)
      }
      if (typeof content !== 'string' || !content.trim()) throw new Error('API返回内容为空或格式异常')

      const usage = json?.usage ?? {}
      const promptTokens = Number(usage.prompt_tokens)
      const completionTokens = Number(usage.completion_tokens)
      const cacheHitTokens = Number(usage.prompt_cache_hit_tokens)
      const cacheMissTokens = Number(usage.prompt_cache_miss_tokens)
      const reasoningTokens = Number(usage.completion_tokens_details?.reasoning_tokens)
      const latencyMs = Math.round(performance.now() - startedAt)
      const metrics = {
        purpose,
        model: opts.model,
        automatic,
        success: true,
        inputTokens: Number.isFinite(promptTokens) ? promptTokens : inputTokens,
        outputTokens: Number.isFinite(completionTokens) ? completionTokens : estimateTokens(content),
        estimated: !Number.isFinite(promptTokens) || !Number.isFinite(completionTokens),
        cacheHitTokens: Number.isFinite(cacheHitTokens) ? cacheHitTokens : undefined,
        cacheMissTokens: Number.isFinite(cacheMissTokens) ? cacheMissTokens : undefined,
        reasoningTokens: Number.isFinite(reasoningTokens) ? reasoningTokens : undefined,
        latencyMs,
        finishReason: finishReason || 'stop',
      }
      const usageWrite = recordAiUsage(metrics)
      if (automatic) await usageWrite
      else void usageWrite.catch(() => undefined)
      void traceAiCall({ ...metrics, messages: opts.messages, output: content, ...opts.trace })
      cleanup()
      return content
    } catch (error) {
      cleanup()
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (opts.signal?.aborted) throw error
        lastError = new Error('API请求超时，请检查网络后重试')
        if (attempt < MAX_ATTEMPTS - 1) {
          await wait(300 * 2 ** attempt + Math.round(Math.random() * 180), opts.signal)
          continue
        }
      } else {
        lastError = error
      }
      break
    }
  }

  const error = lastError instanceof Error ? lastError : new Error(String(lastError ?? 'API请求失败'))
  const latencyMs = Math.round(performance.now() - startedAt)
  const failure = {
    purpose,
    model: opts.model,
    automatic,
    success: false,
    inputTokens,
    outputTokens: 0,
    estimated: true,
    error: error.message.slice(0, 200),
    latencyMs,
  }
  const usageWrite = recordAiUsage(failure)
  if (automatic) await usageWrite
  else void usageWrite.catch(() => undefined)
  void traceAiCall({ ...failure, messages: opts.messages, ...opts.trace })
  throw error
}

export async function chatCompletionStream(
  opts: Omit<ChatCompletionOptions, 'jsonMode'> & { onDelta: (text: string) => void },
): Promise<string> {
  const purpose = opts.purpose ?? 'other'
  const automatic = opts.automatic ?? false
  if (automatic && !opts.skipAutomaticBudgetCheck) await assertAutomaticAiBudget()
  const defaults = PURPOSE_DEFAULTS[purpose]
  const inputTokens = opts.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  const startedAt = performance.now()
  const { signal, cleanup } = linkedTimeoutSignal(opts.signal, opts.timeoutMs ?? defaults.timeoutMs)
  try {
    const res = await fetch(`${normalizeBaseUrl(opts.baseUrl)}/v1/chat/completions`, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        ...(supportsThinkingOption(opts.model) ? { thinking: { type: opts.thinking ?? 'disabled' } } : {}),
        temperature: opts.temperature ?? defaults.temperature,
        max_tokens: opts.maxTokens ?? defaults.maxTokens,
      }),
    })
    if (!res.ok || !res.body) throw new Error(`API请求失败 HTTP ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let output = ''
    let finishReason = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const chunk = JSON.parse(data)
          const delta = chunk?.choices?.[0]?.delta?.content
          const reason = chunk?.choices?.[0]?.finish_reason
          if (typeof reason === 'string') finishReason = reason
          if (typeof delta === 'string') {
            output += delta
            opts.onDelta(delta)
          }
        } catch {
          // Ignore a malformed SSE line while continuing the stream.
        }
      }
    }
    if (finishReason && finishReason !== 'stop') throw new Error(`API返回未正常结束: ${finishReason}`)
    if (!output.trim()) throw new Error('API返回内容为空或格式异常')
    const latencyMs = Math.round(performance.now() - startedAt)
    const usageWrite = recordAiUsage({ purpose, model: opts.model, automatic, success: true, inputTokens, outputTokens: estimateTokens(output), estimated: true, latencyMs, finishReason: finishReason || 'stop' })
    if (automatic) await usageWrite
    else void usageWrite.catch(() => undefined)
    void traceAiCall({ purpose, model: opts.model, messages: opts.messages, output, inputTokens, outputTokens: estimateTokens(output), latencyMs, finishReason: finishReason || 'stop', ...opts.trace })
    return output
  } finally {
    cleanup()
  }
}
