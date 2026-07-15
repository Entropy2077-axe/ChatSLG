import { useState } from 'react'
import type { AppSettings } from '../types'

export type MindReadingStyle = NonNullable<AppSettings['mindReadingStyle']>

export function ThoughtBubble({ thought, style }: { thought: string; style: MindReadingStyle }) {
  const [expanded, setExpanded] = useState(false)

  if (style === 'line') {
    return <div className="border-l-2 border-violet-300 py-0.5 pl-2.5 text-[11px] leading-relaxed text-gray-500">{thought}</div>
  }
  if (style === 'pill') {
    return <div className="inline-flex max-w-full items-start gap-1 rounded-2xl bg-violet-100 px-3 py-1.5 text-[11px] leading-relaxed text-violet-700"><span>✦</span><span>{thought}</span></div>
  }
  if (style === 'reveal') {
    return (
      <button type="button" aria-label={expanded ? '收起想法' : '查看想法'} onClick={() => setExpanded((value) => !value)} className="block max-w-full rounded-full bg-gray-100 px-3 py-1.5 text-left text-[11px] leading-relaxed text-gray-500">
        <span className="mr-1">👁</span>{expanded ? thought : '查看想法'}
      </button>
    )
  }
  return <div className="rounded-xl border border-violet-100 bg-violet-50/80 px-3 py-2 text-[11px] leading-relaxed text-violet-600"><span className="mr-1">◌</span>{thought}</div>
}
