import { describe, expect, it } from 'vitest'
import { textExecutor } from '../src/shared/engine/executors/text'
import { currentTextResult, projectTextOutputs } from '../src/shared/engine/deterministic-projections'

function run(input: {
  body: string
  upstream?: string
  runId?: string
}): { text: string; props: { text: string }; meta: Record<string, unknown> } {
  const result = {
    text: input.body,
    props: { text: input.body },
    meta: {} as Record<string, unknown>
  }
  const ctx = {
    runId: input.runId ?? 'run-1',
    shape: {
      props: { nodeType: 'text', text: input.body },
      meta: {}
    },
    inputs: input.upstream
      ? new Map([['in-text', [{ value: { kind: 'text', text: input.upstream } }]]])
      : new Map(),
    updateProps: (patch: { text?: string }) => {
      if (patch.text !== undefined) result.props.text = patch.text
    },
    updateMeta: (patch: Record<string, unknown>) => Object.assign(result.meta, patch)
  }
  const outcome = textExecutor(ctx as never)
  expect(['done', 'skipped']).toContain(outcome.status)
  return result
}

describe('文本节点：结果只落运行记录，不改写正文（D-01 终版）', () => {
  it('普通运行不触碰正文，合并结果进 nodeResult（含 runId）', () => {
    const out = run({ body: 'B', upstream: 'A' })
    expect(out.props.text).toBe('B')
    const stored = JSON.parse(String(out.meta.nodeResult)) as { kind: string; text: string; runId: string }
    expect(stored).toEqual({ kind: 'text', text: 'A\n$$$\nB', runId: 'run-1' })
  })

  it('连续运行不累积：上游 A→A+C 后正文仍是用户正文', () => {
    const first = run({ body: '', upstream: 'A', runId: 'r1' })
    const second = run({ body: first.props.text, upstream: 'A\n$$$\nC', runId: 'r2' })
    expect(second.props.text).toBe('')
    const stored = JSON.parse(String(second.meta.nodeResult)) as { text: string }
    expect(stored.text).toBe('A\n$$$\nC')
  })

  it('投影只认与 nodeRun 同 runId 的结果；残留结果回退正文', () => {
    const shape = (meta: Record<string, unknown>, body = 'B') => ({ props: { text: body }, meta }) as never
    const fresh = { nodeResult: JSON.stringify({ kind: 'text', text: 'A\n$$$\nB', runId: 'r9' }), nodeRun: { runId: 'r9' } }
    expect(currentTextResult(shape(fresh))).toBe('A\n$$$\nB')
    expect(projectTextOutputs(shape(fresh))['out-text']).toEqual({ kind: 'text', text: 'A\n$$$\nB' })
    const stale = { nodeResult: JSON.stringify({ kind: 'text', text: '旧结果', runId: 'old' }), nodeRun: { runId: 'r9' } }
    expect(currentTextResult(shape(stale))).toBeNull()
    expect(projectTextOutputs(shape(stale))['out-text']).toEqual({ kind: 'text', text: 'B' })
  })
})