import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { slotLabel } from '../lib/world'

export function SceneArchivePage() {
  const [query, setQuery] = useState('')
  const data = useLiveQuery(async () => {
    const conversations = await db.conversations.filter((item) => item.channel === 'scene' && item.status === 'archived').toArray()
    const [locations, contacts, groups] = await Promise.all([db.locations.toArray(), db.contacts.toArray(), db.groups.toArray()])
    const rows = await Promise.all(conversations.map(async (conversation) => ({ conversation, messages: await db.messages.where('conversationId').equals(conversation.id).sortBy('createdAt') })))
    return { rows, locations: new Map(locations.map((item) => [item.id, item])), contacts: new Map(contacts.map((item) => [item.id, item])), groups: new Map(groups.map((item) => [item.id, item])) }
  }, [])
  const filtered = useMemo(() => {
    if (!data) return []
    const needle = query.trim().toLowerCase()
    return data.rows.filter(({ conversation, messages }) => {
      if (!needle) return true
      const location = data.locations.get(conversation.archiveLocationId ?? conversation.sceneLocationId ?? '')?.name ?? ''
      const people = messages.map((message) => message.speakerContactId ? data.contacts.get(message.speakerContactId)?.name : '我').join(' ')
      return `${location} ${people} ${messages.map((message) => message.content).join(' ')}`.toLowerCase().includes(needle)
    }).sort((a, b) => (b.conversation.archivedAtStep ?? 0) - (a.conversation.archivedAtStep ?? 0))
  }, [data, query])
  return <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
    <TopBar title="现场聊天记录" showBack />
    <div className="shrink-0 bg-white px-4 pb-3"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索角色、地点或关键词" className="w-full rounded-xl bg-gray-100 px-3 py-2 text-sm outline-none" /></div>
    <main className="flex-1 overflow-y-auto p-3">
      {filtered.map(({ conversation, messages }) => {
        const locationId = conversation.archiveLocationId ?? conversation.sceneLocationId ?? ''
        const locationName = data?.locations.get(locationId)?.name ?? locationId
        return <section key={conversation.id} className="mb-3 overflow-hidden rounded-2xl bg-white shadow-sm">
          <header className="border-b border-gray-100 px-4 py-3"><h2 className="text-sm font-medium text-gray-900">第{conversation.archiveDay ?? 1}天 · {slotLabel(conversation.archiveSlot ?? 'morning')} · {locationName}</h2><p className="mt-0.5 text-[11px] text-gray-400">只读归档 · 原文仍受角色感知权限约束</p></header>
          <div className="space-y-2 px-4 py-3">{messages.length ? messages.map((message) => <div key={message.id} className="text-sm leading-relaxed"><span className="mr-2 text-xs font-medium text-violet-600">{message.role === 'user' ? '我' : (message.speakerContactId ? data?.contacts.get(message.speakerContactId)?.name : data?.groups.get(conversation.groupId ?? '')?.name) ?? '角色'}</span><span className="text-gray-700">{message.content}</span></div>) : <p className="text-xs text-gray-400">本时段没有发言</p>}</div>
        </section>
      })}
      {data && filtered.length === 0 && <p className="py-16 text-center text-sm text-gray-400">没有匹配的现场聊天记录</p>}
    </main>
  </div>
}
