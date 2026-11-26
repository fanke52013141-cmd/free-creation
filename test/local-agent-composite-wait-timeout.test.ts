import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const socketState = vi.hoisted(() => ({
  timeoutMs: 0,
  written: '',
  handlers: new Map<string, (arg?: unknown) => void>(),
  destroy: vi.fn()
}))

vi.mock('node:net', () => ({
  createConnection: () => ({
    setTimeout: (ms: number) => { socketState.timeoutMs = ms },
    on: (event: string, handler: (arg?: unknown) => void) => {
      socketState.handlers.set(event, handler)
    },
    write: (payload: string) => { socketState.written = payload },
    destroy: socketState.destroy
  })
}))

import { callLocalOperation } from '../src/local-agent/client'

let directory = ''
beforeEach(() => {
  socketState.timeoutMs = 0
  socketState.written = ''
  socketState.handlers.clear()
  socketState.destroy.mockClear()
  directory = mkdtempSync(join(tmpdir(), 'canvas-composite-socket-'))
  mkdirSync(join(directory, 'agent-access'), { recursive: true })
  writeFileSync(join(directory, 'agent-access', 'connection.json'), JSON.stringify({
    apiVersion: 1,
    instanceId: randomUUID(),
    dataStoreId: randomUUID(),
    token: 'a'.repeat(64),
    endpoint: 'isolated-test-socket',
    appVersion: 'test',
    pid: 1
  }), { mode: 0o600 })
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('composite.execute.wait socket 超时', () => {
  it('使用请求的 timeoutMs+30s，不走 15s 默认超时', async () => {
    const pending = callLocalOperation('composite.execute.wait', {
      input: { runId: 'run-1', timeoutMs: 200_000 }
    }, directory)
    expect(socketState.timeoutMs).toBe(230_000)

    socketState.handlers.get('connect')?.()
    const request = JSON.parse(socketState.written).request
    socketState.handlers.get('data')?.(Buffer.from(JSON.stringify({
      apiVersion: 1,
      requestId: request.requestId,
      operationId: 'composite.execute.wait',
      traceId: 'trace',
      status: 'completed',
      data: { runId: 'run-1', status: 'running' }
    }) + '\n'))
    await expect(pending).resolves.toMatchObject({
      status: 'completed',
      data: { status: 'running' }
    })
  })
})
