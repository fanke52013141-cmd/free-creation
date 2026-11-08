import { z } from 'zod'

/**
 * 内部 Agent Flow 的**命令账本协作**操作（F8，flowCommands 族）。
 *
 * 目标：把 GUI「Agent Flow 命令」已有的附着/脱离/可用性/派发/授权/取消/人工协作准备/
 * 提交/核对/查询/unknown 核对/放弃开放给外部。外部主体必须保持可区分：不得伪装成
 * 内部 Agent 的运行身份，也不得改写账本里的既有事实。
 *
 * 新增操作的方法：在本文件的 `FLOW_COMMANDS_OPERATIONS` 里登记
 * { effect, description, input }，并在 `FLOW_COMMANDS_OUTPUTS` 里给出输出 Schema
 * （registry.ts 用 satisfies Record<AccessOperationId, z.ZodType> 强制成对），
 * 再到 src/main/agent-access/service.ts 的 dispatch 给实现。
 * 共享字段请从 ./common 引入；不要用 .refine()。
 */
export const FLOW_COMMANDS_OPERATIONS = {} as const
export const FLOW_COMMANDS_OUTPUTS = {} as const

void z
