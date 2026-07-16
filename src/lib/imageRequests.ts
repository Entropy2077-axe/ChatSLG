import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type { AiBubbleImage, AppSettings, Contact, ImageRequestTask } from '../types'
import { chatCompletion } from './deepseek'
import { extractJsonObject } from './aiProtocol'

const EXPLICIT_IMAGE_REQUEST = /(自拍|照片|图片|相片|拍(?:一|个|张)?|照一张|(?:发|发送|传|给).{0,6}(图|照片|图片|相片)|给我看.{0,6}(你|照片|图片|图)|看看你|看一下你|穿搭照|镜子照|现场照)/i
const IMAGE_FOLLOW_UP = /(那|现在|这会儿|可以|好|行|就).{0,6}(发|拍|照|来)|(?:发|拍|照).{0,6}(吧|呀|啊|给我)/i
const HISTORICAL_PHOTO = /(之前|以前|当时|那天|上次|去年|前年|曾经|小时候|旧照|老照片|相册|回忆|周末.{0,8}拍|路人.{0,8}快门)/i
const IMAGE_REFUSAL = /(不发|不给|不想发|不能发|不方便发|别看|拒绝|算了)/i
const IMAGE_DEFER = /(等会|等等|晚点|以后|下次|改天|现在不|暂时不)/i
const IMMEDIATE_PHOTO_LANGUAGE = /(给你|发你|你看|看这张|这张是|那张是|照片里|图片里|图里|镜头里|拍的是|快门|角度|构图)/i

export interface ImageActionReview {
  taskId: string
  decision: 'accept' | 'reject' | 'defer'
  kind?: AiBubbleImage['kind']
  aspectRatio?: NonNullable<AiBubbleImage['aspectRatio']>
  sensitive?: boolean
  scene?: string
  outfitSource?: AiBubbleImage['outfitSource']
  reason: string
}

function inferOutfitSource(...texts: Array<string | undefined>): NonNullable<AiBubbleImage['outfitSource']> {
  return HISTORICAL_PHOTO.test(texts.filter(Boolean).join('\n')) ? 'scene' : 'current'
}

function inferredKind(text: string): AiBubbleImage['kind'] {
  if (/(穿搭|衣服|衣着|造型)/i.test(text)) return 'outfit'
  if (/(镜子|镜前)/i.test(text)) return 'mirror_selfie'
  if (/(风景|现场|房间|街道|公园).{0,5}(照|图)|拍.{0,5}(风景|现场|房间|街道)/i.test(text)) return 'scene'
  if (/(东西|物品|礼物|食物|桌面|书|花)/i.test(text) && !/(我|你|人|穿|头发|笑)/i.test(text)) return 'object'
  return 'selfie'
}

function cleanScene(text: string): string {
  return text.replace(/<mood>[\s\S]*?<\/mood>/gi, '').replace(/<thought>[\s\S]*?<\/thought>/gi, '').replace(/\[image[^\]]*\]/gi, '').replace(/\s+/g, ' ').trim().slice(0, 180)
}

export function isExplicitImageRequest(text: string): boolean {
  return EXPLICIT_IMAGE_REQUEST.test(text)
}

export async function prepareImageRequest(conversationId: string, contactId: string, requestMessageId: string, userRequest: string): Promise<ImageRequestTask | undefined> {
  const now = Date.now()
  const pending = await db.imageRequests.where('[conversationId+status]').equals([conversationId, 'pending']).sortBy('createdAt')
  if (isExplicitImageRequest(userRequest)) {
    if (pending.length) await db.imageRequests.bulkUpdate(pending.map((task) => ({ key: task.id, changes: { status: 'expired', decisionReason: '新的索图请求已取代旧任务', resolvedAt: now, updatedAt: now } })))
    const task: ImageRequestTask = { id: uuid(), conversationId, contactId, requestMessageId, userRequest, status: 'pending', userTurnCount: 0, createdAt: now, updatedAt: now }
    await db.imageRequests.add(task)
    return task
  }
  const current = pending.at(-1)
  if (!current) return undefined
  const userTurnCount = current.userTurnCount + 1
  if (userTurnCount >= 6) {
    await db.imageRequests.update(current.id, { status: 'expired', userTurnCount, decisionReason: '超过6次用户发言仍未完成', resolvedAt: now, updatedAt: now })
    return undefined
  }
  await db.imageRequests.update(current.id, { userTurnCount, updatedAt: now })
  return IMAGE_FOLLOW_UP.test(userRequest) ? { ...current, userTurnCount, updatedAt: now } : undefined
}

