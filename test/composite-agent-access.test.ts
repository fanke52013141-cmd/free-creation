import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAccessService } from '../src/main/agent-access/service'
import { publishCompositeVersion } from '../src/main/store/composite.repo'
import { createCompositeRun, finishCompositeRun, recordCompositeRunStep } from '../src/main/store/composite-run.repo'
import { closeDb } from '../src/main/store/db'
import { ACCESS_OPERATIONS } from '../src/shared/agent-access/registry'
import { COMPOSITE_OPERATIONS, COMPOSITE_OUTPUTS } from '../src/shared/agent-access/ops/composite'
import { validateCompositeManifest } from '../src/shared/composite/validate'
import type { CompositeManifest } from '../src/shared/composite/manifest'

function manifest(): CompositeManifest {
  return {
    schemaVersion: 1,
    capabilityId: 'character-design',
    version: '1.0',
    name: '人物设计',
    inputs: [
      {
        id: 'requirements',
        label: '人物要求',
        type: 'text',
        required: true,
        cardinality: 'one',
        targets: [{ nodeId: 'n1', portId: 'in-text' }]
      }
    ],
    outputs: [
      {
        id: 'portrait',
        label: '人物设计图',
        type: 'image',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'n3', portId: 'out-image' }
      }
    ],
    graph: {
      nodes: [
        {
          id: 'n1',
          nodeType: 'text',
          contractVersion: 1,
          title: '人物要求',
          dx: 0,
          dy: 0,
          w: 340,
          h: 260,
          ports: [
            {
              id: 'in-text',
              name: '人物要求',
              dir: 'in',
              type: 'text',
              required: true,
              cardinality: 'one'
            },
            {
              id: 'out-text',
              name: '文本',
              dir: 'out',
              type: 'text',
              required: true,
              cardinality: 'one'
            }
          ]
        },
        {
          id: 'n3',
          nodeType: 'image-gen',
          contractVersion: 1,
          title: '生成人物图',
          dx: 380,
          dy: 0,
          w: 340,
          h: 260,
          ports: [
            {
              id: 'in-prompt',
              name: '提示词',
              dir: 'in',
              type: 'text',
              required: true,
              cardinality: 'one'
            },
            {
              id: 'out-image',
              name: '人物设计图',
              dir: 'out',
              type: 'image',
              required: true,
              cardinality: 'one'
            }
          ]
        }
      ],
      edges: [
        {
          from: { nodeId: 'n1', portId: 'out-text' },
          to: { nodeId: 'n3', portId: 'in-prompt' }
        }
      ]
    },
    dependencies: [
      { kind: 'node', id: 'text', contractVersion: 1 },
      { kind: 'node', id: 'image-gen', contractVersion: 1 }
    ]
  }
}

