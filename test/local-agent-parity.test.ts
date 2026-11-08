// 三入口目录一致性（AGENT_PARITY_SPEC §8 第 2 行）的运行时门禁。
//
// CLI 与 MCP 都由同一个 Operation Registry 派生：
//   - CLI 命令 = operationId 以 '.' 分段的 argv（`director publish prepare` → director.publish.prepare）
//   - MCP 工具名 = operationId.replaceAll('.', '_')
// 派生是自动的，但派生本身会坏：撞名、撞保留命令、与运行时目录不一致。这里逐条验证，
// 并顺带确认 capability.list / node.type.list 的运行时输出与 Registry 完全一致
// （防止"文档/生成目录里有，实际运行时没有"）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeDb, getDataDir } from '../src/main/store/db'
import { LocalAccessService } from '../src/main/agent-access/service'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import {
  ACCESS_OPERATIONS,
  nodeAccessDirectory,
  operationDirectory,
  type AccessOperationId
} from '../src/shared/agent-access/registry'
import { ACTIVE_NODE_TYPE_IDS } from '../src/shared/types'

let directory: string
let service: LocalAccessService
const originalDirectory = process.env.CANVAS_DATA_DIR

function call(operationId: string, input: unknown = {}) {
  return service.dispatch({
    apiVersion: 1,
    operationVersion: 1,
    operationId,
    input,
    requestId: randomUUID(),
    expectedDataStoreId: service.dataStoreId
  })
}

const operationIds = Object.keys(ACCESS_OPERATIONS) as AccessOperationId[]

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-parity-test-'))
  process.env.CANVAS_DATA_DIR = directory
  setGatewayEventSink({ emit: () => undefined })
  service = new LocalAccessService({
    instanceId: randomUUID(),
    appVersion: 'test',
    exportDirectory: join(getDataDir(), 'agent-exports'),
    activeProjectId: () => null
  })
})

afterEach(() => {
  closeDb()
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = originalDirectory
  rmSync(directory, { recursive: true, force: true })
})

describe('CLI / MCP 目录派生', () => {
  it('MCP 工具名唯一且符合 MCP 命名规则', () => {
    const seen = new Map<string, string>()
    for (const id of operationIds) {
      const name = String(id).replaceAll('.', '_')
      expect(name, `${String(id)} 的 MCP 名不合法`).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
      expect(seen.has(name), `MCP 名冲突：${seen.get(name)} 与 ${String(id)} 都派生为 ${name}`).toBe(false)
      seen.set(name, String(id))
    }
  })

  it('CLI 命令不会被保留子命令遮蔽，status 别名只指向 app.status', () => {
    for (const id of operationIds) {
      const tokens = String(id).split('.')
      expect(tokens.every((token) => token.length > 0), `${String(id)} 产生空令牌`).toBe(true)
      // 这三个是 CLI 的保留入口（key / contracts / mcp serve）。
      expect(['key', 'contracts', 'mcp']).not.toContain(tokens[0])
      if (tokens[0] === 'status') expect(String(id)).toBe('app.status')
    }
  })

  it('每个操作都有唯一 effect 与可读描述（目录不是空壳）', () => {
    const effects = new Set(['read', 'write', 'execute', 'export', 'delete'])
    for (const id of operationIds) {
      const spec = ACCESS_OPERATIONS[id]
      expect(effects.has(spec.effect), `${String(id)} 的 effect 非法`).toBe(true)
      // 描述必须是人能读懂的说明，不能是空串或把操作 ID 原样抄一遍。
      expect(spec.description.trim().length, `${String(id)} 缺少描述`).toBeGreaterThan(3)
      expect(spec.description.trim()).not.toBe(String(id))
    }
  })
})

describe('运行时目录与 Registry 一致', () => {
  it('capability.list 返回的操作目录与 Registry 完全相同（含顺序）', async () => {
    const response = await call('capability.list')
    expect(response.status).toBe('completed')
    const data = response.data as { operations: unknown[]; limitations: string[] }
    expect(data.operations).toEqual(operationDirectory())
    // 限制项必须是可读的真实边界，不能是空数组或占位符。
    expect(Array.isArray(data.limitations)).toBe(true)
    expect(data.limitations.length).toBeGreaterThan(0)
    expect(data.limitations).toContain('DIRECTOR_PUBLISH_REQUIRES_HUMAN_AUTHORIZATION')
    expect(data.limitations).toContain('DESKTOP_HANDSHAKE_REQUIRED')
  })

  it('node.type.list 覆盖全部 32 类 Active 节点且如实标 planned', async () => {
    const response = await call('node.type.list')
    expect(response.status).toBe('completed')
    const data = response.data as { nodes: Array<{ typeId: string; actions: string }> }
    expect(data.nodes).toEqual(nodeAccessDirectory())
    expect(data.nodes).toHaveLength(ACTIVE_NODE_TYPE_IDS.length)
    for (const node of data.nodes) expect(node.actions).toBe('planned')
  })

  it('app.status 暴露的实例身份与请求校验一致', async () => {
    const response = await call('app.status')
    expect(response.status).toBe('completed')
    const data = response.data as { instanceId: string; dataStoreId: string; apiVersion: number }
    expect(data.dataStoreId).toBe(service.dataStoreId)
    expect(data.apiVersion).toBe(1)
    expect(data.nextIdempotencyKey).toMatch(/^\d{13}:[a-f0-9-]{36}$/)
  })
})