export function imageRequestPrompt(task?: ImageRequestTask): string {
  if (!task) return ''
  return `【待处理索图任务】taskId=${task.id}。用户请求：${task.userRequest}。你可以自然拒绝、推迟或同意；如果同意现在发送，必须输出规定的图片标记，不能只用普通消息描述照片。旧照或相册照片要在标记的画面描述中写清当时的衣着，不要把“绘图提示词”“prompt”等内部说明发给用户。程序会独立裁决，不能只说“已经发了”却不给动作。`
}

function fallbackReview(task: ImageRequestTask, parsedImage?: AiBubbleImage): ImageActionReview | undefined {
  if (!parsedImage) return undefined
  return { taskId: task.id, decision: 'accept', kind: parsedImage.kind, aspectRatio: parsedImage.aspectRatio ?? 'portrait', sensitive: !!parsedImage.sensitive, scene: parsedImage.scene, outfitSource: parsedImage.outfitSource ?? inferOutfitSource(task.userRequest, parsedImage.scene), reason: '主模型已输出结构化图片动作' }
}

export async function reviewImageRequest(input: { task: ImageRequestTask; latestUserText: string; assistantText: string; parsedImage?: AiBubbleImage; contact: Contact; settings: AppSettings; signal?: AbortSignal; trace: { turnId: string; conversationId: string } }): Promise<ImageActionReview> {
  // A valid image marker is already explicit consent and has a usable scene.
  // Avoid a second serial model call that can both delay and lose the action.
  const structured = fallbackReview(input.task, input.parsedImage)
  if (structured) return structured
  const assistant = cleanScene(input.assistantText)
  if (IMAGE_REFUSAL.test(assistant)) return { taskId: input.task.id, decision: 'reject', reason: '角色明确拒绝发送图片' }
  if (IMAGE_DEFER.test(assistant)) return { taskId: input.task.id, decision: 'defer', reason: '角色表示稍后再发送图片' }
  if (IMMEDIATE_PHOTO_LANGUAGE.test(assistant)) {
    return {
      taskId: input.task.id,
      decision: 'accept',
      kind: inferredKind(`${input.task.userRequest}\n${assistant}`),
      aspectRatio: 'portrait',
      sensitive: false,
      scene: assistant || '自然光线下的随手照片',
      outfitSource: inferOutfitSource(input.task.userRequest, assistant),
      reason: '角色已用当前发送口吻介绍具体照片',
    }
  }
  const prompt = `你是ChatSLG图片动作裁决器。判断角色对当前索图任务是明确同意现在发送、明确拒绝，还是推迟/尚未决定。只输出JSON，不续写聊天。

规则：
- accept只用于角色本轮明确同意现在发送；仅口头说“已经发了”也算accept，程序会补实际图片动作。
- reject用于明确拒绝或撤回。
- defer用于以后再说、等会、犹豫、忽略索图或无法确认。
- kind只能是selfie、mirror_selfie、outfit、object、scene；aspectRatio只能是portrait、square、landscape。
- scene写可直接交给绘图模型的具体画面，不超过180字，不要声称图片已经生成。
- outfitSource只能是current或scene。现在拍摄且应使用角色现实当前衣装时填current；旧照、相册照、回忆照片、之前拍摄的照片填scene，此时衣装只来自scene描述。
- 不得仅因为用户要求就替角色同意，必须以角色回复为证据。

只输出：{"taskId":"${input.task.id}","decision":"accept|reject|defer","kind":"selfie","aspectRatio":"portrait","sensitive":false,"scene":"画面","outfitSource":"current|scene","reason":"依据"}

角色：${input.contact.name}
用户当前消息：${input.latestUserText}
原始索图请求：${input.task.userRequest}
角色本轮回复：${input.assistantText}`
  try {
    const raw = await chatCompletion({ apiKey: input.settings.apiKey, baseUrl: input.settings.baseUrl, model: input.settings.utilityModel, jsonMode: true, thinking: 'disabled', temperature: 0, maxTokens: 360, purpose: 'other', messages: [{ role: 'system', content: prompt }], signal: input.signal, trace: { turnId: input.trace.turnId, stage: 'other', conversationId: input.trace.conversationId } })
    const json = extractJsonObject(raw)
    if (!json) throw new Error('图片动作裁决没有返回JSON')
    const value = JSON.parse(json) as Record<string, unknown>
    const decision = ['accept', 'reject', 'defer'].includes(String(value.decision)) ? value.decision as ImageActionReview['decision'] : 'defer'
    const kind = ['selfie', 'mirror_selfie', 'outfit', 'object', 'scene'].includes(String(value.kind)) ? value.kind as AiBubbleImage['kind'] : input.parsedImage?.kind
    const aspectRatio = ['portrait', 'square', 'landscape'].includes(String(value.aspectRatio)) ? value.aspectRatio as NonNullable<AiBubbleImage['aspectRatio']> : input.parsedImage?.aspectRatio ?? 'portrait'
    const scene = typeof value.scene === 'string' ? value.scene.trim().slice(0, 180) : input.parsedImage?.scene
    if (decision === 'accept' && (!kind || !scene)) throw new Error('图片动作裁决同意发送但缺少类型或画面')
    const outfitSource = value.outfitSource === 'scene' || value.outfitSource === 'current' ? value.outfitSource : inferOutfitSource(input.task.userRequest, scene, input.assistantText)
    return { taskId: input.task.id, decision, kind, aspectRatio, sensitive: value.sensitive === true || !!input.parsedImage?.sensitive, scene, outfitSource, reason: typeof value.reason === 'string' ? value.reason.trim().slice(0, 180) : '图片动作裁决完成' }
  } catch (error) {
    const fallback = fallbackReview(input.task, input.parsedImage)
    if (fallback) return fallback
    const message = error instanceof Error ? error.message : String(error)
    await db.imageRequests.update(input.task.id, { decisionReason: `图片动作暂未完成：${message}`, updatedAt: Date.now() })
    throw new Error(`图片动作暂未完成：${message}`)
  }
}

