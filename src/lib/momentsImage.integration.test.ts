import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import type { AppSettings } from '../types'
import { postUserMoment } from './moments'

beforeEach(async () => {
  await db.open()
  await Promise.all([db.moments.clear(), db.mediaAssets.clear()])
})

describe('user moment photos', () => {
  it('persists a photo-only post as an upload media asset', async () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo='
    await postUserMoment('', { apiKey: '' } as AppSettings, dataUrl)
    const moment = await db.moments.toCollection().first()
    expect(moment).toMatchObject({ contactId: 'user', content: '' })
    expect(moment?.mediaAssetId).toBeTruthy()
    const asset = await db.mediaAssets.get(moment!.mediaAssetId!)
    expect(asset).toMatchObject({ source: 'upload', origin: 'moment', status: 'completed', dataUrl })
  })
})
