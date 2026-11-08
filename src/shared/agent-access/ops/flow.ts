import { z } from 'zod'

/**
 * 内部 Agent Flow（F8）：建图预览提交/角色绑定/运行控制/协作输入/固定资产/审核返工/状态机事件。
 *
 * 新增操作的方法：在本文件的 `FLOW_OPERATIONS` 里登记
 * { effect, description, input }，并在 `FLOW_OUTPUTS` 里给出输出 Schema
 * （registry.ts 用 satisfies Record<AccessOperationId, z.ZodType> 强制成对）。
 * 之后必须在 src/main/agent-access/service.ts 的 dispatch 中给出实现，
 * 否则 TypeScript 的 unhandledOperation(never) 会直接失败——这是有意的：
 * 登记但无实现的幽灵操作不能存在。共享字段请从 ./common 引入。
 */
export const FLOW_OPERATIONS = {} as const
export const FLOW_OUTPUTS = {} as const

void z
