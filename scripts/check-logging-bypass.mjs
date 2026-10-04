#!/usr/bin/env node
// L06 日志门禁：对「本次变更新增的行」做增量旁路检查。
// 规则（LOGGING_SPEC.md §11 / 实施计划 L06）：
//   1) 新业务代码不得新增裸 console.*（底座/启动降级/脚本等走允许清单）；
//   2) 新业务代码不得直接 import electron-log（必须经统一诊断底座）；
//   3) 新增网络调用（fetch/axios/XMLHttpRequest）所在的「新文件」必须有诊断事件接入
//      （出现 observability 或 emitGatewayEvent 引用），否则视为 A18 违规。
// 纯样式/文档变更不产生新增违规行，自然通过（A17）；不靠 grep "log" 统计覆盖。
// 用法：
//   node scripts/check-logging-bypass.mjs                # 检查工作区相对 origin/main（或 HEAD）的变更
//   node scripts/check-logging-bypass.mjs --diff-file X  # 从 diff 文件读取（供测试/A18 演示）
/* eslint-disable @typescript-eslint/explicit-function-return-type -- .mjs 运维脚本，与 scripts/ 既有脚本一致 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const diffFileIndex = args.indexOf('--diff-file')
const diffFile = diffFileIndex >= 0 ? args[diffFileIndex + 1] : null

const allowlistPath = join(root, 'scripts', 'logging-allowlist.json')
const allowlist = existsSync(allowlistPath)
  ? JSON.parse(readFileSync(allowlistPath, 'utf8'))
  : { excludedPaths: [], files: [] }
const excludedPrefixes = allowlist.excludedPaths ?? []
const allowedFiles = new Set(allowlist.files ?? [])

const isExcluded = (path) =>
  excludedPrefixes.some((prefix) => path === prefix || path.startsWith(prefix)) ||
  allowedFiles.has(path)

const CONSOLE_RULE = /\bconsole\.(log|error|warn|info|debug)\s*\(/
const ELECTRON_LOG_IMPORT_RULE = /from\s+['"]electron-log(\/[a-z]+)?['"]/
const NETWORK_RULE = /\b(fetch\(|axios|XMLHttpRequest|http\.request|https\.request)\b/
const DIAGNOSTICS_RULE = /(shared\/observability|diagnostics\/gateway-events|emitGatewayEvent|emitDomainEvent)/

/** 把 unified diff 拆成 { path, addedLines }。 */
function parseDiff(text) {
  const files = []
  let current = null
  for (const line of text.split('\n')) {
    const newFile = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (newFile) {
      current = { path: newFile[2], addedLines: [] }
      files.push(current)
      continue
    }
    if (!current) continue
    const added = /^\+(?!\+\+)/.exec(line)
    if (added) current.addedLines.push(line.slice(1))
  }
  return files
}

/** 无 git 上下文（A18 演示/测试）时从 --diff-file 读取。 */
let diffText
if (diffFile) {
  diffText = readFileSync(resolve(diffFile), 'utf8')
} else {
  const git = (args_) => {
    try {
      return execFileSync('git', args_, { cwd: root, encoding: 'utf8' })
    } catch {
      return null
    }
  }
  // 基线：优先 origin/main 的 merge-base，其次 HEAD~1；再没有就当作无变更。
  let base = null
  const mergeBase = git(['merge-base', 'origin/main', 'HEAD'])
  if (mergeBase) base = mergeBase.trim()
  else base = 'HEAD~1'
  diffText = git(['diff', '-U0', base]) ?? ''
  // 未跟踪的新文件：整文件都算「新增行」。
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
  for (const file of (untracked ?? '').split('\n').filter(Boolean)) {
    if (!/\.(ts|tsx|mjs|js|cjs)$/.test(file)) continue
    try {
      const content = readFileSync(join(root, file), 'utf8')
      diffText +=
        `\ndiff --git a/${file} b/${file}\n` +
        content
          .split('\n')
          .map((line) => `+${line}`)
          .join('\n')
    } catch {
      // 文件不可读（被并发删除等）：跳过。
    }
  }
}

const violations = []
const a18Candidates = []
for (const file of parseDiff(diffText)) {
  if (isExcluded(file.path)) continue
  if (!/\.(ts|tsx|mjs|js|cjs)$/.test(file.path)) continue
  // 测试与脚本不算业务代码；demo/浏览器 mock 除外说明见允许清单。
  if (/^test\//.test(file.path) || /^scripts\//.test(file.path)) continue
  const added = file.addedLines
  const hasConsole = added.some((line) => CONSOLE_RULE.test(line))
  const hasElectronLog = added.some((line) => ELECTRON_LOG_IMPORT_RULE.test(line))
  const hasNetwork = added.some((line) => NETWORK_RULE.test(line))
  const fileIsNew = /^diff --git a\/(.+?) b\/(.+)$/.test('') || false
  void fileIsNew
  const fileContent = added.join('\n')
  const hasDiagnostics = DIAGNOSTICS_RULE.test(fileContent)
  if (hasConsole || hasElectronLog) {
    violations.push({
      path: file.path,
      reason: hasConsole && hasElectronLog ? 'console + electron-log 旁路' : hasConsole ? '裸 console 调用' : '直接 import electron-log',
      sample: added.find((line) => CONSOLE_RULE.test(line) || ELECTRON_LOG_IMPORT_RULE.test(line))?.trim().slice(0, 120)
    })
  }
  // A18：新文件里出现网络调用但没有诊断事件接入 → 门禁失败。
  if (hasNetwork && !hasDiagnostics) {
    a18Candidates.push({ path: file.path, sample: added.find((line) => NETWORK_RULE.test(line))?.trim().slice(0, 120) })
  }
}

if (violations.length > 0 || a18Candidates.length > 0) {
  console.error('logging gate failed: 本批变更存在日志旁路或缺诊断接入')
  for (const violation of violations) {
    console.error(`  [旁路] ${violation.path}: ${violation.reason}`)
    if (violation.sample) console.error(`    ${violation.sample}`)
  }
  for (const candidate of a18Candidates) {
    console.error(`  [缺诊断] ${candidate.path}: 新增网络调用但未接入统一诊断事件`)
    if (candidate.sample) console.error(`    ${candidate.sample}`)
  }
  console.error('处理：接入 src/shared/observability 与 main/diagnostics 事件，或在 scripts/logging-allowlist.json 登记理由（密钥/正文禁止项不可豁免）。')
  process.exit(1)
}
console.log('logging gate passed: 本批变更无日志旁路，新增网络路径均已接入诊断')
