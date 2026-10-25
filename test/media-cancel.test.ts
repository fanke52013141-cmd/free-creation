// P1-A 运行中停止：本地媒体任务取消通道的单元回归。
// 覆盖共享竞速包装、渲染器媒体执行器的取消路径与主进程作用域注册表。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCancellableMedia } from '@shared/engine/media-cancel'
import { imageCropExecutor } from '@renderer/engine/executors/imageCrop'
import { imageSplitExecutor } from '@renderer/engine/executors/imageSplit'
import { videoFrameExecutor } from '@renderer/engine/executors/videoTransforms'
import {
  cancelMediaJobs,
  isMediaCancelled,
  MEDIA_TRANSFORM_CANCELLED,
  mediaScopeKey,
  runWithMediaScope,
  trackMediaJob
} from '../src/main/media/cancellation'
import type { CancelSignal } from '@shared/engine/executor-types'

afterEach(() => vi.restoreAllMocks())

/** 可编程取消信号：与渲染器 RunControl 同语义（取消时同步触发监听器）。 */
function makeSignal(): { signal: CancelSignal; cancel: () => void } {
  const listeners: Array<() => void> = []
  const signal: CancelSignal = {
    cancelled: false,
    onCancel(listener) {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    }
  }
  return {
    signal,
    cancel: () => {
      signal.cancelled = true
      for (const listener of listeners.splice(0)) listener()
    }
  }
}

const IMAGE_INPUTS = new Map([
  [
    'in-image',
    [
      {
        type: 'image',
        value: { kind: 'image', mediaId: 'src', mediaPath: 'p', mime: 'image/png' },
        source: { nodeId: 's', portId: 'out-image', runId: 'r' },
        createdAt: 0
      }
    ]
  ]
])

const VIDEO_INPUTS = new Map([
  [
    'in-video',
    [
      {
        type: 'video',
        value: { kind: 'video', mediaId: 'src-video', mediaPath: 'v', mime: 'video/mp4' },
        source: { nodeId: 's', portId: 'out-video', runId: 'r' },
        createdAt: 0
      }
    ]
  ]
])

function baseCtx(overrides: {
  signal: CancelSignal
  gateway: Record<string, unknown>
  nodeId?: string
  config?: string
}): Record<string, unknown> {
  return {
    node: { id: overrides.nodeId ?? 'shape:media', type: 'image-crop' },
    shape: {
      id: overrides.nodeId ?? 'shape:media',
      type: 'node-card',
      props: { config: overrides.config ?? '', text: '', mediaId: '', mediaPath: '', mediaMime: '' },
      meta: {}
    },
    projectId: 'project-a',
    runId: 'cancel-run',
    providers: [],
    signal: overrides.signal,
    gateway: overrides.gateway,
    updateProps: () => undefined,
    updateResult: () => undefined
  }
}

