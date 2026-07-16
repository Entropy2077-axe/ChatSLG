import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type {
  AcousticEdge,
  Audibility,
  CharacterSchedule,
  Contact,
  LocationNode,
  TimeSlot,
  WorldState,
  WorldMapRecord,
} from '../types'
import { createWorldMap, MIN_BUILDING_CHEBYSHEV_DISTANCE, PLACEMENT_VERSION, placeBuildings, terrainAt } from './worldMap'
import { defaultOutfit } from './outfit'

export const TIME_SLOTS: Array<{ slot: TimeSlot; hour: 8 | 12 | 18 | 22; label: string }> = [
  { slot: 'morning', hour: 8, label: '早晨' },
  { slot: 'day', hour: 12, label: '白天' },
  { slot: 'evening', hour: 18, label: '傍晚' },
  { slot: 'night', hour: 22, label: '夜晚' },
]

const DEFAULT_WORLD_ID = 'default-modern-world'

function node(id: string, parentId: string | undefined, name: string, kind: string, description: string, sortOrder: number, access: LocationNode['access'] = 'public'): LocationNode {
  const now = Date.now()
  return { id, worldId: DEFAULT_WORLD_ID, parentId, name, kind, description, access, sortOrder, createdAt: now, updatedAt: now }
}

const APARTMENT_ROOMS = [203, 306, 408, 502, 607, 705, 809, 903, 1006, 1102, 1208, 1505]
  .map((room, index) => node(
    `apartment-room-${room}`,
    'apartment',
    `${room}室`,
    'apartment-room',
    `独立公寓住宅，位于${Math.floor(room / 100)}层。适合不与玩家同住的角色长期居住；除非人设明确合租，否则不要让其他角色共用此房间。`,
    62 + index,
    'private',
  ))

