import { z } from 'zod'
import { identifier, metadata } from './common'

/**
 * 包传输（F7）：项目包/结构包/资源包导入导出（暂存+媒体重映射+密钥剥离+失败清理）。
 *
 * 新增操作的方法：在本文件的 `TRANSFER_OPERATIONS` 里登记
 * { effect, description, input }，并在 `TRANSFER_OUTPUTS` 里给出输出 Schema
 * （registry.ts 用 satisfies Record<AccessOperationId, z.ZodType> 强制成对）。
 * 之后必须在 src/main/agent-access/service.ts 的 dispatch 中给出实现，
 * 否则 TypeScript 的 unhandledOperation(never) 会直接失败——这是有意的：
 * 登记但无实现的幽灵操作不能存在。共享字段请从 ./common 引入。
 *
 * 外部输入边界：导入只接受服务启动时确定的受控导出目录（`<dataDir>/agent-exports`）
 * 内的包文件；路径在 main 侧 realpath 后做包含校验，绝不接受任意路径或目录外文件。
 * 业务实现只在 src/main/agent-access/transfer-ops.ts，复用 GUI 同一 store 服务。
 */
const packagePath = z.string().trim().min(1).max(1000)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const count = z.number().int().nonnegative()

export const TRANSFER_OPERATIONS = {
  'project.import': {
    effect: 'write',
    description:
      '导入受控导出目录内的完整项目包（.canvasbundle）：先写暂存目录，校验版本/媒体哈希与凭据剥离，媒体ID与相对路径全量重映射后才提交为新项目；失败清理暂存与半个项目',
    input: z.object({ filePath: packagePath }).strict()
  },
  'project.importStructure': {
    effect: 'write',
    description:
      '导入受控导出目录内的画布结构包（.canvasflow）为新项目：节点/连线/分组与快照经公共清洗后落库，不含媒体文件、运行结果与聊天正文；失败回滚新项目',
    input: z.object({ filePath: packagePath }).strict()
  },
  'library.import': {
    effect: 'write',
    description:
      '导入受控导出目录内的资源包（.canvaslib）：校验清单格式/版本/逐文件大小与 sha256 后经事务登记为新资源；同一内容包按包哈希拒绝重复导入',
    input: z.object({ filePath: packagePath }).strict()
  },
  'library.export': {
    effect: 'export',
    description:
      '把资源库资源导出为受控导出目录内的资源包（.canvaslib）：临时文件→fsync→排他落位，不覆盖已有文件；返回路径、sha256 与字节数',
    input: z
      .object({
        fileName: z.string().regex(/^[a-zA-Z0-9_-]{1,100}\.canvaslib$/),
        /** 省略=导出全部未归档资源；显式给出时必须全部存在。 */
        resourceIds: z.array(identifier).max(500).optional()
      })
      .strict()
  }
} as const

export const TRANSFER_OUTPUTS = {
  'project.import': z
    .object({
      meta: metadata,
      nodeCount: count,
      edgeCount: count,
      groupCount: count,
      mediaCount: count,
      /** 包内被引用但未随包提供的媒体数量（外部完整导出为 0；如实透传不伪造成功）。 */
      missingMediaCount: count,
      sha256,
      byteSize: count,
      committed: z.literal(true)
    })
    .strict(),
  'project.importStructure': z
    .object({
      meta: metadata,
      nodeCount: count,
      edgeCount: count,
      groupCount: count,
      sha256,
      byteSize: count,
      committed: z.literal(true)
    })
    .strict(),
  'library.import': z
    .object({
      imported: count,
      packageSha256: sha256,
      byteSize: count,
      committed: z.literal(true)
    })
    .strict(),
  'library.export': z
    .object({
      path: z.string().max(1000),
      byteSize: count,
      sha256,
      resourceCount: count,
      /** 排他创建：目标文件已存在时操作拒绝，不会覆盖。 */
      overwritten: z.literal(false)
    })
    .strict()
} as const
