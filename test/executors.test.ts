// 执行器纯函数测试（路线图 R2 / 契约规范 P3）
//
// 覆盖 json / processor / storyboard 三个不依赖 Electron/tldraw/window.api 的
// 纯函数执行器。它们是「节点执行器解耦（R1）」后最易覆盖运行时分支的部分：
// 缺失输入、错误类型、错误结构、固定值兜底、any 实际类型恢复等。
import { describe, it, expect } from 'vitest'
import { jsonExecutor } from '@renderer/engine/executors/json'
import { processorExecutor } from '@renderer/engine/executors/processor'
import { storyboardExecutor } from '@renderer/engine/executors/storyboard'
import type { NodeExecutionContext, NodeExecutionResult } from '@renderer/engine/executor-types'
import type { NodeValue } from '@renderer/nodes/nodeValues'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'

/** 构造测试用 NodeExecutionContext，记录 updateProps / updateResult 调用。
 *  返回一个 holder，其 props 与 result 字段在执行器写入后会被原地更新，
 *  避免 let 基本类型值拷贝导致测试拿不到更新。 */
function makeCtx(over: {
  nodeType?: string
  text?: string
  inputs?: NodeExecutionContext['inputs']
  meta?: Record<string, unknown>
}): {
  ctx: NodeExecutionContext
  props: Partial<NodeCardShape['props']>
  result: { value: string | null }
} {
  const props: Partial<NodeCardShape['props']> = {}
  const result = { value: null as string | null }
  const baseShape = {
    id: 'shape:1' as never,
    type: 'node-card' as const,
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a1' as never,
    isLocked: false,
    props: {
      w: 340,
      h: 260,
      nodeType: over.nodeType ?? 'json',
      title: 'n',
      text: over.text ?? '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle'
    },
    meta: over.meta ?? {}
  } as NodeCardShape

  const ctx: NodeExecutionContext = {
    node: {
      id: 'shape:1',
      type: over.nodeType ?? 'json',
      contractVersion: 1,
      title: 'n',
      x: 0,
      y: 0,
      w: 340,
      h: 260,
      ports: [],
      params: {},
      content: { kind: 'empty' },
      exec: { status: 'idle' },
      meta: { source: 'input', createdAt: 0 }
    },
    shape: baseShape,
    inputs: over.inputs ?? new Map(),
    projectId: 'p1',
    providers: [],
    signal: { cancelled: false },
    updateProps: (patch) => Object.assign(props, patch),
    updateResult: (r) => {
      result.value = r
    }
  }
  return { ctx, props, result }
}

function packet(type: string, value: NodeValue): NodeExecutionContext['inputs'] {
  return new Map([
    [
      'in-json',
      [
        {
          type,
          value,
          source: { nodeId: 'u', portId: 'out-json', runId: 'r1' },
          createdAt: 0
        }
      ]
    ]
  ])
}

function textPacket(portId: string, text: string): NodeExecutionContext['inputs'] {
  return new Map([
    [
      portId,
      [
        {
          type: 'text',
          value: { kind: 'text', text },
          source: { nodeId: 'u', portId: 'out-text', runId: 'r1' },
          createdAt: 0
        }
      ]
    ]
  ])
}

describe('jsonExecutor · 运行时分支', () => {
  it('上游 JSON 输入 → 格式化写回并成功', () => {
    const inputs = packet('json', { kind: 'json', data: { b: 2 } })
    const { ctx, props } = makeCtx({ nodeType: 'json', inputs })
    const r = jsonExecutor(ctx)
    expect(r.status).toBe('done')
    expect(props.text).toBe(JSON.stringify({ b: 2 }, null, 2))
  })

  it('多个上游 JSON → 以数组形式保留', () => {
    const multi = new Map([
      [
        'in-json',
        [
          {
            type: 'json',
            value: { kind: 'json', data: 1 },
            source: { nodeId: 'u1', portId: 'o', runId: 'r' },
            createdAt: 0
          },
          {
            type: 'json',
            value: { kind: 'json', data: 2 },
            source: { nodeId: 'u2', portId: 'o', runId: 'r' },
            createdAt: 0
          }
        ]
      ]
    ])
    const { ctx, props } = makeCtx({ nodeType: 'json', inputs: multi })
    expect(jsonExecutor(ctx).status).toBe('done')
    expect(JSON.parse(props.text as string)).toEqual([1, 2])
  })

  it('无 JSON 时退回上游文本（可 JSON.parse）', () => {
    const { ctx, props } = makeCtx({
      nodeType: 'json',
      inputs: textPacket('in-text', '{"k":"v"}')
    })
    expect(jsonExecutor(ctx).status).toBe('done')
    expect(props.text).toBe(JSON.stringify({ k: 'v' }, null, 2))
  })

  it('无任何上游时用节点内置文本', () => {
    const { ctx, props } = makeCtx({ nodeType: 'json', text: '[1,2,3]' })
    expect(jsonExecutor(ctx).status).toBe('done')
    expect(JSON.parse(props.text as string)).toEqual([1, 2, 3])
  })

  it('文本无法解析为 JSON → failed（不把普通文本伪装成 JSON）', () => {
    const { ctx } = makeCtx({
      nodeType: 'json',
      inputs: textPacket('in-text', '不是 json')
    })
    const r = jsonExecutor(ctx)
    expect(r.status).toBe('failed')
    expect(r.reason).toContain('JSON')
  })
})

