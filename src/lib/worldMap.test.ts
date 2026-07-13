import { describe, expect, it } from 'vitest'
import { createWorldMap, generateTerrain, MIN_BUILDING_CHEBYSHEV_DISTANCE, placeBuildings, terrainAt } from './worldMap'
import { DEFAULT_BUILDING_SPECS, DEFAULT_LOCATIONS, DEFAULT_WORLD_MAP } from './world'

describe('seeded 32x32 world map', () => {
  it('is deterministic and always contains all six terrains', () => {
    const first = generateTerrain('same-seed')
    expect(first).toEqual(generateTerrain('same-seed'))
    expect(first).toHaveLength(1024)
    for (const terrain of ['river', 'grassland', 'beach', 'mountain', 'urban', 'rural']) expect(first).toContain(terrain)
  })

  it('places buildings on compatible unique tiles deterministically', () => {
    const map = createWorldMap('placement-seed', 'custom', 'test')
    const specs = [
      { id: 'mall', allowedTerrains: ['urban'] as const, buildingCategory: 'mall' },
      { id: 'farm', allowedTerrains: ['rural'] as const, buildingCategory: 'farm' },
    ]
    const first = placeBuildings(map, specs.map((item) => ({ ...item, allowedTerrains: [...item.allowedTerrains] })))
    const second = placeBuildings(map, specs.map((item) => ({ ...item, allowedTerrains: [...item.allowedTerrains] })))
    expect(first).toEqual(second)
    const bindings = [...first.values()]
    expect(new Set(bindings.map((item) => `${item.x},${item.y}`)).size).toBe(2)
    expect(Math.max(Math.abs(bindings[0].x - bindings[1].x), Math.abs(bindings[0].y - bindings[1].y))).toBeGreaterThanOrEqual(MIN_BUILDING_CHEBYSHEV_DISTANCE)
    expect(terrainAt(map, first.get('mall')!.x, first.get('mall')!.y)).toBe('urban')
    expect(terrainAt(map, first.get('farm')!.x, first.get('farm')!.y)).toBe('rural')
  })

  it('ships a rich valid default world with twelve distinct apartment homes', () => {
    const ids = DEFAULT_LOCATIONS.map((location) => location.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(DEFAULT_LOCATIONS.filter((location) => location.kind === 'apartment-room')).toHaveLength(12)
    for (const id of ['bar', 'hotel', 'university', 'primary-school', 'middle-school', 'school', 'grass-park', 'mountain-scenic', 'beach-resort', 'river-park', 'farm']) {
      expect(ids).toContain(id)
    }
    const roots = DEFAULT_BUILDING_SPECS.map((spec) => DEFAULT_LOCATIONS.find((location) => location.id === spec.id)!)
    expect(roots.every((location) => location?.mapBinding)).toBe(true)
    for (let i = 0; i < roots.length; i++) {
      const binding = roots[i].mapBinding!
      expect(binding.allowedTerrains).toContain(terrainAt(DEFAULT_WORLD_MAP, binding.x, binding.y))
      for (let j = i + 1; j < roots.length; j++) {
        const other = roots[j].mapBinding!
        expect(Math.max(Math.abs(binding.x - other.x), Math.abs(binding.y - other.y))).toBeGreaterThanOrEqual(MIN_BUILDING_CHEBYSHEV_DISTANCE)
      }
    }
  })
})
