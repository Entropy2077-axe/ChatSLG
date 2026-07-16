import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type { AiBubbleImage, AppSettings, Contact, MediaAsset, Message, OutfitState } from '../types'

const API = 'https://api.atlascloud.ai/api/v1/model'
const activeGenerationIds = new Set<string>()

function localDayStart() { const d = new Date(); d.setHours(0,0,0,0); return d.getTime() }
export async function atlasQuotaAvailable(settings: AppSettings) {
  if (!settings.atlasImageEnabled || !settings.atlasApiKey.trim()) return false
  if (settings.imageDailyLimit <= 0) return true
  return await db.mediaAssets.where('source').equals('atlas').and((a) => a.createdAt >= localDayStart()).count() < settings.imageDailyLimit
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
  return `One adult character only. Fixed identity: ${visual}. Preserve the same face, age, hair and distinguishing features. Current clothing: ${outfitText(contact.outfit)}. Scene: ${bubble.scene}. Image type: ${bubble.kind}. Style: ${style}. ${privateLine}. Correct anatomy and hands, no duplicated person, no watermark, no text, do not change identity.`
}

function sizeFor(bubble: AiBubbleImage) { return bubble.aspectRatio === 'landscape' || bubble.kind === 'scene' ? '1536*1024' : bubble.aspectRatio === 'square' || bubble.kind === 'object' ? '1024*1024' : '1024*1536' }
function requestBody(model: string, prompt: string, size: string, seed: number) {
  if (model === 'google/imagen4-fast') return { model, prompt, aspect_ratio: size === '1536*1024' ? '3:2' : size === '1024*1024' ? '1:1' : '2:3', resolution: '1k', num_images: 1, enable_prompt_expansion: false }
  if (model === 'bytedance/seedream-v4') return { model, prompt, size }
  if (model.includes('qwen-image')) return { model, prompt, size, seed }
  if (model === 'z-image/turbo') return { model, prompt, prompt_extend: false, size, seed, enable_sync_mode: false, enable_base64_output: false }
  return { model, prompt }
}
async function dataUrl(url: string) { const blob = await fetch(url).then((r) => { if (!r.ok) throw new Error(`图片下载失败 HTTP ${r.status}`); return r.blob() }); return await new Promise<string>((resolve,reject) => { const reader = new FileReader(); reader.onload=()=>resolve(String(reader.result)); reader.onerror=()=>reject(reader.error); reader.readAsDataURL(blob) }) }

export async function createAtlasPlaceholder(conversationId: string, contact: Contact, settings: AppSettings, bubble: AiBubbleImage, messageId: string, createdAt: number): Promise<Message> {
  const assetId = uuid(), prompt = buildAtlasPrompt(contact, settings, bubble), size = sizeFor(bubble), [width,height] = size.split('*').map(Number)
  const asset: MediaAsset = { id: assetId, ownerContactId: contact.id, source: 'atlas', origin: 'chat', originId: messageId, status: 'queued', modelId: settings.atlasImageModel, seed: contact.visualSeed ?? -1, prompt, width, height, sensitive: !!bubble.sensitive, createdAt }
  await db.mediaAssets.add(asset)
  return { id: messageId, conversationId, role: 'assistant', type: 'image', content: bubble.scene, image: { assetId, status: 'queued', caption: bubble.scene, aspectRatio: `${width}/${height}`, sensitive: !!bubble.sensitive }, createdAt, pending: true }
}

export function startAtlasGeneration(assetId: string, settings: AppSettings) {
  if (activeGenerationIds.has(assetId)) return
  activeGenerationIds.add(assetId)
  void run(assetId, settings).finally(() => activeGenerationIds.delete(assetId))
}
export async function resumeAtlasGenerations(settings: AppSettings) {
  if (!settings.atlasImageEnabled || !settings.atlasApiKey.trim()) return
  const pending = await db.mediaAssets.where('source').equals('atlas').and((asset)=>!asset.deletedAt && ['queued','generating'].includes(asset.status)).toArray()
  for (const asset of pending) startAtlasGeneration(asset.id, settings)
}
export async function createMomentAtlasAsset(contact: Contact, settings: AppSettings, momentId: string, scene: string) {
  const bubble: AiBubbleImage = { type:'image', kind:'selfie', scene, aspectRatio:'portrait' }
  const prompt=buildAtlasPrompt(contact,settings,bubble), size=sizeFor(bubble), [width,height]=size.split('*').map(Number)
  const asset: MediaAsset={id:uuid(),ownerContactId:contact.id,source:'atlas',origin:'moment',originId:momentId,status:'queued',modelId:settings.atlasImageModel,seed:contact.visualSeed??-1,prompt,width,height,sensitive:false,createdAt:Date.now()}
  await db.mediaAssets.add(asset); return asset
}
async function run(assetId: string, settings: AppSettings) {
  const asset = await db.mediaAssets.get(assetId); if (!asset || asset.deletedAt) return
  try {
    await db.mediaAssets.update(assetId, { status: 'generating' }); if(asset.origin==='chat') await db.messages.update(asset.originId, { image: { assetId, status: 'generating', caption: asset.prompt, aspectRatio: `${asset.width}/${asset.height}`, sensitive: asset.sensitive } })
    let predictionId = asset.predictionId
    if (!predictionId) {
      const submit = await fetch(`${API}/generateImage`, { method:'POST', headers:{ Authorization:`Bearer ${settings.atlasApiKey.trim()}`,'Content-Type':'application/json' }, body:JSON.stringify(requestBody(asset.modelId || 'z-image/turbo', asset.prompt || '', `${asset.width}*${asset.height}`, asset.seed ?? -1)) })
      const submitted = await submit.json(); if (!submit.ok) throw new Error(submitted?.message || `Atlas HTTP ${submit.status}`)
      predictionId = submitted?.data?.id ?? submitted?.id; if (!predictionId) throw new Error('Atlas 未返回任务 ID')
      await db.mediaAssets.update(assetId,{predictionId})
    }
    const deadline=Date.now()+90000; let output=''
    while(Date.now()<deadline){ await new Promise(r=>setTimeout(r,2000)); const res=await fetch(`${API}/prediction/${predictionId}`,{headers:{Authorization:`Bearer ${settings.atlasApiKey.trim()}`}}); const json=await res.json(); const d=json?.data??json; if(['completed','succeeded'].includes(d?.status)){output=d.outputs?.[0]||'';break} if(d?.status==='failed') throw new Error(d.error||'Atlas 生成失败') }
    if(!output) { await db.mediaAssets.update(assetId,{status:'generating',error:'图片仍在生成，稍后会继续查询'}); return }
    let stored: string|undefined; try { stored=await dataUrl(output) } catch { stored=undefined }
    await db.mediaAssets.update(assetId,{status:'completed',remoteUrl:output,dataUrl:stored,completedAt:Date.now()})
    if(asset.origin==='chat') await db.messages.update(asset.originId,{image:{assetId,url:stored||output,status:'completed',sensitive:asset.sensitive,aspectRatio:`${asset.width}/${asset.height}`}})
    if(asset.origin==='moment') await db.moments.update(asset.originId,{imageUrl:stored||output,mediaAssetId:assetId})
  } catch(error) { const message=error instanceof Error?error.message:String(error); await db.mediaAssets.update(assetId,{status:'failed',error:message}); if(asset.origin==='chat') await db.messages.update(asset.originId,{image:{assetId,status:'failed',caption:message,sensitive:asset.sensitive,aspectRatio:`${asset.width}/${asset.height}`}}) }
}
