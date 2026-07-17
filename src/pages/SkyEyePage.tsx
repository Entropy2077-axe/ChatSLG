import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { TopBar } from '../components/TopBar'
import { useConsoleCaptureStore } from '../lib/consoleCapture'
import { db } from '../db/db'
import { formatBubbleTime } from '../lib/time'
import { useChatEngineStore, stopAiTurn } from '../lib/chatEngine'
import { stopGroupAiTurn } from '../lib/groupChatEngine'
import { retryAtlasGeneration } from '../lib/atlasImage'
import { useSettingsStore } from '../store/useSettingsStore'
import type { AdminAiTrace, AdminAiTraceStage, AiTurnDebug, MediaAsset, StateApplicationReceipt } from '../types'

const COLORS: Record<string, string> = { log: 'text-gray-600', info: 'text-blue-600', warn: 'text-amber-600', error: 'text-red-600' }
const PAGE = 50
const TRACE_PAGE = 20
const IMAGE_PAGE = 20
const EMPTY_TRACES: AdminAiTrace[] = []
const STAGE_ORDER: AdminAiTraceStage[] = ['first_chat', 'other', 'first_quality', 'second_chat', 'second_quality', 'state', 'state_retry']
const STAGE_LABEL: Record<AdminAiTraceStage, string> = { first_chat: '第一次 Chat', first_quality: '第一次逻辑审核', second_chat: '第二次 Chat', other: '格式转换', second_quality: '第二次逻辑审核', state: '状态裁决', state_retry: '状态裁决修复' }
const TABS = [['overview', '概览'], ['images', '图片'], ['state', '状态'], ['calls', '调用'], ['logs', '日志']] as const
type SkyEyeTab = typeof TABS[number][0]

interface TraceTurn { id: string; traces: AdminAiTrace[]; createdAt: number; conversationId?: string; legacy: boolean }

function stateReceiptView(turn: AiTurnDebug) {
  if (!turn.parsed || typeof turn.parsed !== 'object') return undefined
  const parsed = turn.parsed as { kind?: unknown; review?: { valid?: unknown; reason?: unknown }; decisions?: unknown; receipts?: unknown }
  if (parsed.kind !== 'unifiedTurnAdjudication') return undefined
  return {
    turn,
    reviewValid: parsed.review?.valid !== false,
    reviewReason: typeof parsed.review?.reason === 'string' ? parsed.review.reason : '',
    decisionCount: Array.isArray(parsed.decisions) ? parsed.decisions.length : 0,
    receipts: Array.isArray(parsed.receipts) ? parsed.receipts as StateApplicationReceipt[] : [],
  }
}

function groupTraces(traces: AdminAiTrace[]): TraceTurn[] {
  const groups = new Map<string, TraceTurn>()
  for (const trace of traces) {
    const id = trace.turnId || `legacy:${trace.id}`
    const existing = groups.get(id)
    if (existing) {
      existing.traces.push(trace)
      existing.createdAt = Math.max(existing.createdAt, trace.createdAt)
    } else groups.set(id, { id, traces: [trace], createdAt: trace.createdAt, conversationId: trace.conversationId, legacy: !trace.turnId })
  }
  return Array.from(groups.values()).sort((a, b) => b.createdAt - a.createdAt)
}

function reviewResult(trace: AdminAiTrace): { passed?: boolean; reason?: string } {
  if (trace.error) return { passed: false, reason: trace.error }
  try {
    const parsed = JSON.parse(trace.output || '') as { valid?: unknown; reason?: unknown }
    return { passed: parsed.valid === true, reason: typeof parsed.reason === 'string' ? parsed.reason : undefined }
  } catch { return {} }
}

