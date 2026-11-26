/* eslint-disable @typescript-eslint/explicit-function-return-type -- repository documentation check */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const specification = /^(?:[A-Z_]+_SPEC|[A-Z_]+_STANDARD)\.md$/
const today = new Date().toISOString().slice(0, 10)
const dayMs = 24 * 60 * 60 * 1000
let failed = false

const EXTRA_SPEC_FILES = [
  'docs/NODE_COMPLIANCE_MATRIX.md',
  'docs/local-agent-access/65-AGENT-PARITY-IRON-RULE.md',
  'docs/local-agent-access/02-capability-matrix.md',
  'docs/local-agent-access/03-change-enforcement.md',
  'docs/local-agent-access/15-gui-cli-mcp-parity-plan.md',
  'docs/local-agent-access/16-node-action-coverage.md',
  'docs/canvas-agent-flow/05-node-coordination-standard.md'
]

const UI_DOMAIN_DOCS = new Set([
  'AGENTS.md',
  'docs/NODE_UI_STANDARD.md',
  'docs/NODE_CANVAS_PRESENTATION_SPEC.md',
  'docs/NODE_REFERENCE_SPEC.md',
  'docs/NODE_COLOR_SPEC.md',
  'docs/NODE_OVERVIEW_PANEL_STANDARD.md',
  'docs/STORYBOARD_TABLE_STANDARD.md',
  'docs/UI_MODAL_STANDARD.md'
])

function stripCodeFences(lines) {
  let inFence = false
  return lines.map((line) => {
    if (/^\s*`{3,}/.test(line)) {
      inFence = !inFence
      return ''
    }
    return inFence ? '' : line
  })
}

function checkRelativeLinks(relPath, proseLines, report) {
  const baseDir = dirname(resolve(root, relPath))
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g
  for (const [index, line] of proseLines.entries()) {
    let match
    linkPattern.lastIndex = 0
    while ((match = linkPattern.exec(line))) {
      const raw = match[1].trim().replace(/^<|>$/g, '')
      if (!raw || /^(?:https?:|mailto:|conversation:|file:|#)/.test(raw)) continue
      const targetPath = raw.split('#')[0]
      if (!targetPath) continue
      if (!existsSync(resolve(baseDir, targetPath))) {
        report(`第 ${index + 1} 行存在失效本地链接：${raw}`)
      }
    }
  }
}

function checkUiArchivedRefs(relPath, proseLines, report) {
  if (!UI_DOMAIN_DOCS.has(relPath)) return
  for (const [index, line] of proseLines.entries()) {
    // 放行明确声明“§13–§21 已归档”的说明行
    if (/13[–-]21|13-21|NODE_UI_STANDARD-history|历史档案/.test(line)) continue
    if (/§(?:1[3-9]|20|21)(?:\.\d+)?(?![0-9])/.test(line)) {
      report(`第 ${index + 1} 行引用了已归档的 UI 历史章节（§13–§21），请改引现行条款`)
    }
  }
}

const targetFiles = new Set()
for (const directory of ['.', 'docs']) {
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
    if (!entry.isFile() || !specification.test(entry.name)) continue
    targetFiles.add(directory === '.' ? entry.name : `${directory}/${entry.name}`)
  }
}
for (const extra of EXTRA_SPEC_FILES) targetFiles.add(extra)

// 1. 检查宪法入口 AGENTS.md（无头部 status 元数据，但必须零断链、零归档 UI 章节引用、零手写当前计数）
{
  const path = 'AGENTS.md'
  const lines = readFileSync(resolve(root, path), 'utf8').split(/\r?\n/)
  const prose = stripCodeFences(lines)
  const report = (message) => {
    process.stderr.write(`${path} ${message}\n`)
    failed = true
  }
  checkRelativeLinks(path, prose, report)
  checkUiArchivedRefs(path, prose, report)
  for (const [index, line] of prose.entries()) {
    if (/当前共\s*\d+\s*(?:项|种|个|类)/.test(line)) {
      report(`第 ${index + 1} 行使用了手写当前计数，请引用机器清单`)
    }
  }
}

// 2. 检查全部规范与治理文档
for (const path of [...targetFiles].sort()) {
  const lines = readFileSync(resolve(root, path), 'utf8').split(/\r?\n/)
  const prose = stripCodeFences(lines)
  const header = lines.slice(0, 12)
  const report = (message) => {
    process.stderr.write(`${path} ${message}\n`)
    failed = true
  }
  const status = header
    .map((line) => /^(?:> )?status: (active|historical|draft|review|frozen)(?:\s+#.*)?$/.exec(line))
    .find(Boolean)?.[1]
  if (!status) report('缺少合法的 status')

  const verified = header
    .find((line) => /^(?:> )?last-verified: /.test(line))
    ?.replace(/^(?:> )?last-verified: /, '')
    .trim()
  const timestamp = Date.parse(verified ?? '')
  const invalidTimestamp =
    !verified ||
    !/^\d{4}-\d{2}-\d{2}$/.test(verified) ||
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== verified ||
    verified > today

  if (status === 'active') {
    if (verified === 'unverified') report('active 规范必须登记 last-verified 日期')
    else if (invalidTimestamp) report('缺少合法的 last-verified')
    else if (Date.parse(today) - timestamp > 14 * dayMs) {
      report(`距上次验证超过 14 天（${verified}）`)
    }
  } else if (verified === 'unverified') {
    process.stderr.write(`${path} 尚未登记验证日期（${status ?? 'unknown'} 仅警告）\n`)
  } else if (invalidTimestamp) {
    process.stderr.write(`${path} last-verified 无效（${status ?? 'unknown'} 仅警告）\n`)
  } else if (Date.parse(today) - timestamp > 14 * dayMs) {
    process.stderr.write(`${path} 距上次验证超过 14 天（${verified}，${status ?? 'unknown'} 仅警告）\n`)
  }

  if (status === 'active') {
    const fullProse = prose.join('\n')
    for (const phrase of ['当前权威', '唯一现行权威', '唯一现行裁决']) {
      if (fullProse.split(phrase).length > 2) {
        report(`同一文档内「${phrase}」最多出现 1 次`)
      }
    }
    if (fullProse.includes('设计提案，未实施')) {
      report('active 规范不得混排「设计提案，未实施」段落（请移入 design/ 或归档）')
    }
    checkRelativeLinks(path, prose, report)
    checkUiArchivedRefs(path, prose, report)
    for (const [index, line] of prose.entries()) {
      if (/当前共\s*\d+\s*(?:项|种|个|类)/.test(line)) {
        report(`第 ${index + 1} 行使用了手写当前计数，请引用机器清单`)
      }
    }
  }
}

if (failed) process.exitCode = 1
else process.stdout.write('规范检查通过\n')
