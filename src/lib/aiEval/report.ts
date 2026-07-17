import { useSettingsStore } from '../../store/useSettingsStore'
import type { AiEvalReport, AiEvalRunResult } from './types'

const pct = (value: number) => `${(value * 100).toFixed(1)}%`
const ms = (value: number) => `${Math.round(value)} ms`

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function redactAiEvalText(text: string): string {
  const settings = useSettingsStore.getState()
  const secrets = [settings.apiKey, settings.pexelsApiKey, settings.atlasApiKey]
    .filter((value): value is string => typeof value === 'string' && value.length >= 6)
  return secrets.reduce((safe, secret) => safe.replaceAll(secret, '[REDACTED]'), text)
}

export function safeAiEvalReport(report: AiEvalReport): AiEvalReport {
  return JSON.parse(redactAiEvalText(JSON.stringify(report))) as AiEvalReport
}

function failureRows(results: AiEvalRunResult[]): string {
  const rows = results.filter((result) => result.status !== 'passed').slice(0, 20)
  if (!rows.length) return '| — | — | — | — |\n'
  return rows.map((result) => `| ${result.scenarioId} | ${result.mode} | ${result.failureType} | ${String(result.error ?? result.assertions.find((item) => !item.passed)?.label ?? '').replaceAll('|', '\\|')} |`).join('\n') + '\n'
}

export function aiEvalReportMarkdown(source: AiEvalReport): string {
  const report = safeAiEvalReport(source)
  const s = report.summary
  const categories = Object.entries(s.byCategory).map(([category, row]) => `| ${category} | ${row.runs} | ${row.passed} | ${pct(row.rate)} |`).join('\n')
  const scenarios = report.scenarios.map((scenario) => `| ${scenario.id} | ${scenario.category} | ${scenario.suite === 'acceptance' ? '独立验收' : '开发回归'} | ${scenario.coverage ?? (scenario.kind === 'state' ? 'adjudicator_only' : scenario.kind === 'fault' ? 'classification_only' : 'end_to_end')} | ${scenario.useRealModel ? '真实模型' : '分类自检'} | ${scenario.repetitions} | ${scenario.description.replaceAll('|', '\\|')} |`).join('\n')
  const confirmed = report.confirmedIssues.length ? report.confirmedIssues.map((item) => `- ${item}`).join('\n') : '- 当前样本未复现新的代码问题。'
  const unconfirmed = report.unconfirmedIssues.length ? report.unconfirmedIssues.map((item) => `- ${item}`).join('\n') : '- 无。'
  return `# ChatSLG AI 回归测试报告

> 本报告只陈述当前样本中观察到的结果。样本量不足时不据此宣称达到 99%。

## 测试信息

- 测试日期：${report.generatedAt}
- 代码/应用版本：${report.codeVersion}
- 主模型：${report.model}
- Utility 模型：${report.utilityModel}
- 测试数据库：${report.databaseName}（隔离=${report.isolated ? '是' : '否'}）
- 随机种子：${report.randomSeedNote}
- 核心聊天逻辑是否修改：${report.coreLogicModified ? '是' : '否/本次仅运行测试'}

## 总体指标

| 指标 | 数值 |
| --- | ---: |
| 总运行次数 | ${s.totalRuns} |
| 实际执行次数 | ${s.executedRuns} |
| 因配置阻塞次数 | ${s.blockedRuns} |
| 真实模型运行次数 | ${s.realRuns} |
| 真实模型完全通过 | ${s.realPassedRuns} |
| 真实模型首次直接通过率 | ${pct(s.realFirstAttemptPassRate)} |
| 真实模型修复后最终通过率 | ${pct(s.realCompletePassRate)} |
| 发生修复/重试的比例 | ${pct(s.repairAttemptRate)} |
| 修复/重试救回率 | ${pct(s.repairRecoveryRate)} |
| 完整端到端通过率 | ${pct(s.endToEndPassRate)} |
| 直接裁决器通过率 | ${pct(s.adjudicatorOnlyPassRate)} |
| 独立验收集通过率 | ${pct(s.acceptancePassRate)} |
| 开发回归集通过率 | ${pct(s.developmentPassRate)} |
| 实际故障注入通过率 | ${pct(s.faultInjectionPassRate)} |
| 分类表自检次数（不计生产通过率） | ${s.classificationOnlyRuns} |
| Mock/分类自检运行次数 | ${s.mockRuns} |
| 回复格式成功率 | ${pct(s.replyFormatSuccessRate)} |
| 热闹度条数达标率 | ${pct(s.livelinessTargetRate)} |
| 多人参与率 | ${pct(s.multiSpeakerRate)} |
| 衣着状态召回率 | ${pct(s.outfitRecallRate)} |
| 衣着误触发率 | ${pct(s.outfitFalsePositiveRate)} |
| 日程状态召回率 | ${pct(s.scheduleRecallRate)} |
| 日程误触发率 | ${pct(s.scheduleFalsePositiveRate)} |
| 地点状态召回率 | ${pct(s.locationRecallRate)} |
| 地点误触发率 | ${pct(s.locationFalsePositiveRate)} |
| 多状态同时提交成功率 | ${pct(s.multiStateCommitRate)} |
| 数据库提交成功率 | ${pct(s.databaseCommitRate)} |
| 平均耗时 | ${ms(s.averageDurationMs)} |
| P50 / P95 | ${ms(s.p50DurationMs)} / ${ms(s.p95DurationMs)} |
| 平均模型调用次数 | ${s.averageModelCalls.toFixed(2)} |

${s.realRuns === 0 ? '> 注意：本次没有成功启动任何真实模型测试；上述通过率只表示 Mock 故障分类与功能检测工具通过，不能解释为模型正确率。\n' : ''}

## 分类成功率

| 分类 | 运行 | 通过 | 成功率 |
| --- | ---: | ---: | ---: |
${categories || '| — | 0 | 0 | 0% |'}

## 场景列表

| 场景ID | 分类 | 测试集 | 覆盖层级 | 模式 | 默认重复 | 说明 |
| --- | --- | --- | --- | --- | ---: | --- |
${scenarios}

## 失败案例摘要

| 场景 | 模式 | 失败类型 | 原因 |
| --- | --- | --- | --- |
${failureRows(report.results)}

## 已确认的代码问题

${confirmed}

## 尚不能确认的问题

${unconfirmed}

## 结果解读

“首次直接通过率”表示没有任何传输重试、结构修复或状态重写就成功；“修复后最终通过率”才包含被重试机制救回的结果。完整端到端状态场景必须先调用真实聊天引擎产生角色回复，再检查状态裁决和数据库；直接裁决器场景使用脚本化证据，只证明裁决器本身。分类表自检不是故障注入，不计入生产正确率。即使固定样本全部通过，也不能外推为未覆盖输入达到 99% 可靠性。

## 后续对比方法

保持场景ID、模型、数据库隔离方式和重复次数不变，从“天眼 → AI测试台”运行全部场景。导出JSON后按 scenarioId + repetition 比较硬断言、失败类型、数据库最终状态、模型调用数和P50/P95耗时。Mock结果不得与真实模型成功率混算。
`
}