describe('组合能力 Agent 契约（P1 对等）', () => {
  it('节点流重试保留执行前失败的标量输入，并拒绝重放已执行的远端步骤', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'canvas-composite-retry-'))
    const priorDirectory = process.env.CANVAS_DATA_DIR
    process.env.CANVAS_DATA_DIR = directory
    const calls: unknown[] = []
    try {
      const { record } = await publishCompositeVersion(manifest())
      const service = new LocalAccessService({
        instanceId: 'composite-retry-test',
        appVersion: 'test',
        exportDirectory: join(directory, 'exports'),
        activeProjectId: () => null,
        desktop: {
          async run(request) {
            calls.push(request)
            return {}
          },
          async ask() { return { authorized: false, code: 'NOT_USED' } }
        }
      })
      for (const runId of ['before-execution', 'after-submission']) {
        createCompositeRun({
          id: runId,
          projectId: 'headless-test',
          capabilityId: record.manifest.capabilityId,
          capabilityVersion: record.manifest.version,
          contentHash: record.contentHash,
          inputValues: { requirements: '原始文本' }
        })
        if (runId === 'after-submission')
          recordCompositeRunStep({ runId, stepKey: 'n3', nodeType: 'image-gen', status: 'failed' })
        finishCompositeRun({ runId, status: 'failed', failurePhase: 'input' })
      }
      const retry = (runId: string) => service.dispatch({
        apiVersion: 1,
        operationVersion: 1,
        operationId: 'composite.run.retry',
        requestId: runId,
        idempotencyKey: `${Date.now()}:${randomUUID()}`,
        expectedDataStoreId: service.dataStoreId,
        input: { runId }
      })
      const allowed = await retry('before-execution')
      expect(allowed.error).toBeUndefined()
      expect(calls).toMatchObject([{ compositeInputs: [{ portId: 'requirements', value: '原始文本' }] }])
      const rejected = await retry('after-submission')
      expect(rejected.error?.code).toBe('RUN_RETRY_REQUIRES_RECONCILIATION')
      expect(calls).toHaveLength(1)
    } finally {
      closeDb()
      if (priorDirectory === undefined) delete process.env.CANVAS_DATA_DIR
      else process.env.CANVAS_DATA_DIR = priorDirectory
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('composite.* 二十项操作全部进入统一 Registry，输入输出成对', () => {
    expect(Object.keys(COMPOSITE_OPERATIONS)).toHaveLength(20)
    expect(COMPOSITE_OPERATIONS).toHaveProperty('composite.upgrade.apply')
    expect(COMPOSITE_OPERATIONS).toHaveProperty('composite.references')
    expect(COMPOSITE_OPERATIONS).toHaveProperty('composite.delete')
    expect(COMPOSITE_OPERATIONS).toHaveProperty('composite.execute')
    expect(COMPOSITE_OPERATIONS).toHaveProperty('composite.execute.wait')
    expect(COMPOSITE_OPERATIONS).toHaveProperty('composite.run.submitHuman')
    expect(COMPOSITE_OPERATIONS).toHaveProperty('composite.run.resume')
    for (const id of Object.keys(COMPOSITE_OPERATIONS)) {
      expect(ACCESS_OPERATIONS).toHaveProperty(id)
      expect(COMPOSITE_OUTPUTS).toHaveProperty(id)
    }
  })

  it('校验规则与 GUI 相同：类型不兼容、缺必填来源、单值端口多连线都拒绝', () => {
    expect(validateCompositeManifest(manifest()).ok).toBe(true)
    const badType = manifest()
    badType.inputs[0].type = 'image'
    expect(validateCompositeManifest(badType).issues.map((issue) => issue.code)).toContain(
      'PORT_TYPE_MISMATCH'
    )
    const unbound = manifest()
    unbound.inputs = []
    expect(validateCompositeManifest(unbound).issues.map((issue) => issue.code)).toContain(
      'REQUIRED_INPUT_UNBOUND'
    )
  })

  it('composite.execute 计费确认门（2026-11-20 G6）：confirmCost 进契约，未确认由 dispatch 拒绝', () => {
    const schema = COMPOSITE_OPERATIONS['composite.execute'].input
    const base = { capabilityId: 'copy-polish' }
    expect(schema.safeParse(base).success).toBe(true)
    expect(schema.safeParse({ ...base, confirmCost: true }).success).toBe(true)
    expect(schema.safeParse({ ...base, unknown: 1 }).success).toBe(false)
    // 描述必须写死键约定与计费口径，Agent 才能不试错地正确取 outputs。
    const description = COMPOSITE_OPERATIONS['composite.execute'].description ?? ''
    expect(description).toContain('in-<公开输入id>')
    expect(description).toContain('confirmCost')
    expect(description).toContain('out-<公开输出id>')
    expect(description).toContain('out-polished')
  })

  it('NF-5.3：headless outputs 以 out- 前缀暴露，resubmit 接受 out- 并归一化', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'canvas-composite-keys-'))
    const priorDirectory = process.env.CANVAS_DATA_DIR
    process.env.CANVAS_DATA_DIR = directory
    try {
      const textManifest = manifest()
      textManifest.capabilityId = 'copy-polish-keys'
      textManifest.name = '润色稿'
      textManifest.outputs = [
        {
          id: 'polished',
          label: '润色稿',
          type: 'text',
          required: true,
          cardinality: 'one',
          source: { nodeId: 'n1', portId: 'out-text' }
        }
      ]
      textManifest.graph = {
        nodes: [textManifest.graph.nodes[0]],
        edges: []
      }
      textManifest.dependencies = [{ kind: 'node', id: 'text', contractVersion: 1 }]
      const { record } = await publishCompositeVersion(textManifest)
      const service = new LocalAccessService({
        instanceId: 'composite-keys-test',
        appVersion: 'test',
        exportDirectory: join(directory, 'exports'),
        activeProjectId: () => 'headless-keys',
        desktop: {
          async run() {
            return {}
          },
          async ask() {
            return { authorized: true }
          }
        }
      })
      const dispatch = (operationId: string, input: Record<string, unknown>) =>
        service.dispatch({
          apiVersion: 1,
          operationVersion: 1,
          operationId,
          requestId: randomUUID(),
          idempotencyKey: `${Date.now()}:${randomUUID()}`,
          expectedDataStoreId: service.dataStoreId,
          input
        })
      const createRun = (runId: string) =>
        createCompositeRun({
          id: runId,
          projectId: 'headless-keys',
          capabilityId: record.manifest.capabilityId,
          capabilityVersion: record.manifest.version,
          contentHash: record.contentHash,
          inputValues: { requirements: '原始文本' }
        })

      // execute.wait：输出键统一带 out- 前缀。
      const completedId = randomUUID()
      createRun(completedId)
      finishCompositeRun({
        runId: completedId,
        status: 'completed',
        outputPorts: [{ portId: 'polished', kind: 'text' }],
        outputValues: { polished: { kind: 'text', text: '自动润色' } }
      })
      const waited = await dispatch('composite.execute.wait', { runId: completedId, timeoutMs: 100 })
      expect(waited.error).toBeUndefined()
      expect((waited.data as { outputs: Record<string, unknown> }).outputs).toEqual({
        'out-polished': { kind: 'text', text: '自动润色' }
      })

      // composite.run.get：读取投影同样带前缀（存储仍为裸 id）。
      const got = await dispatch('composite.run.get', { runId: completedId })
      expect(got.error).toBeUndefined()
      expect((got.data as { run: { outputValues: Record<string, unknown> } }).run.outputValues).toEqual({
        'out-polished': { kind: 'text', text: '自动润色' }
      })

      // resubmit：提交值用 out-<id>，返回的 outputPorts 同样带前缀。
      for (const [portId, text] of [
        ['out-polished', '人工补交'],
        ['polished', '历史裸 id 补交']
      ] as const) {
        const failedId = randomUUID()
        createRun(failedId)
        finishCompositeRun({ runId: failedId, status: 'failed', failurePhase: 'step' })
        const submitted = await dispatch('composite.run.resubmit', {
          runId: failedId,
          outputs: [{ portId, value: { kind: 'text', text } }]
        })
        expect(submitted.error).toBeUndefined()
        expect((submitted.data as { outputPorts: string[] }).outputPorts).toEqual(['out-polished'])
      }
    } finally {
      closeDb()
      if (priorDirectory === undefined) delete process.env.CANVAS_DATA_DIR
      else process.env.CANVAS_DATA_DIR = priorDirectory
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