export const DEFAULT_LOCATIONS: LocationNode[] = [
  node('city', undefined, '城市', 'world', '当前世界的公共区域。', 0),
  node('home', 'city', '玩家的家', 'residence', '玩家自己的私人住所。只有家人、伴侣、室友或人设明确与玩家同住的角色才适合长期住在这里，普通朋友和陌生人不能默认住入。', 10, 'private'),
  node('home-living', 'home', '客厅', 'living-room', '玩家住所的公共活动区域，仅供确实与玩家同住或受邀来访的角色使用。', 11, 'private'),
  node('home-kitchen', 'home', '厨房', 'kitchen', '与客厅相连的开放式厨房。', 12),
  node('home-bedroom', 'home', '卧室', 'bedroom', '私密休息空间，隔门只能模糊听见客厅动静。', 13),
  node('school', 'city', '临江高中', 'high-school', '面向高中生的校园，拥有教室、走廊、食堂和操场。', 20, 'restricted'),
  node('school-classroom', 'school', '教室', 'classroom', '上课和自习的空间。', 21),
  node('school-corridor', 'school', '走廊', 'corridor', '连接教学区域的公共通道。', 22),
  node('school-canteen', 'school', '食堂', 'canteen', '学生和教职工用餐的公共区域。', 23),
  node('school-playground', 'school', '操场', 'playground', '适合体育课和课外活动的开阔场地。', 24),
  node('mall', 'city', '商场', 'mall', '开放且嘈杂的商业空间。', 30),
  node('mall-atrium', 'mall', '中庭', 'atrium', '商场人流汇集的公共区域。', 31),
  node('mall-cafe', 'mall', '咖啡店', 'cafe', '适合见面和聊天的店铺。', 32),
  node('mall-shop', 'mall', '商店', 'shop', '陈列商品的零售空间。', 33),
  node('hospital', 'city', '医院', 'hospital', '提供门诊、住院和公共服务的综合医院。', 40),
  node('hospital-lobby', 'hospital', '医院大厅', 'lobby', '患者与访客进出的公共大厅。', 41),
  node('hospital-clinic', 'hospital', '门诊室', 'clinic', '医生接诊和检查的房间。', 42),
  node('hospital-ward', 'hospital', '病房', 'ward', '住院休息和护理的安静区域。', 43),
  node('apartment', 'city', '栖岸公寓', 'apartment', '面向城市居民的公寓楼，包含十二间分布在不同楼层的独立住宅。', 60, 'restricted'),
  node('apartment-hallway', 'apartment', '公寓走廊', 'hallway', '连接电梯与各住户房门的公共走廊，只能模糊听见房间内有人交谈。', 61, 'restricted'),
  ...APARTMENT_ROOMS,
  node('bar', 'city', '夜航酒吧', 'bar', '夜间营业的城市酒吧，适合成年人聚会、演出和社交。', 80),
  node('hotel', 'city', '云庭酒店', 'hotel', '接待旅客和临时住宿者的城市酒店，不应替代普通居民的长期住所。', 90),
  node('hotel-lobby', 'hotel', '酒店大堂', 'hotel-lobby', '办理入住、等候和短暂会面的公共区域。', 91),
  node('hotel-room', 'hotel', '客房', 'hotel-room', '供住客临时休息的标准客房。', 92, 'private'),
  node('hotel-restaurant', 'hotel', '酒店餐厅', 'restaurant', '面向住客与访客开放的餐厅。', 93),
  node('university', 'city', '东川大学', 'university', '拥有教学、研究和校园生活设施的综合大学。', 100),
  node('university-classroom', 'university', '大学教室', 'classroom', '大学课程与讲座使用的教室。', 101),
  node('university-library', 'university', '大学图书馆', 'library', '安静的学习、借阅和研究空间。', 102),
  node('university-canteen', 'university', '大学食堂', 'canteen', '师生集中用餐的公共区域。', 103),
  node('university-dorm', 'university', '大学宿舍', 'dormitory', '仅适合住校大学生长期居住的集体宿舍。', 104, 'restricted'),
  node('primary-school', 'city', '青禾小学', 'primary-school', '面向小学生的基础教育校园。', 110, 'restricted'),
  node('primary-classroom', 'primary-school', '小学教室', 'classroom', '小学生上课的教室。', 111, 'restricted'),
  node('primary-playground', 'primary-school', '小学操场', 'playground', '课间活动和体育课使用的操场。', 112, 'restricted'),
  node('middle-school', 'city', '明远初中', 'middle-school', '面向初中生的校园。', 120, 'restricted'),
  node('middle-classroom', 'middle-school', '初中教室', 'classroom', '初中课程使用的教室。', 121, 'restricted'),
  node('middle-playground', 'middle-school', '初中操场', 'playground', '体育课和课外活动区域。', 122, 'restricted'),
  node('grass-park', 'city', '原野公园', 'grassland-park', '建在开阔草地区域的自然公园。', 130),
  node('grass-park-lawn', 'grass-park', '中央草坪', 'lawn', '适合散步、野餐和户外活动的开阔草坪。', 131),
  node('grass-park-camp', 'grass-park', '露营地', 'campground', '配有基础设施的草地露营区。', 132),
  node('mountain-scenic', 'city', '雾岭景区', 'mountain-scenic', '位于山地区域的登山与观景设施。', 140),
  node('mountain-trail', 'mountain-scenic', '登山步道', 'mountain-trail', '连接山脚与观景区域的步道。', 141),
  node('mountain-lookout', 'mountain-scenic', '山顶观景台', 'lookout', '可以俯瞰城市和河流的山地观景设施。', 142),
  node('beach-resort', 'city', '白沙湾', 'beach-facility', '位于沙滩区域的公共休闲设施。', 150),
  node('beach-boardwalk', 'beach-resort', '海滨步道', 'boardwalk', '沿沙滩铺设的步行区域。', 151),
  node('beach-shop', 'beach-resort', '海滨小店', 'beach-shop', '出售饮品和沙滩用品的小店。', 152),
  node('river-park', 'city', '临河公园', 'river-facility', '依托河流区域建设的亲水公共空间。', 160),
  node('river-pier', 'river-park', '河畔码头', 'pier', '靠近水面的停靠与观景平台。', 161),
  node('river-walk', 'river-park', '滨河步道', 'river-walk', '沿河设置的步行和慢跑区域。', 162),
  node('farm', 'city', '晴川农场', 'farm', '位于农村区域的生产与生活设施。', 170, 'restricted'),
  node('farm-field', 'farm', '农田', 'farmland', '种植和农事活动区域。', 171, 'restricted'),
  node('farm-house', 'farm', '农舍', 'farmhouse', '适合农场经营者及其家人居住的住宅。', 172, 'private'),
]

