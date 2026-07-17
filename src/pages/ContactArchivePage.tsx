import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useParams } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { displayName } from '../lib/contact'
import { formatWorldDate } from '../lib/worldCalendar'
import { slotLabel } from '../lib/world'

export function ContactArchivePage() {
  const { contactId } = useParams()
  const contact = useLiveQuery(() => contactId ? db.contacts.get(contactId) : undefined, [contactId])
  const archives = useLiveQuery(async () => {
    if (!contactId) return []
    const rows = await db.contactArchives.where('contactId').equals(contactId).toArray()
    return rows.sort((a, b) => b.worldStep - a.worldStep || b.createdAt - a.createdAt)
  }, [contactId]) ?? []
  const [expandedId, setExpandedId] = useState('')

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="联系人自动存档" showBack />
      <main className="min-h-0 flex-1 overflow-y-auto p-4">
        <section className="mb-3 rounded-2xl bg-white p-4">
          <h1 className="text-base font-medium text-gray-900">{contact ? displayName(contact) : '联系人'}</h1>
          <p className="mt-1 text-xs leading-relaxed text-gray-400">每次世界时间推进后，系统会自动保存该时段结束时的人设、关系、记忆、日程与生活状态切片，最多保留最近 120 份。</p>
        </section>

        {archives.length === 0 ? (
          <p className="py-20 text-center text-sm text-gray-400">还没有存档。创建联系人或推进一次世界时间后会自动生成。</p>
        ) : (
          <div className="space-y-3">
            {archives.map((archive) => {
              const snapshot = archive.snapshot
              const archivedContact = snapshot.contact
              const expanded = expandedId === archive.id
              return (
                <button
                  type="button"
                  key={archive.id}
                  onClick={() => setExpandedId(expanded ? '' : archive.id)}
                  className="block w-full rounded-2xl bg-white p-4 text-left shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{formatWorldDate(archive.worldDay)} · {slotLabel(archive.worldSlot)}</p>
                      <p className="mt-1 text-xs text-gray-400">世界步 {archive.worldStep} · {archive.reason === 'created' ? '创建时存档' : '自动时间切片'}</p>
                    </div>
                    <span className="text-xs text-gray-300">{expanded ? '收起' : '查看'}</span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-600">
                    <p>关系：{archivedContact.relationshipBase || '朋友'}</p>
                    <p>职业：{archivedContact.occupation || '未设置'}</p>
                    <p>位置：{archivedContact.currentLocationId || '未知'}</p>
                    <p>心情：{archivedContact.mood?.text || '平静'}</p>
                  </div>
                  {expanded && (
                    <div className="mt-4 space-y-3 border-t border-gray-100 pt-3 text-xs leading-relaxed text-gray-600">
                      <div><p className="font-medium text-gray-800">当时的人设</p><p className="mt-1 whitespace-pre-wrap">{archivedContact.systemPrompt}</p></div>
                      <div><p className="font-medium text-gray-800">关系变化</p><p className="mt-1">{archivedContact.relationshipDynamic || '暂无变化记录'}</p></div>
                      <div><p className="font-medium text-gray-800">记忆概况</p><p className="mt-1">{archivedContact.memoryFacts || '暂无摘要'} · 结构化记忆 {snapshot.memories.length} 条</p></div>
                      <div><p className="font-medium text-gray-800">当时衣着</p><p className="mt-1">{archivedContact.outfit ? Object.values(archivedContact.outfit).filter((value) => typeof value === 'string').join('、') : '暂无记录'}</p></div>
                      {snapshot.lifeState && <div><p className="font-medium text-gray-800">生活状态</p><p className="mt-1">{snapshot.lifeState.location} · {snapshot.lifeState.activity} · 精力 {snapshot.lifeState.energy}</p></div>}
                      <p className="text-[10px] text-gray-300">设备保存时间：{new Date(archive.createdAt).toLocaleString()}</p>
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}

