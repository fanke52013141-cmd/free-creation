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
          { name: 'shot-id', type: 'json' }
        ]
      })
    )
    expect(config.params).toEqual([{ name: 'shot id', type: 'string' }])
    expect(
      codePortConfigErrors(
        JSON.stringify({
          source: '',
          params: [
            { name: 'shot id', type: 'string' },
            { name: 'shot-id', type: 'json' }
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
          { name: 'shot-id', type: 'json' }
        ]
      })
    )
    const ports = getNodePorts(getNodeType('code')!, shape)
    expect(ports.in.map((port) => port.id)).not.toContain('in-param-shot-id')
  })
})