export const DEFAULT_WORLD_MAP = createWorldMap('chatslg-fixed-modern-v1', 'fixed', DEFAULT_WORLD_ID)
export const DEFAULT_BUILDING_SPECS = [
  { id: 'home', allowedTerrains: ['urban', 'rural'], buildingCategory: 'residence' },
  { id: 'school', allowedTerrains: ['urban'], buildingCategory: 'school' },
  { id: 'mall', allowedTerrains: ['urban'], buildingCategory: 'mall' },
  { id: 'hospital', allowedTerrains: ['urban'], buildingCategory: 'hospital' },
  { id: 'apartment', allowedTerrains: ['urban'], buildingCategory: 'apartment' },
  { id: 'bar', allowedTerrains: ['urban'], buildingCategory: 'bar' },
  { id: 'hotel', allowedTerrains: ['urban'], buildingCategory: 'hotel' },
  { id: 'university', allowedTerrains: ['urban'], buildingCategory: 'university' },
  { id: 'primary-school', allowedTerrains: ['urban', 'rural'], buildingCategory: 'primary-school' },
  { id: 'middle-school', allowedTerrains: ['urban', 'rural'], buildingCategory: 'middle-school' },
  { id: 'grass-park', allowedTerrains: ['grassland'], buildingCategory: 'park' },
  { id: 'mountain-scenic', allowedTerrains: ['mountain'], buildingCategory: 'scenic' },
  { id: 'beach-resort', allowedTerrains: ['beach'], buildingCategory: 'beach-facility' },
  { id: 'river-park', allowedTerrains: ['river'], buildingCategory: 'river-facility' },
  { id: 'farm', allowedTerrains: ['rural'], buildingCategory: 'farm' },
] satisfies Array<{ id: string; allowedTerrains: import('../types').TerrainType[]; buildingCategory: string }>

const DEFAULT_BINDINGS = placeBuildings(DEFAULT_WORLD_MAP, DEFAULT_BUILDING_SPECS)
for (const location of DEFAULT_LOCATIONS) {
  const binding = DEFAULT_BINDINGS.get(location.id)
  if (binding) location.mapBinding = binding
}

function edge(from: string, to: string, audibility: Audibility): AcousticEdge {
  return { id: `${from}:${to}`, worldId: DEFAULT_WORLD_ID, fromLocationId: from, toLocationId: to, audibility, bidirectional: true }
}

export const DEFAULT_ACOUSTIC_EDGES: AcousticEdge[] = [
  edge('home-living', 'home-kitchen', 'clear'),
  edge('home-living', 'home-bedroom', 'muffled'),
  edge('school-classroom', 'school-corridor', 'muffled'),
  edge('mall-atrium', 'mall-cafe', 'muffled'),
  edge('mall-atrium', 'mall-shop', 'muffled'),
  ...APARTMENT_ROOMS.map((room) => edge('apartment-hallway', room.id, 'muffled')),
  edge('hotel-lobby', 'hotel-restaurant', 'clear'),
  edge('university-classroom', 'university-library', 'muffled'),
  edge('grass-park-lawn', 'grass-park-camp', 'muffled'),
  edge('beach-boardwalk', 'beach-shop', 'clear'),
  edge('river-pier', 'river-walk', 'clear'),
]

let worldInitializationPromise: Promise<void> | undefined

