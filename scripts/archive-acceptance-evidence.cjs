/**
 * 把验收报告归档进 docs（qa/ 被 gitignore，换机器就丢，证据必须可追溯）。
 *
 * 用法：node scripts/archive-acceptance-evidence.cjs [批次名]
 * 行为：把 qa/local-agent-access/<批次>/report.json 复制到
 *      docs/local-agent-access/evidence/<批次>-<YYYYMMDD-HHmm>.json
 *      并在 docs/local-agent-access/evidence/INDEX.md 追加一行摘要。
 */
const { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const root = process.cwd()
const qaRoot = join(root, 'qa', 'local-agent-access')
const evidenceRoot = join(root, 'docs', 'local-agent-access', 'evidence')

if (!existsSync(qaRoot)) {
  console.log('没有 qa/local-agent-access 目录，先跑验收脚本')
  process.exit(0)
}
mkdirSync(evidenceRoot, { recursive: true })
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13)
const requested = process.argv[2]
const batches = readdirSync(qaRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => !requested || name === requested)

const indexLines = []
for (const batch of batches) {
  const reportPath = join(qaRoot, batch, 'report.json')
  if (!existsSync(reportPath)) continue
  let summary = 'n/a'
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    const total = report.total ?? (report.checks ? report.checks.length : undefined)
    const passed = report.passed ?? (report.checks ? report.checks.filter((c) => c.ok).length : undefined)
    const failed = report.failed ?? (report.failures ? report.failures.length : undefined)
    const parts = []
    if (total !== undefined) parts.push(`步骤 ${total}`)
    if (passed !== undefined) parts.push(`通过 ${passed}`)
    if (failed !== undefined) parts.push(`失败 ${failed}`)
    summary = parts.join(' / ') || 'ok'
  } catch {
    summary = '报告无法解析'
  }
  const target = join(evidenceRoot, `${batch}-${stamp}.json`)
  copyFileSync(reportPath, target)
  indexLines.push(`| ${batch} | ${stamp} | ${summary} | [${batch}-${stamp}.json](${batch}-${stamp}.json) |`)
  console.log('已归档: ' + target)
}

const indexPath = join(evidenceRoot, 'INDEX.md')
if (!existsSync(indexPath)) {
  writeFileSync(
    indexPath,
    '# 验收证据索引\n\n由 `node scripts/archive-acceptance-evidence.cjs` 生成。\n\n| 批次 | 时间 | 摘要 | 报告 |\n| --- | --- | --- | --- |\n',
    'utf8'
  )
}
if (indexLines.length) writeFileSync(indexPath, indexLines.join('\n') + '\n', { encoding: 'utf8', flag: 'a' })
console.log(`共归档 ${indexLines.length} 份报告到 docs/local-agent-access/evidence/`)
