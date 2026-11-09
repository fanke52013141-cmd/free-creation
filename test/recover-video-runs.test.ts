// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor, TLShapeId } from 'tldraw'
import { recoverRunningNodes } from '../src/renderer/src/engine/recoverVideoRuns'

vi.mock('../src/renderer/src/stores/toast', () => ({
  toast: vi.fn(),
  useToastStore: { getState: () => ({ show: vi.fn() }) }
}))

interface FakeShape {
  id: TLShapeId
  type: 'node-card'
  props: { exec: string; nodeType?: string; title: string; text: string; config: string }
  meta: Record<string, unknown>
}

function fakeEditor(shapes: FakeShape[]): Editor {
  const byId = new Map(shapes.map((shape) => [String(shape.id), shape]))
  return {
    getCurrentPageShapes: () => shapes,
    getShape: (id: string) => byId.get(String(id)),
    updateShape: (patch: { id: string; props?: Record<string, unknown>; meta?: Record<string, unknown> }) => {
      const shape = byId.get(String(patch.id))
      if (!shape) return
      if (patch.props) Object.assign(shape.props, patch.props)
      if (patch.meta) shape.meta = { ...shape.meta, ...patch.meta }
    }
  } as unknown as Editor
}

function runningShape(taskId?: string): FakeShape {
  return {
    id: 'shape:video' as TLShapeId,
    type: 'node-card',
    props: {
      exec: 'running',
      nodeType: 'video',
      title: '视频生成',
      text: '一只猫',
      config: JSON.stringify({ modelKey: 'model', params: {}, ...(taskId ? { taskId } : {}) })
    },
    meta: {
      nodeRun: {
        runId: 'run-1',
        status: 'running',
        startedAt: Date.now() - 60_000,
        inputs: {}
      }
    }
  }
}

describe('recoverRunningNodes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('有持久化 taskId 时接回后台任务，成功后写回结果与运行记录', async () => {
    const shape = runningShape('task-1')
    const editor = fakeEditor([shape])
    const videoTask = vi.fn(async () => ({
      ok: true,
      data: { id: 'task-1', status: 'success', mediaId: 'media-1', mediaPath: 'projects/a.mp4' }
    }))
    ;(window as unknown as { api: unknown }).api = { gateway: { videoTask } }

    const stop = recoverRunningNodes(editor, 'project-1')
    await vi.advanceTimersByTimeAsync(3_100)
    stop()

    expect(videoTask).toHaveBeenCalledWith('task-1')
    expect(shape.props.exec).toBe('success')
    expect(String(shape.meta.nodeResult)).toContain('media-1')
    expect((shape.meta.nodeRun as { status: string }).status).toBe('success')
  })

  it('优先使用 meta.videoTaskId（新写入路径）接回后台任务', async () => {
    const shape = runningShape('legacy-task')
    shape.meta.videoTaskId = 'meta-task'
    const editor = fakeEditor([shape])
    const videoTask = vi.fn(async () => ({
      ok: true,
      data: { id: 'meta-task', status: 'success', mediaId: 'media-2', mediaPath: 'projects/b.mp4' }
    }))
    ;(window as unknown as { api: unknown }).api = { gateway: { videoTask } }

    const stop = recoverRunningNodes(editor, 'project-1')
    await vi.advanceTimersByTimeAsync(3_100)
    stop()

    expect(videoTask).toHaveBeenCalledWith('meta-task')
    expect(shape.props.exec).toBe('success')
  })

  it('没有任务号的 running 节点仍按中断标记为 cancelled', () => {
    const shape = runningShape()
    const editor = fakeEditor([shape])
    ;(window as unknown as { api: unknown }).api = { gateway: { videoTask: vi.fn() } }

    recoverRunningNodes(editor, 'project-1')()

    expect(shape.props.exec).toBe('cancelled')
    expect((shape.meta.nodeRun as { status: string; error?: { reason: string } }).status).toBe(
      'cancelled'
    )
    expect((shape.meta.nodeRun as { error?: { reason: string } }).error?.reason).toContain(
      '未找到可恢复的任务号'
    )
  })
})
