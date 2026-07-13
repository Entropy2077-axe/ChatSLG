import { describe, expect, it } from 'vitest'
import { createWorldMap, generateTerrain, MIN_BUILDING_CHEBYSHEV_DISTANCE, placeBuildings, terrainAt } from './worldMap'

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
})
