import { z } from 'zod'

/**
 * 节点库（F7）：全类型单节点与组合保存/命名/更新/删除/搜索/实例化。
 *
 * 新增操作的方法：在本文件的 `NODE_LIBRARY_OPERATIONS` 里登记
 * { effect, description, input }，并在 `NODE_LIBRARY_OUTPUTS` 里给出输出 Schema
 * （registry.ts 用 satisfies Record<AccessOperationId, z.ZodType> 强制成对）。
 * 之后必须在 src/main/agent-access/service.ts 的 dispatch 中给出实现，
 * 否则 TypeScript 的 unhandledOperation(never) 会直接失败——这是有意的：
 * 登记但无实现的幽灵操作不能存在。共享字段请从 ./common 引入。
 */
export const NODE_LIBRARY_OPERATIONS = {} as const
export const NODE_LIBRARY_OUTPUTS = {} as const

void z