export function aiEvalReportHtml(report: AiEvalReport): string {
  const safe = safeAiEvalReport(report)
  const markdown = aiEvalReportMarkdown(safe)
  const resultRows = safe.results.map((result) => `<tr><td>${escapeHtml(result.scenarioId)}</td><td>${escapeHtml(result.mode)}</td><td>${escapeHtml(result.status)}</td><td>${escapeHtml(result.bubbleCount)}</td><td>${escapeHtml(result.distinctSpeakerCount)}</td><td>${escapeHtml(result.failureType)}</td><td>${escapeHtml(result.durationMs)} ms</td></tr>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ChatSLG AI Test Report</title><style>body{font:14px/1.6 system-ui;margin:0;background:#f4f4f6;color:#171717}.wrap{max-width:1100px;margin:auto;padding:24px}.card{background:#fff;border-radius:14px;padding:18px;margin:12px 0;overflow:auto}h1,h2{margin:.2em 0 .7em}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #eee;padding:8px;text-align:left}pre{white-space:pre-wrap;font:12px/1.5 ui-monospace;background:#fafafa;padding:14px;border-radius:10px}</style></head><body><main class="wrap"><h1>ChatSLG AI 回归测试报告</h1><section class="card"><table><tbody><tr><th>生成时间</th><td>${escapeHtml(safe.generatedAt)}</td></tr><tr><th>真实 / Mock</th><td>${safe.summary.realRuns} / ${safe.summary.mockRuns}</td></tr><tr><th>完全通过率</th><td>${pct(safe.summary.completePassRate)}</td></tr><tr><th>隔离数据库</th><td>${escapeHtml(safe.databaseName)}</td></tr></tbody></table></section><section class="card"><h2>逐次结果</h2><table><thead><tr><th>场景</th><th>模式</th><th>状态</th><th>气泡</th><th>发言人</th><th>失败类型</th><th>耗时</th></tr></thead><tbody>${resultRows}</tbody></table></section><section class="card"><h2>完整 Markdown 报告</h2><pre>${escapeHtml(markdown)}</pre></section></main></body></html>`
}

function download(name: string, type: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export function downloadAiEvalJson(report: AiEvalReport): void {
  download('ai-eval-latest.json', 'application/json', JSON.stringify(safeAiEvalReport(report), null, 2))
}

export function downloadAiEvalMarkdown(report: AiEvalReport): void {
  download('AI_TEST_REPORT.md', 'text/markdown;charset=utf-8', aiEvalReportMarkdown(report))
}

export function downloadAiEvalHtml(report: AiEvalReport): void {
  download('ai-test-report.html', 'text/html;charset=utf-8', aiEvalReportHtml(report))
}
