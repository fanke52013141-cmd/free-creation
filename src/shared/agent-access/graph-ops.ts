import { z } from 'zod'
import { ACTIVE_NODE_TYPE_IDS } from '../types'
import { ChatPatchOpsSchema } from './chat-ops'

// 图编辑公共契约（F1/F2）：main 预检、renderer 权威应用、CLI/MCP 输入共用同一 Schema。
// graph.patch 只接收有限的 typed 操作；不接收整份 tldraw 快照或任意 meta 覆盖。
// 渲染侧 planGraphPatch 用同一 Schema 与节点 Spec 做整体校验后原子应用。

export const GRAPH_PATCH_MAX_OPS = 200
export const GRAPH_NODE_TEXT_MAX_CHARS = 200_000
export const GRAPH_NODE_CONFIG_MAX_BYTES = 64 * 1024
export const GRAPH_NODE_TITLE_MAX_CHARS = 200
export const GRAPH_VIEW_MAX_NODES = 200
export const GRAPH_VIEW_MAX_EDGES = 2000
export const GRAPH_NODE_COORD_LIMIT = 100_000
export const GRAPH_NODE_SIZE_LIMIT = 4000

export const accessNodeId = z.string().regex(/^shape:[a-zA-Z0-9_-]{1,160}$/)
export const accessClientRef = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
export const accessPortId = z
  .string()
  .regex(/^(in|out)-[a-zA-Z0-9-]{1,80}$/)
  .max(100)

const coord = z.number().finite().min(-GRAPH_NODE_COORD_LIMIT).max(GRAPH_NODE_COORD_LIMIT)

const nodeCreate = z
  .object({
    action: z.literal('node.create'),
    /** 客户端临时引用：同批 edge.create 端口与回执 created 映射用它寻址。 */
    ref: accessClientRef.optional(),
    nodeType: z.enum(ACTIVE_NODE_TYPE_IDS),
    title: z.string().max(GRAPH_NODE_TITLE_MAX_CHARS).optional(),
    x: coord,
    y: coord,
    w: z.number().finite().min(40).max(GRAPH_NODE_SIZE_LIMIT).optional(),
    h: z.number().finite().min(40).max(GRAPH_NODE_SIZE_LIMIT).optional(),
    text: z.string().max(GRAPH_NODE_TEXT_MAX_CHARS).optional(),
    /** 固定配置键值合并到该类型 GUI 初始配置之上；null 值删除键。 */
    config: z.record(z.string(), z.unknown()).optional(),
    /** 素材引用：mediaId 必须已经 media.import 登记到同一项目，main 预检解析归属。 */
    media: z.object({ mediaId: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/) }).strict().optional()
  })
  .strict()

const nodeUpdate = z
  .object({
    action: z.literal('node.update'),
    nodeId: z.string().min(1).max(180),
    title: z.string().max(GRAPH_NODE_TITLE_MAX_CHARS).optional(),
    x: coord.optional(),
    y: coord.optional(),
    w: z.number().finite().min(40).max(GRAPH_NODE_SIZE_LIMIT).optional(),
    h: z.number().finite().min(40).max(GRAPH_NODE_SIZE_LIMIT).optional(),
    text: z.string().max(GRAPH_NODE_TEXT_MAX_CHARS).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    /** 替换素材引用（null 清除素材字段）。 */
    media: z.object({ mediaId: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/) }).strict().optional(),
    order: z.enum(['front', 'back']).optional()
  })
  .strict()

const nodeDelete = z
  .object({ action: z.literal('node.delete'), nodeId: z.string().min(1).max(180) })
  .strict()

const edgeEndpoint = z.object({ nodeId: z.string().min(1).max(180), portId: accessPortId }).strict()

const edgeCreate = z
  .object({
    action: z.literal('edge.create'),
    ref: accessClientRef.optional(),
    from: edgeEndpoint,
    to: edgeEndpoint,
    /** 多值输入的接入顺序（1 起）；缺省按画布连线记录顺序。 */
    connectOrder: z.number().int().min(1).max(999).optional()
  })
  .strict()

const edgeDelete = z
  .object({ action: z.literal('edge.delete'), edgeId: accessNodeId })
  .strict()

// chat.* 操作：只针对对话节点（main 预检校验 nodeId 为 chat 类型）；
// 结构编辑走权威宿主同一 chat-data 解析，不绕过会话语义。
const chatNodeOp = z
  .object({ action: z.literal('chat.patch'), nodeId: z.string().min(1).max(180), ops: ChatPatchOpsSchema })
  .strict()

