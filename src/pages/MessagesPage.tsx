import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { UnreadBadge } from '../components/UnreadBadge'
import { SearchOverlay } from '../components/SearchOverlay'
import { ActionSheet } from '../components/ActionSheet'
import { useLongPress } from '../hooks/useLongPress'
import { formatListTime } from '../lib/time'
import { displayName } from '../lib/contact'
import { previewForMessage } from '../lib/messagePreview'
import { conversationMessageStats, type ConversationMessageStats } from '../lib/conversationStats'

const EMPTY_ARRAY: never[] = []
const EMPTY_STATS = new Map<string, ConversationMessageStats>()

export function MessagesPage() {
  const [searching, setSearching] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [showAddMenu, setShowAddMenu] = useState(false)
  const navigate = useNavigate()

  const conversations = useLiveQuery(() => db.conversations
    .filter((conversation) => conversation.channel === 'private_phone' || conversation.channel === 'group_phone' || (!conversation.channel && !!(conversation.contactId || conversation.groupId)))
    .toArray(), []) ?? EMPTY_ARRAY
  const contacts = useLiveQuery(() => db.contacts.toArray(), []) ?? EMPTY_ARRAY
  const groups = useLiveQuery(() => db.groups.toArray(), []) ?? EMPTY_ARRAY
  const messageStats = useLiveQuery(() => conversationMessageStats(conversations), [conversations]) ?? EMPTY_STATS

  const rows = useMemo(() => {
    const contactById = new Map(contacts.map((c) => [c.id, c]))
    const groupById = new Map(groups.map((g) => [g.id, g]))
    return conversations
      .map((conv) => {
        const { lastMessage, unread } = messageStats.get(conv.id) ?? { lastMessage: undefined, unread: 0 }
        if (conv.groupId) {
          const group = groupById.get(conv.groupId)
          if (!group) return null
          const speaker =
            lastMessage?.role === 'assistant' && lastMessage.speakerContactId
              ? contactById.get(lastMessage.speakerContactId)
              : undefined
          return {
            conv,
            avatar: group.avatar,
            avatarColor: group.avatarColor,
            name: group.name,
            preview: previewForMessage(lastMessage, speaker ? displayName(speaker) : undefined),
            unread,
          }
        }
        const contact = conv.contactId ? contactById.get(conv.contactId) : undefined
        if (!contact) return null
        return {
          conv,
          avatar: contact.avatar,
          avatarColor: contact.avatarColor,
          name: displayName(contact),
          preview: previewForMessage(lastMessage),
          unread,
        }
      })
      .filter((r): r is NonNullable<typeof r> => !!r)
      .sort((a, b) => {
        if (a.conv.pinned !== b.conv.pinned) return a.conv.pinned ? -1 : 1
        return b.conv.updatedAt - a.conv.updatedAt
      })
  }, [conversations, contacts, groups, messageStats])

  const menuConv = rows.find((r) => r.conv.id === menuFor)?.conv

  return (
    <div className="relative flex min-h-full flex-col">
      <TopBar
        title="消息"
        showSearch
        onSearchClick={() => setSearching(true)}
        right={
          <button
            onClick={() => setShowAddMenu(true)}
            aria-label="添加"
            className="flex h-9 w-9 items-center justify-center text-gray-700"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        }
      />
      <div className="flex-1">
        {rows.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-gray-400">
            还没有手机会话，去“联系人”App 创建角色开始聊天吧
          </p>
        )}
        {rows.map(({ conv, avatar, avatarColor, name, preview, unread }) => (
          <ConversationRow
            key={conv.id}
            pinned={conv.pinned}
            avatar={avatar}
            avatarColor={avatarColor}
            name={name}
            preview={preview}
            unread={unread}
            time={formatListTime(conv.updatedAt)}
            onClick={() => navigate(`/chat/${conv.id}`)}
            onLongPress={() => setMenuFor(conv.id)}
          />
        ))}
      </div>

      {searching && <SearchOverlay onClose={() => setSearching(false)} />}

      {showAddMenu && (
        <ActionSheet
          onClose={() => setShowAddMenu(false)}
          options={[
            { label: '添加联系人', onSelect: () => navigate('/contact/new') },
            { label: '发起群聊', onSelect: () => navigate('/group/new') },
          ]}
        />
      )}

      {menuConv && (
        <ActionSheet
          onClose={() => setMenuFor(null)}
          options={[
            {
              label: menuConv.pinned ? '取消置顶' : '置顶会话',
              onSelect: () => db.conversations.update(menuConv.id, { pinned: !menuConv.pinned }),
            },
          ]}
        />
      )}
    </div>
  )
}

function ConversationRow(props: {
  pinned: boolean
  avatar: string
  avatarColor: string
  name: string
  preview: string
  unread: number
  time: string
  onClick: () => void
  onLongPress: () => void
}) {
  const longPress = useLongPress(props.onLongPress)
  return (
    <button
      type="button"
      {...longPress}
      onClick={props.onClick}
      className={`flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left select-none ${
        props.pinned ? 'bg-gray-100' : 'bg-white active:bg-gray-50'
      }`}
    >
      <div className="relative shrink-0">
        <Avatar avatar={props.avatar} color={props.avatarColor} size={48} />
        <UnreadBadge count={props.unread} className="absolute -top-1 -right-1" />
      </div>
      <div className="min-w-0 flex-1 border-b border-gray-100 pb-2.5 pt-0.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[15px] font-medium text-gray-900">{props.name}</span>
          <span className="shrink-0 text-[11px] text-gray-400">{props.time}</span>
        </div>
        <p className="mt-0.5 truncate text-[13px] text-gray-400">{props.preview}</p>
      </div>
    </button>
  )
}
