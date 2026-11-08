import { z } from 'zod'
import { project } from './common'

/**
 * 项目级节点可见集（F9，project-settings 族）。
 *
 * 目标：把 GUI「工作台节点设置」的读取/保存开放给外部。它直接决定调色板里出现哪些
 * 节点类型——本轮修复过"外部建项目少 8 类节点"的不一致（见台账 34），可见集必须
 * 可读可写，否则 Agent 无法解释"某个节点为什么不在面板里"。
 *
 * 写入必须与 GUI 同一校验：只接受当前可创建的类型 ID，未知/退役类型拒绝；
 * 通过 projects.repo.saveWorkspaceProfile 落盘（正式保存机制，不直写项目文件）。
 *
 * 新增操作的方法：在本文件的 `PROJECT_SETTINGS_OPERATIONS` 里登记
 * { effect, description, input }，并在 `PROJECT_SETTINGS_OUTPUTS` 里给出输出 Schema，
 * 再到 src/main/agent-access/service.ts 的 dispatch 给实现。
 * 共享字段请从 ./common 引入；不要用 .refine()。
 */

/** 单次写入的类型上限：当前 Active 集 32 类，留出未来扩展余量。 */
export const PROJECT_VISIBILITY_MAX_NODE_TYPES = 200

const nodeTypeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/i)

const workspaceProfileDto = z
  .object({
    presetId: z.enum(['general', 'image', 'video', 'audio', 'all', 'custom']),
    visibleNodeTypeIds: z.array(nodeTypeId).max(PROJECT_VISIBILITY_MAX_NODE_TYPES),
    nodeSetRevision: z.number().int().nonnegative()
  })
  .strict()

export const PROJECT_SETTINGS_OPERATIONS = {
  'project.nodeVisibility.get': {
    effect: 'read',
    description:
      '读取项目已保存的节点可见集（预设/可见类型/节点集版本）与当前可创建类型；旧项目从未保存过配置时如实表达"全部可创建节点可见"，不伪造 general 预设',
    input: project
  },
  'project.nodeVisibility.set': {
    effect: 'write',
    description:
      '替换项目的节点可见集（决定调色板里出现哪些节点）；只接受当前可创建类型 ID，未知/重复/空集合显式拒绝；经项目正式保存机制落盘，重开项目后生效',
    input: project
      .extend({
        /** 要可见的节点类型 ID 全集（替换语义，不是增量）。空数组会被执行层拒绝。 */
        visibleNodeTypeIds: z.array(nodeTypeId).max(PROJECT_VISIBILITY_MAX_NODE_TYPES)
      })
      .strict()
  }
} as const

export const PROJECT_SETTINGS_OUTPUTS = {
  'project.nodeVisibility.get': z
    .object({
      projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
      graphVersion: z.number().int().nonnegative(),
      /** null = 旧项目没有保存过可见集：按运行时语义显示全部可创建节点。 */
      profile: workspaceProfileDto.nullable(),
      /** 实际生效的可见类型（= 已保存集合 ∩ 当前可创建类型；旧项目=全部可创建）。 */
      effectiveVisibleNodeTypeIds: z
        .array(nodeTypeId)
        .max(PROJECT_VISIBILITY_MAX_NODE_TYPES),
      /** 已保存但当前已不可创建（退役/发行版裁剪）的类型；如实列出，不静默丢弃。 */
      savedButNotCreatable: z.array(nodeTypeId).max(PROJECT_VISIBILITY_MAX_NODE_TYPES),
      creatableNodeTypeIds: z.array(nodeTypeId).max(PROJECT_VISIBILITY_MAX_NODE_TYPES),
      visibleCount: z.number().int().nonnegative(),
      creatableCount: z.number().int().nonnegative(),
      source: z.enum(['saved-profile', 'legacy-all-visible'])
    })
    .strict(),
  'project.nodeVisibility.set': z
    .object({
      projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
      graphVersion: z.number().int().nonnegative(),
      saved: z.literal(true),
      /** 落盘后的实际配置（经共享 normalize 归一化，可能与请求集合略有差异）。 */
      profile: workspaceProfileDto,
      visibleCount: z.number().int().nonnegative(),
      /** 相对写入前生效集合的增量差异（便于 Agent 核对影响）。 */
      added: z.array(nodeTypeId).max(PROJECT_VISIBILITY_MAX_NODE_TYPES),
      removed: z.array(nodeTypeId).max(PROJECT_VISIBILITY_MAX_NODE_TYPES),
      /** true = 该项目正在桌面画布中打开：GUI 需重开项目才能看到新可见集。 */
      desktopReloadRequired: z.boolean()
    })
    .strict()
} as const
