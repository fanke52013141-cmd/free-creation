import { z } from 'zod'

/**
 * 外部发布授权协议（F6 收尾）。
 *
 * 导演台是 `manual-publish` 节点：工作流与 node.execute 永远不会替用户渲染或导出，
 * 只读取"最近一次已发布且与当前工程一致"的记录。因此外部 Agent 不能借 node.execute
 * 偷渡发布，只能走这里的三段协议：
 *
 *   prepare（写入一条待授权请求，绑定项目/节点/图版本/镜头/模式）
 *     → 人类在 GUI 上看到同一条请求并明确授权或拒绝（GUI 复用同一确认弹窗，不由外部伪造）
 *     → continue（只有已授权才执行，渲染与写入正式结果复用 GUI 同一发布服务）
 *
 * 授权记录持久化在 `director_publish_requests`，唯一终态拥有者是 main；
 * 请求过期即作废，不自动续期，也不因重放而重新发布。
 */
export const PUBLISH_MODES = ['frame', 'video'] as const
export const PublishModeSchema = z.enum(PUBLISH_MODES)
export type PublishMode = (typeof PUBLISH_MODES)[number]

/** 人类授权窗口：超时后请求作废，必须重新 prepare。 */
export const PUBLISH_AUTHORIZATION_TTL_MS = 10 * 60 * 1000
/** 活跃（未授权/已授权/执行中）请求上限，避免外部堆积无法处理的发布请求。 */
export const PUBLISH_MAX_OPEN_REQUESTS = 8

export const PUBLISH_REQUEST_PREFIX = 'pub_'
export const publishRequestIdSchema = z.string().regex(/^pub_[a-zA-Z0-9_-]{6,48}$/)

export const PUBLISH_STATUSES = [
  'awaiting-authorization',
  'authorized',
  'denied',
  'expired',
  'executing',
  'completed',
  'failed'
] as const
export const PublishStatusSchema = z.enum(PUBLISH_STATUSES)
export type PublishStatus = (typeof PUBLISH_STATUSES)[number]

/** 已作废的请求不再接受 continue，但重放原回执仍是幂等的。 */
export const PUBLISH_REVOKED_STATUSES: ReadonlySet<PublishStatus> = new Set([
  'denied',
  'expired',
  'failed'
] as const)

export const PublishArtifactSchema = z
  .object({
    mediaId: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
    mediaPath: z.string().min(1).max(400),
    mime: z.enum(['image/png', 'video/webm'])
  })
  .strict()
export type PublishArtifact = z.infer<typeof PublishArtifactSchema>

/** 宿主回执里的发布结果（renderer 只回传受控媒体事实，不回传路径以外的任何内容）。 */
export const PublishHostResultSchema = z
  .object({
    mediaId: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
    mediaPath: z.string().min(1).max(400),
    mime: z.enum(['image/png', 'video/webm']),
    shotId: z.string().min(1).max(80)
  })
  .strict()
export type PublishHostResult = z.infer<typeof PublishHostResultSchema>

export function publishModeMime(mode: PublishMode): 'image/png' | 'video/webm' {
  return mode === 'frame' ? 'image/png' : 'video/webm'
}
