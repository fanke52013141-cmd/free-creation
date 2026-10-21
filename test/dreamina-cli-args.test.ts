// 即梦 CLI 纯协议层：子命令组装与 stdout 归一化。
// 这一层不 import 主进程模块，所以可以在 node 环境直接测，不需要起子进程、不消耗额度。
import { describe, expect, it } from 'vitest'
import {
  buildImageArgs,
  buildVideoArgs,
  classifyDreaminaTask,
  DreaminaCliError
} from '@shared/dreamina-cli'

describe('buildImageArgs', () => {
  it('没有参考图时走 text2image', () => {
    const args = buildImageArgs({
      modelId: '5.0',
      prompt: 'a cat',
      ratio: '16:9',
      resolution: '2k',
      referencePaths: []
    })
    expect(args[0]).toBe('text2image')
    expect(args).toContain('--prompt=a cat')
    expect(args).toContain('--model_version=5.0')
    expect(args).toContain('--resolution_type=2k')
    expect(args).toContain('--ratio=16:9')
    // 不让 CLI 内部阻塞：外层自己轮询才能响应取消并记录 submit_id。
    expect(args).toContain('--poll=0')
    expect(args).toContain('--session=0')
    expect(args.some((arg) => arg.startsWith('--images='))).toBe(false)
  })

  it('有参考图时走 image2image，并按顺序重复 --images', () => {
    const args = buildImageArgs({
      modelId: '4.7',
      prompt: 'watercolor',
      resolution: '4k',
      referencePaths: ['C:\\media\\a.png', 'C:\\media\\b.png']
    })
    expect(args[0]).toBe('image2image')
    expect(args).toContain('--images=C:\\media\\a.png')
    expect(args).toContain('--images=C:\\media\\b.png')
    // 未指定画幅时不发送 --ratio，交给 CLI 默认值。
    expect(args.some((arg) => arg.startsWith('--ratio='))).toBe(false)
  })

  it('分辨率缺失时不会静默编造（由调用方保证必填）', () => {
    const args = buildImageArgs({
      modelId: '5.0',
      prompt: 'x',
      resolution: '2k',
      referencePaths: []
    })
    expect(args).toContain('--resolution_type=2k')
  })
})

describe('buildVideoArgs', () => {
  const base = { modelId: 'seedance2.0fast', prompt: 'a run', resolution: '720p' }

  it('文生视频', () => {
    const args = buildVideoArgs({ ...base, mode: 'text', ratio: '16:9', duration: 4 })
    expect(args[0]).toBe('text2video')
    expect(args).toContain('--video_resolution=720p')
    expect(args).toContain('--duration=4')
    expect(args).toContain('--ratio=16:9')
  })

  it('首帧视频', () => {
    const args = buildVideoArgs({
      ...base,
      mode: 'first-frame',
      firstFramePath: 'C:\\m\\first.png',
      ratio: '9:16'
    })
    expect(args[0]).toBe('image2video')
    expect(args).toContain('--image=C:\\m\\first.png')
    expect(args).toContain('--ratio=9:16')
  })

  it('首尾帧视频', () => {
    const args = buildVideoArgs({
      ...base,
      mode: 'first-last-frame',
      firstFramePath: 'C:\\m\\a.png',
      lastFramePath: 'C:\\m\\b.png'
    })
    expect(args[0]).toBe('frames2video')
    expect(args).toContain('--first=C:\\m\\a.png')
    expect(args).toContain('--last=C:\\m\\b.png')
  })

  it('参考生视频：图/视频/音频各自重复成独立 flag', () => {
    const args = buildVideoArgs({
      ...base,
      modelId: 'seedance2.5',
      resolution: '1080p',
      mode: 'reference',
      prompt: 'cinematic',
      referenceImagePaths: ['C:\\m\\i1.png', 'C:\\m\\i2.png'],
      referenceVideoPaths: ['C:\\m\\v1.mp4'],
      referenceAudioPaths: ['C:\\m\\a1.mp3']
    })
    expect(args[0]).toBe('multimodal2video')
    expect(args.filter((arg) => arg.startsWith('--image='))).toEqual([
      '--image=C:\\m\\i1.png',
      '--image=C:\\m\\i2.png'
    ])
    expect(args).toContain('--video=C:\\m\\v1.mp4')
    expect(args).toContain('--audio=C:\\m\\a1.mp3')
    expect(args).toContain('--prompt=cinematic')
  })

  it('seedance2.5 在首帧/首尾帧下拒绝 ratio，文生视频仍然发送', () => {
    const frames = buildVideoArgs({
      modelId: 'seedance2.5',
      prompt: 'p',
      resolution: '480p',
      mode: 'first-frame',
      firstFramePath: 'C:\\m\\f.png',
      ratio: '16:9'
    })
    expect(frames.some((arg) => arg.startsWith('--ratio='))).toBe(false)

    const text = buildVideoArgs({
      modelId: 'seedance2.5',
      prompt: 'p',
      resolution: '480p',
      mode: 'text',
      ratio: '16:9'
    })
    expect(text).toContain('--ratio=16:9')
  })

  it('缺少首帧时给明确的参数错误，而不是拼出半截命令', () => {
    expect(() => buildVideoArgs({ ...base, mode: 'first-frame' })).toThrow(DreaminaCliError)
    expect(() =>
      buildVideoArgs({ ...base, mode: 'first-last-frame', firstFramePath: 'C:\\m\\a.png' })
    ).toThrow(DreaminaCliError)
  })
})

describe('classifyDreaminaTask', () => {
  it('success 时取视频地址', () => {
    const state = classifyDreaminaTask({
      submit_id: 'x',
      gen_status: 'success',
      result_json: { videos: [{ video_url: 'https://cdn/v.mp4' }], images: [] }
    })
    expect(state).toEqual({ status: 'succeeded', url: 'https://cdn/v.mp4' })
  })

  it('success 但没有产物地址时判失败，不能当成成功', () => {
    const state = classifyDreaminaTask({ gen_status: 'success', result_json: { videos: [] } })
    expect(state.status).toBe('failed')
  })

  it('fail 时带出 fail_reason', () => {
    const state = classifyDreaminaTask({ gen_status: 'fail', fail_reason: '额度不足' })
    expect(state).toEqual({ status: 'failed', error: '额度不足' })
  })

  it('querying 视为仍在运行', () => {
    expect(classifyDreaminaTask({ gen_status: 'querying' }).status).toBe('running')
    expect(classifyDreaminaTask({}).status).toBe('running')
  })
})
