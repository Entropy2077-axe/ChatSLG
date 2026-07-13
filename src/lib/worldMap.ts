import type { LocationMapBinding, TerrainType, WorldMapRecord } from '../types'

export const MAP_SIZE = 32 as const
export const MAP_GENERATOR_VERSION = 1
export const PLACEMENT_VERSION = 3
export const MIN_BUILDING_CHEBYSHEV_DISTANCE = 3

export const TERRAIN_COLORS: Record<TerrainType, string> = {
  river: '#4AA3DF', grassland: '#7DBE65', beach: '#E8D38A', mountain: '#8A8F98', urban: '#A9A9B3', rural: '#B6C978',
}

export const TERRAIN_LABELS: Record<TerrainType, string> = {
  river: '河流', grassland: '草地', beach: '沙滩', mountain: '山地', urban: '城市', rural: '农村',
}

function seedHash(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

function random01(seed: number, x: number, y: number): number {
  let h = seed ^ Math.imul(x + 374761393, 668265263) ^ Math.imul(y + 1274126177, 2246822519)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

function smooth(t: number): number { return t * t * (3 - 2 * t) }

function valueNoise(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = smooth(x - x0), ty = smooth(y - y0)
  const a = random01(seed, x0, y0), b = random01(seed, x0 + 1, y0)
  const c = random01(seed, x0, y0 + 1), d = random01(seed, x0 + 1, y0 + 1)
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty
}

function fbm(seed: number, x: number, y: number, octaves: number): number {
  let value = 0, amplitude = .5, frequency = 1, total = 0
  for (let i = 0; i < octaves; i++) { value += valueNoise(seed + i * 1013, x * frequency, y * frequency) * amplitude; total += amplitude; amplitude *= .5; frequency *= 2 }
  return value / total
}

function index(x: number, y: number): number { return y * MAP_SIZE + x }
function coordinates(i: number): [number, number] { return [i % MAP_SIZE, Math.floor(i / MAP_SIZE)] }

export function generateTerrain(seedText: string): TerrainType[] {
  const seed = seedHash(seedText)
  const elevations = Array.from({ length: MAP_SIZE * MAP_SIZE }, (_, i) => {
    const [x, y] = coordinates(i)
    const dx = (x - 15.5) / 22, dy = (y - 15.5) / 22
    return fbm(seed, x / 10, y / 10, 4) * .82 + Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy)) * .18
  })
  const sorted = [...elevations].sort((a, b) => a - b)
  const mountainThreshold = sorted[Math.floor(sorted.length * .82)]
  const tiles: TerrainType[] = elevations.map((height) => height >= mountainThreshold ? 'mountain' : 'grassland')

  const candidates = elevations.map((height, i) => ({ i, height })).filter(({ i }) => {
    const [x, y] = coordinates(i); return x > 5 && x < 26 && y > 5 && y < 26
  }).sort((a, b) => b.height - a.height)
  let current = candidates[0]?.i ?? index(16, 16)
  const river = new Set<number>()
  for (let step = 0; step < 90; step++) {
    river.add(current)
    const [x, y] = coordinates(current)
    if (x === 0 || y === 0 || x === MAP_SIZE - 1 || y === MAP_SIZE - 1) break
    const neighbors: number[] = []
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) neighbors.push(index(x + dx, y + dy))
    const next = neighbors.filter((i) => !river.has(i)).sort((a, b) => {
      const [ax, ay] = coordinates(a), [bx, by] = coordinates(b)
      const edgeA = Math.min(ax, ay, 31 - ax, 31 - ay), edgeB = Math.min(bx, by, 31 - bx, 31 - by)
      return (elevations[a] * 2 + edgeA * .016 + random01(seed + 77, ax, ay) * .05) - (elevations[b] * 2 + edgeB * .016 + random01(seed + 77, bx, by) * .05)
    })[0]
    if (next === undefined) break
    current = next
  }
  for (const i of river) tiles[i] = 'river'
  for (const i of river) {
    const [x, y] = coordinates(i)
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy
      if (nx >= 0 && ny >= 0 && nx < 32 && ny < 32 && tiles[index(nx, ny)] === 'grassland') tiles[index(nx, ny)] = 'beach'
    }
  }

  const flat = tiles.map((tile, i) => ({ i, tile, score: fbm(seed + 9001, (i % 32) / 12, Math.floor(i / 32) / 12, 3) }))
    .filter((item) => item.tile === 'grassland').sort((a, b) => b.score - a.score)
  const urbanSeeds = flat.slice(0, Math.max(1, Math.floor(flat.length * .12)))
  for (const item of urbanSeeds) tiles[item.i] = 'urban'
  const rural = flat.filter((item) => tiles[item.i] === 'grassland').sort((a, b) => {
    const [ax, ay] = coordinates(a.i), [bx, by] = coordinates(b.i)
    const nearUrban = (x: number, y: number) => urbanSeeds.reduce((best, u) => { const [ux, uy] = coordinates(u.i); return Math.min(best, Math.abs(x - ux) + Math.abs(y - uy)) }, 99)
    return nearUrban(ax, ay) - nearUrban(bx, by)
  }).slice(0, Math.max(1, Math.floor(flat.length * .22)))
  for (const item of rural) tiles[item.i] = 'rural'

  const fallbacks: Array<[TerrainType, number]> = [['river', index(16, 16)], ['beach', index(17, 16)], ['mountain', index(3, 3)], ['urban', index(23, 23)], ['rural', index(8, 23)], ['grassland', index(15, 23)]]
  for (const [terrain, at] of fallbacks) if (!tiles.includes(terrain)) tiles[at] = terrain
  return tiles
}