/** 对齐/均分模式：与 GUI 多选工具栏（MultiSelectToolbar）的 AlignMode 完全一致。 */
export const GRAPH_ALIGN_MODES = [
  'left',
  'right',
  'center-h',
  'center-v',
  'distribute-h',
  'distribute-v'
] as const
export type GraphAlignMode = (typeof GRAPH_ALIGN_MODES)[number]

/** 复制节点：可选偏移与原引用；复制只带结构（配置/正文/素材引用），不带运行结果。 */
const nodeDuplicate = z
  .object({
    action: z.literal('node.duplicate'),
    nodeId: z.string().min(1).max(180),
    dx: coord.optional(),
    dy: coord.optional(),
    /** 新节点标题；省略则沿用原标题。 */
    title: z.string().max(GRAPH_NODE_TITLE_MAX_CHARS).optional(),
    /** 为复制出的节点登记客户端引用，供同批后续 op 使用。 */
    ref: accessClientRef.optional()
  })
  .strict()

/** 对齐/均分：至少两个节点；坐标由与 GUI 相同的算法计算。 */
const layoutAlign = z
  .object({
    action: z.literal('layout.align'),
    mode: z.enum(GRAPH_ALIGN_MODES),
    nodeIds: z.array(z.string().min(1).max(180)).min(2).max(GRAPH_PATCH_MAX_OPS)
  })
  .strict()

/** 组合：把若干节点归入一个新的 tldraw group（与 GUI「组合」同一 groupShapes）。 */
const groupCreate = z
  .object({
    action: z.literal('group.create'),
    nodeIds: z.array(z.string().min(1).max(180)).min(2).max(GRAPH_PATCH_MAX_OPS),
    ref: accessClientRef.optional()
  })
  .strict()

/** 解组：取消一个既有 group（与 GUI「拆分」同一 ungroupShapes）。 */
const groupDelete = z
  .object({ action: z.literal('group.delete'), groupId: z.string().min(1).max(180) })
  .strict()

/**
 * 切换结果版本：把节点当前引用切换到它自己结果集合里的另一条产物
 * （与 GUI 资产节点"选择结果版本"同一 selectMediaResult）。
 * 只允许在本节点已有的结果集合里选——不能指向任意 mediaId，否则等于换掉了产物来源。
 */
const nodeSelectResult = z
  .object({
    action: z.literal('node.select-result'),
    nodeId: z.string().min(1).max(180),
    mediaId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
  })
  .strict()

export const GraphPatchOpSchema = z.discriminatedUnion('action', [
  nodeCreate,
  nodeUpdate,
  nodeDelete,
  edgeCreate,
  edgeDelete,
  chatNodeOp,
  nodeDuplicate,
  layoutAlign,
  groupCreate,
  groupDelete,
  nodeSelectResult
])
export type GraphPatchOp = z.infer<typeof GraphPatchOpSchema>

export const GraphPatchOpsSchema = z.array(GraphPatchOpSchema).min(1).max(GRAPH_PATCH_MAX_OPS)

/** 图读取 DTO（persisted 与 latest 两种视图同构；config/text 走 node.get 显式读取）。 */
export const graphNodeDto = z
  .object({
    nodeId: z.string(),
    type: z.string(),
    contractVersion: z.number().int().nonnegative(),
    title: z.string().max(GRAPH_NODE_TITLE_MAX_CHARS),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    ports: z.array(
      z
        .object({
          id: z.string(),
          dir: z.enum(['in', 'out']),
          type: z.string(),
          required: z.boolean(),
          cardinality: z.enum(['one', 'many']),
          name: z.string().max(80),
          schema: z.object({ id: z.string(), version: z.number() }).optional()
        })
        .strict()
    ),
    contentKind: z.enum(['text', 'media', 'empty']),
    mediaId: z.string().optional()
  })
  .strict()

export const graphEdgeDto = z
  .object({
    edgeId: z.string(),
    from: z.object({ nodeId: z.string(), portId: z.string() }).strict(),
    to: z.object({ nodeId: z.string(), portId: z.string() }).strict(),
    connectOrder: z.number().int().optional()
  })
  .strict()

export const graphGroupDto = z
  .object({ groupId: z.string(), name: z.string().max(120), nodeIds: z.array(z.string()) })
  .strict()

export interface GraphViewSource {
  nodes: ReadonlyArray<{
    id: string
    type: string
    contractVersion: number
    title: string
    x: number
    y: number
    w: number
    h: number
    ports: ReadonlyArray<PortDeclLike>
    content: { kind: string; mediaId?: string }
  }>
  edges: ReadonlyArray<{
    id: string
    from: { nodeId: string; portId: string }
    to: { nodeId: string; portId: string }
    connectOrder?: number
  }>
  groups: ReadonlyArray<{ id: string; name: string; nodeIds: string[] }>
}