export function SkyEyePage() {
  const navigate = useNavigate()
  const logs = useConsoleCaptureStore((s) => s.logs)
  const clearLogs = useConsoleCaptureStore((s) => s.clear)
  const states = useChatEngineStore((s) => s.states)
  const [tab, setTab] = useState<SkyEyeTab>('overview'); const [logPage, setLogPage] = useState(0); const [turnPage, setTurnPage] = useState(0); const [imagePage, setImagePage] = useState(0); const [level, setLevel] = useState('all'); const [query, setQuery] = useState(''); const [open, setOpen] = useState<string | null>(null); const [openImage, setOpenImage] = useState<string | null>(null)
  const conversations = useLiveQuery(() => db.conversations.toArray(), []) ?? []
  const contacts = useLiveQuery(() => db.contacts.toArray(), []) ?? []
  const traces = useLiveQuery(() => db.adminAiTraces.orderBy('createdAt').reverse().toArray(), []) ?? EMPTY_TRACES
  const imageAssets = useLiveQuery(() => db.mediaAssets.orderBy('createdAt').reverse().filter((asset) => asset.source === 'atlas').toArray(), []) ?? []
  const imageRequests = useLiveQuery(() => db.imageRequests.orderBy('createdAt').reverse().toArray(), []) ?? []
  const stateReceiptTurns = (useLiveQuery(() => db.aiTurns.orderBy('createdAt').reverse().toArray(), []) ?? []).map(stateReceiptView).filter((item): item is NonNullable<typeof item> => !!item).slice(0, 20)
  const traceTurns = useMemo(() => groupTraces(traces), [traces])
  const shownLogs = useMemo(() => logs.slice().reverse().filter((log) => (level === 'all' || log.level === level) && log.message.toLowerCase().includes(query.toLowerCase())), [logs, level, query])
  const shownTurns = traceTurns.slice(turnPage * TRACE_PAGE, turnPage * TRACE_PAGE + TRACE_PAGE)
  const active = Object.entries(states).filter(([, state]) => state.aiTyping)
  const imageFailures = imageRequests.filter((task) => ['failed', 'rejected'].includes(task.status)).length
  const stateFailures = stateReceiptTurns.flatMap((item) => item.receipts).filter((receipt) => ['failed', 'rejected'].includes(receipt.status)).length
  const recentErrors = logs.filter((log) => log.level === 'error').length
  const label = (id: string) => conversations.find((item) => item.id === id)?.groupId ? '群聊' : '私聊'
  return <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]"><TopBar title="天眼" showBack />
    <nav className="flex shrink-0 border-b bg-white px-2">{TABS.map(([id, text]) => <button key={id} type="button" onClick={() => setTab(id)} className={`flex-1 border-b-2 px-1 py-3 text-xs ${tab === id ? 'border-gray-900 font-medium text-gray-900' : 'border-transparent text-gray-400'}`}>{text}</button>)}</nav>
    <div className="flex-1 overflow-y-auto pb-5">
      {tab === 'overview' && <><section className="mt-3 bg-white px-4 py-4"><h2 className="mb-3 text-sm font-medium">当前运行</h2>{active.length === 0 ? <p className="text-xs text-gray-400">系统空闲，没有正在生成的回复。</p> : active.map(([id, state]) => <div key={id} className="mb-2 flex items-center justify-between rounded-lg bg-green-50 p-2 text-sm"><span>{label(id)} · {state.typingLabel || 'AI'} 正在生成</span><button type="button" onClick={() => conversations.find((c) => c.id === id)?.groupId ? stopGroupAiTurn(id) : stopAiTurn(id)} className="text-red-500">停止</button></div>)}</section><section className="mt-3 bg-white px-4 py-4"><button type="button" onClick={() => navigate('/ai-eval')} className="flex w-full items-center justify-between rounded-xl bg-gray-900 px-4 py-3 text-left text-white"><span><strong className="block text-sm">AI测试台</strong><span className="mt-1 block text-[11px] text-gray-300">隔离数据库 · 真实模型基线 · 可导出报告</span></span><span>›</span></button></section><section className="mt-3 bg-white px-4 py-4"><h2 className="mb-3 text-sm font-medium">诊断摘要</h2><div className="grid grid-cols-2 gap-2"><SummaryCard label="图片任务" value={imageRequests.length} issue={imageFailures} /><SummaryCard label="状态异常" value={stateReceiptTurns.length} issue={stateFailures} /><SummaryCard label="AI 回合" value={traceTurns.length} /><SummaryCard label="错误日志" value={recentErrors} issue={recentErrors} /></div><p className="mt-3 text-[11px] text-gray-400">只有出现异常时再进入对应标签查看详情。</p></section></>}
      {tab === 'images' && <section className="mt-3 bg-white px-4 py-4"><h2 className="mb-1 text-sm font-medium">图片任务</h2><p className="mb-3 text-[11px] text-gray-400">点击任务查看提示词和 Atlas 阶段详情。</p>{imageRequests.slice(0, 10).map((task) => <details key={task.id} className="mb-2 rounded-xl border bg-gray-50 p-3 text-[11px]"><summary className="flex cursor-pointer justify-between gap-2 text-sm"><span className="truncate">{contacts.find((contact) => contact.id === task.contactId)?.name || '未知角色'} · {task.userRequest}</span><strong className={task.status === 'completed' ? 'text-green-600' : ['failed','rejected','expired'].includes(task.status) ? 'text-red-500' : 'text-amber-600'}>{task.status}</strong></summary><div className="mt-2 space-y-1 text-gray-500"><p>决定：{task.decisionReason || '等待处理'}</p><p className="break-all">任务 ID：{task.id}</p><p className="break-all">图片 ID：{task.mediaAssetId || '未创建'}</p></div></details>)}{imageAssets.length === 0 ? <p className="rounded-lg bg-gray-50 p-3 text-xs text-gray-400">还没有 Atlas 图片任务。</p> : imageAssets.slice(imagePage * IMAGE_PAGE, imagePage * IMAGE_PAGE + IMAGE_PAGE).map((asset) => <ImageTraceCard key={asset.id} asset={asset} owner={contacts.find((contact) => contact.id === asset.ownerContactId)?.name} open={openImage === asset.id} toggle={() => setOpenImage(openImage === asset.id ? null : asset.id)} />)}<Pager page={imagePage} total={imageAssets.length} size={IMAGE_PAGE} setPage={setImagePage} /></section>}
      {tab === 'state' && <section className="mt-3 bg-white px-4 py-4"><h2 className="mb-1 text-sm font-medium">状态回执</h2><p className="mb-3 text-[11px] text-gray-400">只展示最近 20 次裁决，展开异常项时再看记录 ID。</p>{stateReceiptTurns.length === 0 ? <p className="rounded-lg bg-gray-50 p-3 text-xs text-gray-400">还没有状态裁决记录。</p> : stateReceiptTurns.map(({ turn, reviewValid, reviewReason, decisionCount, receipts }) => <details key={turn.id} className="mb-2 rounded-xl border bg-gray-50 p-3 text-[11px]"><summary className="flex cursor-pointer justify-between gap-2"><strong>{reviewValid ? `${decisionCount} 项决定 · ${receipts.length} 项回执` : '裁决未通过'}</strong><span className="text-gray-400">{new Date(turn.createdAt).toLocaleString()}</span></summary>{reviewReason && <p className="mt-2 text-red-500">{reviewReason}</p>}<div className="mt-2 space-y-1">{receipts.length === 0 ? <p className="text-gray-500">没有状态变化。</p> : receipts.map((receipt, index) => <p key={`${receipt.kind}-${index}`} className={receipt.status === 'applied' ? 'text-green-600' : receipt.status === 'duplicate' ? 'text-amber-600' : 'text-red-500'}>{receipt.kind} · {receipt.status} · {receipt.reason}{receipt.recordIds.length ? ` · ${receipt.recordIds.join(', ')}` : ''}</p>)}</div></details>)}</section>}
      {tab === 'calls' && <section className="mt-3 bg-white px-4 py-4"><h2 className="mb-1 text-sm font-medium">AI 调用</h2><p className="mb-3 text-[11px] text-gray-400">每张卡片是一轮回复，点击后查看各阶段耗时与输入输出。</p>{shownTurns.map((turn) => <TraceTurnCard key={turn.id} turn={turn} open={open === turn.id} toggle={() => setOpen(open === turn.id ? null : turn.id)} scene={turn.conversationId ? label(turn.conversationId) : undefined} />)}<Pager page={turnPage} total={traceTurns.length} size={TRACE_PAGE} setPage={setTurnPage} /></section>}
      {tab === 'logs' && <section className="mt-3 bg-white px-4 py-4"><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-medium">日志</h2><button type="button" onClick={clearLogs} className="text-xs text-red-500">清空</button></div><div className="mb-2 flex gap-2"><select value={level} onChange={(e) => { setLevel(e.target.value); setLogPage(0) }} className="rounded border px-2 text-xs"><option value="all">全部</option><option value="error">错误</option><option value="warn">警告</option><option value="info">信息</option><option value="log">日志</option></select><input value={query} onChange={(e) => { setQuery(e.target.value); setLogPage(0) }} placeholder="搜索日志" className="min-w-0 flex-1 rounded border px-2 text-xs" /></div><div className="space-y-1 rounded-lg bg-gray-50 p-2 font-mono text-[11px]">{shownLogs.slice(logPage * PAGE, logPage * PAGE + PAGE).map((log) => <p key={log.id} className={COLORS[log.level]}><span className="text-gray-400">[{formatBubbleTime(log.timestamp)}]</span> {log.message}</p>)}</div><Pager page={logPage} total={shownLogs.length} size={PAGE} setPage={setLogPage} /></section>}
    </div>
  </div>
}

