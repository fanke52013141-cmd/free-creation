import { describe, expect, it } from 'vitest'
import { textExecutor } from '../src/shared/engine/executors/text'
import { TEXT_MERGE_SEPARATOR } from '../src/shared/engine/helpers'

function run(input: {
  body: string
  upstream?: string
  meta?: Record<string, unknown>
}): { text: string; meta: Record<string, unknown> } {
  const result = { text: input.body, meta: { ...(input.meta ?? {}) } }
  const ctx = {
    runId: 'run-1',
    shape: {
      props: { nodeType: 'text', text: input.body },
      meta: input.meta ?? {}
    },
    inputs: input.upstream
      ? new Map([['in-text', [{ value: { kind: 'text', text: input.upstream } }]]])
      : new Map(),
    updateProps: (patch: { text?: string }) => {
      if (patch.text !== undefined) result.text = patch.text
    },
    updateMeta: (patch: Record<string, unknown>) => Object.assign(result.meta, patch)
  }
  const outcome = textExecutor(ctx as never)
  expect(outcome.status === 'done' || outcome.status === 'skipped').toBe(true)
  return result
}

describe('文本节点合并不累积（D-01 回归）', () => {
  it('上游从 A 变为 A+C 时不重复旧上游', () => {
    const first = run({ body: '', upstream: 'A' })
    expect(first.text).toBe('A')
    const second = run({ body: first.text, meta: first.meta, upstream: `A${TEXT_MERGE_SEPARATOR}C` })
    expect(second.text).toBe(`A${TEXT_MERGE_SEPARATOR}C`)
    expect(second.text.split('A').length - 1).toBe(1)
  })

  it('用户正文保留，且二次运行不会出现 A、C、A、B', () => {
    const first = run({ body: 'B', upstream: 'A' })
    expect(first.text).toBe(`A${TEXT_MERGE_SEPARATOR}B`)
    const second = run({ body: first.text, meta: first.meta, upstream: `A${TEXT_MERGE_SEPARATOR}C` })
    expect(second.text).toBe(`A${TEXT_MERGE_SEPARATOR}C${TEXT_MERGE_SEPARATOR}B`)
  })

  it('用户手动改写正文后按新正文合并，不还原旧结果', () => {
    const first = run({ body: 'B', upstream: 'A' })
    const edited = run({ body: '我改过的正文', meta: first.meta, upstream: 'A' })
    expect(edited.text).toBe(`A${TEXT_MERGE_SEPARATOR}我改过的正文`)
  })

  it('上游断开后正文回到用户正文', () => {
    const first = run({ body: 'B', upstream: 'A' })
    const plain = run({ body: first.text, meta: first.meta })
    expect(plain.text).toBe('B')
  })
})