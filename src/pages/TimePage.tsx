import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'
import { slotLabel } from '../lib/world'
import { advanceWorldTurn } from '../lib/worldTurn'
import { worldTimeIcon } from '../lib/worldTimeIcon'
import { useChatEngineStore } from '../lib/chatEngine'

export function TimePage() {
  const settings = useSettingsStore()
  const world = useLiveQuery(() => db.worldState.get('global'), [])
  const chatBusy = useChatEngineStore((state) => Object.values(state.states).some((runtime) => runtime.aiTyping))
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { void import('../lib/world').then(({ ensureWorldInitialized }) => ensureWorldInitialized()) }, [])
  async function advance() {
    if (busy || chatBusy) return
    setBusy(true); setError('')
    try { await advanceWorldTurn(settings) } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }
  return <div className="h-[var(--app-height)] flex flex-col overflow-hidden bg-[#f4f4f6]"><TopBar title="时间" />
    <main className="flex-1 overflow-y-auto p-5"><section className="rounded-3xl bg-white p-6 text-center shadow-sm"><div className="text-6xl">{worldTimeIcon(world?.slot)}</div><h1 className="mt-4 text-xl font-semibold">第 {world?.day ?? 1} 天 · {slotLabel(world?.slot ?? 'morning')}</h1><p className="mt-2 text-3xl font-medium tabular-nums">{String(world?.hour ?? 8).padStart(2, '0')}:00</p><p className="mt-2 text-xs text-gray-400">推进后，所有角色会结算新的日程、地点和生活状态。</p><button onClick={() => void advance()} disabled={busy || chatBusy} className="mt-7 w-full rounded-xl bg-violet-600 py-3 text-sm font-medium text-white disabled:opacity-50">{busy ? '结算中…' : chatBusy ? '聊天处理中…' : '推进时间'}</button>{chatBusy && <p className="mt-3 text-xs text-amber-600">回复已显示时也可能仍在同步衣着、日程和地点；完成后才能推进时间。</p>}{error && <p className="mt-3 text-xs text-red-500">{error}</p>}</section></main>
  </div>
}
