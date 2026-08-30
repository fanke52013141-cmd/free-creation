import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  separatorFiles: [] as string[],
  saved: 0,
  saveFailureAt: 0
}))

const spawn = vi.hoisted(() =>
  vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => child.emit('close', 0))
    return child
  })
)
const saveFileAsset = vi.hoisted(() => vi.fn())
const deleteMedia = vi.hoisted(() => vi.fn(async () => true))

vi.mock('child_process', () => ({ spawn }))
vi.mock('fs/promises', () => ({
  mkdtemp: vi.fn(async () => '/tmp/canvas-video-test'),
  readFile: vi.fn(),
  readdir: vi.fn(async () => state.separatorFiles),
  rm: vi.fn(async () => undefined),
  stat: vi.fn(async () => ({ isFile: () => true }))
}))
vi.mock('../src/main/store/db', () => ({
  getDb: () => ({
    prepare: () => ({
      get: () => ({ path: 'projects/project-a/media/source.wav', mime: 'audio/wav', kind: 'audio' })
    })
  })
}))
vi.mock('../src/main/store/media.repo', () => ({
  deleteMedia,
  getMediaAbsPath: (path: string) => `/data/${path}`,
  saveFileAsset: (...args: unknown[]) => {
    state.saved += 1
    if (state.saveFailureAt === state.saved) return Promise.reject(new Error('disk full'))
    const name = String(args[3])
    const id = state.saved === 1 ? 'vocal-asset' : 'backing-asset'
    return Promise.resolve({
      id,
      kind: 'audio',
      mime: 'audio/wav',
      path: `projects/project-a/media/${id}.wav`,
      sizeBytes: 8,
      createdAt: 1,
      name
    })
  }
}))

import { separateVocals } from '../src/main/media/video-transform'

afterEach(() => {
  state.separatorFiles = []
  state.saved = 0
  state.saveFailureAt = 0
  spawn.mockClear()
  saveFileAsset.mockClear()
  deleteMedia.mockClear()
})

describe('主进程人声分离媒体回归', () => {
  it('快速模式即使请求伴奏也只产生增强人声，绝不把原始音频伪装为伴奏', async () => {
    const result = await separateVocals({
      projectId: 'project-a',
      sourceMediaId: 'source-audio',
      config: { version: 1, mode: 'fast', outputAccompaniment: true }
    })

    expect(result.vocals.id).toBe('vocal-asset')
    expect(result.accompaniment).toBeUndefined()
    expect(state.saved).toBe(1)
  })

  it('高质量模式请求伴奏但模型未返回伴奏时失败，且不写入半套媒体', async () => {
    state.separatorFiles = ['source_(Vocals).wav']

    await expect(
      separateVocals({
        projectId: 'project-a',
        sourceMediaId: 'source-audio',
        config: { version: 1, mode: 'quality', outputAccompaniment: true }
      })
    ).rejects.toThrow('没有返回伴奏轨')

    expect(state.saved).toBe(0)
    expect(deleteMedia).not.toHaveBeenCalled()
  })

  it('保存第二条轨道失败时回收已登记的人声音频', async () => {
    state.separatorFiles = ['source_(Vocals).wav', 'source_(Instrumental).wav']
    state.saveFailureAt = 2

    await expect(
      separateVocals({
        projectId: 'project-a',
        sourceMediaId: 'source-audio',
        config: { version: 1, mode: 'quality', outputAccompaniment: true }
      })
    ).rejects.toThrow('disk full')

    expect(deleteMedia).toHaveBeenCalledWith('vocal-asset')
  })
})
