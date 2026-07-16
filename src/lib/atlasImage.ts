import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type { AiBubbleImage, AppSettings, Contact, MediaAsset, MediaAssetPhase, Message, OutfitState } from '../types'
import { updateImageRequestForAsset } from './imageRequests'
import { ensureContactVisualIdentity } from './contactVisual'

const MODEL_API = 'https://api.atlascloud.ai/api/v1/model'
const BALANCE_API = 'https://api.atlascloud.ai/public/v1/balance'
const activeGenerationIds = new Set<string>()

export interface AtlasMoney { value: string; currency: string }
export interface AtlasBalance {
  available: AtlasMoney
  cash: AtlasMoney
  bonus: AtlasMoney
  subscription_bonus: AtlasMoney
  frozen: AtlasMoney
  account?: { id?: string; name?: string; type?: string }
}

function localDayStart() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }
export async function atlasQuotaAvailable(settings: AppSettings) {
  if (!settings.atlasImageEnabled || !settings.atlasApiKey.trim()) return false
  if (settings.imageDailyLimit <= 0) return true
  const start = localDayStart()
  const assets = await db.mediaAssets.where('source').equals('atlas').toArray()
  const attempts = assets.reduce((total, asset) => total + (asset.submissionTimestamps?.filter((at) => at >= start).length ?? (asset.lastSubmittedAt && asset.lastSubmittedAt >= start ? 1 : 0)), 0)
  return attempts < settings.imageDailyLimit
}

async function reserveAtlasSubmission(assetId: string, settings: AppSettings) {
  await db.transaction('rw', db.mediaAssets, async () => {
    const asset = await db.mediaAssets.get(assetId)
    if (!asset) throw new Error('Atlas 图片任务不存在')
    const now = Date.now(), start = localDayStart()
    if (settings.imageDailyLimit > 0) {
      const assets = await db.mediaAssets.where('source').equals('atlas').toArray()
      const attempts = assets.reduce((total, row) => total + (row.submissionTimestamps?.filter((at) => at >= start).length ?? (row.lastSubmittedAt && row.lastSubmittedAt >= start ? 1 : 0)), 0)
      if (attempts >= settings.imageDailyLimit) throw new Error('今日 Atlas 图片提交次数已达上限')
    }
    await db.mediaAssets.update(assetId, { submitAttempts: (asset.submitAttempts ?? 0) + 1, lastSubmittedAt: now, submissionTimestamps: [...(asset.submissionTimestamps ?? []), now].slice(-200) })
  })
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 25_000) {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  const abort = () => controller.abort()
  init.signal?.addEventListener('abort', abort, { once: true })
  try { return await fetch(input, { ...init, signal: controller.signal }) }
  catch (error) { if (controller.signal.aborted && !init.signal?.aborted) throw new Error(`网络请求超时（${Math.round(timeoutMs / 1000)}秒）`); throw error }
  finally { window.clearTimeout(timer); init.signal?.removeEventListener('abort', abort) }
}

function payloadError(payload: unknown) {
  if (!payload || typeof payload !== 'object') return ''
  const row = payload as { message?: unknown; error?: { message?: unknown } | string }
  if (typeof row.error === 'string') return row.error
  if (row.error && typeof row.error.message === 'string') return row.error.message
  return typeof row.message === 'string' ? row.message : ''
}

async function responseJson(response: Response) {
  const text = await response.text()
  if (!text) return {} as Record<string, unknown>
  try { return JSON.parse(text) as Record<string, unknown> } catch { throw new Error(`Atlas 返回了无法解析的数据（HTTP ${response.status}）`) }
}

export async function fetchAtlasBalance(apiKey: string): Promise<AtlasBalance> {
  const key = apiKey.trim()
  if (!key) throw new Error('请先填写 Atlas API Key')
  const response = await fetch(BALANCE_API, { headers: { Authorization: `Bearer ${key}` } })
  const payload = await responseJson(response)
  if (!response.ok) {
    const detail = payloadError(payload)
    if (response.status === 401) throw new Error('Atlas API Key 无效或已失效')
    if (response.status === 403) throw new Error('当前 Atlas 账号没有余额读取权限')
    if (response.status === 429) throw new Error('余额查询过于频繁，请稍后再试')
    throw new Error(detail || `Atlas 余额查询失败（HTTP ${response.status}）`)
  }
  const available = (payload as unknown as AtlasBalance).available
  if (!available || typeof available.value !== 'string') throw new Error('Atlas 余额响应缺少可用余额')
  return payload as unknown as AtlasBalance
}

