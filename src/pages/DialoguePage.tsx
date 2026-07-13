import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { ensureActiveSceneConversation } from '../lib/sceneConversation'
import { ChatPage } from './ChatPage'

export function DialoguePage() {
  const world = useLiveQuery(() => db.worldState.get('global'), [])
  const worldStep = world?.step, playerLocationId = world?.playerLocationId
  const [conversationId, setConversationId] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    if (worldStep === undefined || !playerLocationId) return
    let cancelled = false
    setConversationId('')
    ensureActiveSceneConversation().then((id) => {
      if (!cancelled) { setConversationId(id); setError('') }
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err))
    })
    return () => { cancelled = true }
  }, [worldStep, playerLocationId])
  if (error) return <div className="flex h-full items-center justify-center bg-[#ededed] px-6 text-center text-sm text-red-500">{error}</div>
  if (!conversationId) return <div className="flex h-full items-center justify-center bg-[#ededed] text-sm text-gray-400">正在进入当前位置…</div>
  return <ChatPage conversationIdOverride={conversationId} embedded />
}
