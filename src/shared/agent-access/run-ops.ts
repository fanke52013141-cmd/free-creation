import { z } from 'zod'
import type { ProjectFile } from '../types'

// F3 执行与结果公共契约：node.execute / run.get / run.wait / run.cancel / output.get。
// 任务事实唯一拥有者是 main 的 external_runs 账本；运行细节由权威宿主（renderer 引擎）
// 以正式报告回填。外部客户端不能伪造 running/success。

export const NODE_EXECUTE_MAX_NODES = 50
export const RUN_WAIT_MAX_TIMEOUT_MS = 120_000

export const EXTERNAL_RUN_STATES = [
  'accepted',
  'running',
  'cancel-requested',
  'completed',
  'failed',
  'cancelled'
] as const

export const nodeRunTaskDto = z
  .object({
    taskId: z.string(),
    projectId: z.string(),
    source: z.literal('node-run'),
    state: z.enum(EXTERNAL_RUN_STATES),
    mode: z.enum(['single', 'subgraph']),
    nodeIds: z.array(z.string()).min(1).max(NODE_EXECUTE_MAX_NODES),
    cancelRequested: z.boolean(),
    error: z.string().max(500).nullable(),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
    /** 任务的宿主是否仍然驻留（非打开项目上的在途任务只能视为状态未知）。 */
    hostResident: z.boolean()
  })
  .strict()

export const outputValueDto = z
  .object({
    portId: z.string().max(100),
    kind: z.enum([
      'text',
      'markdown',
      'json',
      'media',
      'image',
      'video',
      'audio',
      'camera',
      'file',
      'any',
      'iteration'
    ]),
    /** 文本/JSON 值摘录；JSON 按 schema 校验后的原始值输出（有界）。 */
    text: z.string().max(20_000).optional(),
    json: z.unknown().optional(),
    mediaId: z.string().max(160).optional(),
    mediaPath: z.string().max(500).optional(),
    mime: z.string().max(120).optional()
  })
  .strict()

/** main 侧输出投影：持久化节点 + 快照 meta → 共享确定性投影。仅覆盖已登记类型。 */
export const DETERMINISTIC_OUTPUT_SOURCES: Record<string, 'document' | 'run' | 'manual-publish'> = {
  text: 'document',
  json: 'document',
  processor: 'run',
  image: 'run',
  'image-gen': 'run',
  'image-edit': 'run',
  'image-crop': 'run',
  'image-split': 'run',
  'video-frame': 'run',
  'video-clip': 'run',
  'sound-adjust': 'run',
  'video-depth': 'run',
  'video-clay': 'run',
  website: 'document',
  code: 'run',
  structured: 'run',
  storyboard: 'document',
  iterate: 'run',
  director: 'manual-publish',
  'ai-process': 'run',
  audio: 'run',
  speech: 'run',
  tts: 'run',
  video: 'run',
  'video-asset': 'run',
  timeline: 'run',
  agent: 'run',
  'ai-review': 'run'
}

export function readSnapshotShapeMeta(
  file: ProjectFile,
  nodeId: string
): Record<string, unknown> | null {
  const snapshot = file.tldrawSnapshot as { store?: unknown } | undefined
  if (!snapshot || typeof snapshot.store !== 'object' || snapshot.store === null) return null
  const record = (snapshot.store as Record<string, unknown>)[
    nodeId.startsWith('shape:') ? nodeId : `shape:${nodeId}`
  ]
  if (!record || typeof record !== 'object') return null
  const candidate = record as { type?: unknown; meta?: unknown }
  if (candidate.type !== 'node-card') return null
  return candidate.meta && typeof candidate.meta === 'object'
    ? (candidate.meta as Record<string, unknown>)
    : {}
}

export interface ProjectionShape {
  props: Record<string, unknown>
  meta: Record<string, unknown>
}

/** 从持久化数据组装投影所需的最小 shape 视图（props 来自图数据，meta 来自快照）。 */
export function buildProjectionShape(file: ProjectFile, nodeId: string): ProjectionShape | null {
  const node = file.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return null
  const meta = readSnapshotShapeMeta(file, nodeId) ?? {}
  const config = node.params.config
  return {
    props: {
      nodeType: node.type,
      title: node.title,
      config: typeof config === 'string' ? config : '',
      text: node.content.kind === 'text' ? node.content.text : '',
      mediaId: node.content.kind === 'media' ? node.content.mediaId : '',
      mediaPath: typeof node.params.mediaPath === 'string' ? node.params.mediaPath : '',
      mediaMime: typeof node.params.mediaMime === 'string' ? node.params.mediaMime : '',
      exec: node.exec?.status ?? 'idle'
    },
    meta
  }
}

/** Values supplied for this run only. Media references always belong to the active project. */
export const WorkflowInputSchema = z.object({
  nodeId: z.string().min(1).max(180),
  portId: z.string().min(1).max(100),
  value: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), text: z.string().trim().min(1).max(100000) }).strict(),
    z.object({ kind: z.literal('markdown'), text: z.string().trim().min(1).max(100000) }).strict(),
    z.object({ kind: z.literal('json'), data: z.unknown().refine((value) => value !== undefined) }).strict(),
    z.object({ kind: z.literal('media'), mediaId: z.string().min(1).max(180) }).strict()
  ])
}).strict()

export const WorkflowInputsSchema = z.array(WorkflowInputSchema).max(64).superRefine((inputs, ctx) => {
  const keys = new Set<string>()
  for (const [index, input] of inputs.entries()) {
    const key = JSON.stringify([input.nodeId, input.portId])
    if (keys.has(key)) ctx.addIssue({ code: 'custom', path: [index], message: '输入端口重复' })
    keys.add(key)
  }
})
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>