async function initializeWorldStorage(): Promise<void> {
  const existing = await db.worldState.get('global')
  if (existing) {
    if (!(await db.worldMaps.get('active'))) await db.worldMaps.put({ ...DEFAULT_WORLD_MAP, worldId: existing.worldId, updatedAt: Date.now() })
    let currentLocations = await db.locations.toArray()
    if (existing.worldId === DEFAULT_WORLD_ID) {
      const knownLocationIds = new Set(currentLocations.map((item) => item.id))
      const missingLocations = DEFAULT_LOCATIONS.filter((item) => !knownLocationIds.has(item.id))
      const knownEdgeIds = new Set((await db.acousticEdges.toArray()).map((item) => item.id))
      const missingEdges = DEFAULT_ACOUSTIC_EDGES.filter((item) => !knownEdgeIds.has(item.id))
      if (missingLocations.length || missingEdges.length) {
        await db.transaction('rw', db.locations, db.acousticEdges, db.worldState, async () => {
          if (missingLocations.length) await db.locations.bulkPut(missingLocations.map((item) => ({ ...item, createdAt: Date.now(), updatedAt: Date.now() })))
          if (missingEdges.length) await db.acousticEdges.bulkPut(missingEdges)
          await db.worldState.update('global', { worldVersion: existing.worldVersion + 1, updatedAt: Date.now() })
        })
        currentLocations = await db.locations.toArray()
      }
    }
    const currentMap = await db.worldMaps.get('active')
    if (currentMap && currentMap.placementVersion !== PLACEMENT_VERSION) {
      const roots = currentLocations.filter((item) => item.mapBinding)
      try {
        const placements = placeBuildings(currentMap, roots.map((item) => ({ id: item.id, allowedTerrains: item.mapBinding!.allowedTerrains, buildingCategory: item.mapBinding!.buildingCategory })))
        const now = Date.now()
        await db.transaction('rw', db.locations, db.worldMaps, db.worldState, async () => {
          for (const root of roots) await db.locations.update(root.id, { mapBinding: placements.get(root.id), updatedAt: now })
          await db.worldMaps.update('active', { placementVersion: PLACEMENT_VERSION, placementBlocked: false, placementConflicts: [], updatedAt: now })
          await db.worldState.update('global', { worldVersion: existing.worldVersion + 1, updatedAt: now })
        })
      } catch {
        const conflicts: string[] = []
        for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
          const a = roots[i].mapBinding!, b = roots[j].mapBinding!
          if (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) < MIN_BUILDING_CHEBYSHEV_DISTANCE) conflicts.push(`${roots[i].name} / ${roots[j].name}`)
        }
        await db.worldMaps.update('active', { placementVersion: PLACEMENT_VERSION, placementBlocked: true, placementConflicts: conflicts, updatedAt: Date.now() })
      }
    }
    for (const location of currentLocations) {
      const binding = DEFAULT_BINDINGS.get(location.id)
      if (binding && !location.mapBinding) await db.locations.update(location.id, { mapBinding: binding, updatedAt: Date.now() })
    }
    const leafReplacement = (id: string) => isLeafInTree(id, currentLocations) ? id : leafDescendants(id, currentLocations)[0]?.id
    const playerLeaf = leafReplacement(existing.playerLocationId)
    if (playerLeaf && playerLeaf !== existing.playerLocationId) await db.worldState.update('global', { playerLocationId: playerLeaf, updatedAt: Date.now() })
    const contacts = await db.contacts.toArray()
    for (const contact of contacts) {
      if (!contact.outfit) await db.contacts.update(contact.id, { outfit: defaultOutfit(contact.createdAt) })
      if (!contact.currentLocationId) continue
      const replacement = leafReplacement(contact.currentLocationId)
      if (replacement && replacement !== contact.currentLocationId) await db.contacts.update(contact.id, { currentLocationId: replacement })
    }
    const allSchedules = await db.characterSchedules.toArray()
    for (const schedule of allSchedules) {
      const replacement = leafReplacement(schedule.locationId)
      if (replacement && replacement !== schedule.locationId) await db.characterSchedules.update(schedule.id, { locationId: replacement })
    }
    const fallbackLabels: Record<TimeSlot, string> = { morning: '日常起居', day: '日常活动', evening: '自由安排', night: '休息' }
    const fallbackRows: CharacterSchedule[] = []
    for (const contact of contacts) {
      const base = allSchedules.filter((item) => item.characterId === contact.id && item.priority === 'base')
      if (hasCompleteWeeklySchedule(base)) continue
      for (const slot of ['morning', 'day', 'evening', 'night'] as TimeSlot[]) {
        if (base.some((item) => item.slot === slot && item.dayOfWeek === undefined)) continue
        const template = base.find((item) => item.slot === slot)
        const locationId = leafReplacement(template?.locationId ?? contact.currentLocationId ?? '') ?? playerLeaf ?? 'home-living'
        fallbackRows.push({
          id: uuid(), characterId: contact.id, slot, locationId,
          activity: template?.activity || fallbackLabels[slot],
          phoneAccess: template?.phoneAccess ?? 'available', adherence: template?.adherence ?? 'normal',
          priority: 'base', sourceEventIds: [], createdAt: Date.now(),
        })
      }
    }
    if (fallbackRows.length) await db.characterSchedules.bulkAdd(fallbackRows)
    for (const appointment of await db.appointments.toArray()) {
      const replacement = leafReplacement(appointment.locationId)
      if (replacement && replacement !== appointment.locationId) await db.appointments.update(appointment.id, { locationId: replacement })
    }
    return
  }
  await db.transaction('rw', db.worldState, db.locations, db.acousticEdges, db.worldMaps, async () => {
    await db.locations.bulkPut(DEFAULT_LOCATIONS)
    await db.acousticEdges.bulkPut(DEFAULT_ACOUSTIC_EDGES)
    await db.worldMaps.put(DEFAULT_WORLD_MAP)
    await db.worldState.put({
      id: 'global', worldId: DEFAULT_WORLD_ID, worldVersion: 1,
      day: 1, slot: 'morning', hour: 8, step: 0,
      playerLocationId: 'home-living', advancing: false, updatedAt: Date.now(),
    })
  })
}

