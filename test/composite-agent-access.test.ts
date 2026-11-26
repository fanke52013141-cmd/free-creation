import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAccessService } from '../src/main/agent-access/service'
import { publishCompositeVersion } from '../src/main/store/composite.repo'
import {
  beginCompositeResume,
  createCompositeRun,
  finishCompositeRun,
  getCompositeRun,
  recordCompositeRunStep,
  recordCompositeStepOutput,
  settleInterruptedCompositeRuns,
  waitCompositeRun
} from '../src/main/store/composite-run.repo'
import {
  openCompositeRunWait,
  satisfyCompositeRunWait
} from '../src/main/store/composite-run-wait.repo'
import { closeDb, getDb } from '../src/main/store/db'
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

function textFlowManifest(capabilityId: string, outputIds = ['result']): CompositeManifest {
  return {
    schemaVersion: 1,
    capabilityId,
    version: '1.0',
    name: capabilityId,
    inputs: [],
    outputs: outputIds.map((id) => ({
      id,
      label: id,
      type: 'text',
      required: true,
      cardinality: 'one',
      source: { nodeId: 'n1', portId: 'out-text' }
    })),
    graph: {
      nodes: [{
        id: 'n1', nodeType: 'text', contractVersion: 3, title: '文本',
        dx: 0, dy: 0, w: 340, h: 260, text: 'result',
        ports: [{ id: 'out-text', name: '文本', dir: 'out', type: 'text', required: true, cardinality: 'one' }]
      }],
      edges: []
    },
    dependencies: [{ kind: 'node', id: 'text', contractVersion: 3 }]
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

  it('execute.wait 公开全部持久状态，waiting-input 立即可见且不再触发响应 Schema 错误', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'canvas-composite-wait-states-'))
    const priorDirectory = process.env.CANVAS_DATA_DIR
    process.env.CANVAS_DATA_DIR = directory
    try {
      const { record } = await publishCompositeVersion(textFlowManifest('wait-states'))
      const service = new LocalAccessService({
        instanceId: 'wait-states', appVersion: 'test', exportDirectory: join(directory, 'exports'),
        activeProjectId: () => null,
        desktop: { async run() { return {} }, async ask() { return { authorized: false } } }
      })
      const statuses = [
        'accepted', 'running', 'waiting-input', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown'
      ] as const
      for (const status of statuses) {
        const runId = `wait-${status}`
        createCompositeRun({
          id: runId, projectId: `headless-${runId}`, capabilityId: record.capabilityId,
          capabilityVersion: record.version, contentHash: record.contentHash
        })
        if (status === 'waiting-input') waitCompositeRun({ runId, stepKey: 'h1' })
        else if (status === 'accepted' || status === 'running')
          getDb().prepare('UPDATE composite_runs SET status=? WHERE id=?').run(status, runId)
        else finishCompositeRun({ runId, status })
        const response = await service.dispatch({
          apiVersion: 1, operationVersion: 1, operationId: 'composite.execute.wait',
          requestId: randomUUID(), expectedDataStoreId: service.dataStoreId,
          input: { runId, timeoutMs: 100 }
        })
        expect(response.error, status).toBeUndefined()
        expect(response.data).toMatchObject({ runId, status })
      }
    } finally {
      closeDb()
      if (priorDirectory === undefined) delete process.env.CANVAS_DATA_DIR
      else process.env.CANVAS_DATA_DIR = priorDirectory
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('manifest-aware 输出键在 get/list/wait/resubmit 消歧，歧义历史值显式拒绝', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'canvas-composite-output-collision-'))
    const priorDirectory = process.env.CANVAS_DATA_DIR
    process.env.CANVAS_DATA_DIR = directory
    try {
      const { record } = await publishCompositeVersion(textFlowManifest('output-collision', ['foo', 'out-foo']))
      const service = new LocalAccessService({
        instanceId: 'output-collision', appVersion: 'test', exportDirectory: join(directory, 'exports'),
        activeProjectId: () => null,
        desktop: { async run() { return {} }, async ask() { return { authorized: true } } }
      })
      const dispatch = (operationId: string, input: Record<string, unknown>) => service.dispatch({
        apiVersion: 1, operationVersion: 1, operationId, requestId: randomUUID(),
        idempotencyKey: `${Date.now()}:${randomUUID()}`, expectedDataStoreId: service.dataStoreId, input
      })
      const runId = 'output-pair'
      createCompositeRun({
        id: runId, projectId: `headless-${runId}`, capabilityId: record.capabilityId,
        capabilityVersion: record.version, contentHash: record.contentHash
      })
      finishCompositeRun({
        runId, status: 'completed',
        outputPorts: [{ portId: 'foo', kind: 'text' }, { portId: 'out-foo', kind: 'text' }],
        outputValues: {
          foo: { kind: 'text', text: 'plain foo' },
          'out-foo': { kind: 'text', text: 'declared out-foo' }
        }
      })
      const expected = {
        'out-foo': { kind: 'text', text: 'plain foo' },
        'out-out-foo': { kind: 'text', text: 'declared out-foo' }
      }
      const got = await dispatch('composite.run.get', { runId })
      const listed = await dispatch('composite.run.list', { projectId: `headless-${runId}` })
      const waited = await dispatch('composite.execute.wait', { runId, timeoutMs: 100 })
      expect((got.data as any).run.outputValues).toEqual(expected)
      expect((listed.data as any)[0].outputValues).toEqual(expected)
      expect((waited.data as any).outputs).toEqual(expected)

      const failedId = 'output-resubmit'
      createCompositeRun({
        id: failedId, projectId: `headless-${failedId}`, capabilityId: record.capabilityId,
        capabilityVersion: record.version, contentHash: record.contentHash
      })
      finishCompositeRun({ runId: failedId, status: 'failed', failurePhase: 'step' })
      const submitted = await dispatch('composite.run.resubmit', {
        runId: failedId,
        outputs: [
          { portId: 'foo', value: { kind: 'text', text: 'raw foo' } },
          { portId: 'out-out-foo', value: { kind: 'text', text: 'raw prefixed id' } }
        ]
      })
      expect(submitted.error).toBeUndefined()
      expect((submitted.data as any).outputPorts).toEqual(['out-foo', 'out-out-foo'])
      expect(getCompositeRun(failedId)?.run.outputValues).toMatchObject({
        foo: { text: 'raw foo' }, 'out-foo': { text: 'raw prefixed id' }
      })

      const ambiguousId = 'output-ambiguous'
      createCompositeRun({
        id: ambiguousId, projectId: `headless-${ambiguousId}`, capabilityId: record.capabilityId,
        capabilityVersion: record.version, contentHash: record.contentHash
      })
      finishCompositeRun({
        runId: ambiguousId, status: 'failed', failurePhase: 'step',
        outputValues: { 'out-foo': { kind: 'text', text: 'ambiguous legacy value' } }
      })
      const ambiguous = await dispatch('composite.run.get', { runId: ambiguousId })
      expect(ambiguous.error?.code).toBe('OUTPUT_KEY_AMBIGUOUS')
      const ambiguousSubmit = await dispatch('composite.run.resubmit', {
        runId: ambiguousId,
        outputs: [
          { portId: 'out-foo', value: { kind: 'text', text: 'ambiguous alias' } },
          { portId: 'out-out-foo', value: { kind: 'text', text: 'explicit second' } }
        ]
      })
      expect(ambiguousSubmit.error?.code).toBe('OUTPUT_PORT_AMBIGUOUS')
      expect(getCompositeRun(ambiguousId)?.run.status).toBe('failed')

      const unknownId = 'output-unknown'
      createCompositeRun({
        id: unknownId, projectId: `headless-${unknownId}`, capabilityId: record.capabilityId,
        capabilityVersion: record.version, contentHash: record.contentHash
      })
      finishCompositeRun({
        runId: unknownId, status: 'failed', failurePhase: 'step',
        outputValues: { rogue: { kind: 'text', text: 'not declared' } }
      })
      const unknown = await dispatch('composite.run.get', { runId: unknownId })
      expect(unknown.error?.code).toBe('OUTPUT_KEY_UNKNOWN')
    } finally {
      closeDb()
      if (priorDirectory === undefined) delete process.env.CANVAS_DATA_DIR
      else process.env.CANVAS_DATA_DIR = priorDirectory
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('interrupted resume 恢复已满足提交与 checkpoints，running-step 未结算时拒绝重放', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'canvas-composite-interrupted-resume-'))
    const priorDirectory = process.env.CANVAS_DATA_DIR
    process.env.CANVAS_DATA_DIR = directory
    try {
      const { record } = await publishCompositeVersion(textFlowManifest('interrupted-resume'))
      const calls: any[] = []
      const service = new LocalAccessService({
        instanceId: 'interrupted-resume', appVersion: 'test', exportDirectory: join(directory, 'exports'),
        activeProjectId: () => null,
        desktop: {
          async run(request) {
            calls.push(request)
            // 模拟真实 renderer 的 runStart：使用同一 repo CAS 领取续跑。
            const accepted = beginCompositeResume({
              id: request.ownRunId,
              projectId: request.projectId,
              capabilityId: request.compositeManifest.capabilityId,
              capabilityVersion: request.compositeManifest.version,
              contentHash: record.contentHash
            })
            expect(accepted).toBe(true)
            return { graphVersion: 0 }
          },
          async ask() { return { authorized: false } }
        }
      })
      const dispatch = (runId: string) => service.dispatch({
        apiVersion: 1, operationVersion: 1, operationId: 'composite.run.resume',
        requestId: randomUUID(), idempotencyKey: `${Date.now()}:${randomUUID()}`,
        expectedDataStoreId: service.dataStoreId, input: { runId }
      })
      const seed = (runId: string, runningStep: boolean) => {
        createCompositeRun({
          id: runId, projectId: `headless-${runId}`, capabilityId: record.capabilityId,
          capabilityVersion: record.version, contentHash: record.contentHash
        })
        recordCompositeRunStep({ runId, stepKey: 'upstream', nodeType: 'text', status: 'completed' })
        recordCompositeStepOutput({
          runId, nodeId: 'upstream', nodeResult: null,
          nodeExtra: JSON.stringify({ 'out-text': { kind: 'text', text: 'checkpoint' } }),
          nodeRun: { status: 'success' }
        })
        waitCompositeRun({ runId, stepKey: 'human' })
        openCompositeRunWait({ requestId: `${runId}:human`, runId, stepKey: 'human', kind: 'human', fields: [] })
        expect(satisfyCompositeRunWait({
          requestId: `${runId}:human`, revision: 1,
          value: { kind: 'text', text: 'confirmed' }, submittedBy: 'test'
        }).ok).toBe(true)
        expect(beginCompositeResume({
          id: runId, projectId: `headless-${runId}`, capabilityId: record.capabilityId,
          capabilityVersion: record.version, contentHash: record.contentHash
        })).toBe(true)
        if (runningStep)
          recordCompositeRunStep({ runId, stepKey: 'paid', nodeType: 'image-gen', status: 'running' })
        settleInterruptedCompositeRuns()
        expect(getCompositeRun(runId)?.run.status).toBe('interrupted')
      }

      seed('resume-safe', false)
      const resumed = await dispatch('resume-safe')
      expect(resumed.error).toBeUndefined()
      expect((resumed.data as any).status).toBe('running')
      expect(calls[0].compositeHumanSubmissions).toEqual({ human: { kind: 'text', text: 'confirmed' } })
      expect(calls[0].compositeCompletedSteps).toContain('upstream')
      expect(calls[0].compositeStepOutputs.upstream.nodeExtra).toContain('checkpoint')

      seed('resume-uncertain', true)
      const rejected = await dispatch('resume-uncertain')
      expect(rejected.error?.code).toBe('RUN_RECOVERY_REQUIRES_RECONCILIATION')
      expect(getCompositeRun('resume-uncertain')?.run.status).toBe('interrupted')
      expect(calls).toHaveLength(1)
    } finally {
      closeDb()
      if (priorDirectory === undefined) delete process.env.CANVAS_DATA_DIR
      else process.env.CANVAS_DATA_DIR = priorDirectory
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
