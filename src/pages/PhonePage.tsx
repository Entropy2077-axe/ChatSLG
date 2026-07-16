import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { db } from '../db/db'
import { totalUnreadForConversations } from '../lib/conversationStats'
import { momentsUnreadCount } from '../lib/momentsUnread'
import { checkForUpdate } from '../lib/updateCheck'
import { useSettingsStore } from '../store/useSettingsStore'
import { UnreadBadge } from '../components/UnreadBadge'
import { worldTimeIcon } from '../lib/worldTimeIcon'
import { advanceWorldTurn } from '../lib/worldTurn'
import { useChatEngineStore } from '../lib/chatEngine'

const EMPTY: never[] = []
interface PhoneApp { label: string; icon: string; color: string; to?: string; badge?: number; action?: () => void; disabled?: boolean }

export function PhonePage() {
  const navigate = useNavigate()
  const adminMode = useSettingsStore((state) => state.adminModeEnabled)
  const settings = useSettingsStore()
  const momentsLastReadAt = useSettingsStore((state) => state.momentsLastReadAt)
  const [updateText, setUpdateText] = useState('')
  const [timeBusy, setTimeBusy] = useState(false)
  const chatBusy = useChatEngineStore((state) => Object.values(state.states).some((runtime) => runtime.aiTyping))
  const conversations = useLiveQuery(() => db.conversations.filter((c) => c.channel === 'private_phone' || c.channel === 'group_phone' || (!c.channel && !!(c.contactId || c.groupId))).toArray(), []) ?? EMPTY
  const moments = useLiveQuery(() => db.moments.toArray(), []) ?? EMPTY
  const socialEvents = useLiveQuery(() => db.socialEvents.toArray(), []) ?? EMPTY
  const world = useLiveQuery(() => db.worldState.get('global'), [])
  const messageUnread = useLiveQuery(() => totalUnreadForConversations(conversations), [conversations]) ?? 0
  const momentUnread = useMemo(() => momentsUnreadCount({ lastReadAt: momentsLastReadAt, moments, socialEvents }), [momentsLastReadAt, moments, socialEvents])

  async function update() {
    setUpdateText('检查中…')
    try {
      const result = await checkForUpdate()
      if (result.hasUpdate) { setUpdateText(`发现 ${result.latestVersion}`); window.open(result.releaseUrl, '_blank') }
      else setUpdateText('已是最新版')
    } catch (error) { setUpdateText(error instanceof Error ? error.message : '检查失败') }
  }
  async function advanceTime() {
    if (timeBusy || chatBusy) return
    setTimeBusy(true)
    try { await advanceWorldTurn(settings) } catch (error) { window.alert(error instanceof Error ? error.message : String(error)) } finally { setTimeBusy(false) }
  }

  const apps: PhoneApp[] = [
    { label: '相册', icon: '🖼️', color: 'bg-purple-500', to: '/album' },
    { label: '消息', icon: '💬', color: 'bg-emerald-500', badge: messageUnread, to: '/phone/messages' },
    { label: '联系人', icon: '👥', color: 'bg-cyan-500', to: '/contacts' },
    { label: '朋友圈', icon: '🌄', color: 'bg-sky-500', badge: momentUnread, to: '/phone/moments' },
    { label: '地点', icon: '🗺️', color: 'bg-green-600', to: '/locations' },
    { label: timeBusy ? '结算中…' : chatBusy ? '聊天处理中' : '时间', icon: worldTimeIcon(world?.slot), color: 'bg-violet-500', action: advanceTime, disabled: timeBusy || chatBusy },
    { label: '世界书', icon: '📖', color: 'bg-indigo-500', to: '/world-settings' },
    { label: '关系网', icon: '🕸️', color: 'bg-pink-500', to: '/relationships' },
    { label: '商城', icon: '🛍️', color: 'bg-orange-500', to: '/shop' },
    { label: '仓库', icon: '📦', color: 'bg-amber-600', to: '/warehouse' },
    { label: '工作', icon: '💼', color: 'bg-blue-600', to: '/work' },
    { label: '存档回档', icon: '💾', color: 'bg-violet-600', to: '/save-load' },
    { label: '现场记录', icon: '🗃️', color: 'bg-slate-600', to: '/settings/scene-archives' },
    { label: '新建世界', icon: '🌍', color: 'bg-teal-600', to: '/new-world' },
    { label: '个人资料', icon: '🙂', color: 'bg-rose-500', to: '/profile/edit' },
    { label: '设置', icon: '⚙️', color: 'bg-gray-600', to: '/settings' },
    ...(adminMode ? [{ label: '天眼', icon: '👁️', color: 'bg-red-600', to: '/sky-eye' }] : []),
    { label: updateText || '检查更新', icon: '🔄', color: 'bg-zinc-600', action: update },
  ]

  return <div className="h-full overflow-y-auto bg-gradient-to-b from-slate-100 to-slate-200 px-5 pb-8 pt-[calc(env(safe-area-inset-top)+22px)]">
    <div className="mb-7"><h1 className="text-2xl font-semibold text-slate-800">手机</h1><p className="mt-1 text-xs text-slate-500">世界功能与手机交流</p></div>
    <div className="grid grid-cols-4 gap-x-3 gap-y-6">
      {apps.map((app) => <button key={app.label} disabled={app.disabled} onClick={() => app.to ? navigate(app.to) : app.action?.()} className="flex min-w-0 flex-col items-center gap-2 disabled:opacity-50">
        <span className={`relative flex h-14 w-14 items-center justify-center rounded-2xl ${app.color} text-3xl shadow-md ring-1 ring-white/50`}><span>{app.icon}</span><UnreadBadge count={app.badge ?? 0} className="absolute -right-1 -top-1" /></span>
        <span className="w-full truncate text-center text-[11px] text-slate-700">{app.label}</span>
      </button>)}
    </div>
  </div>
}
