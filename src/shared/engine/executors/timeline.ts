// 时间线节点执行器（M4）
//
// 职责：校验时间线数据 → 预检本机 FFmpeg → 交给主进程合成 → 把成片登记为独立视频资产。
// 硬约束（NODE_CONTRACT_SPEC + node-invariants）：操作节点不得把运行产物写回自身
// mediaId/mediaPath，成片必须通过 emitArtifact 落成独立资产节点；本节点只写 nodeResult。
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { capabilityFailure, unavailableLocalCapability } from '../preflight'
import { runCancellableMedia } from '../media-cancel'
import { appendMediaResult, serializeMediaResultCollection } from '../values'
import {
  clipsOfTrack,
  findTrack,
  formatTimecode,
  parseTimeline,
  timelineDurationMs,
  type TimelineClip
} from '@shared/timeline'

/** 合成最长等待：超过即判失败，避免节点永久停在「执行中」。 */
const TIMELINE_COMPOSE_TIMEOUT_MS = 8 * 60 * 1000

/** 成片画布。默认 1080p；节点配置可覆盖（props.config 的 render 段）。 */
export const TIMELINE_DEFAULT_RENDER = { width: 1920, height: 1080 } as const

export interface TimelineRenderConfig {
  width: number
  height: number
}

/** 从节点 props.config 读取渲染配置；坏数据一律回落到 1080p，不让配置错误阻断运行。 */
export function readTimelineRenderConfig(config: string): TimelineRenderConfig {
  try {
    const parsed = JSON.parse(config || '{}') as { render?: { width?: unknown; height?: unknown } }
    const width = Number(parsed?.render?.width)
    const height = Number(parsed?.render?.height)
    // 只接受偶数且合理的画布尺寸：H.264 的 yuv420p 要求宽高为偶数。
    const normalize = (value: number, fallback: number): number => {
      if (!Number.isFinite(value) || value < 64 || value > 7680) return fallback
      return Math.round(value / 2) * 2
    }
    return {
      width: normalize(width, TIMELINE_DEFAULT_RENDER.width),
      height: normalize(height, TIMELINE_DEFAULT_RENDER.height)
    }
  } catch {
    return { ...TIMELINE_DEFAULT_RENDER }
  }
}

interface ComposeClipPayload {
  kind: 'video' | 'image' | 'audio'
  mediaId: string
  startMs: number
  durationMs: number
  inMs: number
  sourceDurationMs: number
  volume: number
}

function toComposePayload(clip: TimelineClip, muted: boolean): ComposeClipPayload {
  return {
    kind: clip.kind,
    mediaId: clip.mediaId,
    startMs: clip.startMs,
    durationMs: clip.durationMs,
    inMs: clip.inMs,
    sourceDurationMs: clip.sourceDurationMs,
    volume: muted ? 0 : clip.volume
  }
}