function outfitText(outfit?: OutfitState) { return outfit ? Object.values(outfit).filter(Boolean).join(', ') : 'casual everyday clothing' }
function identity(contact: Contact, settings: AppSettings) {
  if (contact.visualIdentity?.trim()) return contact.visualIdentity.trim()
  const region = settings.realisticFacePreference === 'east_asian' ? 'East Asian facial features' : settings.realisticFacePreference === 'western' ? 'Western facial features' : ''
  return [contact.gender || 'adult person', region, contact.personaProfile?.facts.slice(0, 4).join(', ')].filter(Boolean).join(', ')
}

export function buildAtlasPrompt(contact: Contact, settings: AppSettings, bubble: AiBubbleImage) {
  const visual = identity(contact, settings)
  const style = settings.imageVisualStyle === 'anime'
    ? 'high-quality modern 2D anime illustration, clean expressive line art, soft cel shading, consistent character design'
    : 'authentic casual smartphone photo, realistic skin texture, ordinary natural lighting, mildly imperfect candid composition, not a studio advertisement'
  const privateLine = bubble.sensitive ? 'private intimate atmosphere, follow the described scene faithfully' : 'everyday personal snapshot'
  if (bubble.kind === 'object') return `Object-focused casual smartphone photo. Main subject: ${bubble.scene}. No person unless the scene explicitly requires a hand for scale. Style: ${style}. Natural composition, no watermark, no text.`
  if (bubble.kind === 'scene') return `Environment-focused first-person smartphone photo. Scene: ${bubble.scene}. Do not force a person into the frame. Style: ${style}. Natural candid composition, no watermark, no text.`
  return `One adult character only. Fixed identity: ${visual}. Preserve the same face, age, hair and distinguishing features. Current clothing: ${outfitText(contact.outfit)}. Scene: ${bubble.scene}. Image type: ${bubble.kind}. Style: ${style}. ${privateLine}. Correct anatomy and hands, no duplicated person, no watermark, no text, do not change identity.`
}

function sizeFor(bubble: AiBubbleImage) { return bubble.aspectRatio === 'landscape' || bubble.kind === 'scene' ? '1536*1024' : bubble.aspectRatio === 'square' || bubble.kind === 'object' ? '1024*1024' : '1024*1536' }
export function atlasRequestBody(model: string, prompt: string, size: string, seed: number) {
  if (model === 'google/imagen4-fast') return { model, prompt, aspect_ratio: size === '1536*1024' ? '16:9' : size === '1024*1024' ? '1:1' : '9:16', resolution: '1k', num_images: 1, seed, enable_prompt_expansion: false, enable_sync_mode: false, enable_base64_output: false }
  if (model === 'bytedance/seedream-v4') return { model, prompt, size, enable_base64_output: false }
  if (model.includes('qwen-image')) return { model, prompt, size, seed }
  if (model === 'z-image/turbo') return { model, prompt, prompt_extend: false, size, seed, enable_sync_mode: false, enable_base64_output: true }
  return { model, prompt }
}

async function updateTrace(assetId: string, phase: MediaAssetPhase, message: string, patch: Partial<MediaAsset> = {}, httpStatus?: number) {
  await db.transaction('rw', db.mediaAssets, async () => {
    const current = await db.mediaAssets.get(assetId)
    if (!current) return
    const traceEvents = [...(current.traceEvents ?? []), { at: Date.now(), phase, message, httpStatus }].slice(-80)
    await db.mediaAssets.update(assetId, { ...patch, phase, traceEvents, lastCheckedAt: Date.now() })
  })
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'))
    reader.readAsDataURL(blob)
  })
}

function decodeImage(source: string) {
  return new Promise<void>((resolve, reject) => {
    const image = new Image()
    const timer = window.setTimeout(() => reject(new Error('图片解码超时')), 20_000)
    image.onload = () => { window.clearTimeout(timer); resolve() }
    image.onerror = () => { window.clearTimeout(timer); reject(new Error('图片内容无法解码')) }
    image.src = source
  })
}