/** Runs migrations/repairs once per app lifetime, then keeps hot-path reads to
 * one indexed worldState lookup. The stored state itself is never cached, so
 * advancing time or creating a new world is reflected immediately. */
export async function ensureWorldInitialized(): Promise<WorldState> {
  if (!worldInitializationPromise) {
    worldInitializationPromise = initializeWorldStorage().catch((error) => {
      worldInitializationPromise = undefined
      throw error
    })
  }
  await worldInitializationPromise
  const current = await db.worldState.get('global')
  if (current) {
    // Tests, imports and restore flows can replace a world after the one-time
    // promise resolved. A stale pre-v3 map is a cheap indexed signal that the
    // migration must be re-armed without restoring full-table scans to every
    // normal chat turn.
    if (current.worldId === DEFAULT_WORLD_ID && current.worldVersion < 2) {
      const map = await db.worldMaps.get('active')
      if (map?.placementVersion !== PLACEMENT_VERSION) {
        worldInitializationPromise = undefined
        return ensureWorldInitialized()
      }
    }
    return current
  }
  // A backup restore/new-world transaction may clear the table while the app
  // remains open. Re-arm initialization instead of returning stale state.
  worldInitializationPromise = undefined
  return ensureWorldInitialized()
}

export function nextWorldClock(current: WorldState): Pick<WorldState, 'day' | 'slot' | 'hour' | 'step'> {
  const index = TIME_SLOTS.findIndex((item) => item.slot === current.slot)
  const next = TIME_SLOTS[(index + 1) % TIME_SLOTS.length]
  return { day: current.day + (next.slot === 'morning' ? 1 : 0), slot: next.slot, hour: next.hour, step: current.step + 1 }
}

export function slotLabel(slot: TimeSlot): string {
  return TIME_SLOTS.find((item) => item.slot === slot)?.label ?? slot
}

export async function movePlayer(locationId: string): Promise<void> {
  const state = await ensureWorldInitialized()
  const location = await db.locations.get(locationId)
  if (!location || location.worldId !== state.worldId) throw new Error('地点不存在')
  if (!(await isLeafLocation(locationId))) throw new Error('只能进入没有子地点的叶子地点')
  await db.worldState.update('global', { playerLocationId: locationId, updatedAt: Date.now() })
}

export async function moveCharacter(characterId: string, locationId: string): Promise<void> {
  const [contact, location] = await Promise.all([db.contacts.get(characterId), db.locations.get(locationId)])
  if (!contact) throw new Error('角色不存在')
  if (!location) throw new Error('地点不存在')
  if (!(await isLeafLocation(locationId))) throw new Error('角色只能移动到叶子地点')
  await db.contacts.update(characterId, { currentLocationId: locationId })
}