export function createWorldMap(seed: string, mode: 'fixed' | 'custom', worldId: string): WorldMapRecord {
  const now = Date.now()
  return { id: 'active', worldId, width: MAP_SIZE, height: MAP_SIZE, seed, generatorVersion: MAP_GENERATOR_VERSION, placementVersion: PLACEMENT_VERSION, mode, tiles: generateTerrain(seed), createdAt: now, updatedAt: now }
}

export interface BuildingPlacementSpec {
  id: string
  allowedTerrains: TerrainType[]
  buildingCategory: string
}

export function placeBuildings(map: WorldMapRecord, specs: BuildingPlacementSpec[], existing: LocationMapBinding[] = []): Map<string, LocationMapBinding> {
  const seed = seedHash(map.seed + ':buildings')
  const farEnough = (x: number, y: number, bindings: LocationMapBinding[]) => bindings.every((item) => Math.max(Math.abs(item.x - x), Math.abs(item.y - y)) >= MIN_BUILDING_CHEBYSHEV_DISTANCE)
  const candidatesFor = (spec: BuildingPlacementSpec) => map.tiles
    .map((terrain, i) => ({ terrain, i, x: i % map.width, y: Math.floor(i / map.width) }))
    .filter((item) => spec.allowedTerrains.includes(item.terrain) && farEnough(item.x, item.y, existing))
    .sort((a, b) => random01(seedHash(spec.id) ^ seed, a.x, a.y) - random01(seedHash(spec.id) ^ seed, b.x, b.y) || a.i - b.i)
  const ordered = specs.map((spec) => ({ spec, candidates: candidatesFor(spec) }))
    .sort((a, b) => a.candidates.length - b.candidates.length || a.spec.id.localeCompare(b.spec.id))
  const chosen = new Map<string, LocationMapBinding>()
  const placed = [...existing]
  function solve(index: number): boolean {
    if (index >= ordered.length) return true
    const { spec, candidates } = ordered[index]
    for (const candidate of candidates) {
      if (!farEnough(candidate.x, candidate.y, placed)) continue
      const binding = { x: candidate.x, y: candidate.y, allowedTerrains: [...spec.allowedTerrains], buildingCategory: spec.buildingCategory }
      chosen.set(spec.id, binding); placed.push(binding)
      if (solve(index + 1)) return true
      placed.pop(); chosen.delete(spec.id)
    }
    return false
  }
  if (!solve(0)) throw new Error(`建筑布局无解：所有建筑必须横向、纵向或斜向至少间隔 ${MIN_BUILDING_CHEBYSHEV_DISTANCE} 格`)
  return new Map(specs.map((spec) => [spec.id, chosen.get(spec.id)!]))
}

export function terrainAt(map: WorldMapRecord, x: number, y: number): TerrainType | undefined {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= map.width || y >= map.height) return undefined
  return map.tiles[y * map.width + x]
}
