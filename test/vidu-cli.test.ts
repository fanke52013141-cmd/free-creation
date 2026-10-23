import { describe, expect, it } from 'vitest'
import { buildViduVideoArgs, classifyViduTask, parseViduOutput, ViduCliError } from '@shared/vidu-cli'
import { videoCapabilitiesFor, videoCapabilityIssues } from '@shared/video-capabilities'

describe('Vidu CLI task contract', () => {
  it('Q4 reference video sends image references and caps duration at 10 seconds', () => {
    const args = buildViduVideoArgs({ modelId: '3.4', mode: 'reference', prompt: 'move', duration: 10, resolution: '540p', ratio: '1:1', imagePaths: ['start.png'] })
    expect(args[args.indexOf('--type') + 1]).toBe('character2video')
    expect(args).toContain('--image=start.png')
    expect(args).toContain('--duration')
    expect(args).not.toContain('--transition')
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
    expect(() => buildViduVideoArgs({ modelId: '3.2', mode: 'first-last-frame', prompt: 'move', duration: 11, resolution: '1080p', imagePaths: ['a', 'b'] })).toThrow(ViduCliError)
    expect(() => buildViduVideoArgs({ modelId: '3.2', mode: 'first-last-frame', prompt: 'move', duration: 1, resolution: '540p', imagePaths: ['a', 'b'] })).toThrow(ViduCliError)
    expect(() => buildViduVideoArgs({ modelId: '3.4', mode: 'reference', prompt: 'move', duration: 1, resolution: '540p', imagePaths: [] })).toThrow(ViduCliError)
  })

  it('maps Q4 to reference only and Q3 to first/last only', () => {
    expect(videoCapabilitiesFor('vidu', '3.4').modes).toEqual(['reference'])
    expect(videoCapabilitiesFor('vidu', '3.4').resolutions).toEqual(['540p', '720p', '1080p', '2k', '4k'])
    expect(videoCapabilitiesFor('vidu', '3.2').modes).toEqual(['first-last-frame'])
    expect(videoCapabilitiesFor('vidu', '3.2').resolutions).toEqual(['1080p'])
    const issues = videoCapabilityIssues(videoCapabilitiesFor('vidu', '3.2'), { mode: 'first-last-frame', hasFirstFrame: true, hasLastFrame: true, imageCount: 2, params: { duration: 10, resolution: '1080p' } })
    expect(issues).toEqual([])
  })

  it('parses terminal state without logging raw upstream prompt or URLs on malformed output', () => {
    expect(classifyViduTask({ state: 'processing' }).status).toBe('running')
    expect(classifyViduTask({ state: 'success', creations: [{ nomark_uri: 'https://cdn.invalid/result.mp4' }] })).toEqual({ status: 'succeeded', url: 'https://cdn.invalid/result.mp4' })
    expect(classifyViduTask({ state: 'failed', err_msg: 'private prompt' })).toEqual({ status: 'failed', error: 'Vidu 远端生成失败，请查看任务状态' })
    expect(() => parseViduOutput('private prompt and signed url')).toThrow('无法解析')
  })
})
