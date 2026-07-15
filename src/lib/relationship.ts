/**
 * Describe the contact's relationship with the user without assigning it a
 * score. The explicit relationship label and the model-maintained natural
 * language summary are the only relationship state used by prompts.
 */
export function relationshipLine(base: string, dynamic: string): string {
  const parts = [`你们是${base || '朋友'}关系。请按这一关系定位自然调整语气、边界和亲疏程度。`]
  if (dynamic.trim()) parts.push(`当前状态: ${dynamic.trim()}`)
  return parts.join('。')
}
