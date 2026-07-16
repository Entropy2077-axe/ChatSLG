import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { prepareImageRequest } from './imageRequests'

beforeEach(async () => {
  await db.open()
  await db.imageRequests.clear()
})

describe('pending image request tasks', () => {
  it('expires an older task when a new explicit request arrives', async () => {
    const first = await prepareImageRequest('conv', 'contact', 'm1', '给我拍张照片')
    const second = await prepareImageRequest('conv', 'contact', 'm2', '再发一张穿搭照')
    expect(first).toBeTruthy()
    expect(second?.id).not.toBe(first?.id)
    expect((await db.imageRequests.get(first!.id))?.status).toBe('expired')
    expect((await db.imageRequests.get(second!.id))?.status).toBe('pending')
  })

  it('reactivates a pending request from a direct follow-up and expires after six unrelated turns', async () => {
    const task = await prepareImageRequest('conv', 'contact', 'm1', '给我拍张照片')
    expect((await prepareImageRequest('conv', 'contact', 'm2', '那现在发吧'))?.id).toBe(task?.id)
    for (let index = 0; index < 5; index += 1) await prepareImageRequest('conv', 'contact', `u${index}`, '聊点别的')
    expect((await db.imageRequests.get(task!.id))?.status).toBe('expired')
  })
})
