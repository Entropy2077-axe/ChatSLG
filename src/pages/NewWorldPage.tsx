import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import { WorldMapCanvas } from '../components/WorldMapCanvas'
import { commitNewWorld, createNewWorldDraft, generateNewWorldBuildings } from '../lib/newWorld'
import { useSettingsStore } from '../store/useSettingsStore'

function randomSeed() { return crypto.randomUUID().slice(0, 8) }

export function NewWorldPage() {
  const navigate = useNavigate()
  const settings = useSettingsStore()
  const [mode, setMode] = useState<'fixed' | 'custom'>('fixed')
  const [seed, setSeed] = useState(randomSeed())
  const [description, setDescription] = useState('现代城市与周边乡村')
  const [draft, setDraft] = useState(() => createNewWorldDraft('fixed', 'chatslg-fixed-modern-v1'))
  const [acknowledged, setAcknowledged] = useState(false), [busy, setBusy] = useState(false), [aiBusy, setAiBusy] = useState(false), [error, setError] = useState('')
  function preview(nextMode = mode, nextSeed = seed) { try { setDraft(createNewWorldDraft(nextMode, nextMode === 'fixed' ? 'chatslg-fixed-modern-v1' : `${description}:${nextSeed}`)); setError('') } catch (err) { setError(err instanceof Error ? err.message : String(err)) } }
  async function commit() {
    if (!acknowledged) { setError('请先确认已经创建存档或导出备份'); return }
    if (!window.confirm('再次确认：新建世界会清除当前角色、聊天、地点、记忆和世界书。继续吗？')) return
    setBusy(true); setError('')
    try { await commitNewWorld(draft); navigate('/locations', { replace: true }) } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }
  async function generateBuildings() { setAiBusy(true); setError(''); try { setDraft(await generateNewWorldBuildings(settings, description.trim() || '自定义世界', seed)) } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setAiBusy(false) } }
  return <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]"><TopBar title="新建世界" showBack />
    <main className="flex-1 overflow-y-auto p-4"><section className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">请先在“存档与回档”创建内部存档，或在设置中导出备份。只有完整地图通过校验后才会清除旧世界；生成或校验失败不会改动现有数据。</section>
      <div className="mt-3 grid grid-cols-2 gap-2"><button onClick={() => { setMode('fixed'); preview('fixed', seed) }} className={`rounded-xl border p-3 text-sm ${mode === 'fixed' ? 'border-violet-500 bg-violet-50' : 'border-gray-200 bg-white'}`}>固定现代世界</button><button onClick={() => { setMode('custom'); preview('custom', seed) }} className={`rounded-xl border p-3 text-sm ${mode === 'custom' ? 'border-violet-500 bg-violet-50' : 'border-gray-200 bg-white'}`}>自定义世界</button></div>
      {mode === 'custom' && <section className="mt-3 rounded-2xl bg-white p-3"><label className="text-xs text-gray-500">世界描述</label><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} className="mt-1 w-full rounded-xl border border-gray-200 p-2 text-sm"/><div className="mt-2 flex gap-2"><input value={seed} onChange={(event) => setSeed(event.target.value)} className="min-w-0 flex-1 rounded-xl border border-gray-200 px-3 text-sm"/><button onClick={() => { const next = randomSeed(); setSeed(next); preview('custom', next) }} className="rounded-xl border px-3 py-2 text-xs">随机种子</button><button onClick={() => preview()} className="rounded-xl bg-gray-900 px-3 py-2 text-xs text-white">生成地形</button></div><button onClick={() => void generateBuildings()} disabled={aiBusy} className="mt-2 w-full rounded-xl bg-violet-600 py-2 text-sm text-white disabled:opacity-50">{aiBusy ? 'AI规划与校验中…' : 'AI生成建筑并展示最终位置'}</button></section>}
      <div className="mt-3 h-[360px] overflow-hidden rounded-2xl border border-white shadow"><WorldMapCanvas map={draft.map} locations={draft.locations} contacts={[]} playerLocationId="home-living" onTileClick={() => {}} /></div>
      <p className="mt-2 text-xs text-gray-400">预览包含住所、学校、商城和医院；建筑已按区域规则确定性分配。相同种子会得到相同地图与坐标。</p>
      <label className="mt-4 flex items-start gap-2 rounded-xl bg-white p-3 text-sm"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-0.5"/><span>我已创建内部存档或导出备份，并理解旧世界会被清除。</span></label>
      {error && <p className="mt-3 rounded-xl bg-red-50 p-3 text-xs text-red-600">{error}</p>}<button onClick={() => void commit()} disabled={busy} className="mt-3 w-full rounded-xl bg-red-600 py-3 text-sm font-medium text-white disabled:opacity-50">{busy ? '正在创建…' : '二次确认并新建世界'}</button>
    </main></div>
}
