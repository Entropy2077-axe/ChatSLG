import { db } from '../db/db'
import type { AcousticEdge, LocationNode, WorldMapRecord } from '../types'
import { createWorldMap, placeBuildings, terrainAt } from './worldMap'
import { DEFAULT_ACOUSTIC_EDGES, DEFAULT_LOCATIONS, DEFAULT_WORLD_MAP } from './world'
import { chatCompletion } from './deepseek'
import { extractJsonObject } from './aiProtocol'
import { validateLocationExpansion } from './locationExpansion'
import type { AppSettings } from '../types'

export interface NewWorldDraft { map: WorldMapRecord; locations: LocationNode[]; acousticEdges: AcousticEdge[] }

function clonedLocations(worldId: string, map: WorldMapRecord): LocationNode[] {
  const now = Date.now()
  const placements = placeBuildings(map, [
    { id: 'home', allowedTerrains: ['urban', 'rural'], buildingCategory: 'residence' },
    { id: 'school', allowedTerrains: ['urban'], buildingCategory: 'school' },
    { id: 'mall', allowedTerrains: ['urban'], buildingCategory: 'mall' },
    { id: 'hospital', allowedTerrains: ['urban'], buildingCategory: 'hospital' },
  ])
  return DEFAULT_LOCATIONS.map((item) => ({ ...item, worldId, mapBinding: placements.get(item.id), createdAt: now, updatedAt: now }))
}

export function createNewWorldDraft(mode: 'fixed' | 'custom', seed: string): NewWorldDraft {
  const worldId = mode === 'fixed' ? 'default-modern-world' : `custom-world-${seed.replace(/[^a-z0-9]/gi, '-').slice(0, 24)}`
  const map = mode === 'fixed' ? { ...DEFAULT_WORLD_MAP, tiles: [...DEFAULT_WORLD_MAP.tiles], createdAt: Date.now(), updatedAt: Date.now() } : createWorldMap(seed, 'custom', worldId)
  map.worldId = worldId
  return {
    map,
    locations: clonedLocations(worldId, map),
    acousticEdges: DEFAULT_ACOUSTIC_EDGES.map((item) => ({ ...item, worldId })),
  }
}

export async function generateNewWorldBuildings(settings: AppSettings, description: string, seed: string): Promise<NewWorldDraft> {
  if (!settings.apiKey) throw new Error('请先在设置中配置 API Key')
  const worldId = `custom-world-${seed.replace(/[^a-z0-9]/gi, '-').slice(0, 24)}`
  const map = createWorldMap(`${description}:${seed}`, 'custom', worldId)
  const prompt = `你是ChatSLG新世界建筑规划器。根据世界描述生成5到10个建筑及其内部叶子地点，不创建角色，只输出JSON。
世界描述:${description}
地形一定包含river/grassland/beach/mountain/urban/rural。
输出:{"worldVersion":1,"locations":[{"id":"英文小写短ID","parentId":"建筑根必须city，内部地点使用建筑根ID","name":"名称","kind":"类型","description":"简述","access":"public|restricted|private","sortOrder":1,"allowedTerrains":["urban"],"buildingCategory":"school"}],"acousticEdges":[{"fromLocationId":"叶子ID","toLocationId":"叶子ID","audibility":"clear|muffled|none","bidirectional":true}]}
约束: 建筑根必须给allowedTerrains和buildingCategory且不得给坐标；内部叶子不得给区域规则。城市建筑放urban，农场村舍放rural，沙滩设施放beach，山间建筑放mountain，公园露营放grassland。每个建筑至少有一个可进入叶子地点。不能把声音连接到容器。`
  const raw = await chatCompletion({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model, jsonMode: true, purpose: 'other', messages: [{ role: 'system', content: prompt }, { role: 'user', content: '生成建筑预览' }] })
  const json = extractJsonObject(raw); if (!json) throw new Error('AI没有返回有效建筑JSON')
  const expansion = validateLocationExpansion(JSON.parse(json), 1, new Set(['city']))
  const roots = expansion.locations.filter((item) => item.parentId === 'city')
  if (!roots.length) throw new Error('AI没有生成建筑根节点')
  for (const root of roots) if (!root.allowedTerrains?.length || !root.buildingCategory) throw new Error(`建筑 ${root.name} 缺少区域规则`)
  for (const root of roots) if (!expansion.locations.some((item) => item.parentId === root.id)) throw new Error(`建筑 ${root.name} 没有可进入的内部地点`)
  const placements = placeBuildings(map, roots.map((item) => ({ id: item.id, allowedTerrains: item.allowedTerrains!, buildingCategory: item.buildingCategory! })))
  const now = Date.now()
  const city = { ...DEFAULT_LOCATIONS.find((item) => item.id === 'city')!, worldId, createdAt: now, updatedAt: now, mapBinding: undefined }
  const locations: LocationNode[] = [city, ...expansion.locations.map((item) => ({ ...item, mapBinding: placements.get(item.id), worldId, createdAt: now, updatedAt: now }))]
  const acousticEdges = expansion.acousticEdges.map((item, index) => ({ ...item, id: `generated-edge-${index}-${seed}`, worldId }))
  const draft = { map, locations, acousticEdges }
  validateNewWorldDraft(draft)
  return draft
}

