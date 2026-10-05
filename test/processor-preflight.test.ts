import { describe, expect, it } from 'vitest'
import {
  parseProcessor,
  processorInputIssue,
  resolveProcessorInput
} from '@shared/engine/executors/processor'
import { deriveNodeReadiness } from '@renderer/canvas/node-readiness'

describe('data processing preflight', () => {
  it('blocks plain text in field extraction and permits an explicit string template', () => {
    const data = parseProcessor(
      JSON.stringify({ operation: 'pick', fallback: 'hello', path: 'scene' })
    )
    const value = resolveProcessorInput(data, null)
    const configIssue = processorInputIssue(data, value)
    expect(configIssue).toContain('字符串模板')
    expect(
      deriveNodeReadiness({
        executionMode: 'auto',
        exec: 'idle',
        inputs: [],
        incomingCounts: new Map(),
        outputs: {},
        configIssue
      })
    ).toMatchObject({ kind: 'blocked', reason: 'config-missing' })
    expect(processorInputIssue({ ...data, operation: 'template' }, value)).toBeNull()
  })

  it('validates missing, empty, and existing paths including arrays before running', () => {
    const data = parseProcessor(
      JSON.stringify({ operation: 'pick', fallback: '{"shots":[{"scene":"book"}]}' })
    )
    const value = resolveProcessorInput(data, null)
    expect(processorInputIssue(data, value)).toBe('请填写字段路径')
    expect(processorInputIssue({ ...data, path: 'shots.1.scene' }, value)).toContain(
      '字段路径不存在'
    )
    expect(processorInputIssue({ ...data, path: 'shots.0.scene' }, value)).toBeNull()
    expect(processorInputIssue({ ...data, fallback: '' }, null)).toContain('填写固定内容')
  })

  it('validates the connected value ahead of a JSON fallback without changing the selected mode', () => {
    const data = parseProcessor(
      JSON.stringify({ operation: 'pick', fallback: '{"scene":"book"}', path: 'scene' })
    )
    const connected = { kind: 'text' as const, text: 'upstream text' }
    expect(resolveProcessorInput(data, connected)).toBe(connected)
    expect(processorInputIssue(data, resolveProcessorInput(data, connected))).toContain('JSON')
    expect(data.operation).toBe('pick')
  })
})
