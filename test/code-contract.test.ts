// 代码节点动态参数契约：每个参数都必须是可连接、可展示、可执行的真实输入端口。
import { describe, expect, it } from 'vitest'
import { codePortConfigErrors, parseCodeConfigs } from '@renderer/engine/executors/code'
import { getNodePorts, getNodeType } from '@renderer/nodes/registry'
import { registerAllNodeTypes } from './helpers/registerNodes'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'

registerAllNodeTypes()

function codeShape(text: string): NodeCardShape {
  return {
    id: 'shape:code' as never,
    type: 'node-card',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a1' as never,
    isLocked: false,
    props: {
      w: 340,
      h: 260,
      nodeType: 'code',
      title: '代码',
      config: text,
      text: '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle'
    },
    meta: {}
  }
}

describe('代码节点动态输入参数', () => {
  it('camera 参数和输出字段保留 camera 类型与 previs.camera Schema', () => {
    const shape = codeShape(
      JSON.stringify({
        source: '',
        params: [{ name: 'preset', type: 'camera' }],
        outputMode: 'fields',
        outputs: [{ name: 'camera', type: 'camera' }]
      })
    )
    const ports = getNodePorts(getNodeType('code')!, shape)
    expect(ports.in).toContainEqual(
      expect.objectContaining({
        id: 'in-param-preset',
        type: 'camera',
        schema: { id: 'previs.camera', version: 1 }
      })
    )
    expect(ports.out).toContainEqual(
      expect.objectContaining({
        id: 'out-camera',
        type: 'camera',
        schema: { id: 'previs.camera', version: 1 }
      })
    )
  })

  it('JSON 参数声明 json.any@1，使其可以通过 Schema 连线校验', () => {
    const shape = codeShape(
      JSON.stringify({ source: '', params: [{ name: 'shot', type: 'object' }] })
    )
    const ports = getNodePorts(getNodeType('code')!, shape)
    expect(ports.in).toContainEqual(
      expect.objectContaining({
        id: 'in-param-shot',
        type: 'json',
        schema: { id: 'json.any', version: 1 }
      })
    )
  })

  it('输出变量生成真实的命名输出端口，并保留所选数据类型', () => {
    const shape = codeShape(
      JSON.stringify({ source: '', outputName: 'caption', outputType: 'string' })
    )
    const ports = getNodePorts(getNodeType('code')!, shape)
    expect(ports.out).toEqual([
      expect.objectContaining({ id: 'out-caption', name: 'caption', type: 'text' })
    ])
  })

  it('按最终端口 ID 去重，避免名称变化后产生重复输入端口', () => {
    const config = parseCodeConfigs(
      JSON.stringify({
        source: '',
        params: [
          { name: 'shot id', type: 'string' },
          { name: 'shot-id', type: 'object' }
        ]
      })
    )
    expect(config.params).toEqual([{ name: 'shot id', type: 'string', cardinality: 'one' }])
    expect(
      codePortConfigErrors(
        JSON.stringify({
          source: '',
          params: [
            { name: 'shot id', type: 'string' },
            { name: 'shot-id', type: 'object' }
          ]
        })
      )
    ).toEqual(['输入参数端口重复：in-param-shot-id'])
  })

  it('动态端口冲突时不暴露可连接的半成品参数端口', () => {
    const shape = codeShape(
      JSON.stringify({
        source: '',
        params: [
          { name: 'shot id', type: 'string' },
          { name: 'shot-id', type: 'object' }
        ]
      })
    )
    const ports = getNodePorts(getNodeType('code')!, shape)
    expect(ports.in.map((port) => port.id)).not.toContain('in-param-shot-id')
  })

  it('多输出模式按字段创建真实端口，同类型输出也可以并列', () => {
    const shape = codeShape(
      JSON.stringify({
        source: '',
        outputMode: 'fields',
        outputs: [
          { name: 'caption', type: 'string', portId: 'out-caption' },
          { name: 'summary', type: 'string', portId: 'out-summary' },
          { name: 'items', type: 'array', portId: 'out-items' }
        ]
      })
    )
    const ports = getNodePorts(getNodeType('code')!, shape)
    expect(ports.out.map(({ id, type }) => ({ id, type }))).toEqual([
      { id: 'out-caption', type: 'text' },
      { id: 'out-summary', type: 'text' },
      { id: 'out-items', type: 'json' }
    ])
  })

  it('单输出模式在保存 UI 配置字段后仍保持单输出', () => {
    const config = parseCodeConfigs(
      JSON.stringify({
        source: 'return args.input',
        outputMode: 'single',
        outputName: 'caption',
        outputType: 'string',
        outputs: [{ name: 'output', type: 'any' }]
      })
    )
    expect(config.outputMode).toBe('single')
    expect(getNodePorts(getNodeType('code')!, codeShape(JSON.stringify(config))).out).toEqual([
      expect.objectContaining({ id: 'out-caption', type: 'text' })
    ])
  })

  it('多值端口基数与 JSON 数组数据类型分别声明', () => {
    const shape = codeShape(
      JSON.stringify({
        source: '',
        params: [
          { name: 'items', type: 'array', cardinality: 'one' },
          { name: 'references', type: 'image', cardinality: 'many' }
        ]
      })
    )
    const ports = getNodePorts(getNodeType('code')!, shape)
    expect(ports.in.find((port) => port.id === 'in-param-items')).toMatchObject({
      type: 'json',
      cardinality: 'one'
    })
    expect(ports.in.find((port) => port.id === 'in-param-references')).toMatchObject({
      type: 'image',
      cardinality: 'many'
    })
  })

  it('参数名不能覆盖 args 的内置输入变量', () => {
    expect(
      codePortConfigErrors(
        JSON.stringify({ source: '', params: [{ name: 'files', type: 'file' }] })
      )
    ).toContain('输入参数名称与内置代码变量冲突：files')
  })
})
