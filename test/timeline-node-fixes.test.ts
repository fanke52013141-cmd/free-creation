import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TimelineData } from '@shared/timeline'
import { audioClipAtPlayhead } from '../src/renderer/src/nodes/specs/bodies/timeline-editor'

const root = resolve(__dirname, '..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

function data(patch: Partial<TimelineData> = {}): TimelineData {
  return {
    schemaVersion: 1,
    frameRate: 30,
    tracks: [{ id: 'audio-track', name: '音频 1', muted: false, locked: false, visible: true }],
    clips: [
      {
        id: 'clip-audio',
        trackId: 'audio-track',
        kind: 'audio',
        mediaId: 'audio',
        mediaPath: 'projects/a.wav',
        name: '测试音频',
        startMs: 0,
        durationMs: 1000,
        inMs: 0,
        sourceDurationMs: 1000,
        volume: 1
      }
    ],
    references: [],
    ...patch
  }
}

describe('轨道线音频预览与交互修复', () => {
  it('播放头在音频片段内时返回该片段；静音轨道不参与播放', () => {
    expect(audioClipAtPlayhead(data(), 500)?.id).toBe('clip-audio')
    expect(audioClipAtPlayhead(data(), 1500)).toBeNull()
    const muted = data({
      tracks: [{ id: 'audio-track', name: '音频 1', muted: true, locked: false, visible: true }]
    })
    expect(audioClipAtPlayhead(muted, 500)).toBeNull()
  })

  it('全屏预览渲染音频占位与 audio 元素，不再只有画面片段', () => {
    const editor = read('src/renderer/src/nodes/specs/bodies/timeline-editor.tsx')
    const css = read('src/renderer/src/nodes/specs/bodies/timeline.css')
    expect(editor).toContain('audioClipAtPlayhead')
    expect(editor).toContain('<audio ref={audioRef}')
    expect(editor).toContain('tl-preview-audio')
    expect(css).toContain('.tl-preview-audio')
  })

  it('引用素材条不再整条接管指针，避免连接后节点拖不动', () => {
    const timeline = read('src/renderer/src/nodes/specs/bodies/timeline.tsx')
    expect(timeline).not.toContain('<div className="tl-refs" data-node-pointer="control"')
    // 不再用 setEditingShape 抢占编辑态，否则 tldraw 框选/拖动会异常。
    expect(timeline).not.toContain('editor.setEditingShape(shape.id)')
    expect(timeline).toContain("window.addEventListener('keydown', onKeyDown, true)")
  })
})
