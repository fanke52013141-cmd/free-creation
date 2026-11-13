import { describe, expect, it } from 'vitest'
import {
  aiProcessFlowInputsValid,
  aiProcessFlowConfigValid,
  aiProcessFlowOutputPort,
  humanTaskFlowConfigValid,
  humanTaskFlowOutputPort,
  flowTargetContract,
  flowTargetPorts,
  textFlowInputsValid
} from '../src/shared/agent-flow/video-adapter'
import {
  registerBaseNodeTypes,
  registerExtendedNodeTypes,
  registerScriptNodeType
} from '../src/renderer/src/nodes/specs'
import type { CanvasNode } from '../src/shared/types'

registerBaseNodeTypes()
registerExtendedNodeTypes()
registerScriptNodeType()

function node(type: string, contractVersion: number, config: unknown = {}): CanvasNode {
  return {
    id: `shape:${type}`,
    type: type as CanvasNode['type'],
    contractVersion,
    title: type,
    x: 0,
    y: 0,
    w: 340,
    h: 300,
    ports: [],
    params: { config: typeof config === 'string' ? config : JSON.stringify(config) },
    content: { kind: 'empty' },
    exec: 'idle',
    meta: { source: 'input', createdAt: 0 }
  } as unknown as CanvasNode
}

const TEXT_VALUE = { kind: 'text', text: '素材' } as never
const JSON_VALUE = { kind: 'json', data: { a: 1 } } as never
const IMAGE_VALUE = { kind: 'image', mediaId: 'm', mediaPath: 'p', mime: 'image/png' } as never

describe('C1：text/ai-process 可调度目标', () => {
  it('text v3 目标契约：in-text → out-text', () => {
    expect(flowTargetContract(node('text', 3))).toEqual({ inputs: ['in-text'], output: 'out-text' })
  })

  it('text 契约版本不符 → 不支持', () => {
    expect(flowTargetContract(node('text', 2))).toBeNull()
  })

  it('ai-process text 模式（含缺省 mode）→ in-text/in-json → out-text', () => {
    expect(flowTargetContract(node('ai-process', 1, { mode: 'text' }))).toEqual({
      inputs: ['in-text', 'in-json'],
      output: 'out-text'
    })
    expect(flowTargetContract(node('ai-process', 1, {}))).toEqual({
      inputs: ['in-text', 'in-json'],
      output: 'out-text'
    })
  })

  it('AF-01：ai-process markdown/json 模式 → 输出端口由配置 mode 稳定派生', () => {
    expect(flowTargetContract(node('ai-process', 1, { mode: 'markdown' }))).toEqual({
      inputs: ['in-text', 'in-json'],
      output: 'out-markdown'
    })
    expect(flowTargetContract(node('ai-process', 1, { mode: 'json' }))).toEqual({
      inputs: ['in-text', 'in-json'],
      output: 'out-json'
    })
  })

  it('AF-01：aiProcessFlowConfigValid/OutputPort 与执行器解析同口径', () => {
    expect(aiProcessFlowConfigValid('{"mode":"text"}')).toBe(true)
    expect(aiProcessFlowConfigValid('{}')).toBe(true)
    expect(aiProcessFlowConfigValid({ mode: 'json' })).toBe(true)
    expect(aiProcessFlowConfigValid('not-json')).toBe(true) // parseAiProcess 容错默认 text
    expect(aiProcessFlowOutputPort('{}')).toBe('out-text')
    expect(aiProcessFlowOutputPort({ mode: 'markdown' })).toBe('out-markdown')
    expect(aiProcessFlowOutputPort({ mode: 'json' })).toBe('out-json')
  })

  it('AF-01：human-task 输出端口由 outputType 派生（text/json）', () => {
    expect(flowTargetContract(node('human-task', 1, { schemaVersion: 1 }))).toEqual({
      inputs: ['in-text', 'in-json'],
      output: 'out-text'
    })
    expect(
      flowTargetContract(node('human-task', 1, { schemaVersion: 1, outputType: 'json' }))
    ).toEqual({
      inputs: ['in-text', 'in-json'],
      output: 'out-json'
    })
    expect(humanTaskFlowConfigValid({ schemaVersion: 1, outputType: 'json' })).toBe(true)
    expect(humanTaskFlowConfigValid({ schemaVersion: 1, outputType: 'bogus' })).toBe(false)
    expect(humanTaskFlowOutputPort({ schemaVersion: 1, outputType: 'json' })).toBe('out-json')
    expect(humanTaskFlowOutputPort({ schemaVersion: 1 })).toBe('out-text')
  })

  it('text 输入校验：有序文本/markdown，拒绝媒体与未知端口', () => {
    expect(textFlowInputsValid([{ targetPortId: 'in-text', values: [TEXT_VALUE] }])).toBe(true)
    expect(textFlowInputsValid([])).toBe(true)
    expect(textFlowInputsValid([{ targetPortId: 'in-text', values: [IMAGE_VALUE] }])).toBe(false)
    expect(textFlowInputsValid([{ targetPortId: 'in-json', values: [JSON_VALUE] }])).toBe(false)
  })

  it('ai-process 输入校验：in-text 文本、in-json 结构化，拒绝混用', () => {
    expect(
      aiProcessFlowInputsValid([
        { targetPortId: 'in-text', values: [TEXT_VALUE] },
        { targetPortId: 'in-json', values: [JSON_VALUE] }
      ])
    ).toBe(true)
    expect(aiProcessFlowInputsValid([{ targetPortId: 'in-text', values: [JSON_VALUE] }])).toBe(
      false
    )
    expect(aiProcessFlowInputsValid([{ targetPortId: 'in-json', values: [TEXT_VALUE] }])).toBe(
      false
    )
  })

  it('flowTargetPorts 与注册表端口逐字段一致（portIdentity 口径）', async () => {
    const { getNodeType, getNodePorts } = await import('../src/renderer/src/nodes/registry')
    const identity = (
      ports: {
        id: string
        dir: string
        type: string
        required: boolean
        cardinality: string
        schema?: { id: string; version: number }
        exclusiveGroup?: string
      }[]
    ) =>
      JSON.stringify(
        [...ports]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((p) => [
            p.id,
            p.dir,
            p.type,
            p.required,
            p.cardinality,
            p.schema ?? null,
            p.exclusiveGroup ?? null
          ])
      )
    for (const type of ['text', 'ai-process', 'human-task'] as const) {
      const spec = getNodeType(type)
      expect(spec, `${type} 注册存在`).toBeTruthy()
      const registered = [...spec!.ports.in, ...spec!.ports.out]
      expect(identity(flowTargetPorts(node(type, spec!.contractVersion)))).toBe(
        identity(registered)
      )
    }
  })
})