function SummaryCard({ label, value, issue = 0 }: { label: string; value: number; issue?: number }) {
  return <div className="rounded-xl bg-gray-50 p-3"><p className="text-[11px] text-gray-400">{label}</p><p className="mt-1 text-xl font-semibold text-gray-900">{value}</p>{issue > 0 ? <p className="mt-1 text-[10px] text-red-500">{issue} 项需注意</p> : <p className="mt-1 text-[10px] text-green-600">正常</p>}</div>
}

function ImageTraceCard({ asset, owner, open, toggle }: { asset: MediaAsset; owner?: string; open: boolean; toggle: () => void }) {
  const phaseLabel = ({ queued: '等待提交', submitting: '正在提交', polling: '查询生成状态', downloading: '下载图片', decoding: '验证图片', completed: '正常完成', failed: '失败' } as const)[asset.phase ?? (asset.status === 'completed' ? 'completed' : asset.status === 'failed' ? 'failed' : 'queued')]
  const statusColor = asset.status === 'completed' ? 'text-green-600' : asset.status === 'failed' ? 'text-red-500' : 'text-amber-600'
  return <div className="mb-2 overflow-hidden rounded-xl border bg-gray-50">
    <button type="button" onClick={toggle} className="flex w-full items-start justify-between gap-2 p-3 text-left"><div><p className="text-sm font-medium">{owner || '未知角色'} · {asset.origin === 'chat' ? '聊天图片' : asset.origin === 'moment' ? '朋友圈图片' : '图片'}</p><p className="mt-1 text-[11px] text-gray-400">{asset.modelId || '未知模型'} · {new Date(asset.createdAt).toLocaleString()}</p></div><span className={`shrink-0 text-xs ${statusColor}`}>{phaseLabel}</span></button>
    {open && <div className="space-y-2 border-t p-3 text-[11px]">
      <div className="grid grid-cols-[90px_1fr] gap-1 rounded bg-white p-2"><span className="text-gray-400">本地任务 ID</span><span className="break-all">{asset.id}</span><span className="text-gray-400">Prediction ID</span><span className="break-all">{asset.predictionId || '尚未取得'}</span><span className="text-gray-400">尺寸</span><span>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : '未知'}</span><span className="text-gray-400">文件</span><span>{asset.mimeType || '未知格式'}{asset.byteSize ? ` · ${(asset.byteSize / 1024).toFixed(1)} KB` : ''}</span></div>
      {asset.error && <p className="rounded bg-red-50 p-2 text-red-600">错误：{asset.error}</p>}
      <details><summary className="cursor-pointer text-gray-500">绘图提示词</summary><p className="mt-1 whitespace-pre-wrap rounded bg-white p-2">{asset.prompt || '（无）'}</p></details>
      {asset.remoteUrl && <details><summary className="cursor-pointer text-gray-500">远程输出地址</summary><p className="mt-1 break-all rounded bg-white p-2">{asset.remoteUrl}</p></details>}
      <div className="space-y-1 rounded bg-white p-2">{(asset.traceEvents ?? []).length === 0 ? <p className="text-gray-400">旧任务没有阶段记录。</p> : asset.traceEvents?.map((event, index) => <p key={`${event.at}-${index}`}><span className="text-gray-400">[{new Date(event.at).toLocaleTimeString()}]</span> {event.message}{event.httpStatus ? ` · HTTP ${event.httpStatus}` : ''}</p>)}</div>
      {(asset.status !== 'completed' || (!asset.dataUrl && !!asset.remoteUrl)) && <button type="button" onClick={() => void retryAtlasGeneration(asset.id, useSettingsStore.getState())} className="rounded-lg bg-gray-900 px-3 py-2 text-xs text-white">{asset.predictionId ? '重新查询并下载' : '重试提交'}</button>}
    </div>}
  </div>
}

