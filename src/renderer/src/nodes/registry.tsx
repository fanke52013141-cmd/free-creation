// NodeType 注册表（扩展点①，见《技术框架与规范》§5.1）
// 新增节点类型 = 写一份 Spec 并 register，核心零改动
import type { NodeTypeId, PortDecl, PortType } from '@shared/types'
import { nodeSchemaRegistered } from '@shared/node-schemas'
import type { NodeCardShape } from '../canvas/NodeCardShape'
import type { IconName } from '../components/Icon'

export interface PreviewPayload {
  kind: 'image' | 'video' | 'audio'
  url: string
  title: string
}

export interface NodeBodyProps {
  shape: NodeCardShape
  openPreview: (p: PreviewPayload) => void
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
  /** 是否出现在新增节点入口；退役节点保留执行与数据兼容，但不允许再新建。 */
  creatable?: boolean
  /** 输入/输出端口声明，连线类型校验与端口圆点渲染的依据 */
  ports: { in: PortDecl[]; out: PortDecl[] }
  Body: React.ComponentType<NodeBodyProps>
}

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
function validateNodeTypeSpec(spec: NodeTypeSpec): void {
  const errors: string[] = []
  if (!Number.isInteger(spec.contractVersion) || spec.contractVersion < 1) {
    errors.push('contractVersion 必须是大于等于 1 的整数')
  }
  if (!spec.label.trim()) errors.push('label 不能为空')
  if (!spec.description.trim()) errors.push('description 不能为空')
  if (
    !Number.isFinite(spec.defaultSize.w) ||
    !Number.isFinite(spec.defaultSize.h) ||
    spec.defaultSize.w <= 0 ||
    spec.defaultSize.h <= 0
  ) {
    errors.push('defaultSize 必须是大于 0 的有效数字')
  }

  const ids = new Set<string>()
  for (const [direction, ports] of [
    ['in', spec.ports.in],
    ['out', spec.ports.out]
  ] as const) {
    for (const current of ports) {
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

export function allNodeTypes(): NodeTypeSpec[] {
  return Array.from(registry.values()).filter((spec) => spec.creatable !== false)
}

export function mediaUrl(relPath: string): string {
  return `media:///${relPath.split('/').map(encodeURIComponent).join('/')}`
}
