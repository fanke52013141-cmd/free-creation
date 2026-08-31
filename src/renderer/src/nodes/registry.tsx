/* eslint-disable react-refresh/only-export-components -- 这是纯节点注册表，不导出 React 组件。 */
// NodeType 注册表（扩展点①，见《技术框架与规范》§5.1）
// 新增节点类型 = 写一份 Spec 并 register，核心零改动
import type {
  ActiveNodeTypeId,
  NodeExecutionMode,
  NodeTypeId,
  PortDecl,
  PortType
} from '@shared/types'
import { ACTIVE_NODE_TYPE_IDS } from '@shared/types'
import { nodeSchemaRegistered } from '@shared/node-schemas'
import { NODE_CATEGORY_IDS, type NodeCategoryId } from '@shared/palette-preferences'
import type { NodeExecutor } from '../engine/executor-types'
import type { NodeCardShape } from '../canvas/NodeCardShape'
import type { IconName } from '../components/Icon'
import type { RawNodeOutputs } from './nodeValues'

/** 节点分类，用于创建菜单的二级筛选。顺序即 Tab 顺序。 */
export const NODE_CATEGORIES = [
  { id: 'input', label: '素材输入' },
  { id: 'image', label: '图像处理' },
  { id: 'video', label: '视频处理' },
  { id: 'audio', label: '音频语音' },
  { id: 'logic', label: '逻辑流程' }
] as const satisfies ReadonlyArray<{ id: NodeCategoryId; label: string }>

export { NODE_CATEGORY_IDS, type NodeCategoryId }

export interface PreviewPayload {
  kind: 'image' | 'video' | 'audio'
  url: string
  title: string
}

export interface NodeBodyProps {
  shape: NodeCardShape
  openPreview: (p: PreviewPayload) => void
}

/** 节点自有设置面板。用于复杂配置，不让 NodeContractPanel 按节点类型写分支。 */
export interface NodeSettingsProps {
  shape: NodeCardShape
  editor: import('tldraw').Editor
  projectId: string
}

export interface NodeTypeSpec {
  type: NodeTypeId
  /** 输入输出契约版本。端口 ID、类型、必填性或 Schema 破坏性变化时必须递增。 */
  contractVersion: number
  label: string
  icon: IconName
  color: string
  defaultSize: { w: number; h: number }
  /** 节点的业务职责；在选中节点的右侧 I/O 面板中常驻呈现。 */
  description: string
  /** 创建菜单二级筛选分类。 */
  category: NodeCategoryId
  /** 是否出现在新增节点入口；退役节点保留执行与数据兼容，但不允许再新建。 */
  creatable?: boolean
  /** 输入/输出端口声明，连线类型校验与端口圆点渲染的依据 */
  ports: { in: PortDecl[]; out: PortDecl[] }
  /**
   * 已持久化状态到端口数据的投影。每个有输出端口的节点都必须提供，避免由中央
   * switch 猜测节点类型；执行器只负责产生状态，投影只负责暴露已声明的输出。
   */
  projectOutputs?: (shape: NodeCardShape) => RawNodeOutputs
  /** 节点运行方式；默认 auto。 */
  executionMode?: NodeExecutionMode
  /**
   * 可选：根据节点实例配置动态解析端口。如果提供，优先于静态 ports 使用。
   * 用于代码节点等需要用户自定义输入端口的场景。
   * 静态 ports 仍用于注册校验和契约快照测试。
   */
  resolvePorts?: (shape: NodeCardShape) => { in: PortDecl[]; out: PortDecl[] }
  /**
   * 节点自注册执行器（契约规范 P3）。运行器按 nodeType 取出并调用 execute；
   * 新增普通节点只需在此注入自己的执行器，无需修改核心运行器。
   * 未声明执行器的节点在全局运行时会被标记为「未实现」并跳过，但不影响注册。
   */
  executor?: NodeExecutor
  /** 可选的节点专属设置界面；缺省时右侧面板仅展示安全的配置预览。 */
  SettingsPanel?: React.ComponentType<NodeSettingsProps>
  Body: React.ComponentType<NodeBodyProps>
}

/**
 * 所有可创建节点的初始画布尺寸。节点内部可以呈现不同内容，但初始占位必须一致；
 * 复杂配置放入右侧详情面板，不能以更大的默认卡片破坏画布节奏。
 */
export const STANDARD_NODE_SIZE = { w: 340, h: 260 } as const

// 端口类型配色（圆点描边）
export const PORT_COLORS: Record<PortType, string> = {
  text: '#8ab4f8',
  markdown: '#38bdf8',
  json: '#a78bfa',
  image: '#34d399',
  video: '#f472b6',
  audio: '#fbbf24',
  file: '#ffffff60',
  any: '#f7f7f7'
}

