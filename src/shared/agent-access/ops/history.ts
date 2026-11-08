import { z } from 'zod'
import { identifier, project } from './common'

/**
 * 历史与恢复（F7）：工作区快照/恢复副本/撤销重做。
 *
 * 新增操作的方法：在本文件的 `HISTORY_OPERATIONS` 里登记
 * { effect, description, input }，并在 `HISTORY_OUTPUTS` 里给出输出 Schema
 * （registry.ts 用 satisfies Record<AccessOperationId, z.ZodType> 强制成对）。
 * 之后必须在 src/main/agent-access/service.ts 的 dispatch 中给出实现，
 * 否则 TypeScript 的 unhandledOperation(never) 会直接失败——这是有意的：
 * 登记但无实现的幽灵操作不能存在。共享字段请从 ./common 引入。
 *
 * 口径（与 GUI 历史坞同一业务事实，不是另一份实现）：
 * - 快照存储仍是 `history_snapshots` 表（workspace-state.repo），本包只新增
 *   `graph_json` 列保存"该快照对应的已持久化图数据"，让外部恢复能落到正式
 *   项目文件；GUI 在打开的画布内恢复仍走 snapshot-restore 事务，两者互不污染。
 * - 恢复（快照/恢复副本）都是三段：precheck → 短期令牌 → 执行，语义与
 *   project.delete.precheck / project.delete 一致（令牌绑定实例、目标、当前
 *   graphVersion、快照/副本身份与影响摘要；过期或事实漂移必须重新预检）。
 * - 外部只能在项目未于桌面画布打开时恢复：画布打开时权威内容属于桌面宿主，
 *   main 直接改文件会被下一次画布保存覆盖。打开中返回 RESOURCE_BUSY /
 *   desktop-ownership，不伪造成功。
 */

const snapshotId = identifier

const impactShape = z
  .object({
    nodeCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
    groupCount: z.number().int().nonnegative()
  })
  .strict()

const mediaImpact = z
  .object({
    required: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative()
  })
  .strict()

const restoreBlockers = z.array(
  z.enum(['ACTIVE_PROJECT', 'RECOVERY_COPY', 'TASK_OCCUPANCY', 'SNAPSHOT_WITHOUT_GRAPH'])
)

const recoveryBlockers = z.array(z.enum(['ACTIVE_PROJECT', 'TASK_OCCUPANCY']))

const impactToken = z.string().min(1).max(1024)

const paged = z
  .object({
    offset: z.number().int().min(0).max(100000).default(0),
    limit: z.number().int().min(1).max(100).default(50)
  })
  .strict()

export const HISTORY_OPERATIONS = {
  'history.list': {
    effect: 'read',
    description:
      '分页读取项目历史版本快照目录（名称/时间/节点数/可否外部恢复）；不返回快照正文',
    input: project.extend(paged.shape).strict()
  },
  'history.snapshot.create': {
    effect: 'write',
    description:
      '把项目当前已持久化的画布与图数据保存为命名历史版本快照；聊天正文与运行结果不进入快照，未保存的画布编辑不在其中（GUI 历史坞的快照捕获内存状态）',
    input: project
      .extend({
        expectedGraphVersion: z.number().int().nonnegative(),
        label: z.string().trim().max(120).optional()
      })
      .strict()
  },
  'history.snapshot.delete': {
    effect: 'delete',
    description: '删除历史版本快照；当前画布与项目内容不受影响',
    input: project.extend({ snapshotId }).strict()
  },
  'history.restore.precheck': {
    effect: 'read',
    description:
      '读取历史版本恢复影响（当前/目标节点与连线数、媒体可用性）与占用阻塞项；无阻塞且快照含可恢复图数据时签发短期确认令牌',
    input: project.extend({ snapshotId }).strict()
  },
  'history.restore': {
    effect: 'write',
    description:
      '凭预检令牌把历史版本恢复为项目正式内容（先保存恢复前检查点，再走正式保存机制）；生效前失败保持原图，令牌过期或事实漂移需重新预检',
    input: project.extend({ snapshotId, impactToken: impactToken.optional() }).strict()
  },
  'history.recovery.precheck': {
    effect: 'read',
    description:
      '读取关窗冲突恢复副本的事实与阻塞项（是否存在/版本/节点数）。**不传 decision 时只读事实**（无需先做决定）；传入 use/discard 且无阻塞时额外签发短期确认令牌供 resolve 使用',
    input: project.extend({ decision: z.enum(['use', 'discard']).optional() }).strict()
  },
  'history.recovery.resolve': {
    effect: 'write',
    description:
      '凭预检令牌裁决恢复副本：use=经正式保存把副本落盘并移除副本；discard=丢弃副本、保留磁盘版本。与 GUI 打开项目时的裁决调用同一 repo 服务',
    input: project
      .extend({ decision: z.enum(['use', 'discard']), impactToken: impactToken.optional() })
      .strict()
  }
} as const

const snapshotSummary = z
  .object({
    snapshotId,
    label: z.string().max(200),
    createdAt: z.number(),
    nodeCount: z.number().int().nonnegative(),
    /** true 表示该快照含已持久化图数据，可由外部恢复到正式项目文件。 */
    restorable: z.boolean()
  })
  .strict()

export const HISTORY_OUTPUTS = {
  'history.list': z
    .object({
      projectId: identifier,
      total: z.number().int().nonnegative(),
      items: z.array(snapshotSummary).max(100)
    })
    .strict(),
  'history.snapshot.create': z
    .object({
      projectId: identifier,
      snapshotId,
      label: z.string().max(200),
      createdAt: z.number(),
      nodeCount: z.number().int().nonnegative(),
      graphVersion: z.number().int().nonnegative(),
      restorable: z.literal(true)
    })
    .strict(),
  'history.snapshot.delete': z
    .object({ projectId: identifier, snapshotId, deleted: z.literal(true) })
    .strict(),
  'history.restore.precheck': z
    .object({
      projectId: identifier,
      graphVersion: z.number().int().nonnegative(),
      snapshotId,
      current: impactShape,
      target: impactShape,
      media: mediaImpact,
      blockers: restoreBlockers,
      impactToken: impactToken.optional(),
      expiresAt: z.number().int().positive().optional()
    })
    .strict(),
  'history.restore': z
    .object({
      projectId: identifier,
      snapshotId,
      restored: z.literal(true),
      graphVersion: z.number().int().nonnegative(),
      previousGraphVersion: z.number().int().nonnegative(),
      /** 恢复前自动保存的检查点快照；恢复失败时它是回到原图的入口。 */
      checkpointSnapshotId: snapshotId,
      nodeCount: z.number().int().nonnegative(),
      edgeCount: z.number().int().nonnegative()
    })
    .strict(),
  'history.recovery.precheck': z
    .object({
      projectId: identifier,
      graphVersion: z.number().int().nonnegative(),
      exists: z.boolean(),
      copyGraphVersion: z.number().int().nonnegative().nullable(),
      copyNodeCount: z.number().int().nonnegative().nullable(),
      copyUpdatedAt: z.number().nullable(),
      blockers: recoveryBlockers,
      /** 未传 decision 时为 true：只读事实，需再次调用并带 decision 才能拿令牌。 */
      requiresDecision: z.boolean().optional(),
      impactToken: impactToken.optional(),
      expiresAt: z.number().int().positive().optional()
    })
    .strict(),
  'history.recovery.resolve': z
    .object({
      projectId: identifier,
      decision: z.enum(['use', 'discard']),
      resolved: z.literal(true),
      graphVersion: z.number().int().nonnegative(),
      recoveryCopyRemoved: z.literal(true)
    })
    .strict()
} as const
