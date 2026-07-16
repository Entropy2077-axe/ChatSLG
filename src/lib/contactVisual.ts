import { db } from '../db/db'
import type { AppSettings, Contact } from '../types'
import { chatCompletion } from './deepseek'

export function stableVisualSeed(contactId: string): number {
  let hash = 2166136261
  for (const char of contactId) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619) }
  return Math.abs(hash | 0) % 2_147_483_647
}

export async function ensureContactVisualIdentity(contact: Contact, settings: AppSettings): Promise<Contact> {
  const visualSeed = Number.isInteger(contact.visualSeed) && contact.visualSeed! >= 0 ? contact.visualSeed! : stableVisualSeed(contact.id)
  if (contact.visualIdentity?.trim()) {
    if (contact.visualSeed !== visualSeed) await db.contacts.update(contact.id, { visualSeed })
    return { ...contact, visualSeed }
  }
  const fallback = [contact.gender || 'adult person', contact.personaProfile?.facts.slice(0, 3).join(', ')].filter(Boolean).join(', ')
  let visualIdentity = fallback
  if (settings.apiKey) {
    try {
      visualIdentity = (await chatCompletion({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.utilityModel, purpose: 'other', thinking: 'disabled', temperature: 0.3, maxTokens: 180, messages: [{ role: 'system', content: `Create one stable visual identity for an adult fictional character used by an image generator. Output one concise English sentence only. Include apparent adult age, face shape, skin tone, hair style/color, eyes, build, and one distinguishing feature. Never include clothing, pose, mood, location, camera style, celebrity names, or sexual details.\nCharacter facts: ${contact.systemPrompt.slice(0, 900)}\nGender: ${contact.gender || 'unspecified'}` }] })).trim().slice(0, 500) || fallback
    } catch (error) { console.warn('[image] 旧角色视觉身份生成失败，使用稳定回退描述', error) }
  }
  await db.contacts.update(contact.id, { visualIdentity, visualSeed })
  return { ...contact, visualIdentity, visualSeed }
}