export function portCompatible(a: PortType, b: PortType): boolean {
  const bothTextual = (a === 'text' || a === 'markdown') && (b === 'text' || b === 'markdown')
  return a === b || bothTextual || a === 'any' || b === 'any'
}

/** 旧版本曾把画布坐标误当成缩略图单位，历史快照中会出现几千像素宽的节点。 */
const LEGACY_DEFAULT_SIZES: Partial<Record<NodeTypeId, { w: number; h: number }>> = {
  text: { w: 520, h: 300 },
  image: { w: 2880, h: 480 },
  'image-gen': { w: 340, h: 240 },
  video: { w: 2880, h: 480 },
  audio: { w: 2520, h: 240 },
  chat: { w: 2520, h: 340 },
  script: { w: 3240, h: 640 },
  processor: { w: 2520, h: 260 },
  json: { w: 2520, h: 400 },
  code: { w: 2880, h: 440 },
  storyboard: { w: 3420, h: 640 }
}

// 本轮规范化前曾发布过一组宽度不一致的尺寸；只匹配这些默认值，避免覆盖用户手动调整。
const PRE_STANDARD_DEFAULT_SIZES: Partial<Record<NodeTypeId, { w: number; h: number }>> = {
  text: { w: 320, h: 190 },
  image: { w: 320, h: 240 },
  'image-gen': { w: 340, h: 240 },
  video: { w: 320, h: 240 },
  audio: { w: 320, h: 180 },
  chat: { w: 320, h: 210 },
  script: { w: 400, h: 320 },
  processor: { w: 360, h: 210 },
  code: { w: 360, h: 260 },
  storyboard: { w: 420, h: 320 }
}

// 统一 340 × 260 规范之前已创建的默认卡片。仅列出曾作为默认值发布过的尺寸，
// 不会覆盖用户手动拉伸后的节点。
const PRIOR_UNIFIED_SIZES: Partial<Record<NodeTypeId, { w: number; h: number }>> = {
  text: { w: 340, h: 200 },
  image: { w: 340, h: 240 },
  video: { w: 340, h: 240 },
  audio: { w: 340, h: 190 },
  chat: { w: 340, h: 220 },
  script: { w: 340, h: 300 },
  processor: { w: 340, h: 210 },
  json: { w: 340, h: 230 },
  code: { w: 340, h: 260 },
  storyboard: { w: 340, h: 300 }
}

export function needsNodeSizeMigration(type: string, w: number, h: number): boolean {
  const legacy = LEGACY_DEFAULT_SIZES[type as NodeTypeId]
  if (legacy && w === legacy.w && h === legacy.h) return true
  const preStandard = PRE_STANDARD_DEFAULT_SIZES[type as NodeTypeId]
  if (preStandard && w === preStandard.w && h === preStandard.h) return true
  const priorUnified = PRIOR_UNIFIED_SIZES[type as NodeTypeId]
  if (priorUnified && w === priorUnified.w && h === priorUnified.h) return true
  // 保守处理：只自动修正明显异常的尺寸，避免覆盖用户合理的手动调整。
  return w > 900 || h > 700
}

/** 同侧端口在卡片上的纵向落点（px，相对卡片顶部） */
export function portOffsets(count: number, cardH: number): number[] {
  if (count <= 0) return []
  // 端口按整张卡片（含标题）均分：1 个居中；2 个落在 1/4、3/4；
  // 3 个及以上按 n + 1 等分，保证左右端口与连线锚点使用同一坐标。
  if (count === 1) return [cardH / 2]
  if (count === 2) return [cardH / 4, (cardH * 3) / 4]
  return Array.from({ length: count }, (_, i) => (cardH * (i + 1)) / (count + 1))
}

const registry = new Map<NodeTypeId, NodeTypeSpec>()

/**
 * 新节点的硬性质量门。规则的完整解释、兼容策略和迁移流程见 /NODE_CONTRACT_SPEC.md。
 * 这里故意在注册阶段直接抛错：不完整的节点不能进入创建菜单，更不能留到运行时猜测。
 */