export async function audibilityBetween(fromLocationId: string, toLocationId: string): Promise<Audibility> {
  if (fromLocationId === toLocationId) return 'clear'
  const edges = await db.acousticEdges.where('fromLocationId').equals(fromLocationId).toArray()
  const direct = edges.find((item) => item.toLocationId === toLocationId)
  if (direct) return direct.audibility
  const reverse = await db.acousticEdges.where('toLocationId').equals(fromLocationId).toArray()
  return reverse.find((item) => item.bidirectional && item.fromLocationId === toLocationId)?.audibility ?? 'none'
}

export function formatLocationTree(locations: LocationNode[]): string {
  const children = new Map<string | undefined, LocationNode[]>()
  for (const location of locations) {
    const list = children.get(location.parentId) ?? []
    list.push(location)
    children.set(location.parentId, list)
  }
  const lines: string[] = []
  const visit = (parentId: string | undefined, depth: number) => {
    for (const location of [...(children.get(parentId) ?? [])].sort((a, b) => a.sortOrder - b.sortOrder)) {
      const leaf = !(children.get(location.id)?.length)
      const binding = location.mapBinding ? ` | map(${location.mapBinding.x},${location.mapBinding.y}) terrains=${location.mapBinding.allowedTerrains.join(',')}` : ''
      lines.push(`${'  '.repeat(depth)}- ${location.id} | ${location.name} | ${location.kind} | ${location.access} | ${leaf ? 'leaf-enterable' : 'container-not-enterable'}${binding} | ${location.description}`)
      visit(location.id, depth + 1)
    }
  }
  visit(undefined, 0)
  return lines.join('\n')
}

const PRIORITY: Record<CharacterSchedule['priority'], number> = { base: 1, override: 2, commitment: 3 }

export type ScheduleAdherence = NonNullable<CharacterSchedule['adherence']>

export function effectiveScheduleAdherence(schedule: CharacterSchedule): ScheduleAdherence {
  if (schedule.priority === 'commitment' || schedule.priority === 'override') return 'required'
  return schedule.adherence ?? 'normal'
}

export function resolveSchedule(schedules: CharacterSchedule[], day: number, slot: TimeSlot): CharacterSchedule | undefined {
  const dayOfWeek = (day - 1) % 7
  return schedules
    .filter((item) => item.slot === slot && (item.effectiveDay === day || (item.effectiveDay === undefined && (item.dayOfWeek === undefined || item.dayOfWeek === dayOfWeek))))
    .sort((a, b) => PRIORITY[b.priority] - PRIORITY[a.priority]
      || Number(b.effectiveDay === day) - Number(a.effectiveDay === day)
      || Number(b.dayOfWeek === dayOfWeek) - Number(a.dayOfWeek === dayOfWeek)
      || b.createdAt - a.createdAt)[0]
}

export function hasCompleteWeeklySchedule(schedules: Array<Pick<CharacterSchedule, 'dayOfWeek' | 'slot'>>): boolean {
  const covered = new Set(schedules.flatMap((item) => Number.isInteger(item.dayOfWeek)
    ? [`${item.dayOfWeek}:${item.slot}`]
    : []))
  return covered.size === 28
}

export async function schedulesFor(contact: Contact): Promise<CharacterSchedule[]> {
  return db.characterSchedules.where('characterId').equals(contact.id).toArray()
}

export function isLeafInTree(locationId: string, locations: LocationNode[]): boolean {
  return locations.some((item) => item.id === locationId) && !locations.some((item) => item.parentId === locationId)
}

export async function isLeafLocation(locationId: string): Promise<boolean> {
  const [location, child] = await Promise.all([db.locations.get(locationId), db.locations.where('parentId').equals(locationId).first()])
  return !!location && !child
}

export function leafDescendants(locationId: string, locations: LocationNode[]): LocationNode[] {
  const result: LocationNode[] = []
  const visit = (id: string) => {
    const children = locations.filter((item) => item.parentId === id)
    if (!children.length) { const own = locations.find((item) => item.id === id); if (own) result.push(own); return }
    for (const child of children) visit(child.id)
  }
  visit(locationId)
  return result
}

export async function activeWorldMap(): Promise<WorldMapRecord> {
  await ensureWorldInitialized()
  const map = await db.worldMaps.get('active')
  if (!map) throw new Error('世界地图不存在')
  return map
}

