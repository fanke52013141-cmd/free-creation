import { z } from 'zod'

/**
 * 内部 Agent Flow 的**观察与生命周期**操作（F8，flowAgents 族）。
 *
 * 目标：把 GUI「Agent Flow 面板」已有的查看/建图/运行/暂停/停止/协作动作开放给外部，
 * 复用现有 Flow 声明、命令账本、租约、固定资产与审核，不伪造内部运行身份。
 *
 * 新增操作的方法：在本文件的 `FLOW_AGENTS_OPERATIONS` 里登记
 * { effect, description, input }，并在 `FLOW_AGENTS_OUTPUTS` 里给出输出 Schema
 * （registry.ts 用 satisfies Record<AccessOperationId, z.ZodType> 强制成对），
 * 再到 src/main/agent-access/service.ts 的 dispatch 给实现。
 * 共享字段请从 ./common 引入；不要用 .refine()（registry 会对输入 Schema 跑
 * z.toJSONSchema，二选一等约束在执行层校验）。
 */
export const FLOW_AGENTS_OPERATIONS = {} as const
export const FLOW_AGENTS_OUTPUTS = {} as const

void z
