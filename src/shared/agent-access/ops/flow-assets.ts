import { z } from 'zod'

/**
 * 内部 Agent Flow 的**固定资产**操作（F8，flowAssets 族）。
 *
 * 目标：把 GUI「Agent Flow 资产」的提交/列表/读取开放给外部。固定资产是下游命令的
 * 输入来源，外部只能按台账提交与读取，不能伪造版本或绕过审核结论。
 *
 * 新增操作的方法：在本文件的 `FLOW_ASSETS_OPERATIONS` 里登记
 * { effect, description, input }，并在 `FLOW_ASSETS_OUTPUTS` 里给出输出 Schema
 * （registry.ts 用 satisfies Record<AccessOperationId, z.ZodType> 强制成对），
 * 再到 src/main/agent-access/service.ts 的 dispatch 给实现。
 * 共享字段请从 ./common 引入；不要用 .refine()。
 */
export const FLOW_ASSETS_OPERATIONS = {} as const
export const FLOW_ASSETS_OUTPUTS = {} as const

void z
