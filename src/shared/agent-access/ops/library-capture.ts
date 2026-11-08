import { z } from 'zod'
import { identifier } from './common'

/**
 * 资源捕获（F7 收尾）：把项目里的素材/节点快照采集进资源库（画布 → 资源库）。
 *
 * 与 `library.resource.create` 的区别：那是"从本机文件新建资源"，这是"把项目里**已经存在**的
 * 素材或节点采集为可复用资源"。两者都复用 GUI 同一 store 服务，外部只提供受控 ID 与文案，
 * **不提供任何文件路径**（媒体由 main 按 mediaId 解析并复制入库）。
 *
 * 安全边界：节点采集必须校验节点**真实存在于该项目**，且节点上引用的 mediaId 也必须属于
 * 该项目——否则外部可以拿别的项目的 ID 伪造一份"采集"。
 */
const mediaId = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/)
const nodeId = z.string().regex(/^shape:[a-zA-Z0-9_-]{1,160}$/)
const title = z.string().trim().min(1).max(180)
const tags = z.array(z.string().trim().min(1).max(40)).max(20)

export const LIBRARY_CAPTURE_OPERATIONS = {
  'library.captureProjectMedia': {
    effect: 'write',
    description:
      '把项目里已登记的受控媒体采集为资源库资源（复制文件入库，生成来源随之迁移）；媒体必须属于该项目，外部只提供 mediaId 与可选文案，不提供路径；素材缺失/超限如实失败',
    input: z
      .object({
        projectId: identifier,
        mediaId,
        title: title.optional(),
        description: z.string().max(20_000).optional(),
        tags: tags.optional()
      })
      .strict()
  },
  'library.captureProjectNodes': {
    effect: 'write',
    description:
      '把项目中选定的画布节点快照采集为一份独立版本化资源；每个节点的 nodeId 必须真实存在于该项目、nodeType 必须与持久化数据一致、引用的 mediaId 必须属于该项目，外部不能提交伪造的节点或跨项目媒体',
    input: z
      .object({
        projectId: identifier,
        title,
        folderId: identifier.optional(),
        resourceId: identifier.optional(),
        baseRevisionId: identifier.optional(),
        changeNote: z.string().max(2000).optional(),
        nodes: z
          .array(
            z
              .object({
                nodeId,
                title: z.string().max(200),
                nodeType: z.string().min(1).max(80),
                slotId: z.string().max(80).optional(),
                text: z.string().max(20_000).optional(),
                mediaId: mediaId.optional(),
                mediaMime: z.string().max(120).optional()
              })
              .strict()
          )
          .min(1)
          .max(100)
      })
      .strict()
  }
} as const

/** 资源详情里外部只需要"创建结果"，不返回组件正文/媒体路径。 */
const capturedResourceDto = z
  .object({
    resourceId: identifier,
    revisionId: identifier,
    revisionNumber: z.number().int().nonnegative(),
    title: z.string().max(180),
    componentCount: z.number().int().nonnegative()
  })
  .strict()

export const LIBRARY_CAPTURE_OUTPUTS = {
  'library.captureProjectMedia': capturedResourceDto,
  'library.captureProjectNodes': capturedResourceDto
} as const