function portValidationErrors(ports: NodeTypeSpec['ports']): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  for (const [direction, items] of [
    ['in', ports.in],
    ['out', ports.out]
  ] as const) {
    for (const current of items) {
      if (current.dir !== direction) errors.push(`${current.id} 的 dir 与所在分组不一致`)
      if (!new RegExp(`^${direction}-[a-z0-9]+(?:-[a-z0-9]+)*$`).test(current.id)) {
        errors.push(`${current.id} 必须使用 ${direction}- 开头的 kebab-case 稳定 ID`)
      }
      if (ids.has(current.id)) errors.push(`端口 ID 重复：${current.id}`)
      ids.add(current.id)
      if (!current.name.trim()) errors.push(`${current.id} 缺少用户可见名称`)
      if (!current.description.trim()) errors.push(`${current.id} 缺少业务说明`)
      if (typeof current.required !== 'boolean')
        errors.push(`${current.id} 的 required 必须是布尔值`)
      if (current.cardinality !== 'one' && current.cardinality !== 'many') {
        errors.push(`${current.id} 的 cardinality 必须是 one 或 many`)
      }
      if (current.type === 'json' && !current.schema) {
        errors.push(`${current.id} 是 JSON 端口，必须声明 schema`)
      }
      if (current.type !== 'json' && current.schema) {
        errors.push(`${current.id} 不是 JSON 端口，不应声明 schema`)
      }
      if (
        current.schema &&
        (!current.schema.id.trim() ||
          !Number.isInteger(current.schema.version) ||
          current.schema.version < 1)
      ) {
        errors.push(`${current.id} 的 schema id/version 无效`)
      }
      if (current.schema && !nodeSchemaRegistered(current.schema)) {
        errors.push(
          `${current.id} 引用了未注册的 Schema：${current.schema.id}@${current.schema.version}`
        )
      }
    }
  }
  return errors
}

function validateNodeTypeSpec(spec: NodeTypeSpec): void {
  const errors: string[] = []
  if (!Number.isInteger(spec.contractVersion) || spec.contractVersion < 1) {
    errors.push('contractVersion 必须是大于等于 1 的整数')
  }
  if (!spec.label.trim()) errors.push('label 不能为空')
  if (!spec.description.trim()) errors.push('description 不能为空')
  if (!NODE_CATEGORIES.some((c) => c.id === spec.category)) {
    errors.push('category 必须是已注册的分类之一')
  }
  if (
    spec.executionMode !== undefined &&
    spec.executionMode !== 'auto' &&
    spec.executionMode !== 'manual-publish' &&
    spec.executionMode !== 'display-only'
  ) {
    errors.push('executionMode 必须是 auto、manual-publish 或 display-only')
  }
  if (spec.ports.out.length > 0 && !spec.projectOutputs) {
    errors.push('存在输出端口时必须声明 projectOutputs')
  }
  if (spec.creatable !== false && !ACTIVE_NODE_TYPE_IDS.includes(spec.type as ActiveNodeTypeId)) {
    errors.push('可创建节点必须声明为 ActiveNodeTypeId')
  }
  if (spec.creatable !== false && !spec.executor) {
    errors.push('可创建节点必须声明 executor')
  }
  if (
    !Number.isFinite(spec.defaultSize.w) ||
    !Number.isFinite(spec.defaultSize.h) ||
    spec.defaultSize.w <= 0 ||
    spec.defaultSize.h <= 0
  ) {
    errors.push('defaultSize 必须是大于 0 的有效数字')
  }
  if (
    spec.creatable !== false &&
    (spec.defaultSize.w !== STANDARD_NODE_SIZE.w || spec.defaultSize.h !== STANDARD_NODE_SIZE.h)
  ) {
    errors.push(`可创建节点的 defaultSize 必须为 ${STANDARD_NODE_SIZE.w} × ${STANDARD_NODE_SIZE.h}`)
  }

  errors.push(...portValidationErrors(spec.ports))

  if (errors.length > 0) {
    throw new Error(`节点契约不合法：${spec.type}\n- ${errors.join('\n- ')}`)
  }
}

export function registerNodeType(spec: NodeTypeSpec): void {
  validateNodeTypeSpec(spec)
  registry.set(spec.type, spec)
}

/** 旧节点类型退役时显式移出注册表，开发热更新也不会继续残留在创建菜单。 */
export function unregisterNodeType(type: NodeTypeId): void {
  registry.delete(type)
}

export function getNodeType(type: string): NodeTypeSpec | undefined {
  return registry.get(type as NodeTypeId)
}

/** 解析节点的实际端口：如果有 resolvePorts 则动态解析，否则返回静态 ports。 */
export function getNodePorts(
  spec: NodeTypeSpec,
  shape: NodeCardShape
): { in: PortDecl[]; out: PortDecl[] } {
  const ports = spec.resolvePorts ? spec.resolvePorts(shape) : spec.ports
  const errors = portValidationErrors(ports)
  if (errors.length > 0) {
    throw new Error(`节点动态端口不合法：${spec.type}\n- ${errors.join('\n- ')}`)
  }
  return ports
}

export function allNodeTypes(): NodeTypeSpec[] {
  return Array.from(registry.values()).filter((spec) => spec.creatable !== false)
}

/** 可创建节点的单一真值；菜单、模板和合规检查均以此为准。 */
export function activeNodeTypes(): NodeTypeSpec[] {
  return allNodeTypes()
}

export function isActiveNodeType(type: string): type is ActiveNodeTypeId {
  return activeNodeTypes().some((spec) => spec.type === type)
}

export function mediaUrl(relPath: string): string {
  return `media:///${relPath.split('/').map(encodeURIComponent).join('/')}`
}
