import { describe, expect, it } from 'vitest'
import { validateLocationExpansion } from './locationExpansion'

describe('AI location expansion validation', () => {
  it('accepts a legal additive draft', () => {
    const draft = validateLocationExpansion({
      worldVersion: 2,
      locations: [{ id: 'mall-bookstore', parentId: 'mall', name: '书店', kind: 'shop', description: '安静的书店', access: 'public', sortOrder: 1 }],
      acousticEdges: [{ fromLocationId: 'mall-bookstore', toLocationId: 'mall-atrium', audibility: 'muffled', bidirectional: true }],
    }, 2, new Set(['mall', 'mall-atrium']))
    expect(draft.locations[0].id).toBe('mall-bookstore')
  })

  it('rejects invented parents, stale versions, and duplicate IDs', () => {
    const base = { locations: [{ id: 'new-place', parentId: 'missing', name: '新地点', kind: 'custom', description: '描述', access: 'public', sortOrder: 1 }], acousticEdges: [] }
    expect(() => validateLocationExpansion({ ...base, worldVersion: 1 }, 2, new Set(['city']))).toThrow(/版本/)
    expect(() => validateLocationExpansion({ ...base, worldVersion: 2 }, 2, new Set(['city']))).toThrow(/父级/)
    expect(() => validateLocationExpansion({ ...base, worldVersion: 2, locations: [{ ...base.locations[0], id: 'city', parentId: undefined }] }, 2, new Set(['city']))).toThrow(/重复/)
  })

  it('rejects acoustic edges that reference outside locations', () => {
    expect(() => validateLocationExpansion({
      worldVersion: 2,
      locations: [{ id: 'new-place', parentId: 'city', name: '新地点', kind: 'custom', description: '描述', access: 'public', sortOrder: 1 }],
      acousticEdges: [{ fromLocationId: 'new-place', toLocationId: 'invented', audibility: 'clear', bidirectional: true }],
    }, 2, new Set(['city']))).toThrow(/声学连接/)
  })
})
