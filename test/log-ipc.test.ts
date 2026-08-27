// T8 · 运行日志 IPC 通道测试（R0/WP1）
//
// 主进程 log handler 是渲染进程错误落盘的唯一入口，此处在 Node 测试进程用
// mock 替换 electron / electron-log，捕获 handler 注册与 log.warn 写入内容：
// - 含假 Key 的条目落盘内容不含任何密钥（防御纵深：主进程写盘前再脱敏一次）
// - 日志信封字段完整（时间戳 / phase / label / 诊断字段 / reason 分隔）
// - 畸形条目不抛出、不写盘（fire-and-forget 不能影响渲染进程）
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC, type RunLogEntry } from '../src/shared/contracts'

const capture = vi.hoisted(() => {
  const state = { handler: null as ((...args: unknown[]) => void) | null, warns: [] as string[] }
  return state
})

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, handler: (...args: unknown[]) => void) => {
      if (channel === IPC.log.write) capture.handler = handler
    }
  }
}))

vi.mock('electron-log/main', () => ({
  default: {
    warn: (...args: unknown[]) => {
      capture.warns.push(args.join(' '))
    }
  }
}))

import { registerLogIpc } from '../src/main/ipc/log.ipc'

beforeEach(() => {
  capture.warns.length = 0
})

describe('registerLogIpc', () => {
  it('注册到 log:write 通道', () => {
    registerLogIpc()
    expect(capture.handler).toBeTypeOf('function')
  })

  it('含密钥条目：落盘内容不含任何密钥，信封字段完整', () => {
    registerLogIpc()
    const entry: RunLogEntry = {
      label: 'chat 节点',
      reason:
        '请求失败 401: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret, ' +
        'api_key=sk-live-abcdef1234567890, 参考 https://api.openai.com/v1/chat/completions?key=zzz',
      nodeId: 'shape:1',
      portId: 'in-text',
      phase: 'execution',
      nodeType: 'chat',
      contractVersion: 2,
      runId: 'r-abc123',
      timestamp: 1700000000000
    }
    capture.handler!(null, entry)
    expect(capture.warns).toHaveLength(1)
    const line = capture.warns[0]
    // 密钥全部脱敏（handler 在写盘前二次脱敏，防御渲染进程漏脱敏）
    expect(line).not.toContain('sk-live-abcdef1234567890')
    expect(line).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(line).not.toContain('key=zzz')
    // URL 只留协议+域名
    expect(line).toContain('https://api.openai.com')
    expect(line).not.toContain('/v1/chat/completions')
    // 信封字段完整
    expect(line).toContain('[2023-11-14T22:13:20.000Z]')
    expect(line).toContain('(execution)')
    expect(line).toContain('chat 节点')
    expect(line).toContain('type=chat')
    expect(line).toContain('node=shape:1')
    expect(line).toContain('port=in-text')
    expect(line).toContain('contract=v2')
    expect(line).toContain('run=r-abc123')
    expect(line).toContain('— ')
  })

  it('畸形条目不抛出且不写盘', () => {
    registerLogIpc()
    expect(() => capture.handler!(null, { label: 123, reason: 'x', timestamp: 0 })).not.toThrow()
    expect(capture.warns).toHaveLength(0)
  })
})
