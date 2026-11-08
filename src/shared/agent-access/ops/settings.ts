import { z } from 'zod'

/**
 * 模型与设置（F9）：模型连接/定义/绑定/发现/验证/受控凭据/环境探测/节点可见集/诊断。
 *
 * 新增操作的方法：在本文件的 `SETTINGS_OPERATIONS` 里登记
 * { effect, description, input }，并在 `SETTINGS_OUTPUTS` 里给出输出 Schema
 * （registry.ts 用 satisfies Record<AccessOperationId, z.ZodType> 强制成对）。
 * 之后必须在 src/main/agent-access/service.ts 的 dispatch 中给出实现，
 * 否则 TypeScript 的 unhandledOperation(never) 会直接失败——这是有意的：
 * 登记但无实现的幽灵操作不能存在。共享字段请从 ./common 引入。
 */
export const SETTINGS_OPERATIONS = {} as const
export const SETTINGS_OUTPUTS = {} as const

void z
