import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { WorldMapCanvas } from '../components/WorldMapCanvas'
import { useSettingsStore } from '../store/useSettingsStore'
import { addLocation, ensureWorldInitialized, leafDescendants, movePlayer, slotLabel } from '../lib/world'
import { TERRAIN_COLORS, TERRAIN_LABELS, terrainAt } from '../lib/worldMap'
import { advanceWorldTurn } from '../lib/worldTurn'
import { commitLocationExpansion, generateLocationExpansion, type LocationExpansionDraft } from '../lib/locationExpansion'
import type { LocationNode, TerrainType } from '../types'

const EMPTY_LOCATIONS: LocationNode[] = []
const EMPTY_CONTACTS: import('../types').Contact[] = []

export function WorldPage() {
  const settings = useSettingsStore()
  const world = useLiveQuery(() => db.worldState.get('global'), [])
  const map = useLiveQuery(() => db.worldMaps.get('active'), [])
  const locations = useLiveQuery(() => db.locations.orderBy('sortOrder').toArray(), []) ?? EMPTY_LOCATIONS
  const contacts = useLiveQuery(() => db.contacts.orderBy('createdAt').toArray(), []) ?? EMPTY_CONTACTS
  const [selectedRoot, setSelectedRoot] = useState<LocationNode | null>(null)
  const [emptyTile, setEmptyTile] = useState<{ x: number; y: number; terrain: TerrainType } | null>(null)
  const [newName, setNewName] = useState(''), [advancing, setAdvancing] = useState(false), [error, setError] = useState('')
  const [expansionDraft, setExpansionDraft] = useState<LocationExpansionDraft | null>(null), [expanding, setExpanding] = useState(false)
  useEffect(() => { void ensureWorldInitialized() }, [])
  const anchored = useMemo(() => locations.filter((item) => item.mapBinding), [locations])
  async function enter(location: LocationNode) { try { await movePlayer(location.id); setSelectedRoot(null); setError('') } catch (err) { setError(err instanceof Error ? err.message : String(err)) } }
  function selectTile(x: number, y: number) {
    const root = anchored.find((item) => item.mapBinding?.x === x && item.mapBinding?.y === y)
    if (root) {
      if (!locations.some((item) => item.parentId === root.id)) { void enter(root); return }
      setSelectedRoot(root); setEmptyTile(null); return
    }
    if (map) { const terrain = terrainAt(map, x, y); if (terrain) { setEmptyTile({ x, y, terrain }); setSelectedRoot(null); setNewName('') } }
  }
  async function createBuilding() {
    if (!emptyTile || !newName.trim()) return
    try {
      await addLocation({ parentId: 'city', name: newName.trim(), kind: 'custom', description: `位于${TERRAIN_LABELS[emptyTile.terrain]}区域的独立建筑。`, access: 'public', sortOrder: Date.now(), mapBinding: { x: emptyTile.x, y: emptyTile.y, allowedTerrains: [emptyTile.terrain], buildingCategory: 'custom' } })
      setEmptyTile(null); setNewName(''); setError('')
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }
  async function advance() { if (advancing) return; setAdvancing(true); setError(''); try { await advanceWorldTurn(settings) } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setAdvancing(false) } }
  async function expandWithAi() { const request = window.prompt('描述要新增的建筑与内部地点'); if (!request?.trim()) return; setExpanding(true); setError(''); try { setExpansionDraft(await generateLocationExpansion(settings, request.trim())) } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setExpanding(false) } }
  async function confirmExpansion() { if (!expansionDraft) return; try { await commitLocationExpansion(expansionDraft); setExpansionDraft(null); setError('') } catch (err) { setError(err instanceof Error ? err.message : String(err)) } }
  const leaves = selectedRoot ? leafDescendants(selectedRoot.id, locations) : []
  return <div className="flex h-full min-h-0 flex-col bg-[#f4f4f6]">
    <header className="shrink-0 bg-white px-4 pb-2 pt-[calc(env(safe-area-inset-top)+10px)] shadow-sm">
      <div className="flex items-center justify-between"><div><h1 className="text-lg font-semibold">地点</h1><p className="text-xs text-gray-400">第{world?.day ?? 1}天 · {slotLabel(world?.slot ?? 'morning')} · {String(world?.hour ?? 8).padStart(2, '0')}:00</p></div><button onClick={() => void advance()} disabled={advancing} className="rounded-xl bg-violet-600 px-4 py-2 text-sm text-white disabled:opacity-50">{advancing ? '结算中…' : '推进时间'}</button></div>
      <div className="mt-2 flex items-center justify-between"><p className="text-[11px] text-gray-400">拖动地图 · 双指/滚轮缩放 · 点击建筑进入</p><button onClick={() => void expandWithAi()} disabled={expanding} className="text-xs text-violet-600">{expanding ? '生成中…' : 'AI扩展'}</button></div>
      <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1">{Object.entries(TERRAIN_COLORS).map(([terrain, color]) => <span key={terrain} className="flex items-center gap-1 text-[9px] text-gray-500"><i className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />{TERRAIN_LABELS[terrain as TerrainType]}</span>)}</div>
      {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-600">{error}</p>}
      {map?.placementBlocked && <p className="mt-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-700">旧建筑间距冲突：{map.placementConflicts?.join('、') || '布局无解'}。请删除冲突建筑或从手机新建世界；当前禁止新增地点。</p>}
    </header>
    <main className="relative min-h-0 flex-1">{map && world ? <WorldMapCanvas map={map} locations={expansionDraft ? [...locations, ...expansionDraft.locations.map((item) => ({ ...item, worldId: world.worldId, createdAt: 0, updatedAt: 0 }))] : locations} contacts={contacts} playerLocationId={world.playerLocationId} onTileClick={selectTile} /> : <div className="flex h-full items-center justify-center text-sm text-gray-400">地图加载中…</div>}</main>
    {selectedRoot && <div className="absolute inset-x-0 bottom-[calc(58px+env(safe-area-inset-bottom))] z-20 rounded-t-3xl bg-white p-4 shadow-2xl"><div className="flex items-center justify-between"><div><h2 className="font-semibold">{selectedRoot.name}</h2><p className="text-xs text-gray-400">建筑格不可直接进入，请选择内部地点</p></div><button onClick={() => setSelectedRoot(null)} className="text-gray-400">✕</button></div><div className="mt-3 grid grid-cols-2 gap-2">{leaves.map((leaf) => <button key={leaf.id} onClick={() => void enter(leaf)} className={`rounded-xl border px-3 py-3 text-left text-sm ${world?.playerLocationId === leaf.id ? 'border-violet-500 bg-violet-50 text-violet-700' : 'border-gray-200'}`}>{leaf.name}<span className="mt-1 block text-[10px] text-gray-400">{contacts.filter((item) => item.currentLocationId === leaf.id).length} 位角色</span></button>)}</div></div>}
    {emptyTile && <div className="absolute inset-x-0 bottom-[calc(58px+env(safe-area-inset-bottom))] z-20 rounded-t-3xl bg-white p-4 shadow-2xl"><div className="flex justify-between"><div><h2 className="font-semibold">新增独立建筑</h2><p className="text-xs text-gray-400">坐标 {emptyTile.x},{emptyTile.y} · {TERRAIN_LABELS[emptyTile.terrain]}</p></div><button onClick={() => setEmptyTile(null)} className="text-gray-400">✕</button></div><input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="建筑名称" className="mt-3 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"/><button onClick={() => void createBuilding()} className="mt-2 w-full rounded-xl bg-gray-900 py-2 text-sm text-white">创建并绑定此区域</button></div>}
    {expansionDraft && <div className="absolute inset-x-0 bottom-[calc(58px+env(safe-area-inset-bottom))] z-30 rounded-t-3xl bg-white p-4 shadow-2xl"><div className="flex justify-between"><div><h2 className="font-semibold">AI扩展预览</h2><p className="text-xs text-gray-400">紫图层中的新建筑已按区域规则确定坐标</p></div><button onClick={() => setExpansionDraft(null)} className="text-gray-400">✕</button></div><div className="mt-2 max-h-32 overflow-y-auto text-xs text-gray-600">{expansionDraft.locations.map((item) => <p key={item.id}>{item.name}{item.mapBinding ? ` · (${item.mapBinding.x},${item.mapBinding.y})` : ' · 内部地点'}</p>)}</div><button onClick={() => void confirmExpansion()} className="mt-3 w-full rounded-xl bg-violet-600 py-2 text-sm text-white">确认写入世界</button></div>}
  </div>
}
