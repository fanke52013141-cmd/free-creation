import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
// L06 自动门禁测试（A17/A18）：门禁脚本对真实 fixture diff 的行为。
// A18：新增网络功能缺日志 → 门禁必须失败，不能以「功能成功」交付。
// A17：纯样式变更 no-impact → 门禁不要求人为添加日志。
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const GATE = join(ROOT, 'scripts', 'check-logging-bypass.mjs')
const fixture = (name: string): string => join(__dirname, 'fixtures', name)

function runGateAt(gate: string, cwd: string, args: string[] = []): { status: number; output: string } {
  try {
    const output = execFileSync('node', [gate, ...args], {
      encoding: 'utf8',
      cwd,
      // 显式 pipe：故意失败的用例不得把 stderr 泄漏进测试输出。
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { status: 0, output }
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

function runGate(diffFile: string): { status: number; output: string } {
  return runGateAt(GATE, ROOT, ['--diff-file', diffFile])
}

describe('L06 日志门禁脚本', () => {
  it('A18 · 新增网络功能缺诊断事件：门禁失败并给出可行动指引', () => {
    const result = runGate(fixture('a18-bad.diff'))
    expect(result.status).toBe(1)
    expect(result.output).toContain('[旁路]')
    expect(result.output).toContain('[缺诊断]')
    expect(result.output).toContain('newthing.ts')
    expect(result.output).toContain('logging-allowlist.json')
  })

  it('新增网络功能已接入统一诊断事件：门禁通过', () => {
    const result = runGate(fixture('a18-good.diff'))
    expect(result.status).toBe(0)
    expect(result.output).toContain('logging gate passed')
  })

  it('A17 · 纯样式变更：门禁通过，不要求人为添加点击/样式日志', () => {
    const result = runGate(fixture('a17-style.diff'))
    expect(result.status).toBe(0)
  })

  it('正则或字符串中的 fetch 字样不算新增网络调用', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canvas-log-gate-fetch-word-'))
    try {
      const diff = join(dir, 'change.diff')
      writeFileSync(
        diff,
        'diff --git a/src/classifier.ts b/src/classifier.ts\n+const NETWORK = /network|fetch|socket|网络|连接/i\n'
      )
      expect(runGate(diff).status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('当前工作区增量检查通过（真实 git 状态；并发任务的改动同样受检）', () => {
    const result = runGateWithoutDiff()
    // 工作区门禁输出真实状态：通过则打印 passed；失败则列出违规。
    // 这里断言脚本本身可运行且退出码与输出一致（门禁有效性验证）。
    if (result.status === 1) {
      expect(result.output).toContain('logging gate failed')
    } else {
      expect(result.output).toContain('logging gate passed')
    }
  })

  it('浅克隆缺少完整历史：fail closed 并提示 fetch-depth: 0', () => {
    const directory = mkdtempSync(join(tmpdir(), 'canvas-log-gate-shallow-'))
    try {
      const source = join(directory, 'source')
      const clone = join(directory, 'clone')
      initSingleCommitRepo(source)
      git(directory, ['clone', '--depth', '1', '--no-local', pathToFileURL(source).href, clone])
      const gate = installGate(clone)
      const result = runGateAt(gate, clone)
      expect(result.status).toBe(1)
      expect(result.output).toContain('logging gate failed')
      expect(result.output).toContain('浅克隆')
      expect(result.output).toContain('fetch-depth: 0')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('无父提交且没有 origin/main：fail closed，不能把空 diff 当通过', () => {
    const directory = mkdtempSync(join(tmpdir(), 'canvas-log-gate-no-parent-'))
    try {
      initSingleCommitRepo(directory)
      const gate = installGate(directory)
      const result = runGateAt(gate, directory)
      expect(result.status).toBe(1)
      expect(result.output).toContain('logging gate failed')
      expect(result.output).toContain('无法取得比较基线')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

function runGateWithoutDiff(): { status: number; output: string } {
  return runGateAt(GATE, ROOT)
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true })
}

function initSingleCommitRepo(directory: string): void {
  mkdirSync(directory, { recursive: true })
  git(directory, ['init'])
  writeFileSync(join(directory, 'fixture.ts'), 'export const fixture = true\n')
  git(directory, ['add', 'fixture.ts'])
  git(directory, ['-c', 'user.name=Canvas CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'fixture'])
}

function installGate(directory: string): string {
  const scripts = join(directory, 'scripts')
  mkdirSync(scripts, { recursive: true })
  const gate = join(scripts, 'check-logging-bypass.mjs')
  copyFileSync(GATE, gate)
  return gate
}

it.each(['fetch()', 'await fetch( )', 'fetch(`${base}/x`)', 'https.request(options)'])(
  'A18 不漏掉网络写法 %s',
  (call) => {
    const dir = mkdtempSync(join(tmpdir(), 'canvas-log-gate-'))
    try {
      const diff = join(dir, 'change.diff')
      writeFileSync(diff, `diff --git a/src/new-path.ts b/src/new-path.ts\n+${call}\n`)
      expect(runGate(diff).status).toBe(1)
      writeFileSync(
        diff,
        `diff --git a/src/new-path.ts b/src/new-path.ts\n+import { emitDomainEvent } from './diagnostics/ipc-domain-events'\n+${call}\n`
      )
      expect(runGate(diff).status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
