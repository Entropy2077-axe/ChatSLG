import { useMemo } from 'react'
import { NavLink } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { UnreadBadge } from './UnreadBadge'
import { totalUnreadForConversations } from '../lib/conversationStats'
import { momentsUnreadCount } from '../lib/momentsUnread'
import { useSettingsStore } from '../store/useSettingsStore'

const TABS = [
  { to: '/phone', label: '手机', icon: MessageIcon },
  { to: '/dialogue', label: '对话', icon: ContactIcon },
]

const EMPTY_ARRAY: never[] = []

export function BottomNav() {
  const conversations = useLiveQuery(() => db.conversations.filter((item) => item.channel !== 'scene').toArray(), []) ?? EMPTY_ARRAY
  const moments = useLiveQuery(() => db.moments.toArray(), []) ?? EMPTY_ARRAY
  const socialEvents = useLiveQuery(() => db.socialEvents.toArray(), []) ?? EMPTY_ARRAY
  const momentsLastReadAt = useSettingsStore((s) => s.momentsLastReadAt)

  const totalUnread = useLiveQuery(() => totalUnreadForConversations(conversations), [conversations]) ?? 0
  const momentsUnread = useMemo(
    () => momentsUnreadCount({ lastReadAt: momentsLastReadAt, moments, socialEvents }),
    [momentsLastReadAt, moments, socialEvents],
  )

  return (
    <nav className="flex shrink-0 border-t border-gray-100 bg-white pb-[env(safe-area-inset-bottom)]">
      {TABS.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={false}
          className={({ isActive }) =>
            `flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${
              isActive ? 'text-gray-900' : 'text-gray-400'
            }`
          }
        >
          {() => (
            <>
              <div className="relative">
                <Icon />
                {to === '/phone' && <UnreadBadge count={totalUnread + momentsUnread} className="absolute -top-1 -right-2" />}
              </div>
              <span>{label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}

function MessageIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4.4 3.3A.6.6 0 0 1 3 19.8V6a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  )
}
function ContactIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M5 19c1.2-3.2 3.8-5 7-5s5.8 1.8 7 5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  )
}