export function validateNewWorldDraft(draft: NewWorldDraft): void {
  if (draft.map.width !== 32 || draft.map.height !== 32 || draft.map.tiles.length !== 1024) throw new Error('地图必须为32×32')
  for (const terrain of ['river', 'grassland', 'beach', 'mountain', 'urban', 'rural'] as const) if (!draft.map.tiles.includes(terrain)) throw new Error(`地图缺少${terrain}区域`)
  const ids = new Set(draft.locations.map((item) => item.id)), occupied = new Set<string>()
  for (const location of draft.locations) {
    if (location.parentId && !ids.has(location.parentId)) throw new Error(`地点 ${location.name} 的父节点不存在`)
    if (!location.mapBinding) continue
    const key = `${location.mapBinding.x},${location.mapBinding.y}`
    if (occupied.has(key)) throw new Error(`建筑坐标重叠: ${key}`)
    occupied.add(key)
    const terrain = terrainAt(draft.map, location.mapBinding.x, location.mapBinding.y)
    if (!terrain || !location.mapBinding.allowedTerrains.includes(terrain)) throw new Error(`建筑 ${location.name} 不符合区域规则`)
  }
  for (const edge of draft.acousticEdges) if (!ids.has(edge.fromLocationId) || !ids.has(edge.toLocationId)) throw new Error('声学连接引用了不存在的地点')
  const firstLeaf = draft.locations.find((item) => !draft.locations.some((child) => child.parentId === item.id))
  if (!firstLeaf) throw new Error('世界没有可进入地点')
}

export async function commitNewWorld(draft: NewWorldDraft): Promise<void> {
  validateNewWorldDraft(draft)
  const preserved = new Set(['savedPersonas', 'saveSlots'])
  const tables = db.tables.filter((table) => !preserved.has(table.name))
  const firstLeaf = draft.locations.find((item) => item.id === 'home-living') ?? draft.locations.find((item) => !draft.locations.some((child) => child.parentId === item.id))!
  const now = Date.now()
  await db.transaction('rw', tables, async () => {
    for (const table of tables) await table.clear()
    await db.locations.bulkPut(draft.locations)
    await db.acousticEdges.bulkPut(draft.acousticEdges)
    await db.worldMaps.put(draft.map)
    await db.worldState.put({ id: 'global', worldId: draft.map.worldId, worldVersion: 1, day: 1, slot: 'morning', hour: 8, step: 0, playerLocationId: firstLeaf.id, advancing: false, updatedAt: now })
  })
}
