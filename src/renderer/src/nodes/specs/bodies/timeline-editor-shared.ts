// 轨道线全屏编辑器与时间轴共用的素材类型/拖拽协议。
// 单独成文件：编辑器组件文件只导出组件，避免 react-refresh 失效。
import type { TimelineData } from '@shared/timeline'

export interface TimelineEditorAsset {
  mediaId: string
  mediaPath: string
  name: string
  kind: 'video' | 'image' | 'audio'
  durationMs?: number
}

export const TIMELINE_ASSET_DRAG_TYPE = 'application/x-canvas-timeline-asset'

/** 把拖拽负载解析成素材；非法负载返回 null。 */
export function parseTimelineAssetPayload(raw: string): TimelineEditorAsset | null {
  try {
    const value = JSON.parse(raw) as Partial<TimelineEditorAsset>
    if (
      typeof value.mediaId !== 'string' ||
      typeof value.mediaPath !== 'string' ||
      typeof value.kind !== 'string' ||
      !['video', 'image', 'audio'].includes(value.kind)
    )
      return null
    return {
      mediaId: value.mediaId,
      mediaPath: value.mediaPath,
      name: typeof value.name === 'string' && value.name ? value.name : '素材',
      kind: value.kind as TimelineEditorAsset['kind'],
      durationMs: typeof value.durationMs === 'number' ? value.durationMs : undefined
    }
  } catch {
    return null
  }
}

/** 片段在某一时刻是否覆盖播放头（画面预览用）。 */
export function clipCovers(clip: { startMs: number; durationMs: number }, nowMs: number): boolean {
  return nowMs >= clip.startMs && nowMs < clip.startMs + clip.durationMs
}

/** 供测试使用的空数据守卫：全屏编辑器在项目未就绪时不应崩溃。 */
export function editorHasClips(data: TimelineData | null | undefined): boolean {
  return Boolean(data && data.clips.length > 0)
}