describe('runCancellableMedia', () => {
  it('未取消时等价于直接 await，不触发取消请求', async () => {
    const cancelMediaTransforms = vi.fn(async () => ({ ok: true, data: { cancelled: 0 } }))
    const outcome = await runCancellableMedia(
      {
        signal: makeSignal().signal,
        node: { id: 'shape:a' } as never,
        projectId: 'project-a',
        gateway: { cancelMediaTransforms }
      },
      async () => 'value'
    )
    expect(outcome).toEqual({ cancelled: false, value: 'value' })
    expect(cancelMediaTransforms).not.toHaveBeenCalled()
  })

  it('取消发生在 IPC 进行中：立即返回已取消并请求主进程终止该节点作业', async () => {
    const { signal, cancel } = makeSignal()
    const cancelMediaTransforms = vi.fn(async () => ({ ok: true, data: { cancelled: 1 } }))
    let resolveCall: (value: string) => void = () => undefined
    const pending = runCancellableMedia(
      {
        signal,
        node: { id: 'shape:clip' } as never,
        projectId: 'project-a',
        gateway: { cancelMediaTransforms }
      },
      () =>
        new Promise<string>((resolve) => {
          resolveCall = resolve
        })
    )
    cancel()
    expect(await pending).toEqual({ cancelled: true })
    expect(cancelMediaTransforms).toHaveBeenCalledWith({
      projectId: 'project-a',
      nodeId: 'shape:clip'
    })
    // 迟到完成不产生未处理拒绝；信封不再暴露给执行器。
    resolveCall('late')
    await new Promise((done) => setTimeout(done, 0))
  })

  it('取消后主进程仍成功返回的迟到信封交给 onLateArtifact 清理', async () => {
    const { signal, cancel } = makeSignal()
    const cancelMediaTransforms = vi.fn(async () => ({ ok: true, data: { cancelled: 1 } }))
    let resolveCall: (value: { ok: boolean; data: { id: string } }) => void = () => undefined
    const onLateArtifact = vi.fn()
    const pending = runCancellableMedia(
      {
        signal,
        node: { id: 'shape:crop' } as never,
        projectId: 'project-a',
        gateway: { cancelMediaTransforms }
      },
      () =>
        new Promise<{ ok: boolean; data: { id: string } }>((resolve) => {
          resolveCall = resolve
        }),
      onLateArtifact
    )
    cancel()
    expect(await pending).toEqual({ cancelled: true })
    resolveCall({ ok: true, data: { id: 'late-asset' } })
    await vi.waitFor(() => {
      expect(onLateArtifact).toHaveBeenCalledWith({ ok: true, data: { id: 'late-asset' } })
    })
  })

  it('signal 不支持 onCancel 时保持旧行为：返回后按 signal.cancelled 丢弃结果', async () => {
    const signal: CancelSignal = { cancelled: false }
    const cancelMediaTransforms = vi.fn(async () => ({ ok: true, data: { cancelled: 0 } }))
    const outcome = await runCancellableMedia(
      {
        signal,
        node: { id: 'shape:a' } as never,
        projectId: 'project-a',
        gateway: { cancelMediaTransforms }
      },
      async () => {
        signal.cancelled = true
        return 'late-value'
      }
    )
    expect(outcome).toEqual({ cancelled: true })
    expect(cancelMediaTransforms).not.toHaveBeenCalled()
  })

  it('进入时已取消则不再发起调用', async () => {
    const { signal, cancel } = makeSignal()
    cancel()
    const call = vi.fn(async () => 'value')
    const outcome = await runCancellableMedia(
      {
        signal,
        node: { id: 'shape:a' } as never,
        projectId: 'project-a',
        gateway: {}
      },
      call
    )
    expect(outcome).toEqual({ cancelled: true })
    expect(call).not.toHaveBeenCalled()
  })

  it('非取消失败原样抛出，不触发终止请求', async () => {
    const { signal } = makeSignal()
    const cancelMediaTransforms = vi.fn(async () => ({ ok: true, data: { cancelled: 0 } }))
    await expect(
      runCancellableMedia(
        {
          signal,
          node: { id: 'shape:a' } as never,
          projectId: 'project-a',
          gateway: { cancelMediaTransforms }
        },
        async () => {
          throw new Error('FFmpeg 退出码 1')
        }
      )
    ).rejects.toThrow('FFmpeg 退出码 1')
    expect(cancelMediaTransforms).not.toHaveBeenCalled()
  })
})