describe('processorExecutor · 固定值兜底与透传', () => {
  it('有上游值时原样透传到 meta.nodeResult', () => {
    const inputs = new Map([
      [
        'in-value',
        [
          {
            type: 'json',
            value: { kind: 'json', data: { x: 1 } },
            source: { nodeId: 'u', portId: 'o', runId: 'r' },
            createdAt: 0
          }
        ]
      ]
    ])
    const { ctx, result } = makeCtx({ nodeType: 'processor', inputs })
    expect(processorExecutor(ctx).status).toBe('done')
    expect(result.value).not.toBeNull()
    const parsed = JSON.parse(result.value as string)
    expect(parsed.kind).toBe('json')
    expect(parsed.data).toEqual({ x: 1 })
    expect(parsed.variableName).toBe('output')
  })

  it('无上游但有 string 类型固定值兜底', () => {
    const config = JSON.stringify({ valueType: 'string', fallback: '默认值' })
    const { ctx, result } = makeCtx({ nodeType: 'processor', text: config })
    expect(processorExecutor(ctx).status).toBe('done')
    expect(JSON.parse(result.value as string).kind).toBe('text')
    expect(JSON.parse(result.value as string).text).toBe('默认值')
  })

  it('无上游但有 JSON 固定值兜底（按 valueType 推断）', () => {
    const config = JSON.stringify({ valueType: 'object', fallback: '{"a":1}' })
    const { ctx, result } = makeCtx({ nodeType: 'processor', text: config })
    expect(processorExecutor(ctx).status).toBe('done')
    expect(JSON.parse(result.value as string).kind).toBe('json')
  })

  it('无上游也无固定值 → skipped', () => {
    const { ctx } = makeCtx({ nodeType: 'processor', text: '' })
    const r = processorExecutor(ctx)
    expect(r.status).toBe('skipped')
    expect(r.reason).toContain('固定值')
  })
})

describe('storyboardExecutor · 分镜解析分支', () => {
  const validShots = { kind: 'json', data: { shots: [{ id: 's1', scene: '街道' }] } }

  it('上游分镜 JSON → 标准化写回并成功', () => {
    const inputs = packet('json', validShots)
    const { ctx, props } = makeCtx({ nodeType: 'storyboard', inputs })
    expect(storyboardExecutor(ctx).status).toBe('done')
    const written = JSON.parse(props.text as string)
    expect(written.shots[0].scene).toBe('街道')
    expect(written.shots[0].id).toBe('s1')
  })

  it('无 JSON 但有可解析文本输入 → 成功', () => {
    const { ctx, props } = makeCtx({
      nodeType: 'storyboard',
      inputs: textPacket('in-text', JSON.stringify({ shots: [{ scene: '夜' }] }))
    })
    expect(storyboardExecutor(ctx).status).toBe('done')
    const written = JSON.parse(props.text as string)
    expect(written.shots[0].scene).toBe('夜')
    expect(typeof written.shots[0].id).toBe('string')
  })

  it('文本输入无法解析为分镜 → failed', () => {
    const { ctx } = makeCtx({
      nodeType: 'storyboard',
      inputs: textPacket('in-text', '不是 json')
    })
    const r = storyboardExecutor(ctx)
    expect(r.status).toBe('failed')
    expect(r.reason).toContain('分镜')
  })

  it('无上游时回退到节点内置存量', () => {
    const stored = JSON.stringify({ shots: [{ id: 's0', scene: '存量' }] })
    const { ctx, props } = makeCtx({ nodeType: 'storyboard', text: stored })
    expect(storyboardExecutor(ctx).status).toBe('done')
    expect(JSON.parse(props.text as string).shots[0].scene).toBe('存量')
  })

  it('无任何分镜来源 → skipped', () => {
    const { ctx } = makeCtx({ nodeType: 'storyboard', text: '' })
    const r = storyboardExecutor(ctx)
    expect(r.status).toBe('skipped')
  })
})

describe('执行器返回类型完整性', () => {
  it('所有执行器返回的对象 status 限于 done/skipped/failed', () => {
    const results: NodeExecutionResult[] = []
    results.push(jsonExecutor(makeCtx({ nodeType: 'json', text: '{}' }).ctx))
    results.push(processorExecutor(makeCtx({ nodeType: 'processor', text: '' }).ctx))
    results.push(storyboardExecutor(makeCtx({ nodeType: 'storyboard', text: '' }).ctx))
    for (const r of results) {
      expect(['done', 'skipped', 'failed']).toContain(r.status)
    }
  })
})
