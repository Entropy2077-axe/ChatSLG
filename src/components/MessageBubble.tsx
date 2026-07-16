import { forwardRef, useEffect, useState } from 'react'
import type React from 'react'
import { Avatar } from './Avatar'
import { useLongPress } from '../hooks/useLongPress'
import type { Message } from '../types'
import { useSettingsStore } from '../store/useSettingsStore'
import { reportImageDisplayError } from '../lib/atlasImage'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { downloadImageSource } from '../lib/imageDownload'

interface MessageBubbleProps {
  message: Message
  contactName: string
  contactAvatar: string
  contactAvatarColor: string
  userAvatar: string
  highlighted?: boolean
  mentionNames?: string[]
  replyPreview?: string
  selecting?: boolean
  selected?: boolean
  onReply?: () => void
  onLongPress?: () => void
  onSelect?: () => void
  onLinkClick?: (label: string) => void
  onFinanceClick?: (message: Message) => void
  showName?: boolean
}

export const MessageBubble = forwardRef<HTMLDivElement, MessageBubbleProps>(function MessageBubble(
  {
    message,
    contactName,
    contactAvatar,
    contactAvatarColor,
    userAvatar,
    highlighted,
    mentionNames = [],
    replyPreview,
    selecting,
    selected,
    onReply,
    onLongPress,
    onSelect,
    onLinkClick, onFinanceClick,
    showName = false,
  },
  ref,
) {
  const showPrivateImages = useSettingsStore((state) => state.showPrivateImages)
  const imageAsset = useLiveQuery(() => message.image?.assetId ? db.mediaAssets.get(message.image.assetId) : undefined, [message.image?.assetId])
  const imageSource = imageAsset?.dataUrl || imageAsset?.remoteUrl || message.image?.url
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false)
  const isUser = message.role === 'user'
  const longPress = useLongPress(() => onLongPress?.())
  if (message.type === 'systemState' && message.systemState) {
    const state = message.systemState
    const range = state.startDay === state.endDay ? `第${state.startDay}天` : `第${state.startDay}–${state.endDay}天`
    const slots = state.slots?.length ? ` · ${state.slots.map((slot) => ({ morning: '早晨', day: '白天', evening: '傍晚', night: '夜晚' }[slot])).join('、')}` : ' · 全天'
    const title = state.kind === 'outfit' ? `${state.contactName} 已变更衣着` : state.kind === 'schedule' ? `${state.contactName} 已变更日程` : state.kind === 'outfitRestored' ? `${state.contactName} 已恢复默认衣着` : `${state.contactName} 已恢复基础日程`
    return <div ref={ref} className="px-7 py-2"><div className="rounded-xl border border-violet-100 bg-violet-50 px-3 py-2 text-[12px] text-violet-900"><p className="font-medium">{title}</p><p className="mt-0.5 text-violet-700">{state.state === 'upcoming' ? `将在第${state.startDay}天开始生效` : state.state === 'restored' ? '有效期结束，已恢复默认状态' : `现已生效 · ${range}${slots}`}</p>{state.kind === 'outfit' && <p className="mt-1 text-violet-800">{state.outfit ? `当前衣着：${Object.values(state.outfit).filter((value) => typeof value === 'string').join(' · ')}` : `变更部位：${Object.entries(state.patch ?? {}).map(([key, value]) => `${key}：${value}`).join(' · ')}`}</p>}{state.kind === 'schedule' && <p className="mt-1 text-violet-800">{state.locationName} · {state.activity} · {state.phoneAccess === 'unavailable' ? '暂不方便看手机' : '可使用手机'}</p>}</div></div>
  }
  return (
    <div
      ref={ref}
      {...(selecting ? {} : longPress)}
      onClick={selecting ? onSelect : undefined}
      className={`relative px-3 py-1.5 ${selecting ? 'cursor-pointer pl-12' : ''} ${
        selected ? 'bg-gray-200' : highlighted ? 'bg-yellow-50' : ''
      }`}
    >
      {selecting && (
        <span
          className={`absolute left-4 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border text-[12px] ${
            selected ? 'border-[#1296db] bg-[#1296db] text-white' : 'border-gray-300 bg-white text-transparent'
          }`}
          aria-hidden="true"
        >
          ✓
        </span>
      )}
      {!isUser && showName && <p className="mb-1 pl-10 text-[11px] text-gray-400">{contactName}</p>}
      <div className={`flex items-start gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
        {isUser ? (
          <Avatar avatar={userAvatar} size={32} />
        ) : (
          <Avatar avatar={contactAvatar} color={contactAvatarColor} size={32} />
        )}

        <div className={`flex max-w-[68%] flex-col ${isUser ? 'items-end' : 'items-start'}`}>
          {replyPreview && (
            <div className="mb-1 max-w-full truncate rounded-lg bg-black/5 px-2 py-1 text-[11px] text-gray-500">
              {replyPreview}
            </div>
          )}
          {message.type === 'text' && (
            <div
              className={`whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[14.5px] leading-relaxed ${
                isUser ? 'bg-[#95ec69] text-gray-900' : 'bg-white text-gray-900'
              }`}
            >
              <TextWithMentions text={message.content} names={mentionNames} />
            </div>
          )}

          {message.type === 'link' && (
            <button
              onClick={() => onLinkClick?.(message.link?.label ?? message.content)}
              className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-left"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#aa3bff]/10 text-sm">
                🔗
              </span>
              <span className="text-[13.5px] text-gray-800">{message.link?.label ?? message.content}</span>
            </button>
          )}

          {message.type === 'gift' && message.gift && (
            <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2.5">
              <span className="text-2xl">{message.gift.icon}</span>
              <div>
                <p className="text-[13.5px] text-gray-800">送出了「{message.gift.name}」</p>
                {message.gift.description && <p className="text-[11px] text-gray-400">{message.gift.description}</p>}
              </div>
            </div>
          )}

          {message.type === 'scheduleChange' && message.scheduleChange && (
            <div className="w-56 rounded-xl border border-gray-200 bg-white p-3">
              <div className="mb-1.5 flex items-center gap-1.5">
                <span className="text-xs text-gray-400">📅 日程变更</span>
                <span className="ml-auto text-xs text-gray-400">第{message.scheduleChange.effectiveDay}天</span>
              </div>
              <p className="mb-1 text-[14px] font-medium text-gray-900">{message.scheduleChange.summary}</p>
              <p className="text-[12.5px] leading-relaxed text-gray-500">
                {({ morning: '08:00', day: '12:00', evening: '18:00', night: '22:00' } as const)[message.scheduleChange.slot]} · {message.scheduleChange.location || message.scheduleChange.locationId}
              </p>
            </div>
          )}
          {message.type === 'image' && (
            <div className="relative w-56 overflow-hidden rounded-xl bg-gray-200" style={{ aspectRatio: message.image?.aspectRatio || '2/3' }}>
              {message.image?.status === 'completed' && imageSource ? <button type="button" disabled={message.image.sensitive && !showPrivateImages} onClick={(event) => { event.stopPropagation(); setImagePreviewOpen(true) }} className="h-full w-full cursor-zoom-in disabled:cursor-default"><img src={imageSource} alt={message.image.caption || '聊天图片'} onError={() => { if (message.image?.assetId) void reportImageDisplayError(message.image.assetId, '聊天图片在当前设备中加载失败') }} className={`h-full w-full object-cover ${message.image.sensitive && !showPrivateImages ? 'scale-105 blur-xl' : ''}`} /></button> : <div className="flex h-full items-center justify-center whitespace-pre-line px-4 text-center text-xs text-gray-500">{message.image?.status === 'failed' ? `图片发送失败\n${message.image.caption || ''}` : '图片生成中…'}</div>}
              {message.image?.status === 'completed' && message.image.sensitive && !showPrivateImages && <div className="absolute inset-0 flex items-center justify-center bg-black/25 px-4 text-center text-xs text-white">较私密图片已隐藏<br/>可在设置中开启直接显示</div>}
            </div>
          )}
          {message.type === 'groupPlan' && (
            <div className="w-56 rounded-xl border border-[#07c160]/30 bg-[#f0fff5] p-3">
              <p className="text-xs text-[#07a651]">📅 共同计划 · 待确认</p>
              <p className="mt-1 text-[14px] font-medium text-gray-900">{message.content}</p>
              <p className="mt-1 text-[11px] text-gray-500">可在群聊信息中确认、取消或标记成行</p>
            </div>
          )}
          {['transfer','redPacket','loanRequest','loanResult','repayment'].includes(message.type) && message.finance && (
            <button onClick={()=>onFinanceClick?.(message)} className="w-56 rounded-xl border border-orange-200 bg-gradient-to-br from-orange-400 to-red-500 p-3 text-left text-white">
              <p className="text-sm font-medium">{message.type==='transfer'?'💸 转账':message.type==='redPacket'?'🧧 红包':message.type==='loanRequest'?'🤝 借款申请':message.type==='repayment'?'✅ 已还款':'📋 借款结果'}</p>
              <p className="mt-2 text-xl font-bold">{message.type==='redPacket'&&message.finance.status==='pending'?'点击领取':message.finance.amount}</p>
              <p className="mt-1 text-xs text-white/80">{message.finance.note || message.finance.status}</p>
            </button>
          )}

          <div className={`mt-0.5 flex items-center gap-2 px-1 ${isUser ? 'flex-row-reverse' : ''}`}>
            {onReply && (
              <button onClick={onReply} className="text-[10px] text-gray-400">
                回复
              </button>
            )}
          </div>
        </div>
      </div>
      {imagePreviewOpen && imageSource && <ImagePreview source={imageSource} alt={message.image?.caption || '聊天图片'} onClose={() => setImagePreviewOpen(false)} />}
    </div>
  )
})

function ImagePreview({ source, alt, onClose }: { source: string; alt: string; onClose: () => void }) {
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])
  const save = async () => {
    setSaveState('saving')
    try { await downloadImageSource(source); setSaveState('saved') }
    catch { setSaveState('error') }
  }
  return <div role="dialog" aria-modal="true" aria-label="图片预览" onClick={(event) => { event.stopPropagation(); onClose() }} onPointerDown={(event: React.PointerEvent) => event.stopPropagation()} className="fixed inset-0 z-[100] flex flex-col bg-black/95">
    <div className="flex shrink-0 items-center justify-between px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))] text-white">
      <button type="button" onClick={onClose} className="rounded-full bg-white/10 px-3 py-2 text-sm">关闭</button>
      <span className={`text-xs ${saveState === 'error' ? 'text-red-300' : 'text-white/70'}`}>{saveState === 'saved' ? '已保存' : saveState === 'error' ? '保存失败' : ''}</span>
      <button type="button" disabled={saveState === 'saving'} onClick={(event) => { event.stopPropagation(); void save() }} className="rounded-full bg-white px-4 py-2 text-sm font-medium text-gray-900 disabled:opacity-60">{saveState === 'saving' ? '保存中…' : '保存图片'}</button>
    </div>
    <div className="min-h-0 flex flex-1 items-center justify-center p-3"><img src={source} alt={alt} onClick={(event) => event.stopPropagation()} className="max-h-full max-w-full object-contain" /></div>
  </div>
}

function TextWithMentions({ text, names }: { text: string; names: string[] }) {
  if (names.length === 0) return <>{text}</>

  const escaped = names
    .filter(Boolean)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (escaped.length === 0) return <>{text}</>

  const pattern = new RegExp(`@(${escaped.join('|')})`, 'g')
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index))
    parts.push(
      <span key={`${match[0]}-${match.index}`} className="font-medium text-[#576b95]">
        {match[0]}
      </span>,
    )
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return <>{parts}</>
}
