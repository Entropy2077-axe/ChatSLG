import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { displayName } from '../lib/contact'
import { uniqueRelationPairs } from '../lib/contactRelations'
import type { Contact } from '../types'

const EMPTY_ARRAY: never[] = []

export function RelationshipsPage() {
  const navigate = useNavigate()
  const contactsRaw = useLiveQuery(() => db.contacts.toArray(), []) ?? EMPTY_ARRAY
  const relationRows = useLiveQuery(() => db.contactRelations.toArray(), []) ?? EMPTY_ARRAY
  const relations = useMemo(() => uniqueRelationPairs(relationRows), [relationRows])
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const contacts = useMemo(() => [...contactsRaw].sort((a, b) => a.createdAt - b.createdAt), [contactsRaw])
  const contactById = useMemo(() => new Map(contactsRaw.map((c) => [c.id, c])), [contactsRaw])

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="关系网" showBack />
      <div className="flex-1 overflow-y-auto">

      <p className="px-4 pt-3 pb-1 text-xs text-gray-400">
        这里只展示明确身份关系、当前关系描述和可追溯的 AI-AI 关系链。
      </p>

      {contacts.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-gray-400">还没有联系人</p>
      ) : (
        <div className="mt-1 flex-1 space-y-2 px-4 pb-4">
          {contacts.map((c) => (
            <RelationshipCard
              key={c.id}
              contact={c}
              expanded={expandedId === c.id}
              onToggle={() => setExpandedId(expandedId === c.id ? null : c.id)}
              onOpenCard={() => navigate(`/contact/${c.id}`)}
              links={relations
                .filter((r) => r.fromContactId === c.id || r.toContactId === c.id)
                .map((r) => ({
                  label: r.label,
                  other: contactById.get(r.fromContactId === c.id ? r.toContactId : r.fromContactId),
                }))
                .filter((l) => l.other)}
            />
          ))}
        </div>
      )}
      </div>
    </div>
  )
}

function RelationshipCard({
  contact: c,
  expanded,
  onToggle,
  onOpenCard,
  links,
}: {
  contact: Contact
  expanded: boolean
  onToggle: () => void
  onOpenCard: () => void
  links: { label: string; other: Contact | undefined }[]
}) {
  return (
    <div className="rounded-xl bg-white p-3">
      <button onClick={onToggle} className="flex w-full items-center gap-3 text-left">
        <Avatar avatar={c.avatar} color={c.avatarColor} size={40} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium text-gray-900">{displayName(c)}</p>
          <p className="text-xs text-gray-400">{c.relationshipBase || '朋友'}{c.relationshipDynamic ? ` · ${c.relationshipDynamic}` : ''}</p>
        </div>
        <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600">{c.relationshipBase || '朋友'}</span>
      </button>

      {expanded && (
        <div className="mt-3 space-y-1.5 border-t border-gray-100 pt-3">
          <div className="flex justify-between text-xs text-gray-500">
            <span>基础关系</span>
            <span>{c.relationshipBase || '朋友'}</span>
          </div>
          {c.relationshipDynamic && (
            <div className="flex justify-between text-xs text-gray-500">
              <span>当前状态</span>
              <span>{c.relationshipDynamic}</span>
            </div>
          )}

          <div className="border-t border-gray-100 pt-2">
            <p className="mb-1 text-xs font-medium text-gray-400">TA与其他人的关系</p>
            {links.length === 0 ? (
              <p className="text-xs text-gray-400">还没有设置和其他联系人的关系</p>
            ) : (
              <div className="space-y-1">
                {links.map((l, i) => (
                  <p key={i} className="text-xs text-gray-500">
                    {l.other ? displayName(l.other) : '未知'} · {l.label}
                  </p>
                ))}
              </div>
            )}
          </div>

          <button onClick={onOpenCard} className="mt-2 w-full rounded-lg bg-gray-100 py-2 text-xs text-gray-700">
            查看联系人名片
          </button>
        </div>
      )}
    </div>
  )
}