describe('C1：text 目标执行不写回正文（固定语义修订）', () => {
  function textCtx(over: {
    flowCommand?: unknown
    runId?: string
    body?: string
    upstream?: string
  }) {
    const metaPatches: Record<string, unknown>[] = []
    const propPatches: Record<string, unknown>[] = []
    const inputs = new Map(
      over.upstream ? [['in-text', [{ value: { kind: 'text', text: over.upstream } }]]] : []
    )
    const ctx = {
      shape: { props: { text: over.body ?? '正文' }, meta: {} },
      inputs,
      runId: over.runId ?? 'run-1',
      flowCommand: over.flowCommand,
      updateMeta: (patch: Record<string, unknown>) => metaPatches.push(patch),
      updateProps: (patch: Record<string, unknown>) => propPatches.push(patch)
    }
    return { ctx: ctx as never, metaPatches, propPatches }
  }

  it('普通执行：合并文本写回 props.text（既有行为不变）', async () => {
    const { textExecutor } = await import('../src/shared/engine/executors/text')
    const { ctx, propPatches, metaPatches } = textCtx({ body: '正文', upstream: '上游' })
    expect(textExecutor(ctx).status).toBe('done')
    expect(propPatches).toHaveLength(1)
    expect(String(propPatches[0].text)).toContain('上游')
    expect(metaPatches).toHaveLength(0)
  })

  it('Agent 调度执行：不写回正文，合并结果走 nodeResult（含 runId）', async () => {
    const { textExecutor } = await import('../src/shared/engine/executors/text')
    const { ctx, propPatches, metaPatches } = textCtx({
      body: '正文',
      upstream: '上游',
      flowCommand: { commandId: 'c1', leaseId: 'l1' },
      runId: 'run-9'
    })
    expect(textExecutor(ctx).status).toBe('done')
    expect(propPatches).toHaveLength(0)
    expect(metaPatches).toHaveLength(1)
    const stored = JSON.parse(String(metaPatches[0].nodeResult))
    expect(stored.kind).toBe('text')
    expect(stored.runId).toBe('run-9')
    expect(stored.text).toContain('上游')
    expect(stored.text).toContain('正文')
  })

  it('投影：nodeResult 与 nodeRun 同 runId 时优先；残留/不匹配读正文', async () => {
    const { projectTextOutputs } = await import('../src/shared/engine/deterministic-projections')
    const flowResult = JSON.stringify({ kind: 'text', text: '合并结果', runId: 'run-9' })
    const matched = projectTextOutputs({
      props: { text: '正文' },
      meta: { nodeResult: flowResult, nodeRun: { runId: 'run-9' } }
    } as never)
    expect(matched['out-text']).toEqual({ kind: 'text', text: '合并结果' })
    const stale = projectTextOutputs({
      props: { text: '正文' },
      meta: { nodeResult: flowResult, nodeRun: { runId: 'run-other' } }
    } as never)
    expect(stale['out-text']).toEqual({ kind: 'text', text: '正文' })
    const plain = projectTextOutputs({ props: { text: '正文' }, meta: {} } as never)
    expect(plain['out-text']).toEqual({ kind: 'text', text: '正文' })
  })
})
