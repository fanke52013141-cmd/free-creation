import { describe, expect, it } from 'vitest'
import { nodeExecLabel } from '../src/renderer/src/canvas/node-status'

describe('node execution labels', () => {
  it('uses concise user-facing labels for all active execution states', () => {
    expect(nodeExecLabel('idle')).toBe('未运行')
    expect(nodeExecLabel('running')).toBe('执行中')
    expect(nodeExecLabel('failed')).toBe('执行失败')
    expect(nodeExecLabel('cached')).toBe('使用缓存')
  })

  it('does not expose raw unknown state values as UI copy', () => {
    expect(nodeExecLabel('unrecognized')).toBe('状态未知')
  })
})
