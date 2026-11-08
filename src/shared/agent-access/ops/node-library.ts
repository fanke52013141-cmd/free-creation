import { z } from 'zod'
import { identifier, nodeId, revision, templateSummary } from './common'

/**
 * 节点库（F7）：全类型单节点与组合保存/命名/更新/删除/搜索/实例化。
 *
 * 新增操作的方法：在本文件的 `NODE_LIBRARY_OPERATIONS` 里登记
 * { effect, description, input }，并在 `NODE_LIBRARY_OUTPUTS` 里给出输出 Schema
 * （registry.ts 用 satisfies Record<AccessOperationId, z.ZodType> 强制成对）。
 * 之后必须在 src/main/agent-access/service.ts 的 dispatch 中给出实现，
 * 否则 TypeScript 的 unhandledOperation(never) 会直接失败——这是有意的：
 * 登记但无实现的幽灵操作不能存在。共享字段请从 ./common 引入。
 *
 * 兼容边界：既有 `node.library.save`（AI 对话技能预设子集，只接收单个 chat 节点）
 * 保持原样不动；通用组合保存是新增的 `node.library.compose`，两者写入同一张
 * workflow_templates 表、同一保存策略（GUI 节点库面板可见），不静默改变旧接口。
 */

/** 单个组合条目的节点/连线上限；insert 会展开成同一批 graph.patch 操作。 */
export const NODE_LIBRARY_MAX_NODES = 40
export const NODE_LIBRARY_MAX_EDGES = 120

const entryId = identifier
/** 节点库条目里的节点类型名（含历史类型，不做 Active 白名单裁剪）。 */
const libraryNodeType = z.string().min(1).max(60)
const edgeRef = z.number().int().min(0).max(NODE_LIBRARY_MAX_NODES - 1)

const insertCoord = z.number().finite().min(-100000).max(100000)

export const NODE_LIBRARY_OPERATIONS = {
  'node.library.compose': {
    effect: 'write',
    description:
      '把项目中选中的多个节点及它们之间的连线保存为节点库组合条目（含媒体引用记录）；排除聊天历史、附件与运行结果',
    input: revision
      .extend({
        name: z.string().trim().min(1).max(120),
        nodeIds: z.array(nodeId).min(1).max(NODE_LIBRARY_MAX_NODES)
      })
      .strict()
  },
  'node.library.update': {
    effect: 'write',
    description: '重命名节点库条目；条目内容与画布不受影响',
    input: z.object({ entryId, name: z.string().trim().min(1).max(120) }).strict()
  },
  'node.library.delete': {
    effect: 'delete',
    description: '删除节点库条目；画布上已经插入的节点不受影响',
    input: z.object({ entryId }).strict()
  },
  'node.library.get': {
    effect: 'read',
    description:
      '读取节点库条目详情（节点类型/标题/尺寸/正文与配置存在性/媒体引用/连线拓扑）；不返回配置与正文内容',
    input: z.object({ entryId }).strict()
  },
  'node.library.search': {
    effect: 'read',
    description: '按条目名称、节点标题与节点类型过滤节点库条目（分页）；不返回配置正文',
    input: z
      .object({
        query: z.string().max(200).optional(),
        nodeType: libraryNodeType.optional(),
        offset: z.number().int().min(0).max(100000).default(0),
        limit: z.number().int().min(1).max(100).default(50)
      })
      .strict()
  },
  'node.library.insert': {
    effect: 'write',
    description:
      '把节点库条目实例化到指定项目画布（须先 project.open 到当前画布）：重映射节点 ID、连线与媒体引用，经权威宿主落盘；外部输入只携带媒体 ID',
    input: revision
      .extend({
        entryId,
        /** 落点左上角；节点相对偏移沿用条目保存时的组合布局。缺省 (0,0)。 */
        x: insertCoord.optional(),
        y: insertCoord.optional()
      })
      .strict()
  }
} as const

const libraryImpact = z
  .object({
    nodeCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
    groupCount: z.number().int().nonnegative()
  })
  .strict()

const mediaOutcome = z
  .object({
    /** 条目里记录的源媒体 ID（只出现在回执与条目内部，不进入节点 op）。 */
    entryMediaId: z.string().max(40),
    /** 目标项目里新登记的媒体 ID（跨画布不串用：每个项目各自的受控媒体）。 */
    mediaId: z.string().max(40)
  })
  .strict()

export const NODE_LIBRARY_OUTPUTS = {
  'node.library.compose': templateSummary,
  'node.library.update': templateSummary,
  'node.library.delete': z
    .object({ entryId, deleted: z.literal(true) })
    .strict(),
  'node.library.get': z
    .object({
      entryId,
      name: z.string().max(200),
      createdAt: z.number(),
      nodeCount: z.number().int().nonnegative(),
      impact: libraryImpact,
      nodes: z
        .array(
          z
            .object({
              nodeType: libraryNodeType,
              title: z.string().max(200),
              dx: z.number(),
              dy: z.number(),
              w: z.number(),
              h: z.number(),
              hasText: z.boolean(),
              configBytes: z.number().int().nonnegative(),
              mediaId: z.string().max(40).optional(),
              mediaRefCount: z.number().int().nonnegative()
            })
            .strict()
        )
        .max(NODE_LIBRARY_MAX_NODES),
      edges: z
        .array(
          z
            .object({
              fromIdx: edgeRef,
              toIdx: edgeRef,
              fromPort: z.string().max(100).optional(),
              toPort: z.string().max(100).optional(),
              connectOrder: z.number().int().min(1).max(999).optional()
            })
            .strict()
        )
        .max(NODE_LIBRARY_MAX_EDGES)
    })
    .strict(),
  'node.library.search': z
    .object({
      total: z.number().int().nonnegative(),
      items: z
        .array(
          z
            .object({
              id: identifier,
              name: z.string().max(200),
              createdAt: z.number(),
              nodeCount: z.number().int().nonnegative(),
              nodeTypes: z.array(libraryNodeType).max(NODE_LIBRARY_MAX_NODES)
            })
            .strict()
        )
        .max(100)
    })
    .strict(),
  'node.library.insert': z
    .object({
      projectId: identifier,
      graphVersion: z.number().int().nonnegative(),
      saved: z.literal(true),
      entryId,
      /** 宿主创建的节点与连线 ID（ref 对应本次提交的临时引用）。 */
      created: z
        .array(
          z
            .object({ ref: z.string().max(64).optional(), nodeId: z.string().max(180) })
            .strict()
        )
        .max(200),
      applied: z
        .object({
          nodeCreated: z.number().int().nonnegative(),
          nodeUpdated: z.number().int().nonnegative(),
          nodeDeleted: z.number().int().nonnegative(),
          edgeCreated: z.number().int().nonnegative(),
          edgeDeleted: z.number().int().nonnegative()
        })
        .strict(),
      /** 复制进目标项目的媒体（无媒体引用时为空数组）。 */
      media: z.array(mediaOutcome).max(64),
      /** 条目里端口不确定而未恢复的旧连线数（与 GUI 插入同一跳过规则）。 */
      skippedEdges: z.number().int().nonnegative()
    })
    .strict()
} as const