export async function applyImageActionReview(task: ImageRequestTask, review: ImageActionReview): Promise<AiBubbleImage | undefined> {
  const now = Date.now()
  if (review.decision === 'reject') {
    await db.imageRequests.update(task.id, { status: 'rejected', decisionReason: review.reason, resolvedAt: now, updatedAt: now })
    return undefined
  }
  if (review.decision === 'defer') {
    await db.imageRequests.update(task.id, { status: 'pending', decisionReason: review.reason, updatedAt: now })
    return undefined
  }
  const bubble: AiBubbleImage = { type: 'image', kind: review.kind ?? 'selfie', aspectRatio: review.aspectRatio ?? 'portrait', sensitive: !!review.sensitive, scene: review.scene || '自然光线下的随手照片', outfitSource: review.outfitSource ?? 'current' }
  await db.imageRequests.update(task.id, { status: 'accepted', decisionReason: review.reason, imageKind: bubble.kind, aspectRatio: bubble.aspectRatio, sensitive: bubble.sensitive, scene: bubble.scene, resolvedAt: now, updatedAt: now })
  return bubble
}

export async function attachImageRequestAsset(taskId: string, assetId: string): Promise<void> {
  await db.imageRequests.update(taskId, { mediaAssetId: assetId, status: 'generating', updatedAt: Date.now() })
}

export async function updateImageRequestForAsset(assetId: string, status: 'completed' | 'failed', reason?: string): Promise<void> {
  const task = await db.imageRequests.where('mediaAssetId').equals(assetId).first()
  if (!task) return
  await db.imageRequests.update(task.id, { status, decisionReason: reason ?? task.decisionReason, resolvedAt: Date.now(), updatedAt: Date.now() })
}
