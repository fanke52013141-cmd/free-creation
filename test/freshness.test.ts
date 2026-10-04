// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import type { Editor } from 'tldraw'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import { registerAllNodeTypes } from './helpers/registerNodes'
import {
  currentNodeFingerprint,
  fingerprintNodeInputs,
  successfulInputFingerprint
} from '@renderer/engine/resultFreshness'
import { projectNodeOutputs, readPinnedOutputs } from '@renderer/nodes/nodeValues'
import { remapMediaReferences } from '@shared/media-reference-remap'

beforeAll(registerAllNodeTypes)
function shape(type = 'ai-process'): NodeCardShape {
  return {
    id: 'shape:target',
    type: 'node-card',
    props: {
      nodeType: type,
      config: '',
      text: 'prompt',
      title: '标题',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'success',
      w: 340,
      h: 260
    },
    meta: {}
  } as NodeCardShape
}
describe('T09 结果新鲜度与固定输出', () => {
  it('修改正文只改变指纹，不删除旧结果', () => {
    const node = shape()
    node.meta.nodeResult = JSON.stringify({ kind: 'text', text: 'old' })
    const prior = fingerprintNodeInputs(node, new Map())
    node.props.text = 'edited'
    expect(fingerprintNodeInputs(node, new Map())).not.toBe(prior)
    expect(node.meta.nodeResult).toContain('old')
  })
  it('同一上游不同产物或不同源端口都使结果过期', () => {
    const node = shape()
    const inputs = (text: string, portId = 'out-text') =>
      new Map([
        [
          'in-text',
          [{ source: { nodeId: 'shape:source', portId }, value: { kind: 'text' as const, text } }]
        ]
      ])
    const prior = fingerprintNodeInputs(node, inputs('first'))
    expect(fingerprintNodeInputs(node, inputs('second'))).not.toBe(prior)
    expect(fingerprintNodeInputs(node, inputs('first', 'out-other'))).not.toBe(prior)
  })
  it('标题、坐标、媒体显示名不改变指纹', () => {
    const node = shape()
    const inputs = (name: string) =>
      new Map([
        [
          'in-image',
          [
            {
              source: { nodeId: 'shape:a', portId: 'out-image' },
              value: {
                kind: 'image' as const,
                mediaId: 'm1',
                mediaPath: 'p',
                mime: 'image/png',
                name
              }
            }
          ]
        ]
      ])
    const prior = fingerprintNodeInputs(node, inputs('old'))
    node.props.title = 'new title'
    node.x = 300
    expect(fingerprintNodeInputs(node, inputs('new'))).toBe(prior)
  })
  it('实际连线读取与执行器输入一致，移除连线后不同', () => {
    const node = shape()
    const source = shape('text')
    source.id = 'shape:source' as NodeCardShape['id']
    source.props.text = 'upstream'
    let connected = true
    const editor = {
      getCurrentPageShapes: () =>
        connected
          ? [
              {
                id: 'shape:arrow',
                type: 'arrow',
                index: 'a1',
                meta: { fromPort: 'out-text', toPort: 'in-text' }
              }
            ]
          : [],
      getBindingsFromShape: () => [
        { props: { terminal: 'start' }, toId: source.id },
        { props: { terminal: 'end' }, toId: node.id }
      ],
      getShape: () => source
    } as unknown as Editor
    const expected = fingerprintNodeInputs(
      node,
      new Map([
        [
          'in-text',
          [
            {
              source: { nodeId: source.id, portId: 'out-text' },
              value: projectNodeOutputs(source)['out-text']
            }
          ]
        ]
      ])
    )
    expect(currentNodeFingerprint(editor, node)).toBe(expected)
    connected = false
    expect(currentNodeFingerprint(editor, node)).not.toBe(expected)
  })
  it('失败重试后仍能以最近成功记录判定旧结果的新鲜度', () => {
    const node = shape()
    node.meta.nodeRun = { runId: 'fail', status: 'failed', startedAt: 2, inputs: {} }
    node.meta.nodeRunHistory = [
      { runId: 'ok', status: 'success', startedAt: 1, inputs: {}, inputFingerprint: 'v1:known' }
    ]
    expect(successfulInputFingerprint(node)).toBe('v1:known')
  })
  it('固定后新候选或运行失败不改变下游；解除固定回到当前输出', () => {
    const node = shape('text')
    node.meta.pinnedOutput = JSON.stringify({
      version: 1,
      outputs: { 'out-text': { kind: 'text', text: 'chosen' } }
    })
    node.props.text = 'new candidate'
    node.meta.nodeRun = { runId: 'failed', status: 'failed', startedAt: 1, inputs: {} }
    const reopened = JSON.parse(JSON.stringify(node)) as NodeCardShape
    expect(projectNodeOutputs(reopened)['out-text']).toEqual({ kind: 'text', text: 'chosen' })
    delete reopened.meta.pinnedOutput
    expect(projectNodeOutputs(reopened)['out-text']).toEqual({
      kind: 'text',
      text: 'new candidate'
    })
  })
  it('无效固定快照不能覆盖有效输出', () => {
    expect(readPinnedOutputs('{broken')).toBeNull()
    expect(
      readPinnedOutputs(JSON.stringify({ version: 1, outputs: { x: { kind: 'invalid' } } }))
    ).toBeNull()
  })
  it('导入重映射也进入固定输出内的媒体引用', () => {
    const value = {
      pinnedOutput: JSON.stringify({
        version: 1,
        outputs: {
          'out-image': { kind: 'image', mediaId: 'old', mediaPath: 'old.png', mime: 'image/png' }
        }
      })
    }
    const result = remapMediaReferences(value, {
      ids: new Map([['old', 'new']]),
      paths: new Map([['old.png', 'new.png']])
    })
    expect(readPinnedOutputs(result.pinnedOutput)?.['out-image']).toMatchObject({
      mediaId: 'new',
      mediaPath: 'new.png'
    })
  })
})
