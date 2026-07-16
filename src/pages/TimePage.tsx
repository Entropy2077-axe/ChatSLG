import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'
import { slotLabel } from '../lib/world'
import { advanceWorldTurn } from '../lib/worldTurn'
import { worldTimeIcon } from '../lib/worldTimeIcon'
import { useChatEngineStore } from '../lib/chatEngine'
import { formatWorldDate } from '../lib/worldCalendar'
import { SEASON_RULES, weatherForWorld } from '../lib/worldWeather'

export function TimePage() {
  const settings = useSettingsStore()
  const world = useLiveQuery(() => db.worldState.get('global'), [])
  const worldMap = useLiveQuery(() => db.worldMaps.get('active'), [])
  const publicEvents = useLiveQuery(() => db.worldEvents.orderBy('worldStep').reverse().filter((event) => !!event.directedEventKey && (event.visibility === 'public' || event.participantIds.includes('user'))).limit(6).toArray(), []) ?? []
  const chatBusy = useChatEngineStore((state) => Object.values(state.states).some((runtime) => runtime.aiTyping))
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { void import('../lib/world').then(({ ensureWorldInitialized }) => ensureWorldInitialized()) }, [])
  async function advance() {
    if (busy || chatBusy) return
    setBusy(true); setError('')
    try { await advanceWorldTurn(settings) } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }
  const weather = weatherForWorld(worldMap?.seed ?? world?.worldId ?? 'default-world', world?.day ?? 1, world?.slot ?? 'morning')
  return <div className="h-[var(--app-height)] flex flex-col overflow-hidden bg-[#f4f4f6]"><TopBar title="时间" />
    <main className="flex-1 overflow-y-auto p-5"><section className="rounded-3xl bg-white p-6 text-center shadow-sm"><div className="text-6xl">{worldTimeIcon(world?.slot)}</div><h1 className="mt-4 text-xl font-semibold">{formatWorldDate(world?.day ?? 1)}</h1><p className="mt-2 text-sm text-gray-500">世界连续第 {world?.day ?? 1} 天 · {slotLabel(world?.slot ?? 'morning')}</p><p className="mt-2 text-3xl font-medium tabular-nums">{String(world?.hour ?? 8).padStart(2, '0')}:00</p><div className="mt-5 rounded-2xl bg-sky-50 px-4 py-3 text-left"><div className="flex items-center gap-3"><span className="text-3xl">{weather.icon}</span><div><p className="text-sm font-medium text-gray-800">{weather.label} · 体感{weather.temperature}</p><p className="mt-0.5 text-xs text-gray-500">{weather.description}</p></div></div><p className="mt-2 text-[11px] leading-relaxed text-gray-400">{SEASON_RULES[weather.calendar.season].climate}</p></div><p className="mt-3 text-xs text-gray-400">推进后，所有角色会按新的时段、天气、日程和地点结算生活状态。</p><button onClick={() => void advance()} disabled={busy || chatBusy} className="mt-7 w-full rounded-xl bg-violet-600 py-3 text-sm font-medium text-white disabled:opacity-50">{busy ? '结算中…' : chatBusy ? '聊天处理中…' : '推进时间'}</button>{chatBusy && <p className="mt-3 text-xs text-amber-600">回复已显示时也可能仍在同步衣着、日程和地点；完成后才能推进时间。</p>}{error && <p className="mt-3 text-xs text-red-500">{error}</p>}</section>{publicEvents.length > 0 && <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm"><h2 className="text-xs font-medium text-gray-400">最近的世界小事件</h2><div className="mt-2 space-y-3">{publicEvents.map((event) => <div key={event.id} className="border-l-2 border-violet-300 pl-3"><p className="text-sm leading-relaxed text-gray-700">{event.content}</p><p className="mt-1 text-[10px] text-gray-400">{event.worldDay ? formatWorldDate(event.worldDay) : `世界步 ${event.worldStep}`}{event.worldSlot ? ` · ${slotLabel(event.worldSlot)}` : ''} · {event.type === 'seasonal' ? '季节' : event.type === 'weather' ? '天气' : '日常'}</p></div>)}</div></section>}</main>
  </div>
}
