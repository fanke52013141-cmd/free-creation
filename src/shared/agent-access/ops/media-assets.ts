import { z } from 'zod'
import { identifier } from './common'

/**
 * 媒体素材族（F7 收尾）：产物生成来源读取 + 素材批量导出。
 *
 * 边界：
 * - `media.getRecipe` 只读：查"这个产物是哪个节点/哪次运行、用什么参数生成的"（谱系）。
 *   **不能写**（`media.saveRecipe` 是运行事实，由执行器写入；外部写会伪造谱系，因此不开放）。
 * - `media.batchExport` 只导出到**受控导出目录内的子目录**（不接受任意目标路径、不覆盖同名文件），
 *   逐项回执便于核对部分失败，不用"总数"掩盖个别失败。
 */
const mediaId = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/)

/** 生成来源（recipe）的只读投影：字段白名单。
 * **绝不返回 `fullPrompt`（提示词正文）**——它是业务正文，不进接口也不进日志。 */
const recipeDto = z
  .object({
    mediaId,
    projectId: identifier,
    producerNodeId: z.string().max(200),
    nodeType: z.string().max(120),
    contractVersion: z.number().int().nonnegative(),
    runId: z.string().max(200),
    modelKey: z.string().max(256).optional(),
    providerId: z.string().max(128).optional(),
    /** 生成该产物时引用过的上游媒体 ID（只有引用，不含路径）。 */
    inputMediaIds: z.array(z.string().max(128)).max(200),
    missingInputMediaIds: z.array(z.string().max(128)).max(200).optional(),
    /** 已脱敏的参数摘要（敏感键与二进制已在公共 recipeParams 中剔除）。 */
    params: z.record(z.string(), z.json()),
    createdAt: z.number().int().nonnegative()
  })
  .strict()

export const MEDIA_ASSET_OPERATIONS = {
  'media.getRecipe': {
    effect: 'read',
    description:
      '读取某个项目媒体的生成来源（产物谱系）：生产者节点、运行ID、操作与参数摘要；媒体不属于该项目或没有来源时如实返回 found=false，不伪造谱系。生成来源只能由执行器写入，外部不可写',
    input: z.object({ projectId: identifier, mediaId }).strict()
  },
  'media.batchExport': {
    effect: 'export',
    description:
      '把项目媒体（可指定 mediaIds，省略=全部）批量导出到受控导出目录下的新子目录：同名文件自动加序号后缀、绝不覆盖已有文件；逐项回执成功/失败文件名，不用总数掩盖个别失败',
    input: z
      .object({
        projectId: identifier,
        mediaIds: z.array(mediaId).min(1).max(200).optional()
      })
      .strict()
  }
} as const

export const MEDIA_ASSET_OUTPUTS = {
  'media.getRecipe': z
    .object({
      projectId: identifier,
      mediaId,
      found: z.boolean(),
      recipe: recipeDto.nullable()
    })
    .strict(),
  'media.batchExport': z
    .object({
      projectId: identifier,
      /** 受控导出目录内的子目录名；不返回绝对路径。 */
      directoryName: z.string().max(160),
      exported: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      files: z
        .array(
          z
            .object({
              mediaId,
              fileName: z.string().max(200),
              byteSize: z.number().int().nonnegative()
            })
            .strict()
        )
        .max(200),
      failures: z
        .array(z.object({ mediaId, reason: z.string().max(120) }).strict())
        .max(200)
    })
    .strict()
} as const
