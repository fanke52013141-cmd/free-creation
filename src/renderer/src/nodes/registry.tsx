// NodeType 注册表（扩展点①，见《技术框架与规范》§5.1）
// 新增节点类型 = 写一份 Spec 并 register，核心零改动
import type { NodeTypeId, PortDecl, PortType } from '@shared/types'
import type { NodeCardShape } from '../canvas/NodeCardShape'

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
  label: string
  icon: string
  color: string
  defaultSize: { w: number; h: number }
  /** 输入/输出端口声明，连线类型校验与端口圆点渲染的依据 */
  ports: { in: PortDecl[]; out: PortDecl[] }
  Body: React.ComponentType<NodeBodyProps>
}

// 端口类型配色（圆点描边）
export const PORT_COLORS: Record<PortType, string> = {
  text: '#8ab4f8',
  json: '#a78bfa',
  image: '#34d399',
  video: '#f472b6',
  audio: '#fbbf24',
  file: '#9aa3b2',
  any: '#e6e9ef'
}

export function portCompatible(a: PortType, b: PortType): boolean {
  return a === b || a === 'any' || b === 'any'
}

// 卡片头部高度（端口与锚点计算依赖此值，与 app.css 的 .node-header 保持一致）
export const NODE_HEADER_H = 30

/** 同侧端口在卡片上的纵向落点（px，相对卡片顶部） */
export function portOffsets(count: number, cardH: number): number[] {
  if (count <= 0) return []
  const top = NODE_HEADER_H + 14
  const bottom = Math.max(top + 8, cardH - 12)
  if (count === 1) return [(top + bottom) / 2]
  const step = (bottom - top) / (count - 1)
  return Array.from({ length: count }, (_, i) => top + i * step)
}

const registry = new Map<NodeTypeId, NodeTypeSpec>()

export function registerNodeType(spec: NodeTypeSpec): void {
  registry.set(spec.type, spec)
}

export function getNodeType(type: string): NodeTypeSpec | undefined {
  return registry.get(type as NodeTypeId)
}

export function allNodeTypes(): NodeTypeSpec[] {
  return Array.from(registry.values())
}

export function mediaUrl(relPath: string): string {
  return `media:///${relPath.split('/').map(encodeURIComponent).join('/')}`
}
