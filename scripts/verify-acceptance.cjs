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
const ALL = [
  { name: 'protocol', script: 'scripts/mcp-acceptance.cjs', timeout: 15 * 60_000 },
  { name: 'family1', script: 'scripts/mcp-acceptance-family1-project-graph.cjs', timeout: 20 * 60_000 },
  { name: 'families-2-3-7-8', script: 'scripts/mcp-acceptance-families-2-3-7-8.cjs', timeout: 20 * 60_000 },
  { name: 'families-4-5-6-9', script: 'scripts/mcp-acceptance-families-4-5-6-9.cjs', timeout: 25 * 60_000 },
  { name: 'gap-fill', script: 'scripts/mcp-acceptance-gap-fill.cjs', timeout: 15 * 60_000 },
  { name: 'f9-remaining', script: 'scripts/mcp-acceptance-f9-remaining.cjs', timeout: 20 * 60_000 },
  { name: 'optimizations', script: 'scripts/mcp-acceptance-optimizations.cjs', timeout: 20 * 60_000 },
  { name: 'sse', script: 'scripts/mcp-acceptance-sse.cjs', timeout: 15 * 60_000 }
]
const FAST = ['protocol', 'optimizations']

const argv = process.argv.slice(2)
const fast = argv.includes('--fast')
const requested = argv.filter((argument) => !argument.startsWith('--'))
const selected = (fast ? ALL.filter((entry) => FAST.includes(entry.name)) : ALL).filter(
  (entry) => requested.length === 0 || requested.some((name) => entry.name.includes(name))
)

if (!existsSync(join(root, 'out', 'main', 'local-agent.js'))) {
  console.error('缺少构建产物 out/main/local-agent.js，请先 npm run build')
  process.exit(2)
}

const results = []
let failed = 0
for (const entry of selected) {
  if (!existsSync(join(root, entry.script))) {
    console.log(`SKIP ${entry.name}（脚本不存在：${entry.script}）`)
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
  console.log(`  ${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.ok ? '' : '（exit ' + result.status + '）'}`)
}
if (results.length === 0) {
  console.log('  没有选中任何验收项')
  process.exit(2)
}

// 归档证据（qa/ 被忽略，证据要进 docs）
const archive = join(root, 'scripts', 'archive-acceptance-evidence.cjs')
if (existsSync(archive)) {
  spawnSync(process.execPath, [archive], { cwd: root, stdio: 'inherit', windowsHide: true })
}

console.log(`\n${results.length - failed}/${results.length} 个验收批次通过`)
process.exit(failed === 0 ? 0 : 1)
