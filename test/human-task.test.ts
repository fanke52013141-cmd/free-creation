import { admitHumanTaskSubmission } from '../src/shared/agent-flow/human-task-submission'
import { describe, expect, it, vi } from 'vitest'
import { humanTaskExecutor, projectHumanTaskOutputs } from '../src/shared/engine/executors/humanTask'
import type { NodeExecutionContext } from '../src/shared/engine/executor-types'

function ctx(overrides: {
  config?: unknown
  meta?: Record<string, unknown>
}): { ctx: NodeExecutionContext; updates: Record<string, unknown>; result: { value: unknown } } {
  const updates: Record<string, unknown> = {}
  const result = { value: undefined as unknown }
  const context = {
    node: { id: 'shape:human', type: 'human-task', title: '人工任务', contractVersion: 1 },
    shape: {
      id: 'shape:human',
      type: 'node-card',
      props: {
        nodeType: 'human-task',
        config: JSON.stringify(overrides.config ?? { schemaVersion: 1, outputType: 'text' })
      },
      meta: overrides.meta ?? {}
    },
    inputs: new Map(),
    projectId: 'project',
    providers: [],
    signal: { cancelled: false, paused: false, onCancel: () => () => undefined },
    gateway: {},
    updateProps: vi.fn(),
    updateResult: vi.fn((value: unknown) => {
      result.value = value
    }),
    updateMeta: vi.fn((patch: Record<string, unknown>) => {
      Object.assign(updates, patch)
    }),
    trace: vi.fn()
  } as unknown as NodeExecutionContext
  return { ctx: context, updates, result }
}

const textPending = (expectedRevision: number, submissionId = 'sub-1', text = '人工结果') =>
  JSON.stringify({ submissionId, expectedRevision, value: { kind: 'text', text } })

describe('C4 人工任务执行器（停等语义）', () => {
  it('无提交时停等：返回 skipped，不伪造成功，初始化权威实例', async () => {
    const { ctx: c, updates } = ctx({})
    const result = await humanTaskExecutor(c)
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('等待人工提交')
    expect(JSON.parse(String(updates.humanTask))).toMatchObject({ status: 'pending', revision: 1 })
  })

  it('有效文本提交：完成并投影结果，修订递增，消费 pending（空串）', async () => {
    const { ctx: c, updates, result } = ctx({
      meta: { humanTaskPending: JSON.stringify({ ...JSON.parse(textPending(1)), handoffNote: 'Check sources' }) }
    })
    const outcome = await humanTaskExecutor(c)
    expect(outcome.status).toBe('done')
    const instance = JSON.parse(String(updates.humanTask))
    expect(instance).toMatchObject({ status: 'completed', revision: 2, lastSubmissionId: 'sub-1', handoffNote: 'Check sources', actor: { kind: 'user', roleId: 'owner' } })
    expect(updates.humanTaskPending).toBe('')
    expect(JSON.parse(String(result.value))).toEqual({ kind: 'text', text: '人工结果' })
  })

  it('opens a fresh pending revision for a new parent task scope', async () => {
    const { ctx: execution, updates } = ctx({ meta: {
      humanTask: JSON.stringify({
        schemaVersion: 1, nodeId: 'shape:human', revision: 2, status: 'completed',
        scope: 'old-task', result: { kind: 'text', text: 'old result' }, handoffNote: 'old note'
      }),
      humanTaskPending: textPending(2)
    } })
    execution.humanTaskScope = 'new-task'
    expect((await humanTaskExecutor(execution)).status).toBe('skipped')
    expect(JSON.parse(String(updates.humanTask))).toEqual({
      schemaVersion: 1, nodeId: 'shape:human', revision: 3, status: 'pending', scope: 'new-task'
    })
    expect(updates.humanTaskPending).toBe('')
  })

  it('修订冲突：过期提交拒绝', async () => {
    const { ctx: c } = ctx({
      meta: {
        humanTask: JSON.stringify({ schemaVersion: 1, nodeId: 'shape:human', revision: 3, status: 'pending' }),
        humanTaskPending: textPending(1)
      }
    })
    const outcome = await humanTaskExecutor(c)
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toContain('修订冲突')
  })

  it('重复 submissionId：拒绝重复提交', async () => {
    const { ctx: c } = ctx({
      meta: {
        humanTask: JSON.stringify({
          schemaVersion: 1, nodeId: 'shape:human', revision: 2, status: 'completed', lastSubmissionId: 'sub-1'
        }),
        humanTaskPending: textPending(2, 'sub-1')
      }
    })
    const outcome = await humanTaskExecutor(c)
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toContain('重复提交')
  })

  it('类型不符：text 节点拒绝 json 提交', async () => {
    const { ctx: c } = ctx({
      config: { schemaVersion: 1, outputType: 'text' },
      meta: {
        humanTaskPending: JSON.stringify({
          submissionId: 'sub-2', expectedRevision: 1, value: { kind: 'json', data: {} }
        })
      }
    })
    const outcome = await humanTaskExecutor(c)
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toContain('类型与节点声明不符')
  })

  it('JSON 节点接受 json 提交并投影 out-json', async () => {
    const { ctx: c, result } = ctx({
      config: { schemaVersion: 1, outputType: 'json' },
      meta: {
        humanTaskPending: JSON.stringify({
          submissionId: 'sub-3', expectedRevision: 1, value: { kind: 'json', data: { a: 1 } }
        })
      }
    })
    const outcome = await humanTaskExecutor(c)
    expect(outcome.status).toBe('done')
    expect(JSON.parse(String(result.value))).toEqual({ kind: 'json', data: { a: 1 } })
  })

  it('已完成实例重跑：投影既有结果，不要求再次提交', async () => {
    const { ctx: c, result } = ctx({
      meta: {
        humanTask: JSON.stringify({
          schemaVersion: 1, nodeId: 'shape:human', revision: 2, status: 'completed',
          result: { kind: 'text', text: '既有结果' }
        })
      }
    })
    const outcome = await humanTaskExecutor(c)
    expect(outcome.status).toBe('done')
    expect(JSON.parse(String(result.value))).toEqual({ kind: 'text', text: '既有结果' })
  })

  it('损坏的待提交：按输入失败处理，不静默当作无提交', async () => {
    const { ctx: c } = ctx({ meta: { humanTaskPending: '{bad json' } })
    const outcome = await humanTaskExecutor(c)
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toContain('格式无效')
  })

  it('无效配置：输入失败', async () => {
    const { ctx: c } = ctx({ config: { schemaVersion: 1, outputType: 'invalid' } })
    const outcome = await humanTaskExecutor(c)
    expect(outcome.status).toBe('failed')
    expect(outcome.diagnosticPhase).toBe('input')
  })
})