interface PortDeclLike {
  id: string
  dir: 'in' | 'out'
  type: string
  required: boolean
  cardinality: 'one' | 'many'
  name?: string
  description?: string
  schema?: { id: string; version: number }
}

/** persisted/latest 两种视图共用的 DTO 投影；config 与正文不进入目录视图，走 node.get。 */
export function toGraphView(
  source: GraphViewSource,
  offset: number,
  limit: number
): {
  total: number
  offset: number
  nodes: unknown[]
  edges: unknown[]
  groups: unknown[]
} {
  const sorted = [...source.nodes].sort((a, b) => a.id.localeCompare(b.id))
  const page = sorted.slice(offset, offset + limit)
  const nodeIds = new Set(sorted.map((n) => n.id))
  const edges = [...source.edges]
    .filter((edge) => nodeIds.has(edge.from.nodeId) && nodeIds.has(edge.to.nodeId))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, GRAPH_VIEW_MAX_EDGES)
  return {
    total: sorted.length,
    offset,
    nodes: page.map((node) => ({
      nodeId: node.id,
      type: node.type,
      contractVersion: node.contractVersion,
      title: node.title.slice(0, GRAPH_NODE_TITLE_MAX_CHARS),
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      ports: node.ports.map((port) => ({
        id: port.id,
        dir: port.dir,
        type: port.type,
        required: port.required,
        cardinality: port.cardinality,
        name: (port.name ?? port.id).slice(0, 80),
        ...(port.schema ? { schema: port.schema } : {})
      })),
      contentKind:
        node.content.kind === 'media' ? 'media' : node.content.kind === 'text' ? 'text' : 'empty',
      ...(node.content.kind === 'media' && node.content.mediaId
        ? { mediaId: node.content.mediaId }
        : {})
    })),
    edges: edges.map((edge) => ({
      edgeId: edge.id,
      from: edge.from,
      to: edge.to,
      ...(edge.connectOrder !== undefined ? { connectOrder: edge.connectOrder } : {})
    })),
    groups: [...source.groups].slice(0, GRAPH_VIEW_MAX_NODES).map((group) => ({
      groupId: group.id,
      name: group.name.slice(0, 120),
      nodeIds: group.nodeIds
    }))
  }
}

export interface GraphPatchReferenceError {
  index: number
  code: string
}

/** 寻址约定：`shape:` 前缀为已存在/持久化节点 ID；无前缀为同批 node.create 声明的 ref。 */
export function isExistingNodeId(id: string): boolean {
  return id.startsWith('shape:')
}

/** main 预检解析出的素材事实（相对路径与 MIME），桌面载荷按 mediaId 注入。 */
export const mediaResolutionSchema = z
  .object({
    mediaId: z.string(),
    mediaPath: z.string().max(300),
    mediaMime: z.string().max(120),
    name: z.string().max(200).optional()
  })
  .strict()
export type MediaResolution = z.infer<typeof mediaResolutionSchema>
export type MediaResolutionMap = Record<string, MediaResolution>

/** main 侧结构预检：引用可解析、ref 唯一、目标存在。类型/端口/兼容校验由权威宿主做。 */
export function resolvePatchReferences(
  ops: readonly GraphPatchOp[],
  existing: { nodes: ReadonlyArray<{ id: string }>; edges: ReadonlyArray<{ id: string }> }
): { ok: true } | { ok: false; errors: GraphPatchReferenceError[] } {
  const errors: GraphPatchReferenceError[] = []
  const existingNodeIds = new Set(existing.nodes.map((n) => n.id))
  const existingEdgeIds = new Set(existing.edges.map((e) => e.id))
  const refs = new Set<string>()
  const resolveTarget = (id: string): boolean =>
    isExistingNodeId(id) ? existingNodeIds.has(id) : refs.has(id)
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index]
    if (op.action === 'node.create') {
      if (op.ref) {
        if (refs.has(op.ref)) errors.push({ index, code: 'REF_CONFLICT' })
        else refs.add(op.ref)
      }
      continue
    }
    if (op.action === 'node.delete' || op.action === 'node.update') {
      if (!resolveTarget(op.nodeId)) errors.push({ index, code: 'NODE_NOT_FOUND' })
      continue
    }
    if (op.action === 'edge.delete') {
      if (!existingEdgeIds.has(op.edgeId)) errors.push({ index, code: 'EDGE_NOT_FOUND' })
      continue
    }
    if (op.action === 'edge.create') {
      for (const endpoint of [op.from, op.to]) {
        if (!resolveTarget(endpoint.nodeId)) errors.push({ index, code: 'NODE_NOT_FOUND' })
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true }
}