function rawBase64DataUrl(output: string) {
  const compact = output.replace(/\s/g, '')
  if (compact.length < 64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return undefined
  const mimeType = compact.startsWith('/9j/') ? 'image/jpeg' : compact.startsWith('UklGR') ? 'image/webp' : compact.startsWith('R0lGOD') ? 'image/gif' : 'image/png'
  return { dataUrl: `data:${mimeType};base64,${compact}`, mimeType, byteSize: Math.floor(compact.length * 0.75) }
}

interface PersistableImage { dataUrl?: string; remoteUrl?: string; mimeType?: string; byteSize?: number }

async function persistableImage(assetId: string, output: string): Promise<PersistableImage> {
  if (output.startsWith('data:image/')) {
    const mimeType = output.slice(5, output.indexOf(';')) || 'image/png'
    await updateTrace(assetId, 'decoding', `正在验证 ${mimeType} 图片`)
    await decodeImage(output)
    const payload = output.slice(output.indexOf(',') + 1)
    return { dataUrl: output, mimeType, byteSize: Math.floor(payload.length * 0.75) }
  }

  const base64 = rawBase64DataUrl(output)
  if (base64) {
    await updateTrace(assetId, 'decoding', `正在验证 Atlas Base64 图片（${base64.mimeType}）`)
    await decodeImage(base64.dataUrl)
    return base64
  }

  if (!/^https:\/\//i.test(output)) throw new Error('Atlas 输出既不是 HTTPS 图片地址，也不是有效的 Base64 图片')
  await updateTrace(assetId, 'downloading', '正在下载 Atlas 输出图片')
  try {
    const response = await fetchWithTimeout(output, {}, 30_000)
    if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`)
    const mimeType = response.headers.get('content-type')?.split(';')[0].trim() || ''
    if (!mimeType.startsWith('image/')) throw new Error(`Atlas 输出不是图片（Content-Type: ${mimeType || '未知'}）`)
    const blob = await response.blob()
    if (blob.size === 0) throw new Error('Atlas 输出图片大小为 0')
    const dataUrl = await blobToDataUrl(blob)
    await updateTrace(assetId, 'decoding', `正在验证 ${mimeType} 图片（${blob.size} 字节）`)
    await decodeImage(dataUrl)
    return { dataUrl, remoteUrl: output, mimeType, byteSize: blob.size }
  } catch (downloadError) {
    await updateTrace(assetId, 'decoding', '网页下载失败，尝试直接加载远程图片')
    try {
      await decodeImage(output)
      return { remoteUrl: output }
    } catch {
      throw downloadError
    }
  }
}

export async function createAtlasPlaceholder(conversationId: string, contact: Contact, settings: AppSettings, bubble: AiBubbleImage, messageId: string, createdAt: number): Promise<Message> {
  const visualContact = await ensureContactVisualIdentity(contact, settings)
  const assetId = uuid(); const prompt = buildAtlasPrompt(visualContact, settings, bubble); const size = sizeFor(bubble); const [width, height] = size.split('*').map(Number)
  const asset: MediaAsset = { id: assetId, ownerContactId: contact.id, source: 'atlas', origin: 'chat', originId: messageId, status: 'queued', phase: 'queued', traceEvents: [{ at: createdAt, phase: 'queued', message: '聊天图片任务已创建' }], modelId: settings.atlasImageModel, seed: visualContact.visualSeed ?? -1, prompt, width, height, sensitive: !!bubble.sensitive, createdAt }
  await db.mediaAssets.add(asset)
  return { id: messageId, conversationId, role: 'assistant', type: 'image', content: bubble.scene, image: { assetId, status: 'queued', caption: bubble.scene, aspectRatio: `${width}/${height}`, sensitive: !!bubble.sensitive }, createdAt, pending: true }
}

export function startAtlasGeneration(assetId: string, settings: AppSettings) {
  if (activeGenerationIds.has(assetId)) return
  activeGenerationIds.add(assetId)
  void run(assetId, settings).finally(() => activeGenerationIds.delete(assetId))
}

export async function retryAtlasGeneration(assetId: string, settings: AppSettings) {
  const asset = await db.mediaAssets.get(assetId)
  if (!asset || asset.source !== 'atlas') return
  await updateTrace(assetId, 'queued', asset.predictionId ? '手动重试查询和下载，不会重复提交任务' : '手动重试提交任务', { status: 'queued', error: undefined, displayError: undefined })
  if (asset.origin === 'chat') await db.messages.update(asset.originId, { image: { assetId, status: 'queued', caption: asset.prompt, aspectRatio: `${asset.width}/${asset.height}`, sensitive: asset.sensitive } })
  startAtlasGeneration(assetId, settings)
}

export async function reportImageDisplayError(assetId: string, detail = '图片元素加载失败') {
  const asset = await db.mediaAssets.get(assetId)
  if (!asset) return
  await updateTrace(assetId, asset.phase ?? (asset.status === 'completed' ? 'completed' : 'failed'), detail, { displayError: detail })
}

export async function resumeAtlasGenerations(settings: AppSettings) {
  if (!settings.atlasImageEnabled || !settings.atlasApiKey.trim()) return
  const pending = await db.mediaAssets.where('source').equals('atlas').and((asset) => !asset.deletedAt && ['queued', 'generating'].includes(asset.status)).toArray()
  for (const asset of pending) startAtlasGeneration(asset.id, settings)
}

export async function createMomentAtlasAsset(contact: Contact, settings: AppSettings, momentId: string, scene: string) {
  const visualContact = await ensureContactVisualIdentity(contact, settings)
  const bubble: AiBubbleImage = { type: 'image', kind: 'selfie', scene, aspectRatio: 'portrait' }
  const prompt = buildAtlasPrompt(visualContact, settings, bubble); const size = sizeFor(bubble); const [width, height] = size.split('*').map(Number); const createdAt = Date.now()
  const asset: MediaAsset = { id: uuid(), ownerContactId: contact.id, source: 'atlas', origin: 'moment', originId: momentId, status: 'queued', phase: 'queued', traceEvents: [{ at: createdAt, phase: 'queued', message: '朋友圈图片任务已创建' }], modelId: settings.atlasImageModel, seed: visualContact.visualSeed ?? -1, prompt, width, height, sensitive: false, createdAt }
  await db.mediaAssets.add(asset)
  return asset
}

async function run(assetId: string, settings: AppSettings) {
  const asset = await db.mediaAssets.get(assetId)
  if (!asset || asset.deletedAt) return
  try {
    await updateTrace(assetId, asset.predictionId ? 'polling' : 'submitting', asset.predictionId ? '继续查询已有 Atlas 任务' : '正在向 Atlas 提交图片任务', { status: 'generating', error: undefined })
    if (asset.origin === 'chat') await db.messages.update(asset.originId, { image: { assetId, status: 'generating', caption: asset.prompt, aspectRatio: `${asset.width}/${asset.height}`, sensitive: asset.sensitive } })

    let predictionId = asset.predictionId
    if (!predictionId) {
      await reserveAtlasSubmission(assetId, settings)
      const response = await fetchWithTimeout(`${MODEL_API}/generateImage`, { method: 'POST', headers: { Authorization: `Bearer ${settings.atlasApiKey.trim()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(atlasRequestBody(asset.modelId || 'z-image/turbo', asset.prompt || '', `${asset.width}*${asset.height}`, asset.seed ?? -1)) }, 30_000)
      const payload = await responseJson(response)
      if (!response.ok) throw new Error(payloadError(payload) || `Atlas 提交失败（HTTP ${response.status}）`)
      const data = (payload.data && typeof payload.data === 'object' ? payload.data : payload) as Record<string, unknown>
      predictionId = typeof data.id === 'string' ? data.id : undefined
      if (!predictionId) throw new Error('Atlas 未返回任务 ID')
      await updateTrace(assetId, 'polling', `任务提交成功，开始查询状态`, { predictionId }, response.status)
    }

    const deadline = Date.now() + 90_000
    let output = ''
    let previousStatus = ''
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      const response = await fetchWithTimeout(`${MODEL_API}/prediction/${predictionId}`, { headers: { Authorization: `Bearer ${settings.atlasApiKey.trim()}` } }, 20_000)
      const payload = await responseJson(response)
      if (!response.ok) throw new Error(payloadError(payload) || `Atlas 查询失败（HTTP ${response.status}）`)
      const data = (payload.data && typeof payload.data === 'object' ? payload.data : payload) as Record<string, unknown>
      const status = typeof data.status === 'string' ? data.status : 'unknown'
      if (status !== previousStatus) {
        await updateTrace(assetId, 'polling', `Atlas 任务状态：${status}`, {}, response.status)
        previousStatus = status
      }
      if (status === 'completed' || status === 'succeeded') {
        const outputs = Array.isArray(data.outputs) ? data.outputs : []
        output = typeof outputs[0] === 'string' ? outputs[0] : ''
        if (!output) throw new Error('Atlas 标记任务完成，但没有返回图片内容')
        break
      }
      if (status === 'failed') throw new Error(payloadError(data) || 'Atlas 图片生成失败')
    }

    if (!output) {
      await updateTrace(assetId, 'polling', '本轮查询超时，10 秒后继续查询', { status: 'generating', error: '图片仍在生成，稍后会继续查询' })
      window.setTimeout(() => startAtlasGeneration(assetId, settings), 10_000)
      return
    }

    const image = await persistableImage(assetId, output)
    const source = image.dataUrl || image.remoteUrl
    if (!source) throw new Error('图片验证成功后没有可保存的内容')
    await updateTrace(assetId, 'completed', '图片已通过下载与解码验证', { status: 'completed', remoteUrl: image.remoteUrl, dataUrl: image.dataUrl, mimeType: image.mimeType, byteSize: image.byteSize, completedAt: Date.now(), error: undefined, displayError: undefined })
    if (asset.origin === 'chat') await db.messages.update(asset.originId, { pending: false, image: { assetId, status: 'completed', sensitive: asset.sensitive, aspectRatio: `${asset.width}/${asset.height}` } })
    if (asset.origin === 'moment') await db.moments.update(asset.originId, { mediaAssetId: assetId })
    await updateImageRequestForAsset(assetId, 'completed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateTrace(assetId, 'failed', message, { status: 'failed', error: message })
    if (asset.origin === 'chat') await db.messages.update(asset.originId, { pending: false, image: { assetId, status: 'failed', caption: message, sensitive: asset.sensitive, aspectRatio: `${asset.width}/${asset.height}` } })
    await updateImageRequestForAsset(assetId, 'failed', message)
  }
}
