import type { AdminAiTraceStage } from '../../types'

export interface AiEvalObservedCall {
  id: string
  service: 'model' | 'search'
  model?: string
  purpose?: string
  stage?: AdminAiTraceStage
  query?: string
  startedAt: number
  finishedAt?: number
  status?: number
  success?: boolean
  error?: string
}

type Listener = (call: AiEvalObservedCall) => void
let listener: Listener | undefined

export function setAiEvalObserver(next?: Listener): () => void {
  listener = next
  return () => {
    if (listener === next) listener = undefined
  }
}

export function observeAiEvalCall(call: AiEvalObservedCall): void {
  if (typeof window === 'undefined' || !new URLSearchParams(window.location.search).has('__aiEvalDb')) return
  listener?.(call)
}