describe('媒体执行器取消路径', () => {
  it('imageCropExecutor：停止后返回已取消，迟到资产被删除，不写入结果', async () => {
    const { signal, cancel } = makeSignal()
    const cancelMediaTransforms = vi.fn(async () => ({ ok: true, data: { cancelled: 1 } }))
    const deleteMedia = vi.fn(async () => ({ ok: true, data: true }))
    let resolveCall: (value: unknown) => void = () => undefined
    const updateResult = vi.fn()
    const ctx = baseCtx({
      signal,
      gateway: {
        cancelMediaTransforms,
        deleteMedia,
        cropImage: () =>
          new Promise((resolve) => {
            resolveCall = resolve
          })
      }
    })
    const call = imageCropExecutor({ ...ctx, inputs: IMAGE_INPUTS, updateResult } as never)
    cancel()
    expect(await call).toEqual({ status: 'skipped', reason: '已取消' })
    expect(cancelMediaTransforms).toHaveBeenCalled()
    resolveCall({
      ok: true,
      data: {
        id: 'late-crop',
        path: 'p',
        mime: 'image/png',
        kind: 'image',
        sizeBytes: 1,
        createdAt: 1
      }
    })
    await vi.waitFor(() => {
      expect(deleteMedia).toHaveBeenCalledWith('late-crop')
    })
    expect(updateResult).not.toHaveBeenCalled()
  })

  it('imageSplitExecutor：停止后返回已取消，迟到整包资产逐个删除', async () => {
    const { signal, cancel } = makeSignal()
    const cancelMediaTransforms = vi.fn(async () => ({ ok: true, data: { cancelled: 1 } }))
    const deleteMedia = vi.fn(async () => ({ ok: true, data: true }))
    let resolveCall: (value: unknown) => void = () => undefined
    const updateResult = vi.fn()
    const ctx = baseCtx({
      signal,
      gateway: {
        cancelMediaTransforms,
        deleteMedia,
        splitImageGrid: () =>
          new Promise((resolve) => {
            resolveCall = resolve
          })
      },
      nodeId: 'shape:split'
    })
    const call = imageSplitExecutor({ ...ctx, inputs: IMAGE_INPUTS, updateResult } as never)
    cancel()
    expect(await call).toEqual({ status: 'skipped', reason: '已取消' })
    expect(cancelMediaTransforms).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'shape:split' })
    )
    resolveCall({
      ok: true,
      data: [
        { id: 'late-1', path: 'p1', mime: 'image/png' },
        { id: 'late-2', path: 'p2', mime: 'image/png' }
      ]
    })
    await vi.waitFor(() => {
      expect(deleteMedia).toHaveBeenCalledWith('late-1')
      expect(deleteMedia).toHaveBeenCalledWith('late-2')
    })
    expect(updateResult).not.toHaveBeenCalled()
  })

  it('videoFrameExecutor：停止后返回已取消并请求主进程终止 ffmpeg', async () => {
    const { signal, cancel } = makeSignal()
    const cancelMediaTransforms = vi.fn(async () => ({ ok: true, data: { cancelled: 1 } }))
    const deleteMedia = vi.fn(async () => ({ ok: true, data: true }))
    let releaseCapability: (() => void) | null = null
    const ctx = baseCtx({
      signal,
      gateway: {
        cancelMediaTransforms,
        deleteMedia,
        extractVideoFrame: () => new Promise(() => undefined),
        getLocalMediaCapabilities: () =>
          new Promise((resolve) => {
            releaseCapability = () =>
              resolve({
                ok: true as const,
                data: {
                  ffmpeg: { available: true, message: 'ok' },
                  ffprobe: { available: true, message: 'ok' },
                  audioSeparator: { available: false, message: 'missing' }
                }
              })
          })
      }
    })
    const call = videoFrameExecutor({ ...ctx, inputs: VIDEO_INPUTS } as never)
    // 等执行器通过能力探测并进入媒体调用（取消监听器已注册），再停止。
    await new Promise((done) => setTimeout(done, 0))
    releaseCapability?.()
    await new Promise((done) => setTimeout(done, 0))
    cancel()
    await expect(call).resolves.toEqual({ status: 'skipped', reason: '已取消' })
    expect(cancelMediaTransforms).toHaveBeenCalled()
    expect(deleteMedia).not.toHaveBeenCalled()
  })

  it('videoFrameExecutor：主进程返回稳定取消码时按已取消处理', async () => {
    const { signal } = makeSignal()
    const cancelMediaTransforms = vi.fn(async () => ({ ok: true, data: { cancelled: 1 } }))
    const ctx = baseCtx({
      signal,
      gateway: {
        cancelMediaTransforms,
        extractVideoFrame: async () => ({
          ok: false as const,
          error: { code: MEDIA_TRANSFORM_CANCELLED, message: '本地媒体任务已停止' }
        }),
        getLocalMediaCapabilities: async () => ({
          ok: true as const,
          data: {
            ffmpeg: { available: true, message: 'ok' },
            ffprobe: { available: true, message: 'ok' },
            audioSeparator: { available: false, message: 'missing' }
          }
        })
      }
    })
    // 停止信号已经置位（停止回调先到，IPC 稍后返回稳定取消码）。
    signal.cancelled = true
    await expect(videoFrameExecutor({ ...ctx, inputs: VIDEO_INPUTS } as never)).resolves.toEqual({
      status: 'skipped',
      reason: '已取消'
    })
  })
})

describe('主进程媒体作业作用域', () => {
  it('mediaScopeKey 缺少项目或节点时不产生可取消作用域', () => {
    expect(mediaScopeKey('p', 'n')).toBe('p/n')
    expect(mediaScopeKey('p', undefined)).toBeNull()
    expect(mediaScopeKey(undefined, 'n')).toBeNull()
  })

  it('作用域内注册的终止句柄在取消时触发，且只触发一次', async () => {
    const key = mediaScopeKey('project-a', 'shape:kill')
    expect(key).toBeTruthy()
    const kill = vi.fn()
    let release: (() => void) | null = null
    const pending = runWithMediaScope(key, async () => {
      const untrack = trackMediaJob(kill)
      expect(isMediaCancelled()).toBe(false)
      await new Promise<void>((resolve) => {
        release = resolve
      })
      untrack()
      return 'done'
    })
    await vi.waitFor(() => expect(kill).not.toHaveBeenCalled())
    expect(cancelMediaJobs(key)).toBe(1)
    release?.()
    await expect(pending).resolves.toBe('done')
    // 作业结束后再次取消：没有存活的作业可终止。
    expect(cancelMediaJobs(key)).toBe(0)
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('作用域外 trackMediaJob/isMediaCancelled 是无操作，取消不误伤其他节点', async () => {
    expect(trackMediaJob(() => undefined)).toBeTypeOf('function')
    expect(isMediaCancelled()).toBe(false)
    expect(cancelMediaJobs(mediaScopeKey('project-a', 'shape:unknown'))).toBe(0)
    await expect(runWithMediaScope(null, async () => 'legacy')).resolves.toBe('legacy')
  })
})
