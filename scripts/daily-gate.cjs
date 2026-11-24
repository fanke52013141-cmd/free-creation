/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
/**
 * 每日门禁：静态门禁（lint/typecheck/单测/契约三关）+ 真实窗口验收（Playwright 启动 Electron）。
 *
 * 用法：
 *   node scripts/daily-gate.cjs             # 完整：静态门禁 + 构建 + verify:acceptance
 *   node scripts/daily-gate.cjs --fast      # 只跑静态门禁（跳过最慢的真实窗口验收）
 *   node scripts/daily-gate.cjs --list      # 只打印将执行的步骤与命令，不执行
 *   node scripts/daily-gate.cjs --dry-run   # 与 --list 等价
 *   node scripts/daily-gate.cjs --help
 *
 * 证据：qa/daily-gate/<timestamp>.json（qa/ 已被 gitignore）。
 * 退出码：0 通过；1 失败（失败即停）；2 参数或计划前置错误。
 * 说明：本脚本不注入任何模型凭据、不传 --real-model，验收脚本内部需要 key 的分支由脚本自身
 * 决定跳过与否，保持既有行为。
 */
const { spawn } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

const OPTIONS_ERROR = 'DAILY_GATE_OPTIONS_INVALID'
const PLAN_ERROR = 'DAILY_GATE_PLAN_INVALID'
const MINUTE = 60_000

// 静态门禁：与 package.json 中既有脚本一一对应，不在此重复实现命令内容。
const STATIC_STEPS = [
  {
    id: 'lint',
    phase: 'static',
    title: 'ESLint 静态检查',
    script: 'lint',
    timeoutMs: 15 * MINUTE
  },
  {
    id: 'typecheck',
    phase: 'static',
    title: 'TypeScript 类型检查（package.json 的 typecheck 链）',
    script: 'typecheck',
    timeoutMs: 30 * MINUTE
  },
  {
    id: 'unit-tests',
    phase: 'static',
    title: '全量单元/集成测试（vitest，经 scripts/run-vitest.cjs）',
    script: 'test',
    timeoutMs: 60 * MINUTE
  },
  {
    id: 'contract-tests',
    phase: 'static',
    title: '契约三关（node-compliance / node-contract-snapshot / connection-matrix）',
    script: 'test:contract',
    timeoutMs: 20 * MINUTE
  }
]

// 真实窗口验收：先构建出被验收的产物，再跑 verify-acceptance.cjs 的全部批次。
// CANVAS_OWNER=1 是既有约定（见 scripts/run-verification.cjs）：自用版构建跳过授权门禁，
// 保留全部节点，使桌面验收无需手工设环境变量即可运行。
const ACCEPTANCE_STEPS = [
  {
    id: 'build',
    phase: 'acceptance',
    title: '真实窗口验收前置构建（CANVAS_OWNER=1 自用版）',
    script: 'build',
    timeoutMs: 30 * MINUTE,
    env: { CANVAS_OWNER: '1' }
  },
  {
    id: 'acceptance',
    phase: 'acceptance',
    title: '真实 MCP/桌面验收（scripts/verify-acceptance.cjs 全批次，Playwright 启动 Electron）',
    script: 'verify:acceptance',
    timeoutMs: 180 * MINUTE
  }
]

function usage() {
  return [
    '每日门禁（静态门禁 + 真实窗口验收）',
    '',
    '用法：',
    '  node scripts/daily-gate.cjs             完整门禁：静态 + 构建 + verify:acceptance',
    '  node scripts/daily-gate.cjs --fast      只跑静态门禁（跳过真实窗口验收）',
    '  node scripts/daily-gate.cjs --list      只打印步骤与命令，不执行（等价 --dry-run）',
    '  node scripts/daily-gate.cjs --dry-run   与 --list 等价',
    '  node scripts/daily-gate.cjs --help      显示本帮助',
    '',
    '证据：qa/daily-gate/<timestamp>.json',
    '控制台最后一行：DAILY_GATE_RESULT=passed|failed',
    '退出码：0 通过 / 1 失败 / 2 参数或计划错误',
    ''
  ].join('\n')
}

function parseArgs(argv) {
  const options = { fast: false, listOnly: false, help: false }
  for (const arg of argv) {
    if (arg === '--fast') options.fast = true
    else if (arg === '--list' || arg === '--dry-run') options.listOnly = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(OPTIONS_ERROR)
  }
  return options
}

function copyStep(step) {
  return {
    id: step.id,
    phase: step.phase,
    title: step.title,
    script: step.script,
    command: `npm run ${step.script}`,
    timeoutMs: step.timeoutMs,
    env: step.env ? { ...step.env } : null
  }
}