function TraceTurnCard({ turn, open, toggle, scene }: { turn: TraceTurn; open: boolean; toggle: () => void; scene?: string }) {
  const ordered = [...turn.traces].sort((a, b) => {
    const ai = a.stage ? STAGE_ORDER.indexOf(a.stage) : 99
    const bi = b.stage ? STAGE_ORDER.indexOf(b.stage) : 99
    return ai === bi ? a.createdAt - b.createdAt : ai - bi
  })
  const finalReview = [...ordered].reverse().find((trace) => trace.stage === 'second_quality')
  const firstReview = ordered.find((trace) => trace.stage === 'first_quality')
  const finalStatus = finalReview ? reviewResult(finalReview) : firstReview ? reviewResult(firstReview) : {}
  return <div className="mb-3 overflow-hidden rounded-xl border bg-gray-50">
    <button type="button" onClick={toggle} className="w-full p-3 text-left">
      <div className="flex items-start justify-between gap-2"><div><p className="text-sm font-medium">{turn.legacy ? `${ordered[0].purpose} · ${ordered[0].model}` : `${scene || 'AI 回复'} · ${ordered.length} 次调用`}</p><div className="mt-1 flex flex-wrap gap-1">{ordered.map((trace) => <span key={trace.id} className="rounded bg-white px-1.5 py-0.5 text-[10px] text-gray-500">{trace.stage ? STAGE_LABEL[trace.stage] : trace.purpose}</span>)}</div></div><div className="text-right"><p className="text-[11px] text-gray-400">{new Date(turn.createdAt).toLocaleString()}</p>{finalStatus.passed !== undefined && <p className={`mt-1 text-[11px] ${finalStatus.passed ? 'text-green-600' : 'text-red-500'}`}>{finalStatus.passed ? '审核通过' : '审核未通过'}</p>}</div></div>
    </button>
    {open && <div className="space-y-3 border-t p-3">{ordered.map((trace, index) => <TraceStep key={trace.id} trace={trace} index={index} />)}</div>}
  </div>
}

