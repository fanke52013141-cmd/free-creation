import { z } from 'zod'
import { SkillAgentConfigSchema } from '../skill-agent'
import { GraphPatchOpsSchema, GRAPH_VIEW_MAX_NODES } from './graph-ops'
import { NODE_EXECUTE_MAX_NODES } from './run-ops'

export const ACCESS_DESKTOP_REQUEST = 'local-agent:desktop-request'
export const ACCESS_DESKTOP_REPLY = 'local-agent:desktop-reply'
export const ACCESS_DESKTOP_COMMIT = 'local-agent:desktop-commit'
export const ACCESS_TASK_REPORT = 'local-agent:task-report'
export const DesktopRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    expiresAt: z.number().int().positive(),
    projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    action: z.enum([
      'open',
      'flush',
      'rename',
      'bind-skills',
      'graph-patch',
      'read-graph',
      'execute-nodes',
      'cancel-run'
    ]),
    nodeId: z.string().optional(),
    agent: SkillAgentConfigSchema.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    /** graph-patch：类型化画布编辑批次（renderer 权威校验并原子应用）。 */
    ops: GraphPatchOpsSchema.optional(),
    /** graph.patch 提交方期望的图版本；权威宿主在保存未保存内容后核对。 */
    expectedGraphVersion: z.number().int().nonnegative().optional(),
    /** read-graph：latest 视图分页参数。 */
    offset: z.number().int().min(0).max(100000).optional(),
    limit: z.number().int().min(1).max(GRAPH_VIEW_MAX_NODES).optional(),
    /** execute-nodes：外部执行任务（账本已受理）。 */
    taskId: z.string().max(160).optional(),
    mode: z.enum(['single', 'subgraph']).optional(),
    nodeIds: z.array(z.string().max(180)).min(1).max(NODE_EXECUTE_MAX_NODES).optional(),
    confirmPaidRerun: z.boolean().optional()
  })
  .strict()
export type DesktopRequest = z.infer<typeof DesktopRequestSchema>
export const DesktopReplySchema = z
  .object({
    requestId: z.string().uuid(),
    projectId: z.string(),
    ok: z.boolean(),
    graphVersion: z.number().int().nonnegative().optional(),
    /** ok=false 且 validated=true：失败发生在任何变更之前，main 可安全返回 failed 而非 unknown。 */
    validated: z.boolean().optional(),
    errorCode: z.string().max(80).optional(),
    errorDetail: z.string().max(300).optional(),
    /** read-graph / graph-patch 的结果载荷（DTO 与 created 映射）。 */
    result: z.unknown().optional()
  })
  .strict()
export const DesktopCommitSchema = z
  .object({
    requestId: z.string().uuid(),
    projectId: z.string(),
    graphVersion: z.number().int().nonnegative()
  })
  .strict()
