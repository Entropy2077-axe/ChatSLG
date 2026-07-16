import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type { MediaAsset, MediaAssetOrigin } from '../types'

export async function archivePexelsImage(input: { ownerContactId?: string; origin: MediaAssetOrigin; originId: string; url: string; photographer?: string; photographerUrl?: string }): Promise<MediaAsset> {
  const existing = await db.mediaAssets.where('[origin+originId]').equals([input.origin, input.originId]).first()
  if (existing) return existing
  const asset: MediaAsset = { id: uuid(), ownerContactId: input.ownerContactId, source: 'pexels', origin: input.origin, originId: input.originId, status: 'completed', remoteUrl: input.url, photographer: input.photographer, photographerUrl: input.photographerUrl, createdAt: Date.now(), completedAt: Date.now() }
  await db.mediaAssets.add(asset)
  return asset
}

export async function moveAssetToTrash(id: string) { await db.mediaAssets.update(id, { deletedAt: Date.now() }) }
export async function restoreAsset(id: string) { await db.mediaAssets.update(id, { deletedAt: undefined }) }
export async function permanentlyDeleteAsset(id: string) {
  const asset = await db.mediaAssets.get(id)
  if (!asset) return
  if (asset.origin === 'chat') await db.messages.update(asset.originId, { image: { assetId: id, status: 'failed', caption: '图片已删除' } })
  if (asset.origin === 'moment') await db.moments.update(asset.originId, { imageUrl: undefined, mediaAssetId: undefined })
  await db.mediaAssets.delete(id)
}
