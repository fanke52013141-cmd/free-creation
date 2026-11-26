import { createRequire } from 'node:module'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// 源码级测试：只校验 daily-gate.cjs 的参数解析与计划生成，不启动任何真实命令、
// 不创建 qa/ 证据。真实门禁运行由 `node scripts/daily-gate.cjs --list` 与人工/调度执行。
const require = createRequire(import.meta.url)
const {
  auditActions,
  parseIpcChannels,
  parseRegistryOperationIds
} = require('../scripts/audit-business-actions.cjs')
const {
  ACCEPTANCE_STEPS,
  STATIC_STEPS,
  buildPlan,
  formatPlan,
  main,
  missingScripts,
  parseArgs,
  relativeSummaryPath,
  summaryPath,
  timestampFor
} = require('../scripts/daily-gate.cjs')

interface GateStep {
  id: string
  phase: 'static' | 'acceptance'
  title: string
  script: string
  command: string
  timeoutMs: number
  env: Record<string, string> | null
}

const packageScripts = (): Record<string, string> =>
  JSON.parse(readFileSync(resolve('package.json'), 'utf8')).scripts

const planFor = (fast: boolean): GateStep[] => buildPlan({ fast }) as GateStep[]

function runNode(script: string, cwd: string, args: string[] = []): { status: number; output: string } {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`
  }
}

function writeFixture(root: string, relativePath: string, content: string): void {
  const target = join(root, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function runSpecGate(files: Record<string, string>): { status: number; output: string } {
  const directory = mkdtempSync(join(tmpdir(), 'canvas-spec-gate-'))
  try {
    const gate = join(directory, 'scripts', 'check-specs.mjs')
    mkdirSync(dirname(gate), { recursive: true })
    mkdirSync(join(directory, 'docs'), { recursive: true })
    copyFileSync(resolve('scripts/check-specs.mjs'), gate)
    if (!files['AGENTS.md']) writeFixture(directory, 'AGENTS.md', '# Fixture constitution\n')
    for (const extra of [
      'docs/NODE_COMPLIANCE_MATRIX.md',
      'docs/local-agent-access/65-AGENT-PARITY-IRON-RULE.md',
      'docs/local-agent-access/02-capability-matrix.md',
      'docs/local-agent-access/03-change-enforcement.md',
      'docs/local-agent-access/15-gui-cli-mcp-parity-plan.md',
      'docs/local-agent-access/16-node-action-coverage.md',
      'docs/canvas-agent-flow/05-node-coordination-standard.md'
    ]) {
      if (!files[extra]) writeFixture(directory, extra, '# Fixture\n\n> status: draft\n> last-verified: unverified\n')
    }
    for (const [relativePath, content] of Object.entries(files)) writeFixture(directory, relativePath, content)
    return runNode(gate, directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('每日门禁参数解析', () => {
  it('默认是完整模式，未指定 --list', () => {
    expect(parseArgs([])).toEqual({ fast: false, listOnly: false, help: false })
    expect(parseArgs(['--fast'])).toEqual({ fast: true, listOnly: false, help: false })
  })

  it('--list 与 --dry-run 等价，都只生成计划', () => {
    expect(parseArgs(['--list']).listOnly).toBe(true)
    expect(parseArgs(['--dry-run']).listOnly).toBe(true)
    expect(parseArgs(['--list']).listOnly).toBe(parseArgs(['--dry-run']).listOnly)
    expect(parseArgs(['--fast', '--dry-run'])).toEqual({
      fast: true,
      listOnly: true,
      help: false
    })
  })

  it('--help 单独生效', () => {
    expect(parseArgs(['--help']).help).toBe(true)
    expect(parseArgs(['-h']).help).toBe(true)
  })

  it('拒绝未知参数与位置参数，避免静默跑错范围', () => {
    for (const argv of [['--bogus'], ['full'], ['--list=1'], ['--fast=1'], ['--LIST']]) {
      expect(() => parseArgs(argv)).toThrow('DAILY_GATE_OPTIONS_INVALID')
    }
  })
})

describe('每日门禁计划生成', () => {
  it('--fast 只包含静态门禁四步', () => {
    expect(planFor(true).map((step) => step.id)).toEqual([
      'lint',
      'typecheck',
      'unit-tests',
      'contract-tests'
    ])
    expect(planFor(true).every((step) => step.phase === 'static')).toBe(true)
  })

  it('默认模式在静态门禁之后追加构建与真实窗口验收', () => {
    const plan = planFor(false)
    expect(plan.map((step) => step.id)).toEqual([
      'lint',
      'typecheck',
      'unit-tests',
      'contract-tests',
      'build',
      'acceptance'
    ])
    // 构建必须先于验收；静态门禁必须先于任何真实窗口步骤。
    const buildIndex = plan.findIndex((step) => step.id === 'build')
    const acceptanceIndex = plan.findIndex((step) => step.id === 'acceptance')
    expect(buildIndex).toBeLessThan(acceptanceIndex)
    expect(acceptanceIndex).toBe(plan.length - 1)
    expect(plan.slice(0, 4)).toEqual(planFor(true))
  })

  it('每步都复用 package.json 既有脚本，并带正整数超时', () => {
    const plan = planFor(false)
    for (const step of plan) {
      expect(step.command).toBe(`npm run ${step.script}`)
      expect(Number.isInteger(step.timeoutMs)).toBe(true)
      expect(step.timeoutMs).toBeGreaterThan(0)
      expect(step.timeoutMs).toBeLessThanOrEqual(180 * 60_000)
      expect(step.title.length).toBeGreaterThan(0)
    }
    // 验收用全批次入口，不用 --fast 子集。
    expect(plan.find((step) => step.id === 'acceptance')?.script).toBe('verify:acceptance')
  })

  it('只有构建步骤注入 CANVAS_OWNER=1，验收步骤不带额外环境变量', () => {
    const plan = planFor(false)
    const build = plan.find((step) => step.id === 'build')
    const acceptance = plan.find((step) => step.id === 'acceptance')
    expect(build?.env).toEqual({ CANVAS_OWNER: '1' })
    expect(acceptance?.env).toBeNull()
    expect(plan.filter((step) => step.env !== null).map((step) => step.id)).toEqual(['build'])
  })

  it('默认不包含真实付费模型脚本，也不传 --real-model', () => {
    for (const step of planFor(false)) {
      expect(step.script).not.toMatch(/^model:smoke/)
      expect(step.command).not.toMatch(/--real-model/)
    }
  })

  it('计划里每个脚本都真实存在于 package.json', () => {
    expect(missingScripts(planFor(false), packageScripts())).toEqual([])
  })

  it('缺失或空白的脚本会被逐个指出', () => {
    const plan = planFor(false)
    expect(missingScripts(plan, {})).toEqual(plan.map((step) => step.id))
    const partial = packageScripts()
    delete partial['verify:acceptance']
    expect(missingScripts(plan, partial)).toEqual(['acceptance'])
    const blank = { ...packageScripts(), build: '   ' }
    expect(missingScripts(plan, blank)).toEqual(['build'])
  })

  it('计划返回独立副本，调用方修改不会污染模块常量', () => {
    const snapshot = JSON.stringify(planFor(false))
    const mutable = planFor(false)
    mutable[0].id = 'mutated'
    mutable[4].env = { CANVAS_OWNER: '0' }
    expect(JSON.stringify(planFor(false))).toBe(snapshot)
    expect(STATIC_STEPS[0].id).toBe('lint')
    expect(ACCEPTANCE_STEPS[0].env).toEqual({ CANVAS_OWNER: '1' })
  })

  it('package.json 暴露 verify:daily 与 verify:daily:fast 两个入口', () => {
    const scripts = packageScripts()
    expect(scripts['verify:daily']).toBe('node scripts/daily-gate.cjs')
    expect(scripts['verify:daily:fast']).toBe('node scripts/daily-gate.cjs --fast')
  })
})

describe('每日门禁计划展示与证据路径', () => {
  it('按顺序打印步骤与命令，并标注模式', () => {
    const plan = planFor(false)
    const text = formatPlan(plan, { fast: false })
    expect(text.startsWith('DAILY_GATE_PLAN mode=full steps=6')).toBe(true)
    const positions = plan.map((step) => text.indexOf(`${step.id}: ${step.command}`))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((left, right) => left - right)).toEqual(positions)
    expect(text.indexOf('build: npm run build')).toBeLessThan(
      text.indexOf('acceptance: npm run verify:acceptance')
    )
  })

  it('--fast 的计划不列出真实窗口验收步骤', () => {
    const text = formatPlan(planFor(true), { fast: true })
    expect(text.startsWith('DAILY_GATE_PLAN mode=fast steps=4')).toBe(true)
    expect(text).not.toContain('verify:acceptance')
    expect(text).not.toContain('npm run build')
  })

  it('证据路径按时间戳落到 qa/daily-gate，且不受时区影响去重', () => {
    const date = new Date('2026-11-24T07:32:41.123Z')
    expect(timestampFor(date)).toBe('2026-11-24T07-32-41-123Z')
    expect(relativeSummaryPath(date)).toBe('qa/daily-gate/2026-11-24T07-32-41-123Z.json')
    expect(relativeSummaryPath(date)).toMatch(/^qa\/daily-gate\/[0-9A-Za-z-]+\.json$/)
    const absolute = summaryPath(date, 'C:\\repo\\source').replace(/\\/g, '/')
    expect(absolute.endsWith(relativeSummaryPath(date))).toBe(true)
    expect(relativeSummaryPath(date)).not.toBe(
      relativeSummaryPath(new Date('2026-11-24T07:32:41.124Z'))
    )
  })

  it('导出可编程入口但不在导入时执行任何计划', () => {
    expect(typeof main).toBe('function')
    expect(typeof buildPlan).toBe('function')
  })
})

describe('CI verify:checks 组合', () => {
  const scripts = packageScripts()
  const commands = scripts['verify:checks'].split('&&').map((command: string) => command.trim())

  it('显式包含 Agent 三关守卫与快速真实验收，且各只运行一次', () => {
    expect(commands.filter((command: string) => command === 'npm run guard:agent-parity')).toHaveLength(1)
    expect(commands.filter((command: string) => command === 'npm run verify:acceptance:fast')).toHaveLength(1)
    expect(commands).not.toContain('npm run verify:agent-access')
    expect(commands).not.toContain('npm run verify:logging')
  })

  it('包含关键并行队列、CMD08 与面板抖动回归，并移除重复 parallel-review', () => {
    for (const script of [
      'test:agent-flow-parallel-queue',
      'test:agent-flow-cmd08-gate',
      'test:agent-flow-cmd08-unknown-footer',
      'test:agent-flow-panel-churn'
    ]) {
      expect(commands).toContain(`npm run ${script}`)
    }
    expect(commands).not.toContain('npm run test:agent-flow-parallel-review')
  })

  it('verify:checks 引用的 npm run 脚本都真实存在', () => {
    const references = [...scripts['verify:checks'].matchAll(/npm run ([\w:-]+)/g)].map((match) => match[1])
    expect(references.length).toBeGreaterThan(0)
    expect([...new Set(references)].filter((name) => !scripts[name])).toEqual([])
  })
})

describe('规范元数据门禁', () => {
  const spec = (status: string, verified: string) =>
    `# Fixture\n\n> status: ${status}\n> last-verified: ${verified}\n`

  it('active 规范 last-verified: unverified 必须失败', () => {
    const result = runSpecGate({ 'ACTIVE_SPEC.md': spec('active', 'unverified') })
    expect(result.status).toBe(1)
    expect(result.output).toContain('active 规范必须登记 last-verified 日期')
  })

  it('active 规范超过 14 天必须失败', () => {
    const stale = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const result = runSpecGate({ 'ACTIVE_SPEC.md': spec('active', stale) })
    expect(result.status).toBe(1)
    expect(result.output).toContain('距上次验证超过 14 天')
  })

  it('active 规范使用当天验证日期可通过', () => {
    const today = new Date().toISOString().slice(0, 10)
    const result = runSpecGate({ 'ACTIVE_SPEC.md': spec('active', today) })
    expect(result.status).toBe(0)
    expect(result.output).toContain('规范检查通过')
  })

  it('draft 规范 last-verified: unverified 仅警告', () => {
    const result = runSpecGate({ 'DRAFT_SPEC.md': spec('draft', 'unverified') })
    expect(result.status).toBe(0)
    expect(result.output).toContain('尚未登记验证日期')
    expect(result.output).toContain('仅警告')
  })
})

