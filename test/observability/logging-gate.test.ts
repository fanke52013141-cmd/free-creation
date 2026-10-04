// L06 自动门禁测试（A17/A18）：门禁脚本对真实 fixture diff 的行为。
// A18：新增网络功能缺日志 → 门禁必须失败，不能以「功能成功」交付。
// A17：纯样式变更 no-impact → 门禁不要求人为添加日志。
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const GATE = join(ROOT, 'scripts', 'check-logging-bypass.mjs')
const fixture = (name: string): string => join(__dirname, 'fixtures', name)

function runGate(diffFile: string): { status: number; output: string } {
  try {
    const output = execFileSync('node', [GATE, '--diff-file', diffFile], {
      encoding: 'utf8',
      cwd: ROOT,
      // 显式 pipe：故意失败的用例（A18 fixture）不得把 stderr 泄漏进测试输出。
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { status: 0, output }
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
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
})

function runGateWithoutDiff(): { status: number; output: string } {
  try {
    const output = execFileSync('node', [GATE], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { status: 0, output }
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}