// fast 只保留静态门禁；默认模式在静态门禁之后追加构建与真实窗口验收。
function buildPlan(options = {}) {
  const selected = options.fast ? STATIC_STEPS : STATIC_STEPS.concat(ACCEPTANCE_STEPS)
  return selected.map(copyStep)
}

function formatDuration(milliseconds) {
  const minutes = Math.round(milliseconds / MINUTE)
  return minutes >= 1 ? `${minutes}m` : `${Math.round(milliseconds / 1000)}s`
}

function formatPlan(plan, options = {}) {
  const mode = options.fast ? 'fast' : 'full'
  const lines = [`DAILY_GATE_PLAN mode=${mode} steps=${plan.length}`]
  plan.forEach((step, index) => {
    const env = step.env
      ? ` env=${Object.entries(step.env)
          .map(([key, value]) => `${key}=${value}`)
          .join(' ')}`
      : ''
    lines.push(
      `  ${index + 1}. [${step.phase}] ${step.id}: ${step.command}` +
        `（超时 ${formatDuration(step.timeoutMs)}${env}）`
    )
    lines.push(`     ${step.title}`)
  })
  return lines.join('\n')
}

function missingScripts(plan, scripts) {
  const available = scripts || {}
  return plan
    .filter((step) => typeof available[step.script] !== 'string' || !available[step.script].trim())
    .map((step) => step.id)
}

function timestampFor(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

function relativeSummaryPath(date = new Date()) {
  return ['qa', 'daily-gate', `${timestampFor(date)}.json`].join('/')
}

function summaryPath(date = new Date(), root = process.cwd()) {
  return join(root, 'qa', 'daily-gate', `${timestampFor(date)}.json`)
}

function readPackageScripts(root) {
  const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  return parsed.scripts || {}
}

// 直接 `node scripts/daily-gate.cjs` 时没有 npm_execpath，回退到 node 同目录的 npm-cli.js，
// 再退化为 PATH 上的 npm（Windows 需要 shell 才能启动 npm.cmd）。
function npmLauncher() {
  const execPath = process.env.npm_execpath
  if (execPath && existsSync(execPath)) {
    return { file: process.execPath, args: [execPath], shell: false }
  }
  const bundled = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(bundled)) {
    return { file: process.execPath, args: [bundled], shell: false }
  }
  return {
    file: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: [],
    shell: process.platform === 'win32'
  }
}

// 超时必须连同子进程树一起结束：Windows 下 npm -> tsc/vitest/electron 是多层进程。
// taskkill 不可用时退回 kill 当前子进程；无论哪条路径失败，runStep 的 watchdog 都会收敛。
function killProcessTree(child) {
  if (!child || !child.pid) return
  const fallback = () => {
    try {
      child.kill('SIGKILL')
    } catch {
      // 终止失败不应掩盖超时结论；watchdog 会兜底结算。
    }
  }
  try {
    if (process.platform === 'win32') {
      // 不依赖 PATH：部分环境只给了不带盘符的 \WINDOWS\system32，直接 spawn('taskkill') 会 ENOENT。
      const taskkill = process.env.SystemRoot
        ? join(process.env.SystemRoot, 'System32', 'taskkill.exe')
        : 'taskkill'
      const killer = spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
      killer.on('error', fallback)
      return
    }
    child.kill('SIGKILL')
  } catch {
    fallback()
  }
}

function runStep(step, context) {
  return new Promise((resolveStep) => {
    const startedAt = Date.now()
    const args = context.npm.args.concat(['run', step.script])
    let settled = false
    let timedOut = false
    let timer = null
    let watchdog = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (watchdog) clearTimeout(watchdog)
      resolveStep({ ...result, durationMs: Date.now() - startedAt, timedOut })
    }

    let child
    try {
      child = spawn(context.npm.file, args, {
        cwd: context.root,
        env: { ...process.env, ...(step.env || {}) },
        stdio: 'inherit',
        windowsHide: true,
        shell: context.npm.shell
      })
    } catch {
      finish({ status: 'failed', exitCode: null, signal: null, errorCode: 'SPAWN_ERROR' })
      return
    }

    timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
      // 结束进程树失败时也必须让门禁收敛，不能因为等不到 close 而永久挂起。
      watchdog = setTimeout(() => {
        finish({ status: 'failed', exitCode: null, signal: null, errorCode: 'STEP_TIMEOUT' })
      }, 30_000)
    }, step.timeoutMs)

    child.on('error', () => {
      finish({ status: 'failed', exitCode: null, signal: null, errorCode: 'SPAWN_ERROR' })
    })
    child.on('close', (code, signal) => {
      const passed = !timedOut && code === 0
      finish({
        status: passed ? 'passed' : 'failed',
        exitCode: typeof code === 'number' ? code : null,
        signal: signal || null,
        errorCode: timedOut ? 'STEP_TIMEOUT' : null
      })
    })
  })
}