export async function addLocation(input: Omit<LocationNode, 'id' | 'worldId' | 'createdAt' | 'updatedAt'>): Promise<LocationNode> {
  const state = await ensureWorldInitialized()
  if (input.parentId && !(await db.locations.get(input.parentId))) throw new Error('父地点不存在')
  if (input.mapBinding) {
    const [map, locations] = await Promise.all([db.worldMaps.get('active'), db.locations.toArray()])
    if (!map) throw new Error('世界地图不存在')
    if (map.placementBlocked) throw new Error(`当前世界的旧建筑布局存在间距冲突：${map.placementConflicts?.join('、') || '请删除冲突建筑或新建世界'}`)
    const terrain = terrainAt(map, input.mapBinding.x, input.mapBinding.y)
    if (!terrain || !input.mapBinding.allowedTerrains.includes(terrain)) throw new Error('建筑坐标与允许区域不匹配')
    for (const location of locations) if (location.mapBinding && Math.max(Math.abs(location.mapBinding.x - input.mapBinding.x), Math.abs(location.mapBinding.y - input.mapBinding.y)) < MIN_BUILDING_CHEBYSHEV_DISTANCE) throw new Error(`建筑距离“${location.name}”太近，必须至少间隔2个完整格子`)
  }
  const now = Date.now()
  const created: LocationNode = { ...input, id: uuid(), worldId: state.worldId, createdAt: now, updatedAt: now }
  await db.transaction('rw', db.locations, db.worldState, async () => {
    await db.locations.add(created)
    await db.worldState.update('global', { worldVersion: state.worldVersion + 1, updatedAt: now })
  })
  return created
}

export async function remapAndDeleteLocation(locationId: string, replacementId: string): Promise<void> {
  const state = await ensureWorldInitialized()
  if (locationId === 'city' || locationId === replacementId) throw new Error('根地点不能删除，替代地点也不能是自身')
  const [target, replacement, locations] = await Promise.all([db.locations.get(locationId), db.locations.get(replacementId), db.locations.toArray()])
  if (!target || !replacement || target.worldId !== state.worldId || replacement.worldId !== state.worldId) throw new Error('地点或替代地点不存在')
  const descendants = new Set<string>()
  const visit = (id: string) => { for (const child of locations.filter((item) => item.parentId === id)) { descendants.add(child.id); visit(child.id) } }
  visit(locationId)
  if (descendants.has(replacementId)) throw new Error('不能用待删除地点的子地点作为替代')
  const [contacts, schedules, appointments, edges] = await Promise.all([
    db.contacts.filter((item) => item.currentLocationId === locationId).toArray(),
    db.characterSchedules.where('locationId').equals(locationId).toArray(),
    db.appointments.where('locationId').equals(locationId).toArray(),
    db.acousticEdges.filter((item) => item.fromLocationId === locationId || item.toLocationId === locationId).toArray(),
  ])
  const now = Date.now()
  await db.transaction('rw', [db.locations, db.contacts, db.characterSchedules, db.appointments, db.acousticEdges, db.worldState], async () => {
    const latest = await db.worldState.get('global')
    if (!latest || latest.worldVersion !== state.worldVersion) throw new Error('地点树已变化，请重新操作')
    for (const contact of contacts) await db.contacts.update(contact.id, { currentLocationId: replacementId })
    for (const schedule of schedules) await db.characterSchedules.update(schedule.id, { locationId: replacementId })
    for (const appointment of appointments) await db.appointments.update(appointment.id, { locationId: replacementId })
    for (const child of locations.filter((item) => item.parentId === locationId)) await db.locations.update(child.id, { parentId: replacementId, updatedAt: now })
    for (const edge of edges) {
      const fromLocationId = edge.fromLocationId === locationId ? replacementId : edge.fromLocationId
      const toLocationId = edge.toLocationId === locationId ? replacementId : edge.toLocationId
      if (fromLocationId === toLocationId) await db.acousticEdges.delete(edge.id)
      else await db.acousticEdges.update(edge.id, { fromLocationId, toLocationId })
    }
    await db.locations.delete(locationId)
    await db.worldState.update('global', {
      playerLocationId: latest.playerLocationId === locationId ? replacementId : latest.playerLocationId,
      worldVersion: latest.worldVersion + 1, updatedAt: now,
    })
  })
}