describe('C4 人工任务输出投影', () => {
  it('completed 文本结果投影 out-text', () => {
    const outputs = projectHumanTaskOutputs({
      meta: {
        humanTask: JSON.stringify({
          schemaVersion: 1, nodeId: 'shape:human', revision: 2, status: 'completed',
          result: { kind: 'text', text: '结果' }
        })
      }
    })
    expect(outputs).toEqual({ 'out-text': { kind: 'text', text: '结果' } })
  })

  it('completed JSON 结果投影 out-json', () => {
    const outputs = projectHumanTaskOutputs({
      meta: {
        humanTask: JSON.stringify({
          schemaVersion: 1, nodeId: 'shape:human', revision: 2, status: 'completed',
          result: { kind: 'json', data: { x: 1 } }
        })
      }
    })
    expect(outputs).toEqual({ 'out-json': { kind: 'json', data: { x: 1 } } })
  })

  it('pending / 无实例：不产生输出', () => {
    expect(projectHumanTaskOutputs({ meta: {} })).toEqual({})
    expect(
      projectHumanTaskOutputs({
        meta: {
          humanTask: JSON.stringify({ schemaVersion: 1, nodeId: 'shape:human', revision: 1, status: 'pending' })
        }
      })
    ).toEqual({})
  })
})
describe('人工媒体交付', () => {
  it.each(['image', 'video'] as const)('从项目媒体解析 %s，正式结果引用所提交的资产', async (kind) => {
    const ref = { kind, mediaId: 'fixture-media' }
    const media = { ...ref, mediaPath: 'projects/project/media/fixture', mime: kind === 'image' ? 'image/png' : 'video/mp4' }
    const { ctx: execution, updates, result } = ctx({
      config: { schemaVersion: 1, outputType: kind },
      meta: { humanTaskPending: JSON.stringify({ submissionId: 'media-1', expectedRevision: 1, value: ref }) }
    })
    execution.resolveHumanTaskMedia = vi.fn(async () => media)
    expect((await humanTaskExecutor(execution)).status).toBe('done')
    expect(execution.resolveHumanTaskMedia).toHaveBeenCalledWith(kind, ref.mediaId)
    expect(projectHumanTaskOutputs({ meta: { ...updates, nodeResult: result.value } }))
      .toEqual({ [`out-${kind}`]: media })
    expect(projectHumanTaskOutputs({ meta: { ...updates, nodeResult: JSON.stringify({ ...media, mediaId: 'other' }) } }))
      .toEqual({})
  })

  it('媒体不属于当前项目时保留待处理提交并拒绝交付', async () => {
    const { ctx: execution, updates } = ctx({
      config: { schemaVersion: 1, outputType: 'video' },
      meta: { humanTaskPending: JSON.stringify({
        submissionId: 'media-1', expectedRevision: 1, value: { kind: 'video', mediaId: 'foreign' }
      }) }
    })
    execution.resolveHumanTaskMedia = async () => null
    expect((await humanTaskExecutor(execution)).status).toBe('failed')
    expect(updates).toEqual({})
  })
})


it('prevents a second writer from replacing a pending canvas submission', () => {
  const shape = {
    props: { nodeType: 'human-task', config: JSON.stringify({ schemaVersion: 1, outputType: 'text' }) },
    meta: { humanTaskPending: textPending(1, 'first', 'original') }
  }
  const second = { submissionId: 'second', expectedRevision: 1, value: { kind: 'text' as const, text: 'original' } }
  expect(admitHumanTaskSubmission(shape, second)).toMatchObject({
    ok: true, replay: true, pending: { submissionId: 'first' }
  })
  expect(admitHumanTaskSubmission(shape, { ...second, handoffNote: 'changed note' })).toEqual({
    ok: false, code: 'HUMAN_TASK_SUBMISSION_CONFLICT'
  })
  expect(admitHumanTaskSubmission(shape, { ...second, expectedRevision: 2 })).toEqual({
    ok: false, code: 'HUMAN_TASK_REVISION_CONFLICT'
  })
})
