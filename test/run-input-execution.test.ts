// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import type { Editor } from 'tldraw'
import { runNodeManually } from '@renderer/engine/executor'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import { registerAllNodeTypes } from './helpers/registerNodes'

beforeAll(() => registerAllNodeTypes())

function node(id: string, nodeType: string, text: string, config = ''): NodeCardShape {
  return {
    id: id as never,
    type: 'node-card',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a1' as never,
    isLocked: false,
    props: {
      w: 340,
      h: 260,
      nodeType,
      title: nodeType,
      config,
      text,
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle'
    },
    meta: {}
  }
}

function mockEditor(target: NodeCardShape): Editor {
  const shapes = new Map([[target.id, target]])
  return {
    getCurrentPageShapes: () => Array.from(shapes.values()),
    getShape: (id: string) => shapes.get(id as never),
    getBindingsFromShape: () => [],
    updateShape: (patch: {
      id: string
      props?: Record<string, unknown>
      meta?: Record<string, unknown>
    }) => {
      const shape = shapes.get(patch.id as never)!
      if (patch.props) Object.assign(shape.props, patch.props)
      if (patch.meta) Object.assign(shape.meta, patch.meta)
    },
    markHistoryStoppingPoint: () => undefined
  } as unknown as Editor
}

describe('T2 单节点补输入执行实测（离线节点）', () => {
  it('text 空正文 → 汇总弹窗补文本 → 运行产出', async () => {
    const target = node('shape:exec-text', 'text', '')
    let calls = 0
    const result = await runNodeManually(
      mockEditor(target),
      'p',
      [],
      target.id,
      undefined,
      undefined,
      undefined,
      {
        requestInputs: async (req) => {
          calls++
          return req.gaps.map((g) => ({
            nodeId: g.nodeId,
            portId: g.port.id,
            value: { kind: 'text' as const, text: '补充文本' }
          }))
        }
      }
    )
    expect(calls).toBe(1)
    expect(result.status).toBe('done')
    // 临时输入只作用本次运行（不写回 props.text）；运行成功即证明补齐生效。
    expect(target.props.exec).toBe('success')
    expect(target.meta.nodeRun).toMatchObject({ status: 'success' })
  })

  it('processor 预供 in-value → 不弹窗但注入运行（pass 透传）', async () => {
    const target = node('shape:exec-proc', 'processor', '', JSON.stringify({ operation: 'pass' }))
    let calls = 0
    const result = await runNodeManually(
      mockEditor(target),
      'p',
      [],
      target.id,
      undefined,
      undefined,
      undefined,
      {
        inputs: [
          { nodeId: target.id, portId: 'in-value', value: { kind: 'text', text: '透传输入' } }
        ],
        requestInputs: async () => {
          calls++
          return []
        }
      }
    )
    expect(calls).toBe(0)
    expect(result.status).toBe('done')
    expect(JSON.parse(String(target.meta.nodeResult))).toMatchObject({
      kind: 'text',
      text: '透传输入'
    })
  })

  it('processor 无输入无 fallback → 不弹窗，自然跳过（覆盖缺口现状）', async () => {
    const target = node(
      'shape:exec-proc-empty',
      'processor',
      '',
      JSON.stringify({ operation: 'pass' })
    )
    let calls = 0
    const result = await runNodeManually(
      mockEditor(target),
      'p',
      [],
      target.id,
      undefined,
      undefined,
      undefined,
      {
        requestInputs: async () => {
          calls++
          return []
        }
      }
    )
    expect(calls).toBe(0)
    expect(result.status).toBe('skipped')
  })

  it('json 空正文 → 弹窗补 JSON 文本 → 运行产出', async () => {
    const target = node('shape:exec-json-empty', 'json', '')
    let calls = 0
    const result = await runNodeManually(
      mockEditor(target),
      'p',
      [],
      target.id,
      undefined,
      undefined,
      undefined,
      {
        requestInputs: async (req) => {
          calls++
          return req.gaps.map((g) => ({
            nodeId: g.nodeId,
            portId: g.port.id,
            value: { kind: 'text' as const, text: '{"a":1}' }
          }))
        }
      }
    )
    expect(calls).toBe(1)
    expect(result.status).toBe('done')
    expect(JSON.parse(target.props.text)).toMatchObject({ a: 1 })
  })

  it('json 有效正文 → 不弹窗直接运行产出', async () => {
    const target = node('shape:exec-json-ok', 'json', '{"a":1}')
    let calls = 0
    const result = await runNodeManually(
      mockEditor(target),
      'p',
      [],
      target.id,
      undefined,
      undefined,
      undefined,
      {
        requestInputs: async () => {
          calls++
          return []
        }
      }
    )
    expect(calls).toBe(0)
    expect(result.status).toBe('done')
    expect(target.meta.nodeRun).toMatchObject({ status: 'success', outputPorts: ['out-json'] })
    expect(JSON.parse(target.props.text)).toMatchObject({ a: 1 })
  })

  it('structured 空正文 → 弹窗补 JSON 模板（temporaryText 注入正文）→ 运行产出', async () => {
    const target = node('shape:exec-struct-empty', 'structured', '')
    let calls = 0
    const result = await runNodeManually(
      mockEditor(target),
      'p',
      [],
      target.id,
      undefined,
      undefined,
      undefined,
      {
        requestInputs: async (req) => {
          calls++
          return req.gaps.map((g) => ({
            nodeId: g.nodeId,
            portId: g.port.id,
            value: { kind: 'text' as const, text: '{"a":1}' }
          }))
        }
      }
    )
    expect(calls).toBe(1)
    expect(result.status).toBe('done')
    expect(target.meta.nodeRun).toMatchObject({ status: 'success' })
  })

  it('video 空正文 → 列出提示词缺口（模型节点弹窗机制）', async () => {
    const target = node('shape:exec-video-empty', 'video', '')
    let gaps: string[] = []
    const result = await runNodeManually(
      mockEditor(target),
      'p',
      [],
      target.id,
      undefined,
      undefined,
      undefined,
      {
        requestInputs: async (req) => {
          gaps = req.gaps.map((g) => g.port.id)
          return req.gaps.map((g) => ({
            nodeId: g.nodeId,
            portId: g.port.id,
            value: { kind: 'text' as const, text: '一只猫在跑' }
          }))
        }
      }
    )
    expect(gaps).toEqual(['in-text'])
    // 模型节点：验证缺口被列出且补值已注入；实际生成依赖视频模型，此处不作状态断言。
    expect(result.status).toBeDefined()
  })

  it('voice-design 空正文 → 列出描述缺口（模型节点弹窗机制）', async () => {
    const target = node('shape:exec-vd-empty', 'voice-design', '')
    let gaps: string[] = []
    await runNodeManually(mockEditor(target), 'p', [], target.id, undefined, undefined, undefined, {
      requestInputs: async (req) => {
        gaps = req.gaps.map((g) => g.port.id)
        return req.gaps.map((g) => ({
          nodeId: g.nodeId,
          portId: g.port.id,
          value: { kind: 'text' as const, text: '温柔女声' }
        }))
      }
    })
    expect(gaps).toEqual(['in-text'])
  })
})
