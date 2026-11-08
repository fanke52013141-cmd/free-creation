import { z } from 'zod'

/**
 * 包传输（F7）：项目包/结构包/资源包导入导出（暂存+媒体重映射+密钥剥离+失败清理）。
 *
 * 新增操作的方法：在本文件的 `TRANSFER_OPERATIONS` 里登记
 * { effect, description, input }，并在 `TRANSFER_OUTPUTS` 里给出输出 Schema
 * （registry.ts 用 satisfies Record<AccessOperationId, z.ZodType> 强制成对）。
 * 之后必须在 src/main/agent-access/service.ts 的 dispatch 中给出实现，
 * 否则 TypeScript 的 unhandledOperation(never) 会直接失败——这是有意的：
 * 登记但无实现的幽灵操作不能存在。共享字段请从 ./common 引入。
 */
export const TRANSFER_OPERATIONS = {} as const
export const TRANSFER_OUTPUTS = {} as const

void z
