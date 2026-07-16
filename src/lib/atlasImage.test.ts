import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db/db'
import { atlasRequestBody, buildAtlasPrompt, fetchAtlasBalance, refreshQueuedAtlasPrompt } from './atlasImage'
import type { AppSettings, Contact } from '../types'

afterEach(() => vi.unstubAllGlobals())
beforeEach(async () => { await db.open(); await db.mediaAssets.clear() })

describe('Atlas billing API', () => {
  it('reads the available account balance with the configured API key', async () => {
    const payload = {
      available: { value: '12.500000', currency: 'usd' },
      cash: { value: '10.000000', currency: 'usd' },
      bonus: { value: '2.500000', currency: 'usd' },
      subscription_bonus: { value: '0.000000', currency: 'usd' },
      frozen: { value: '0.000000', currency: 'usd' },
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchAtlasBalance('apikey-test')).resolves.toMatchObject({ available: payload.available })
    expect(fetchMock).toHaveBeenCalledWith('https://api.atlascloud.ai/public/v1/balance', { headers: { Authorization: 'Bearer apikey-test' } })
  })

  it('turns missing billing permission into a useful message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'forbidden' } }), { status: 403 })))
    await expect(fetchAtlasBalance('apikey-test')).rejects.toThrow('没有余额读取权限')
  })
})

describe('Atlas model request bodies', () => {
  it('uses only supported Imagen 4 aspect ratios', () => {
    expect(atlasRequestBody('google/imagen4-fast', 'p', '1536*1024', 7)).toMatchObject({ aspect_ratio: '16:9', seed: 7 })
    expect(atlasRequestBody('google/imagen4-fast', 'p', '1024*1024', 7)).toMatchObject({ aspect_ratio: '1:1' })
    expect(atlasRequestBody('google/imagen4-fast', 'p', '1024*1536', 7)).toMatchObject({ aspect_ratio: '9:16' })
  })

  it('builds model-specific bodies', () => {
    expect(atlasRequestBody('z-image/turbo', 'p', '1024*1536', 9)).toMatchObject({ size: '1024*1536', seed: 9, enable_base64_output: true })
    expect(atlasRequestBody('qwen/qwen-image-2.0/text-to-image', 'p', '1024*1024', 3)).toEqual({ model: 'qwen/qwen-image-2.0/text-to-image', prompt: 'p', size: '1024*1024', seed: 3 })
    expect(atlasRequestBody('bytedance/seedream-v4', 'p', '1536*1024', 3)).toEqual({ model: 'bytedance/seedream-v4', prompt: 'p', size: '1536*1024', enable_base64_output: false })
  })

  it('does not force people into object or scene images', () => {
    const contact = { id: 'c', name: 'C', systemPrompt: '', avatar: '', avatarColor: '', createdAt: 1, memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 0, memoryMessageCursor: 0, relationshipBase: '朋友', relationshipDynamic: '', visualIdentity: 'adult woman with black hair' } as Contact
    const settings = { imageVisualStyle: 'realistic', realisticFacePreference: 'auto' } as AppSettings
    expect(buildAtlasPrompt(contact, settings, { type: 'image', kind: 'object', scene: 'a cup', aspectRatio: 'square' })).toContain('No person')
    expect(buildAtlasPrompt(contact, settings, { type: 'image', kind: 'scene', scene: 'a park', aspectRatio: 'landscape' })).toContain('Do not force a person')
  })

  it('uses the latest structured outfit and excludes outfit metadata', () => {
    const contact = {
      id: 'c', name: 'C', systemPrompt: '', avatar: '', avatarColor: '', createdAt: 1,
      memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 0, memoryMessageCursor: 0,
      relationshipBase: 'friend', relationshipDynamic: '', visualIdentity: 'adult woman with black hair',
      outfit: { head: 'black hair', top: 'white shirt', bottom: 'jeans', outerwear: 'none', footwear: 'sneakers', accessories: 'none', updatedAt: 987654321, sourceEventIds: ['event-secret'] },
    } as Contact
    const settings = { imageVisualStyle: 'realistic', realisticFacePreference: 'auto' } as AppSettings
    const prompt = buildAtlasPrompt(contact, settings, { type: 'image', kind: 'outfit', scene: 'standing by a window after taking off her coat', aspectRatio: 'portrait' })
    expect(prompt).toContain('outerwear: none')
    expect(prompt).not.toContain('987654321')
    expect(prompt).not.toContain('event-secret')
  })

  it('does not inject current clothing into a historical photo', () => {
    const contact = {
      id: 'c', name: 'C', systemPrompt: '', avatar: '', avatarColor: '', createdAt: 1,
      memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 0, memoryMessageCursor: 0,
      relationshipBase: 'friend', relationshipDynamic: '', visualIdentity: 'adult woman with black hair',
      outfit: { head: 'black hair', top: 'red sweater', bottom: 'jeans', outerwear: 'black coat', footwear: 'boots', accessories: 'none', updatedAt: 2, sourceEventIds: [] },
    } as Contact
    const settings = { imageVisualStyle: 'realistic', realisticFacePreference: 'auto' } as AppSettings
    const prompt = buildAtlasPrompt(contact, settings, { type: 'image', kind: 'selfie', outfitSource: 'scene', scene: 'a previous weekend photo under cherry blossoms, wearing a white shirt', aspectRatio: 'portrait' })
    expect(prompt).toContain('Clothing must follow the Scene description only')
    expect(prompt).not.toContain('black coat')
    expect(prompt).not.toContain('red sweater')
  })

  it('rebases a queued prompt from the post-adjudication outfit before submission', async () => {
    await db.mediaAssets.add({ id: 'asset', ownerContactId: 'c', source: 'atlas', origin: 'chat', originId: 'message', status: 'queued', phase: 'queued', traceEvents: [], prompt: 'Current clothing: outerwear: black coat', width: 1024, height: 1536, sensitive: false, createdAt: 1 })
    const contact = {
      id: 'c', name: 'C', systemPrompt: '', avatar: '', avatarColor: '', createdAt: 1,
      memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 0, memoryMessageCursor: 0,
      relationshipBase: 'friend', relationshipDynamic: '', visualIdentity: 'adult woman with black hair',
      outfit: { head: 'black hair', top: 'white shirt', bottom: 'jeans', outerwear: 'none', footwear: 'sneakers', accessories: 'none', updatedAt: 2, sourceEventIds: ['current-turn'] },
    } as Contact
    const settings = { imageVisualStyle: 'realistic', realisticFacePreference: 'auto' } as AppSettings
    await refreshQueuedAtlasPrompt('asset', contact, settings, { type: 'image', kind: 'outfit', scene: 'standing without her coat', aspectRatio: 'portrait' })
    const refreshed = await db.mediaAssets.get('asset')
    expect(refreshed?.prompt).toContain('outerwear: none')
    expect(refreshed?.prompt).not.toContain('outerwear: black coat')
  })
})
