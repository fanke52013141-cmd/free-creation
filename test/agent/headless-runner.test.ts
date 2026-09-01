import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileProjectStore } from '../../src/application/stores/file-store'
import { HeadlessRunExecutor } from '../../src/main/headless/run-executor'
import type { GatewayClient } from '../../src/shared/engine/gateway-client'
import { getCapabilityByNodeType } from '../../src/capabilities'
import type { CanvasNode } from '../../src/shared/types'

function textNode(id: string, text: string): CanvasNode {
  const cap = getCapabilityByNodeType('text')!
  return {
    id,
    type: 'text',
    contractVersion: cap.contractVersion,
    title: '文本',
    x: 0,
    y: 0,
    w: 320,
    h: 200,
    ports: [
      ...cap.inputs.map((port) => ({ ...port, dir: 'in' as const })),
      ...cap.outputs.map((port) => ({ ...port, dir: 'out' as const }))
    ],
    params: {},
    content: { kind: 'text', text },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: Date.now() }
  }
}

describe('HeadlessRunExecutor', () => {
  it('消费 queued Run，执行文本节点并持久化成功状态', async () => {
    const root = mkdtempSync(join(tmpdir(), 'canvas-headless-run-'))
    try {
      const store = new FileProjectStore({ dataDir: root })
      const project = await store.createProject('headless')
      const node = textNode('shape:text-one', '你好，Headless')
      await store.saveGraph(project.id, { nodes: [node], edges: [], groups: [] })
      const run = await store.createRun({
        runId: 'run-headless',
        projectId: project.id,
        scope: { type: 'node', nodeIds: [node.id] },
        status: 'queued',
        actor: 'agent'
      })
      const gateway = {
        listProviders: async () => ({ ok: true, data: [] })
      } as unknown as GatewayClient

      await new HeadlessRunExecutor({ store, gateway }).execute(run)

      expect((await store.getRun(run.runId))?.status).toBe('succeeded')
      expect((await store.getNodes(project.id))[0]?.exec.status).toBe('success')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('单节点运行可消费范围外上游已持久化的输出', async () => {
    const root = mkdtempSync(join(tmpdir(), 'canvas-headless-upstream-'))
    try {
      const store = new FileProjectStore({ dataDir: root })
      const project = await store.createProject('headless upstream')
      const source = textNode('shape:source', '上游内容')
      const target = textNode('shape:target', '目标内容')
      await store.saveGraph(project.id, {
        nodes: [source, target],
        edges: [
          {
            id: 'shape:edge',
            from: { nodeId: source.id, portId: 'out-text' },
            to: { nodeId: target.id, portId: 'in-text' }
          }
        ],
        groups: []
      })
      const run = await store.createRun({
        runId: 'run-upstream',
        projectId: project.id,
        scope: { type: 'node', nodeIds: [target.id] },
        status: 'queued',
        actor: 'agent'
      })
      const gateway = {
        listProviders: async () => ({ ok: true, data: [] })
      } as unknown as GatewayClient

      await new HeadlessRunExecutor({ store, gateway }).execute(run)

      const savedTarget = (await store.getNodes(project.id)).find((node) => node.id === target.id)
      expect((await store.getRun(run.runId))?.status).toBe('succeeded')
      expect(savedTarget?.content).toEqual({
        kind: 'text',
        text: '上游内容\n\n---\n\n目标内容'
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('任何 gateway 前置失败都会将 Run 落为 failed，不会遗留 running 状态', async () => {
    const root = mkdtempSync(join(tmpdir(), 'canvas-headless-failure-'))
    try {
      const store = new FileProjectStore({ dataDir: root })
      const project = await store.createProject('headless failure')
      const node = textNode('shape:fail', '失败测试')
      await store.saveGraph(project.id, { nodes: [node], edges: [], groups: [] })
      const run = await store.createRun({
        runId: 'run-failure',
        projectId: project.id,
        scope: { type: 'node', nodeIds: [node.id] },
        status: 'queued',
        actor: 'agent'
      })
      const gateway = {
        listProviders: async () => ({
          ok: false,
          error: { code: 'NO_PROVIDER', message: 'provider unavailable' }
        })
      } as unknown as GatewayClient

      await new HeadlessRunExecutor({ store, gateway }).execute(run)

      const savedRun = await store.getRun(run.runId)
      expect(savedRun?.status).toBe('failed')
      expect(savedRun?.error?.code).toBe('HEADLESS_RUN_FAILED')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
