import { describe, expect, it } from 'vitest'
import { buildViduVideoArgs, classifyViduTask, parseViduOutput, ViduCliError } from '@shared/vidu-cli'
import { videoCapabilitiesFor, videoCapabilityIssues } from '@shared/video-capabilities'

describe('Vidu CLI task contract', () => {
  it('Q4 reference video sends image references and supports 1–16 second durations', () => {
    const args = buildViduVideoArgs({ modelId: '3.4', mode: 'reference', prompt: 'move', duration: 16, resolution: '540p', ratio: '1:1', imagePaths: ['start.png'] })
    expect(args[args.indexOf('--type') + 1]).toBe('character2video')
    expect(args).toContain('--image=start.png')
    expect(args).toContain('--duration')
    // 2026-11-09 用户报障：Q4 传 transition 会被 CLI 拒绝
    // （"Q4 should not include transition"，client_error，任务不会创建）。
    expect(args).not.toContain('--transition')
  })

  it('Q3 first frame uses img2video, one ordered image and required transition', () => {
    const args = buildViduVideoArgs({ modelId: '3.2', mode: 'first-frame', prompt: 'move', duration: 4, resolution: '1080p', imagePaths: ['first.png'] })
    expect(args[args.indexOf('--type') + 1]).toBe('img2video')
    expect(args).toContain('--image=first.png')
    expect(args).toContain('--transition')
    expect(args).not.toContain('--aspect-ratio')
  })

  it('Q3 text to video has no images and keeps the requested aspect ratio', () => {
    const args = buildViduVideoArgs({ modelId: '3.2', mode: 'text', prompt: 'a cat', duration: 8, resolution: '1080p', ratio: '9:16', imagePaths: [] })
    expect(args[args.indexOf('--type') + 1]).toBe('text2video')
    expect(args).toContain('--aspect-ratio')
    expect(args).not.toContain('--transition')
    expect(args.some((arg) => arg.startsWith('--image='))).toBe(false)
  })

  it('Q3 first/last frame uses ordered images, Q3 model and required transition', () => {
    const args = buildViduVideoArgs({ modelId: '3.2', mode: 'first-last-frame', prompt: 'move', duration: 1, resolution: '1080p', imagePaths: ['first.png', 'last.png'] })
    expect(args[args.indexOf('--type') + 1]).toBe('headtailimg2video')
    expect(args.indexOf('--image=first.png')).toBeLessThan(args.indexOf('--image=last.png'))
    expect(args).toContain('--transition')
    expect(args).toContain('pro')
    expect(args).not.toContain('--aspect-ratio')
  })

  it('rejects mode/model substitution and invalid resolutions, duration, and reference counts', () => {
    expect(() => buildViduVideoArgs({ modelId: '3.4', mode: 'first-last-frame', prompt: 'move', duration: 1, resolution: '1080p', imagePaths: ['a', 'b'] })).toThrow(ViduCliError)
    expect(() => buildViduVideoArgs({ modelId: '3.2', mode: 'first-last-frame', prompt: 'move', duration: 17, resolution: '1080p', imagePaths: ['a', 'b'] })).toThrow(ViduCliError)
    expect(() => buildViduVideoArgs({ modelId: '3.2', mode: 'first-last-frame', prompt: 'move', duration: 1, resolution: '540p', imagePaths: ['a', 'b'] })).toThrow(ViduCliError)
    expect(() => buildViduVideoArgs({ modelId: '3.4', mode: 'reference', prompt: 'move', duration: 1, resolution: '540p', imagePaths: [] })).toThrow(ViduCliError)
    expect(() => buildViduVideoArgs({ modelId: '3.2', mode: 'first-frame', prompt: 'move', duration: 1, resolution: '1080p', imagePaths: ['a', 'b'] })).toThrow(ViduCliError)
    expect(() => buildViduVideoArgs({ modelId: '3.2', mode: 'text', prompt: 'move', duration: 1, resolution: '1080p', imagePaths: ['a'] })).toThrow(ViduCliError)
  })

  it('maps Q4 to reference only and Q3 to text/first/last/reference', () => {
    expect(videoCapabilitiesFor('vidu', '3.4').modes).toEqual(['reference'])
    expect(videoCapabilitiesFor('vidu', '3.4').resolutions).toEqual(['540p', '720p', '1080p', '2k', '4k'])
    expect(videoCapabilitiesFor('vidu', '3.2').modes).toEqual(['text', 'first-frame', 'first-last-frame', 'reference'])
    expect(videoCapabilitiesFor('vidu', '3.2').resolutions).toEqual(['1080p'])
    const issues = videoCapabilityIssues(videoCapabilitiesFor('vidu', '3.2'), { mode: 'first-last-frame', hasFirstFrame: true, hasLastFrame: true, imageCount: 2, params: { duration: 16, resolution: '1080p' } })
    expect(issues).toEqual([])
  })

  it('parses terminal state without logging raw upstream prompt or URLs on malformed output', () => {
    expect(classifyViduTask({ state: 'processing' }).status).toBe('running')
    expect(classifyViduTask({ state: 'success', creations: [{ nomark_uri: 'https://cdn.invalid/result.mp4' }] })).toEqual({ status: 'succeeded', url: 'https://cdn.invalid/result.mp4' })
    expect(classifyViduTask({ state: 'failed', err_msg: 'private prompt' })).toEqual({ status: 'failed', error: 'Vidu 远端生成失败，请查看任务状态' })
    expect(() => parseViduOutput('private prompt and signed url')).toThrow('无法解析')
  })

  it('treats unrecognized or missing in-flight states as still running, never terminal unknown', () => {
    // Vidu Q4 实测：任务刚提交时 state 可能是文档之外的值甚至缺省；
    // 误判成 unknown 会终止轮询，远端成功后本地取不回结果。
    expect(classifyViduTask({ state: 'generating' }).status).toBe('running')
    expect(classifyViduTask({}).status).toBe('running')
    expect(classifyViduTask({ task_id: 'x', ok: true }).status).toBe('running')
  })
})