function describeStep(step) {
  return {
    id: step.id,
    phase: step.phase,
    title: step.title,
    script: step.script,
    command: step.command,
    timeoutMs: step.timeoutMs,
    env: step.env
  }
}

async function main(argv, io = {}) {
  const out = io.out || process.stdout
  const err = io.err || process.stderr
  const root = io.root || process.cwd()

  let options
  try {
    options = parseArgs(argv)
  } catch {
    err.write(`${OPTIONS_ERROR} 未知参数：${argv.join(' ')}\n`)
    err.write(usage())
    return 2
  }
  if (options.help) {
    out.write(usage())
    return 0
  }

  const mode = options.fast ? 'fast' : 'full'
  const plan = buildPlan(options)

  // --list / --dry-run：只打印计划，不创建 qa 目录、不启动任何子进程。
  if (options.listOnly) {
    out.write(`${formatPlan(plan, options)}\n`)
    out.write(`DAILY_GATE_SUMMARY_PLANNED=${relativeSummaryPath()}\n`)
    out.write(`DAILY_GATE_MODE=${mode}（--list 未执行任何步骤）\n`)
    return 0
  }

  let scripts
  try {
    scripts = readPackageScripts(root)
  } catch {
    err.write(`${PLAN_ERROR} 无法读取 package.json 的 scripts\n`)
    out.write('DAILY_GATE_RESULT=failed\n')
    return 2
  }
  const missing = missingScripts(plan, scripts)
  if (missing.length > 0) {
    err.write(`${PLAN_ERROR} package.json 缺少必需脚本：${missing.join(', ')}\n`)
    out.write('DAILY_GATE_RESULT=failed\n')
    return 2
  }

  const startedAt = new Date()
  const summaryFile = summaryPath(startedAt, root)
  const summary = {
    tool: 'daily-gate',
    version: 1,
    mode,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    status: 'running',
    failedStep: null,
    summaryPath: relativeSummaryPath(startedAt),
    steps: []
  }

  out.write(`DAILY_GATE_START mode=${mode} steps=${plan.length}\n`)
  out.write(`${formatPlan(plan, options)}\n\n`)

  const npm = npmLauncher()
  let failedStep = null
  for (let index = 0; index < plan.length; index += 1) {
    const step = plan[index]
    if (failedStep) {
      summary.steps.push({
        ...describeStep(step),
        status: 'skipped',
        exitCode: null,
        signal: null,
        durationMs: 0,
        timedOut: false,
        errorCode: null
      })
      continue
    }
    out.write(`\n=== [${index + 1}/${plan.length}] ${step.phase}/${step.id}: ${step.command} ===\n`)
    const result = await runStep(step, { root, npm })
    summary.steps.push({ ...describeStep(step), ...result })
    const seconds = Math.round(result.durationMs / 1000)
    const suffix = result.timedOut ? `，超时 ${formatDuration(step.timeoutMs)}` : ''
    out.write(`=== ${result.status.toUpperCase()} ${step.id}（${seconds}s${suffix}）===\n`)
    if (result.status !== 'passed') failedStep = step.id
  }

  summary.failedStep = failedStep
  summary.status = failedStep ? 'failed' : 'passed'
  summary.finishedAt = new Date().toISOString()

  let summaryWritten = true
  try {
    mkdirSync(dirname(summaryFile), { recursive: true })
    writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  } catch (error) {
    summaryWritten = false
    summary.status = 'failed'
    summary.summaryWriteError = String(error && error.code ? error.code : 'SUMMARY_WRITE_FAILED')
    err.write(`DAILY_GATE_SUMMARY_WRITE_FAILED ${summary.summaryWriteError}\n`)
  }

  out.write(`\nDAILY_GATE_SUMMARY=${summary.summaryPath}${summaryWritten ? '' : '（写入失败）'}\n`)
  out.write(`DAILY_GATE_RESULT=${summary.status}\n`)
  return summary.status === 'passed' ? 0 : 1
}

module.exports = {
  ACCEPTANCE_STEPS,
  STATIC_STEPS,
  buildPlan,
  formatPlan,
  main,
  missingScripts,
  parseArgs,
  relativeSummaryPath,
  summaryPath,
  timestampFor,
  usage
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      const detail =
        error && typeof error.message === 'string' && /^DAILY_GATE_/.test(error.message)
          ? error.message
          : 'DAILY_GATE_START_FAILED'
      process.stderr.write(`${detail}\n`)
      process.stdout.write('DAILY_GATE_RESULT=failed\n')
      process.exitCode = 1
    })
}
