// N1：节点类型契约目录外部接入（node.type.get）。
//
// 这组断言守的是"不创建实例也能如实了解节点"：
// - 端口 ID/类型/必填/基数/Schema 必须与真实注册表一致（快照由 jsdom 生成、有漂移门禁）；
// - 初始配置、执行方式、输出真值来源要被如实带出（Agent 不该靠标题猜）；
// - 动态端口节点必须明确标注"这只是默认配置下的端口"，不能让人误以为覆盖所有配置；
// - 逐节点矩阵的 N1 不再是 planned（否则等于没接通）。
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
  validateAccessRegistry
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

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-node-contract-test-'))
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

describe('node.type.get 节点契约查询', () => {
  it('注册表自洽：矩阵与契约快照都通过校验', () => {
    expect(validateAccessRegistry()).toEqual([])
    expect(ACCESS_OPERATIONS).toHaveProperty('node.type.get')
  })

  it('文本节点：契约版本、端口、初始配置与执行方式如实返回', async () => {
    const response = await call('node.type.get', { typeId: 'text' })
    expect(response.status).toBe('completed')
    const data = response.data as {
      typeId: string
      contractVersion: number
      executionMode: string
      outputSource: string
      dynamicPorts: boolean
      ports: { in: Array<{ id: string; type: string; required: boolean }>; out: Array<{ id: string; type: string }> }
      initialConfig: string | null
    }
    expect(data.typeId).toBe('text')
    expect(data.contractVersion).toBeGreaterThanOrEqual(3)
    expect(data.executionMode).toBe('auto')
    expect(data.dynamicPorts).toBe(false)
    expect(data.ports.out.map((port) => port.id)).toContain('out-text')
    expect(data.ports.in.map((port) => port.id)).toContain('in-text')
    // 初始配置要么是合法 JSON 字符串，要么明确为 null（不允许含糊的空串）。
    expect(data.initialConfig === null || typeof data.initialConfig === 'string').toBe(true)
    if (data.initialConfig !== null) expect(() => JSON.parse(data.initialConfig!)).not.toThrow()
  })

  it('动态端口节点：明确标注需要实例读取，且带出默认配置下的端口', async () => {
    const speech = (await call('node.type.get', { typeId: 'speech' })).data as {
      dynamicPorts: boolean
      ports: { in: Array<{ id: string }> }
    }
    expect(speech.dynamicPorts).toBe(true)
    expect(speech.ports.in.map((port) => port.id)).toEqual(expect.arrayContaining(['in-text']))

    const code = (await call('node.type.get', { typeId: 'code' })).data as { dynamicPorts: boolean }
    expect(code.dynamicPorts).toBe(true)
  })

  it('manual-publish 节点带出执行方式；JSON 端口带出 Schema 引用', async () => {
    const director = (await call('node.type.get', { typeId: 'director' })).data as {
      executionMode: string
    }
    expect(director.executionMode).toBe('manual-publish')

    const tts = (await call('node.type.get', { typeId: 'tts' })).data as {
      ports: { out: Array<{ id: string; schema?: string }> }
    }
    const voiceProfile = tts.ports.out.find((port) => port.id === 'out-json')
    expect(voiceProfile?.schema).toBe('voice.profile@1')
  })

  it('未知类型被 Schema 拒绝（不是返回空契约）', async () => {
    const response = await call('node.type.get', { typeId: 'not-a-node' })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('INVALID_INPUT')
  })

  it('32 类 Active 节点全部可查询，且 N1 不再是 planned', async () => {
    const listed = nodeAccessDirectory()
    expect(listed).toHaveLength(ACTIVE_NODE_TYPE_IDS.length)
    for (const typeId of ACTIVE_NODE_TYPE_IDS) {
      const response = await call('node.type.get', { typeId })
      expect(response.status, `${typeId}: ${JSON.stringify(response.error)}`).toBe('completed')
      const record = listed.find((entry) => entry.typeId === typeId)!
      const n1 = record.actions.find((action) => action.actionId === 'N1')!
      expect(n1.status, `${typeId} 的 N1 仍是 ${n1.status}`).not.toBe('planned')
      expect(n1.evidence.length).toBeGreaterThan(3)
    }
  })
})
