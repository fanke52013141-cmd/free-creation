/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * 统一验收入口：串行跑全部真实 MCP / 桌面验收脚本，最后汇总。
 *
 * 用法：
 *   node scripts/verify-acceptance.cjs                # 全跑
 *   node scripts/verify-acceptance.cjs --fast         # 只跑协议层 + 优化验证（约 3 分钟）
 *   node scripts/verify-acceptance.cjs family1 sse    # 只跑指定条目（名字前缀匹配）
 *
 * 前置：`npm run build` 已执行、本机已激活（脚本会自己探测授权目录）。
 * 每个脚本都会把 report.json 写到 qa/local-agent-access/<批次>/；
 * 本脚本结束时再调 archive-acceptance-evidence.cjs 归档到 docs。
 */
const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const root = process.cwd()
// 所有条目默认必需；只有显式声明 optional: true 的条目才允许缺失并在汇总中 SKIP。
const ALL = [
  { name: 'node-combos', script: 'scripts/test-node-combos.cjs', timeout: 10 * 60_000 },
  { name: 'protocol', script: 'scripts/mcp-acceptance.cjs', timeout: 15 * 60_000 },
  { name: 'family1', script: 'scripts/mcp-acceptance-family1-project-graph.cjs', timeout: 20 * 60_000 },
  { name: 'families-2-3-7-8', script: 'scripts/mcp-acceptance-families-2-3-7-8.cjs', timeout: 20 * 60_000 },
  { name: 'families-4-5-6-9', script: 'scripts/mcp-acceptance-families-4-5-6-9.cjs', timeout: 25 * 60_000 },
  { name: 'gap-fill', script: 'scripts/mcp-acceptance-gap-fill.cjs', timeout: 15 * 60_000 },
  { name: 'f9-remaining', script: 'scripts/mcp-acceptance-f9-remaining.cjs', timeout: 20 * 60_000 },
  { name: 'optimizations', script: 'scripts/mcp-acceptance-optimizations.cjs', timeout: 20 * 60_000 },
  { name: 'composite-remediation', script: 'scripts/acceptance/agent-composite-remediation-e2e.cjs', timeout: 20 * 60_000 },
  { name: 'composite-legacy-runtime', script: 'scripts/acceptance/agent-composite-legacy-runtime-e2e.cjs', timeout: 20 * 60_000 },
  { name: 'capability-params', script: 'scripts/acceptance/agent-capability-params-e2e.cjs', timeout: 20 * 60_000 },
  { name: 'agent-flow-context-adoption', script: 'scripts/acceptance/agent-flow-context-adoption-e2e.cjs', timeout: 20 * 60_000 },
  { name: 'sse', script: 'scripts/mcp-acceptance-sse.cjs', timeout: 15 * 60_000 },
  // R2 缺口：GUI 反向腿 / 双画布并发 / 崩溃重启（真实桌面 + CLI）。
  { name: 'parity-gaps', script: 'scripts/test-agent-parity-gaps.cjs', timeout: 25 * 60_000 }
]
const FAST = ['protocol', 'optimizations']

const argv = process.argv.slice(2)
const fast = argv.includes('--fast')
const requested = argv.filter((argument) => !argument.startsWith('--'))
const selected = (fast ? ALL.filter((entry) => FAST.includes(entry.name)) : ALL).filter(
  (entry) => requested.length === 0 || requested.some((name) => entry.name.includes(name))
)

const missingRequired = selected.filter(
  (entry) => entry.optional !== true && !existsSync(join(root, entry.script))
)
if (missingRequired.length > 0) {
  console.error('验收前置失败：以下必需脚本不存在')
  for (const entry of missingRequired) console.error(`  MISSING_REQUIRED_SCRIPT ${entry.name}: ${entry.script}`)
  process.exit(2)
}

if (!existsSync(join(root, 'out', 'main', 'local-agent.js'))) {
  console.error('缺少构建产物 out/main/local-agent.js，请先 npm run build')
  process.exit(2)
}

const results = []
let failed = 0
for (const entry of selected) {
  if (!existsSync(join(root, entry.script))) {
    const optional = entry.optional === true
    console.log(`${optional ? 'SKIP' : 'FAIL'} ${entry.name}（${optional ? '可选' : '必需'}脚本不存在：${entry.script}）`)
    results.push({
      name: entry.name,
      script: entry.script,
      ok: optional,
      status: 'skipped',
      skipped: true,
      optional,
      reason: 'SCRIPT_MISSING'
    })
    if (!optional) failed += 1
    continue
  }
  console.log(`\n=== 验收 ${entry.name} (${entry.script}) ===`)
  const child = spawnSync(process.execPath, [join(root, entry.script)], {
    cwd: root,
    env: { ...process.env },
    stdio: 'inherit',
    timeout: entry.timeout,
    windowsHide: true
  })
  const ok = child.status === 0
  if (!ok) failed += 1
  results.push({ name: entry.name, ok, status: child.status })
}

console.log('\n=== 验收汇总 ===')
for (const result of results) {
  if (result.skipped) {
    console.log(`  SKIP ${result.name}（可选脚本不存在：${result.script}）`)
  } else {
    console.log(`  ${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.ok ? '' : '（exit ' + result.status + '）'}`)
  }
}
if (results.length === 0) {
  console.log('  没有选中任何验收项')
  process.exit(2)
}
const skipped = results.filter((result) => result.skipped).length
const executed = results.length - skipped
const passed = results.filter((result) => result.ok && !result.skipped).length

// 归档证据（qa/ 被忽略，证据要进 docs）
const archive = join(root, 'scripts', 'archive-acceptance-evidence.cjs')
if (existsSync(archive)) {
  spawnSync(process.execPath, [archive], { cwd: root, stdio: 'inherit', windowsHide: true })
}

console.log(`\n${passed}/${executed} 个验收批次通过，${skipped} 个可选批次跳过`)
process.exit(failed === 0 ? 0 : 1)