describe('业务动作分母审计 fixture', () => {
  it('IPC 解析兼容 CRLF、制表符、空白与双引号', () => {
    const source = 'export const IPC = {\r\n\tProject\t: {\r\n\t\tlist : "project:list",\r\n\t},\r\n}'
    expect(parseIpcChannels(source)).toEqual([
      { family: 'Project', key: 'list', channel: 'project:list' }
    ])
  })

  it('Registry 操作重复声明必须失败', () => {
    expect(() =>
      parseRegistryOperationIds([`export const FOO_OPERATIONS = { 'a.b': {}, "a.b": {} }`])
    ).toThrow('Registry operation declared twice: a.b')
  })

  it('IPC 通道缺少 coverage 必须报告 MISSING_COVERAGE', () => {
    const { errors } = auditActions({
      channels: [{ family: 'project', key: 'list', channel: 'project:list' }],
      operations: [],
      coverage: { actions: {} }
    })
    expect(errors).toContain('MISSING_COVERAGE:ipc.project.list (project:list)')
  })

  it('external 映射到不存在的操作必须报告 UNKNOWN_EXTERNAL_OP', () => {
    const { errors } = auditActions({
      channels: [],
      operations: [],
      coverage: {
        actions: {
          'canvas.node.create': { phase: 'external', external: ['missing.op'], gui: 'button' }
        }
      }
    })
    expect(errors).toContain('UNKNOWN_EXTERNAL_OP:canvas.node.create:missing.op')
  })

  it('已不在 IPC 或画布动作分母中的登记必须报告 STALE_ACTION', () => {
    const { errors } = auditActions({
      channels: [],
      operations: [],
      coverage: { actions: { 'ipc.ghost.action': { phase: 'F1' } } }
    })
    expect(errors).toContain('STALE_ACTION:ipc.ghost.action')
  })
})

describe('验收入口必需脚本预检', () => {
  it('声明的必需脚本缺失时直接失败，不静默跳过', () => {
    const directory = mkdtempSync(join(tmpdir(), 'canvas-acceptance-preflight-'))
    try {
      writeFixture(directory, 'out/main/local-agent.js', '')
      const result = runNode(resolve('scripts/verify-acceptance.cjs'), directory, ['--fast'])
      expect(result.status).toBe(2)
      expect(result.output).toContain('MISSING_REQUIRED_SCRIPT')
      expect(result.output).toContain('scripts/mcp-acceptance.cjs')
      expect(result.output).toContain('scripts/mcp-acceptance-optimizations.cjs')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
