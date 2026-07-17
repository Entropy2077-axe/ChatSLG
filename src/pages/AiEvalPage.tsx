import { useMemo, useRef, useState } from 'react'
import { TopBar } from '../components/TopBar'
import { isAiEvalDatabase } from '../db/db'
import { AI_EVAL_SCENARIOS } from '../lib/aiEval/scenarios'
import { createAiEvalSandboxUrl, exitAiEvalSandboxUrl, loadLatestAiEvalReport, runAiEval } from '../lib/aiEval/runner'
import { downloadAiEvalHtml, downloadAiEvalJson, downloadAiEvalMarkdown } from '../lib/aiEval/report'
import type { AiEvalCategory, AiEvalReport, AiEvalRunResult, AiEvalSuite } from '../lib/aiEval/types'

const CATEGORY_LABEL: Record<AiEvalCategory, string> = {
  private_reply: '私聊回复',
  group_liveliness: '群聊热闹度',
  outfit: '衣着',
  schedule: '日程',
  location: '位置',
  multi_state: '多状态',
  fault_recovery: '故障恢复',
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`

export function AiEvalPage() {
  const [report, setReport] = useState<AiEvalReport | undefined>(() => loadLatestAiEvalReport())
  const [running, setRunning] = useState(false)
  const [completed, setCompleted] = useState(0)
  const [total, setTotal] = useState(0)
  const [latest, setLatest] = useState<AiEvalRunResult | undefined>()
  const [selectedCategory, setSelectedCategory] = useState<AiEvalCategory>('group_liveliness')
  const [selectedSuite, setSelectedSuite] = useState<AiEvalSuite>('acceptance')
  const [repeat, setRepeat] = useState(1)
  const [openResult, setOpenResult] = useState<string | undefined>()
  const controller = useRef<AbortController | null>(null)
  const failures = useMemo(() => report?.results.filter((result) => result.status !== 'passed') ?? [], [report])

  const execute = async (options: { category?: AiEvalCategory; suite?: AiEvalSuite; scenarioIds?: string[]; repetitionOverride?: number }) => {
    const abort = new AbortController()
    controller.current = abort
    setRunning(true)
    setCompleted(0)
    setTotal(0)
    try {
      const next = await runAiEval({
        ...options,
        signal: abort.signal,
        maxModelCalls: 180,
        onProgress: (done, count, result) => {
          setCompleted(done)
          setTotal(count)
          setLatest(result)
        },
      })
      setReport(next)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    } finally {
      setRunning(false)
      controller.current = null
    }
  }

  if (!isAiEvalDatabase) {
    return <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="AI测试台" showBack />
      <main className="flex-1 overflow-y-auto p-4">
        <section className="rounded-2xl bg-white p-5">
          <h2 className="text-base font-semibold">先进入隔离测试空间</h2>
          <p className="mt-2 text-sm leading-6 text-gray-500">测试会重新加载应用，并从启动时使用独立 IndexedDB。你的联系人、聊天记录、世界和正式数据库不会被测试读取或写入；API Key 仍只从本机设置读取，不会进入报告。</p>
          <button type="button" onClick={() => { window.location.href = createAiEvalSandboxUrl() }} className="mt-4 w-full rounded-xl bg-gray-900 py-3 text-sm text-white">进入隔离测试空间</button>
        </section>
      </main>
    </div>
  }

  return <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
    <TopBar title="AI测试台 · 隔离" />
    <main className="flex-1 overflow-y-auto pb-8">
      <section className="bg-green-50 px-4 py-3 text-xs leading-5 text-green-700">
        当前使用独立数据库。单次完整基线最多允许180次模型尝试，低于任务上限200次；模型接口不支持固定随机种子。
      </section>
      <section className="mt-3 bg-white p-4">
        <div className="flex items-center justify-between"><h2 className="font-medium">运行控制</h2><button type="button" disabled={running} onClick={() => { window.location.href = exitAiEvalSandboxUrl() }} className="text-xs text-gray-500 disabled:opacity-40">退出隔离空间</button></div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <select value={selectedSuite} onChange={(event) => setSelectedSuite(event.target.value as AiEvalSuite)} className="rounded-xl border px-3 py-2 text-sm">
            <option value="acceptance">独立验收集</option>
            <option value="development">开发回归集</option>
          </select>
          <select value={selectedCategory} onChange={(event) => setSelectedCategory(event.target.value as AiEvalCategory)} className="rounded-xl border px-3 py-2 text-sm">
            {Object.entries(CATEGORY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="flex items-center gap-2 rounded-xl border px-3 text-xs">重复 <input type="number" min={1} max={10} value={repeat} onChange={(event) => setRepeat(Math.max(1, Math.min(10, Number(event.target.value))))} className="w-full py-2 text-right text-sm outline-none" /></label>
          <button disabled={running} type="button" onClick={() => void execute({ suite: selectedSuite, repetitionOverride: repeat })} className="rounded-xl border py-2.5 text-sm disabled:opacity-40">运行所选测试集</button>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button disabled={running} type="button" onClick={() => void execute({ category: selectedCategory, suite: selectedSuite, repetitionOverride: repeat })} className="rounded-xl border py-2.5 text-sm disabled:opacity-40">运行测试集内分类</button>
          <button disabled={running} type="button" onClick={() => void execute({})} className="rounded-xl bg-gray-900 py-2.5 text-sm text-white disabled:opacity-40">运行全部</button>
        </div>
        {running && <button type="button" onClick={() => controller.current?.abort()} className="mt-2 w-full rounded-xl bg-red-50 py-2.5 text-sm text-red-600">取消执行</button>}
        <div className="mt-4">
          <div className="flex justify-between text-xs text-gray-500"><span>{running ? '正在运行' : '空闲'}</span><span>{completed}/{total || '—'}</span></div>
          <div className="mt-1 h-2 overflow-hidden rounded bg-gray-100"><div className="h-full bg-green-500 transition-all" style={{ width: total ? `${completed / total * 100}%` : '0%' }} /></div>
          {latest && <p className="mt-2 text-xs text-gray-500">最近：{latest.scenarioId} · {latest.status} · {(latest.durationMs / 1000).toFixed(1)}秒</p>}
        </div>
      </section>

      {report && <section className="mt-3 bg-white p-4">
        <h2 className="font-medium">最近结果</h2>
        <div className="mt-3 grid grid-cols-2 gap-2 text-center">
          <Metric label="执行 / 计划" value={`${report.summary.executedRuns}/${report.summary.totalRuns}`} />
          <Metric label="完全通过率" value={pct(report.summary.completePassRate)} />
          <Metric label="真实 / Mock" value={`${report.summary.realRuns}/${report.summary.mockRuns}`} />
          <Metric label="首次直接通过" value={pct(report.summary.realFirstAttemptPassRate)} />
          <Metric label="修复后最终通过" value={pct(report.summary.realCompletePassRate)} />
          <Metric label="重试救回率" value={pct(report.summary.repairRecoveryRate)} />
          <Metric label="端到端通过率" value={pct(report.summary.endToEndPassRate)} />
          <Metric label="独立验收集" value={pct(report.summary.acceptancePassRate)} />
          <Metric label="直接裁决器" value={pct(report.summary.adjudicatorOnlyPassRate)} />
          <Metric label="真实故障注入" value={pct(report.summary.faultInjectionPassRate)} />
          <Metric label="配置阻塞" value={String(report.summary.blockedRuns)} />
          <Metric label="模型调用均值" value={report.summary.averageModelCalls.toFixed(2)} />
          <Metric label="热闹度条数" value={pct(report.summary.livelinessTargetRate)} />
          <Metric label="多人参与" value={pct(report.summary.multiSpeakerRate)} />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <button type="button" onClick={() => downloadAiEvalJson(report)} className="rounded-lg border py-2">导出JSON</button>
          <button type="button" onClick={() => downloadAiEvalMarkdown(report)} className="rounded-lg border py-2">导出MD</button>
          <button type="button" onClick={() => downloadAiEvalHtml(report)} className="rounded-lg border py-2">导出HTML</button>
        </div>
      </section>}

      <section className="mt-3 bg-white p-4">
        <div className="flex items-center justify-between"><h2 className="font-medium">最近失败案例</h2>{failures.length > 0 && <button disabled={running} type="button" onClick={() => void execute({ scenarioIds: [...new Set(failures.map((item) => item.scenarioId))], repetitionOverride: 1 })} className="text-xs text-blue-600">重跑失败案例</button>}</div>
        {failures.length === 0 ? <p className="mt-3 rounded-xl bg-gray-50 p-3 text-xs text-gray-400">还没有失败结果。</p> : failures.slice(-10).reverse().map((result) => <ResultCard key={result.id} result={result} open={openResult === result.id} toggle={() => setOpenResult(openResult === result.id ? undefined : result.id)} />)}
      </section>

      <section className="mt-3 bg-white p-4">
        <h2 className="font-medium">测试场景</h2>
        <div className="mt-2 space-y-2">{AI_EVAL_SCENARIOS.map((scenario) => <div key={scenario.id} className="rounded-xl border p-3"><div className="flex justify-between gap-2"><div><p className="text-sm">{scenario.description}</p><p className="mt-1 text-[11px] text-gray-400">{scenario.id} · {CATEGORY_LABEL[scenario.category]} · {scenario.suite === 'acceptance' ? '独立验收' : '开发回归'} · {scenario.coverage ?? (scenario.kind === 'state' ? '直接裁决器' : scenario.kind === 'fault' ? '分类自检' : '端到端')} · 默认{scenario.repetitions}次</p></div><button disabled={running} type="button" onClick={() => void execute({ scenarioIds: [scenario.id], repetitionOverride: repeat })} className="shrink-0 text-xs text-blue-600 disabled:opacity-40">运行</button></div></div>)}</div>
      </section>
    </main>
  </div>
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl bg-gray-50 p-3"><p className="text-[11px] text-gray-400">{label}</p><p className="mt-1 text-lg font-semibold">{value}</p></div>
}

function ResultCard({ result, open, toggle }: { result: AiEvalRunResult; open: boolean; toggle: () => void }) {
  return <div className="mt-2 overflow-hidden rounded-xl border">
    <button type="button" onClick={toggle} className="flex w-full justify-between gap-2 p-3 text-left text-xs"><span>{result.scenarioId}<br /><span className="text-gray-400">{result.failureType} · {result.durationMs}ms</span></span><strong className={result.status === 'passed' ? 'text-green-600' : 'text-red-500'}>{result.status}</strong></button>
    {open && <div className="space-y-2 border-t bg-gray-50 p-3 text-[11px]">
      <p className="text-gray-600">首次直接通过：{result.firstAttemptPassed ? '是' : '否'} · 触发修复/重试：{result.repairAttempted ? '是' : '否'} · 最终救回：{result.recovered ? '是' : '否'}</p>
      <p className="text-red-600">{result.error || result.assertions.filter((item) => !item.passed).map((item) => item.label).join('；') || '无错误文字'}</p>
      <details><summary>硬性断言</summary><pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap rounded bg-white p-2">{JSON.stringify(result.assertions, null, 2)}</pre></details>
      <details><summary>原始输出</summary><pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap rounded bg-white p-2">{result.rawOutputs.join('\n\n') || '（无）'}</pre></details>
      <details><summary>解析结果</summary><pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap rounded bg-white p-2">{JSON.stringify(result.parsedOutputs, null, 2)}</pre></details>
      <details><summary>最终数据库状态</summary><pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap rounded bg-white p-2">{JSON.stringify(result.databaseState, null, 2)}</pre></details>
    </div>}
  </div>
}