export async function timelineExecutor(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const parsed = parseTimeline(ctx.shape.props.text)
  if (!parsed.ok) return { status: 'failed', reason: parsed.reason }
  const data = parsed.data
  if (data.clips.length === 0) {
    return { status: 'skipped', reason: '时间线还没有片段，请先在卡片里添加素材' }
  }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  const capabilityReason = await unavailableLocalCapability(ctx.gateway, 'ffmpeg')
  if (capabilityReason) {
    return { status: 'failed', reason: capabilityFailure('ffmpeg', capabilityReason) }
  }
  const compose = ctx.gateway.composeTimeline
  if (!compose) {
    return { status: 'failed', reason: '当前运行环境不支持时间线合成（缺少本地媒体通道）' }
  }

  // 轨道是通用的：画面/音频由片段自己的 kind 决定去向，不由轨道类型决定。
  const videoClips: ComposeClipPayload[] = []
  const audioClips: ComposeClipPayload[] = []
  for (const track of data.tracks) {
    if (!track.visible) continue
    const muted = track.muted
    for (const clip of clipsOfTrack(data, track.id)) {
      if (!clip.mediaId) continue
      const payload = toComposePayload(clip, muted)
      if (clip.kind === 'audio') audioClips.push(payload)
      else videoClips.push(payload)
    }
  }
  const hasVisual = videoClips.some((clip) => clip.kind === 'video' || clip.kind === 'image')
  const hasAudio = audioClips.length > 0 || videoClips.some((clip) => clip.kind === 'video' && clip.volume > 0)
  if (!hasVisual) return { status: 'skipped', reason: '视频轨还没有画面片段，无法合成' }
  if (!hasAudio) {
    // 纯画面也允许：主进程会补静音轨，这里不阻断。
  }

  const render = readTimelineRenderConfig(String(ctx.shape.props.config ?? ''))
  const totalDurationMs = timelineDurationMs(data)
  // 阶段日志只记形状与数量，不记素材路径、文件名或用户正文（LOGGING_SPEC）。
  ctx.trace?.(
    'input',
    'info',
    `时间线就绪：${data.tracks.length} 轨 / ${videoClips.length + audioClips.length} 片段 / ${totalDurationMs}ms`
  )
  ctx.trace?.(
    'execution',
    'info',
    `开始合成：${render.width}x${render.height}@${data.frameRate}fps`
  )
  const firstTrackName = findTrack(data, data.tracks[0]?.id ?? '')?.name ?? ''
  const prompt = `时间线合成 · ${formatTimecode(totalDurationMs)} · ${data.tracks.length} 轨 · ${
    data.clips.length
  } 片段${firstTrackName ? ` · 起始轨 ${firstTrackName}` : ''}`

  try {
    // 安全网：主进程若在 normalize/concat 阶段卡住（2026-11-03 真机发现的一次挂起），
    // 这里必须给出可读失败，而不是让节点永远停在「执行中」。
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    const composeWithTimeout = async (): Promise<Awaited<ReturnType<typeof compose>>> => {
      try {
        return await Promise.race([
          compose({
            projectId: ctx.projectId,
            nodeId: ctx.node.id,
            width: render.width,
            height: render.height,
            frameRate: data.frameRate,
            clips: videoClips,
            audioClips
          }),
          new Promise<never>((_, reject) => {
            timeoutTimer = setTimeout(
              () => reject(new Error('合成超时：ffmpeg 长时间无进展，本次运行已终止')),
              TIMELINE_COMPOSE_TIMEOUT_MS
            )
          })
        ])
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer)
      }
    }
    const outcome = await runCancellableMedia(ctx, composeWithTimeout, (envelope) => {
        // 取消后迟到的成片属于孤儿，直接删掉，不留在项目媒体库里。
        if (envelope?.ok) void ctx.gateway.deleteMedia?.(envelope.data.id).catch(() => undefined)
      }
    )
    if (outcome.cancelled) return { status: 'skipped', reason: '已取消' }
    const result = outcome.value
    if (!result.ok) return { status: 'failed', reason: result.error.message }
    const asset = result.data
    // 成功终态由公共运行器记录；这里只补一条结果阶段，避免重复记同一终态。
    ctx.trace?.('result', 'info', '时间线成片已登记为独立视频资产')
    ctx.updateResult(
      serializeMediaResultCollection(
        appendMediaResult(
          typeof ctx.shape.meta?.nodeResult === 'string' ? ctx.shape.meta.nodeResult : '',
          { mediaId: asset.id, mediaPath: asset.path, mime: asset.mime },
          {
            nodeId: ctx.node.id,
            modelKey: 'local:ffmpeg-timeline',
            prompt,
            runId: ctx.runId
          }
        )
      )
    )
    ctx.emitArtifact?.({
      kind: 'video',
      mediaId: asset.id,
      mediaPath: asset.path,
      mime: asset.mime,
      portId: 'out-video',
      title: `（合成）时间线 ${formatTimecode(totalDurationMs)}`
    })
    return { status: 'done' }
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}
