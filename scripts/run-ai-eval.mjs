import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'

const root = process.cwd()
const scenarioArg = process.argv.find((value) => value.startsWith('--scenarios='))
const selectedScenarioIds = scenarioArg?.slice('--scenarios='.length).split(',').filter(Boolean)
const labelArg = process.argv.find((value) => value.startsWith('--label='))
const reportLabel = labelArg?.slice('--label='.length).replace(/[^a-zA-Z0-9_-]/g, '') || 'latest'
const postFix = process.argv.includes('--post-fix')
const selectedSuite = process.argv.includes('--acceptance')
  ? 'acceptance'
  : process.argv.includes('--development')
    ? 'development'
    : undefined
const mergeExisting = process.argv.includes('--merge')
const mode = selectedScenarioIds?.length ? 'selected' : process.argv.includes('--smoke') ? 'smoke' : process.argv.includes('--mock') ? 'mock' : 'all'
const externalBaseUrl = process.env.AI_EVAL_BASE_URL
const port = 4179
const baseUrl = externalBaseUrl || `http://127.0.0.1:${port}`
const gitCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const existingReport = mergeExisting
  ? JSON.parse(await readFile(path.join(root, 'test-results', 'ai-eval', 'latest.json'), 'utf8'))
  : undefined
let server

if (!externalBaseUrl) {
  server = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(port)], {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true,
  })
}

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const url = `${baseUrl}/?__aiEvalDb=chatslg-ai-eval-cli-${Date.now()}#/ai-eval`
  let lastError
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 3_000 })
      lastError = undefined
      break
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  if (lastError) throw new Error('无法启动或连接Vite测试服务器')
  await page.waitForSelector('text=AI测试台 · 隔离', { timeout: 15_000 })
  const artifact = await page.evaluate(async ({ selectedMode, selectedSuite, postFix, gitCommit, selectedScenarioIds, existingReport }) => {
    const [runnerModule, { AI_EVAL_SCENARIOS }, reportModule, assertionModule] = await Promise.all([
      import('/src/lib/aiEval/runner.ts'),
      import('/src/lib/aiEval/scenarios.ts'),
      import('/src/lib/aiEval/report.ts'),
      import('/src/lib/aiEval/assertions.ts'),
    ])
    const { runAiEval } = runnerModule
    const scenarioIds = selectedScenarioIds?.length
      ? selectedScenarioIds
      : selectedMode === 'smoke'
      ? ['outfit-photo-negative']
      : selectedMode === 'mock'
        ? AI_EVAL_SCENARIOS.filter((scenario) => !scenario.useRealModel).map((scenario) => scenario.id)
        : undefined
    const report = await runAiEval({ scenarioIds, suite: selectedSuite, repetitionOverride: selectedMode === 'smoke' ? 1 : undefined, maxModelCalls: 180 })
    if (existingReport && scenarioIds?.length) {
      const replaced = new Set(scenarioIds)
      report.results = [
        ...existingReport.results.filter((result) => !replaced.has(result.scenarioId)),
        ...report.results,
      ]
      report.scenarios = existingReport.scenarios.map((scenario) => AI_EVAL_SCENARIOS.find((candidate) => candidate.id === scenario.id) ?? scenario)
      report.summary = assertionModule.summarizeResults(report.results)
      report.confirmedIssues = runnerModule.confirmedAiEvalIssues(report.results)
      report.unconfirmedIssues = existingReport.unconfirmedIssues
    }
    report.codeVersion = `${report.codeVersion} / ${gitCommit}`
    report.coreLogicModified = postFix
    const safe = reportModule.safeAiEvalReport(report)
    return {
      report: safe,
      markdown: reportModule.aiEvalReportMarkdown(safe),
      html: reportModule.aiEvalReportHtml(safe),
    }
  }, { selectedMode: mode, selectedSuite, postFix, gitCommit, selectedScenarioIds, existingReport })
  const resultsDir = path.join(root, 'test-results', 'ai-eval')
  const docsDir = path.join(root, 'docs')
  await mkdir(resultsDir, { recursive: true })
  await mkdir(docsDir, { recursive: true })
  const jsonName = reportLabel === 'latest' ? 'latest.json' : `${reportLabel}.json`
  const markdownName = reportLabel === 'latest' ? 'AI_TEST_REPORT.md' : `AI_TEST_REPORT-${reportLabel}.md`
  const htmlName = reportLabel === 'latest' ? 'ai-test-report.html' : `ai-test-report-${reportLabel}.html`
  await Promise.all([
    writeFile(path.join(resultsDir, jsonName), `${JSON.stringify(artifact.report, null, 2)}\n`, 'utf8'),
    writeFile(path.join(docsDir, markdownName), artifact.markdown, 'utf8'),
    writeFile(path.join(docsDir, htmlName), artifact.html, 'utf8'),
    ...(reportLabel === 'latest' ? [] : [
      writeFile(path.join(resultsDir, 'latest.json'), `${JSON.stringify(artifact.report, null, 2)}\n`, 'utf8'),
      writeFile(path.join(docsDir, 'AI_TEST_REPORT.md'), artifact.markdown, 'utf8'),
      writeFile(path.join(docsDir, 'ai-test-report.html'), artifact.html, 'utf8'),
    ]),
  ])
  const { summary } = artifact.report
  process.stdout.write(`${JSON.stringify({
    mode,
    totalRuns: summary.totalRuns,
    executedRuns: summary.executedRuns,
    blockedRuns: summary.blockedRuns,
    realRuns: summary.realRuns,
    mockRuns: summary.mockRuns,
    passedRuns: summary.passedRuns,
    completePassRate: summary.completePassRate,
    output: {
      json: `test-results/ai-eval/${jsonName}`,
      markdown: `docs/${markdownName}`,
      html: `docs/${htmlName}`,
    },
  }, null, 2)}\n`)
} finally {
  await browser.close()
  if (server && !server.killed) server.kill()
}
