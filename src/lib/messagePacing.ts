/** Human-like pause before the next already-generated message bubble appears. */
export function messageRevealDelayMs(content: string): number {
  const length = Array.from(content.trim()).length
  return Math.min(2_500, 800 + Math.min(85, length) * 20)
}

/** A delay that resolves immediately when the owning chat turn is cancelled. */
export function waitForMessageReveal(content: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  // Regression runs execute in a dedicated IndexedDB sandbox and measure the
  // model/database pipeline rather than cosmetic typing delays.
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('__aiEvalDb')) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, messageRevealDelayMs(content))
    signal.addEventListener('abort', finish, { once: true })
  })
}
