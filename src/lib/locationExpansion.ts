import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { extractJsonObject } from './aiProtocol'
import { chatCompletion } from './deepseek'
import { ensureWorldInitialized, formatLocationTree } from './world'
import { placeBuildings } from './worldMap'
import { retrieveWorldbookTrace } from './worldbook'
import type { AcousticEdge, AppSettings, Audibility, LocationAccess, LocationNode, TerrainType } from '../types'

export interface LocationExpansionDraft {
  worldVersion: number
  locations: Array<Pick<LocationNode, 'id' | 'parentId' | 'name' | 'kind' | 'description' | 'access' | 'sortOrder' | 'mapBinding'> & { allowedTerrains?: TerrainType[]; buildingCategory?: string }>
  acousticEdges: Array<Pick<AcousticEdge, 'fromLocationId' | 'toLocationId' | 'audibility' | 'bidirectional'>>
}

const ACCESS = new Set<LocationAccess>(['public', 'restricted', 'private'])
const AUDIBILITY = new Set<Audibility>(['clear', 'muffled', 'none'])
const TERRAINS = new Set<TerrainType>(['river', 'grassland', 'beach', 'mountain', 'urban', 'rural'])

export function validateLocationExpansion(
  raw: unknown,
  expectedWorldVersion: number,
  existingIds: Set<string>,
): LocationExpansionDraft {
  if (!raw || typeof raw !== 'object') throw new Error('地点扩展格式无效')
  const value = raw as Record<string, unknown>
  if (Number(value.worldVersion) !== expectedWorldVersion || !Array.isArray(value.locations) || !Array.isArray(value.acousticEdges)) {
    throw new Error('地点扩展版本或结构无效')
  }
  if (value.locations.length === 0 || value.locations.length > 20) throw new Error('一次只能扩展1到20个地点')
  const addedIds = new Set<string>()
  const locations = value.locations.map((entry, index) => {
    const item = entry as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const parentId = typeof item.parentId === 'string' ? item.parentId.trim() : undefined
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    const kind = typeof item.kind === 'string' ? item.kind.trim() : 'custom'
    const description = typeof item.description === 'string' ? item.description.trim() : ''
    const access = item.access as LocationAccess
    if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(id) || existingIds.has(id) || addedIds.has(id)) throw new Error(`新增地点ID无效或重复: ${id || '空'}`)
    if (!name || !description || !ACCESS.has(access)) throw new Error(`地点 ${id} 缺少名称、描述或权限`)
    addedIds.add(id)
    const allowedTerrains = Array.isArray(item.allowedTerrains) ? item.allowedTerrains.filter((terrain): terrain is TerrainType => TERRAINS.has(terrain as TerrainType)) : undefined
    const buildingCategory = typeof item.buildingCategory === 'string' ? item.buildingCategory.trim().slice(0, 40) : undefined
    return { id, parentId, name, kind, description, access, sortOrder: Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : index + 1, allowedTerrains, buildingCategory }
  })
  const allIds = new Set([...existingIds, ...addedIds])
  for (const item of locations) if (item.parentId && !allIds.has(item.parentId)) throw new Error(`地点 ${item.id} 的父级不存在`)
  const acousticEdges = value.acousticEdges.map((entry) => {
    const item = entry as Record<string, unknown>
    const fromLocationId = typeof item.fromLocationId === 'string' ? item.fromLocationId.trim() : ''
    const toLocationId = typeof item.toLocationId === 'string' ? item.toLocationId.trim() : ''
    const audibility = item.audibility as Audibility
    if (!allIds.has(fromLocationId) || !allIds.has(toLocationId) || fromLocationId === toLocationId || !AUDIBILITY.has(audibility)) throw new Error('声学连接引用了非法地点')
    return { fromLocationId, toLocationId, audibility, bidirectional: item.bidirectional !== false }
  })
  return { worldVersion: expectedWorldVersion, locations, acousticEdges }
}

export async function generateLocationExpansion(settings: AppSettings, request: string): Promise<LocationExpansionDraft> {
  if (!settings.apiKey) throw new Error('请先在设置中配置 API Key')
  const world = await ensureWorldInitialized()
  const locations = await db.locations.where('worldId').equals(world.worldId).sortBy('sortOrder')
  const worldbook = await retrieveWorldbookTrace(request, { maxEntries: 8, maxChars: 6000 })
  const prompt = `你是ChatSLG地点设计器。只扩展地点，不创建角色、不删除旧地点、不修改日程。只输出JSON。
世界版本:${world.worldVersion}
【完整现有地点树】
${formatLocationTree(locations)}
【相关世界书】
${worldbook.text || '无'}
【用户要求】
${request}
输出:{"worldVersion":${world.worldVersion},"locations":[{"id":"仅小写字母数字和连字符，不能与旧ID重复","parentId":"建筑根节点用city，内部地点用本批建筑根ID","name":"名称","kind":"类型","description":"简短描述","access":"public|restricted|private","sortOrder":1,"allowedTerrains":["urban"],"buildingCategory":"mall"}],"acousticEdges":[{"fromLocationId":"具体叶子地点ID","toLocationId":"具体叶子地点ID","audibility":"clear|muffled|none","bidirectional":true}]}
建筑根节点必须给allowedTerrains和buildingCategory，不能输出坐标；规则层会按世界种子分配合法空格。子地点不要提供区域规则。`
  const raw = await chatCompletion({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model, jsonMode: true, purpose: 'other', messages: [{ role: 'system', content: prompt }, { role: 'user', content: '生成可预览的地点增量' }] })
  const json = extractJsonObject(raw)
  if (!json) throw new Error('模型没有返回有效地点JSON')
  const draft = validateLocationExpansion(JSON.parse(json), world.worldVersion, new Set(locations.map((item) => item.id)))
  const roots = draft.locations.filter((item) => item.parentId === 'city')
  for (const root of roots) if (!root.allowedTerrains?.length || !root.buildingCategory) throw new Error(`建筑根节点 ${root.name} 缺少区域规则或建筑类别`)
  const map = await db.worldMaps.get('active')
  if (!map) throw new Error('地图不存在')
  const placements = placeBuildings(map, roots.map((item) => ({ id: item.id, allowedTerrains: item.allowedTerrains!, buildingCategory: item.buildingCategory! })), locations.flatMap((item) => item.mapBinding ? [item.mapBinding] : []))
  draft.locations = draft.locations.map((item) => ({ ...item, mapBinding: placements.get(item.id) }))
  return draft
}

export async function commitLocationExpansion(draft: LocationExpansionDraft): Promise<void> {
  const world = await ensureWorldInitialized()
  if (world.worldVersion !== draft.worldVersion) throw new Error('地点树已变化，请重新生成预览')
  const now = Date.now()
  await db.transaction('rw', db.worldState, db.locations, db.acousticEdges, async () => {
    const latest = await db.worldState.get('global')
    if (!latest || latest.worldVersion !== draft.worldVersion) throw new Error('地点树已变化，请重新生成预览')
    await db.locations.bulkAdd(draft.locations.map((item) => ({ ...item, worldId: world.worldId, createdAt: now, updatedAt: now })))
    if (draft.acousticEdges.length) await db.acousticEdges.bulkAdd(draft.acousticEdges.map((item) => ({ ...item, id: uuid(), worldId: world.worldId })))
    await db.worldState.update('global', { worldVersion: latest.worldVersion + 1, updatedAt: now })
  })
}