function TraceStep({ trace, index }: { trace: AdminAiTrace; index: number }) {
  const isReview = trace.stage === 'first_quality' || trace.stage === 'second_quality' || (!trace.stage && trace.purpose === 'quality')
  const result = isReview ? reviewResult(trace) : {}
  const title = trace.stage ? STAGE_LABEL[trace.stage] : `${trace.purpose} · ${trace.model}`
  return <div className={`rounded-lg border p-2 ${trace.stage === 'first_chat' ? 'border-blue-200 bg-blue-50' : isReview ? 'border-amber-200 bg-amber-50' : 'bg-white'}`}>
    <div className="mb-2 flex items-center justify-between gap-2"><p className="text-xs font-medium">{index + 1}. {title} <span className="font-normal text-gray-400">· {trace.model}</span></p>{isReview && result.passed !== undefined && <span className={`rounded px-1.5 py-0.5 text-[10px] ${result.passed ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>{result.passed ? '通过' : '未通过'}</span>}</div>
    {result.reason && <p className="mb-2 rounded bg-white/80 p-2 text-[11px] text-gray-600">审核原因：{result.reason}</p>}
    <details open={trace.stage === 'first_chat' || !trace.stage}><summary className="cursor-pointer text-[11px] text-gray-500">输入消息 / Prompt</summary><pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-[11px]">{trace.messages.map((message) => `[${message.role}]\n${message.content}`).join('\n\n')}</pre></details>
    <details open><summary className="cursor-pointer text-[11px] text-gray-500">{trace.error ? '错误' : '模型输出'}</summary><pre className={`mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded p-2 text-[11px] ${trace.error ? 'bg-red-50 text-red-600' : 'bg-white'}`}>{trace.output || trace.error || '（无输出）'}</pre></details>
    <p className="mt-1 text-right text-[10px] text-gray-400">耗时 {trace.latencyMs === undefined ? '—' : `${(trace.latencyMs / 1000).toFixed(2)} 秒`} · 输入 {trace.inputTokens} · 输出 {trace.outputTokens} tokens</p>
  </div>
}
function Pager({ page, total, size, setPage }: { page: number; total: number; size: number; setPage: (page: number) => void }) { const pages = Math.max(1, Math.ceil(total / size)); return <div className="mt-2 flex justify-between text-xs"><button disabled={page === 0} onClick={() => setPage(page - 1)} className="disabled:text-gray-300">上一页</button><span>{page + 1} / {pages}</span><button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} className="disabled:text-gray-300">下一页</button></div> }
