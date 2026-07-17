import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const valueOf = (name, fallback) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
const beforePath = path.resolve(root, valueOf('before', 'test-results/ai-eval/baseline.json'))
const afterPath = path.resolve(root, valueOf('after', 'test-results/ai-eval/after.json'))
const outputPath = path.resolve(root, valueOf('output', 'docs/AI_TEST_COMPARISON.md'))
const [before, after] = await Promise.all([
  readFile(beforePath, 'utf8').then(JSON.parse),
  readFile(afterPath, 'utf8').then(JSON.parse),
])

const pct = (value) => `${(Number(value || 0) * 100).toFixed(1)}%`
const pp = (beforeValue, afterValue) => `${((Number(afterValue || 0) - Number(beforeValue || 0)) * 100).toFixed(1)}pp`
const metrics = [
  ['首次直接通过率', 'realFirstAttemptPassRate'],
  ['修复后最终通过率', 'realCompletePassRate'],
  ['完整端到端通过率', 'endToEndPassRate'],
  ['直接裁决器通过率', 'adjudicatorOnlyPassRate'],
  ['独立验收集通过率', 'acceptancePassRate'],
  ['热闹度条数达标率', 'livelinessTargetRate'],
  ['多人参与率', 'multiSpeakerRate'],
  ['衣着召回率', 'outfitRecallRate'],
  ['衣着误触发率', 'outfitFalsePositiveRate'],
  ['日程召回率', 'scheduleRecallRate'],
  ['日程误触发率', 'scheduleFalsePositiveRate'],
  ['地点召回率', 'locationRecallRate'],
  ['地点误触发率', 'locationFalsePositiveRate'],
  ['多状态同轮成功率', 'multiStateCommitRate'],
  ['数据库提交率', 'databaseCommitRate'],
]

const failedIds = (report) => new Set(report.results.filter((result) => result.mode === 'real' && result.status === 'failed').map((result) => result.scenarioId))
const beforeFailed = failedIds(before)
const afterFailed = failedIds(after)
const fixed = [...beforeFailed].filter((id) => !afterFailed.has(id))
const regressions = [...afterFailed].filter((id) => !beforeFailed.has(id))
const stillFailing = [...afterFailed].filter((id) => beforeFailed.has(id))
const rows = metrics.map(([label, key]) => `| ${label} | ${pct(before.summary[key])} | ${pct(after.summary[key])} | ${pp(before.summary[key], after.summary[key])} |`).join('\n')
const list = (values) => values.length ? values.map((value) => `- ${value}`).join('\n') : '- 无'

const markdown = `# ChatSLG AI 自我迭代对比报告

## 对比信息

- 修改前：${before.generatedAt} · ${before.codeVersion}
- 修改后：${after.generatedAt} · ${after.codeVersion}
- 修改前真实运行：${before.summary.realRuns}
- 修改后真实运行：${after.summary.realRuns}
- 注意：只有场景ID、模型、重复次数和断言保持一致时，百分点变化才可直接解释。

## 核心指标

| 指标 | 修改前 | 修改后 | 变化 |
| --- | ---: | ---: | ---: |
${rows}

## 调用与耗时

| 指标 | 修改前 | 修改后 | 变化 |
| --- | ---: | ---: | ---: |
| 平均模型调用次数 | ${Number(before.summary.averageModelCalls || 0).toFixed(2)} | ${Number(after.summary.averageModelCalls || 0).toFixed(2)} | ${(Number(after.summary.averageModelCalls || 0) - Number(before.summary.averageModelCalls || 0)).toFixed(2)} |
| 平均耗时 | ${Math.round(before.summary.averageDurationMs || 0)} ms | ${Math.round(after.summary.averageDurationMs || 0)} ms | ${Math.round((after.summary.averageDurationMs || 0) - (before.summary.averageDurationMs || 0))} ms |
| P50 耗时 | ${Math.round(before.summary.p50DurationMs || 0)} ms | ${Math.round(after.summary.p50DurationMs || 0)} ms | ${Math.round((after.summary.p50DurationMs || 0) - (before.summary.p50DurationMs || 0))} ms |
| P95 耗时 | ${Math.round(before.summary.p95DurationMs || 0)} ms | ${Math.round(after.summary.p95DurationMs || 0)} ms | ${Math.round((after.summary.p95DurationMs || 0) - (before.summary.p95DurationMs || 0))} ms |

## 被修复的失败场景

${list(fixed)}

## 新增回归

${list(regressions)}

## 仍然失败

${list(stillFailing)}

## 结论边界

- “最终通过率”包含重试或重写救回；稳定性优先看“首次直接通过率”。
- “直接裁决器”使用脚本化证据；真实体验优先看“完整端到端”和“独立验收集”。
- 分类表自检不是真实故障注入，不计入生产成功率。
- 固定样本全通过不能外推为所有用户表达达到 100% 或 99%。
`

await writeFile(outputPath, markdown, 'utf8')
process.stdout.write(`${outputPath}\n`)
