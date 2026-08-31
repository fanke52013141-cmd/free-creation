import { describe, expect, it } from 'vitest'
import { deriveInputPortReadiness, deriveNodeReadiness } from '@renderer/canvas/node-readiness'
import type { PortDecl } from '@shared/types'

const requiredText: PortDecl = {
  id: 'in-text',
  name: '正文',
  dir: 'in',
  type: 'text',
  required: true,
  cardinality: 'one',
  description: '待处理正文。'
}

describe('节点就绪状态', () => {
  it('端口级状态区分缺失必填、可选未连和多输入连接数量', () => {
    const many = {
      ...requiredText,
      id: 'in-context',
      required: false,
      cardinality: 'many' as const
    }
    const states = deriveInputPortReadiness([requiredText, many], new Map([['in-context', 2]]))
    expect(states.get('in-text')).toMatchObject({ kind: 'missing', label: '缺少必填输入' })
    expect(states.get('in-context')).toMatchObject({ kind: 'connected', label: '2 条连接' })
  })
  it('必填端口未连接时明确说明缺失输入', () => {
    expect(
      deriveNodeReadiness({
        executionMode: 'auto',
        exec: 'idle',
        inputs: [requiredText],
        incomingCounts: new Map(),
        outputs: {}
      })
    ).toMatchObject({ kind: 'blocked', label: '缺少输入：正文' })
  })

  it('手动发布节点仅工程摘要时仍提示等待发布', () => {
    expect(
      deriveNodeReadiness({
        executionMode: 'manual-publish',
        exec: 'idle',
        inputs: [],
        incomingCounts: new Map(),
        outputs: { 'out-project': { kind: 'json', data: {} } }
      })
    ).toMatchObject({ kind: 'manual-publish', label: '等待发布' })
  })

  it('发布媒体后表示为可供下游使用', () => {
    expect(
      deriveNodeReadiness({
        executionMode: 'manual-publish',
        exec: 'success',
        inputs: [],
        incomingCounts: new Map(),
        outputs: {
          'out-frame': {
            kind: 'image',
            mediaId: 'frame',
            mediaPath: 'p/frame.png',
            mime: 'image/png'
          }
        }
      })
    ).toMatchObject({ kind: 'ready', label: '已发布' })
  })
})
