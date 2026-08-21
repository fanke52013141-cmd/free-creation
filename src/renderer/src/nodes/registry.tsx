// NodeType 注册表（扩展点①，见《技术框架与规范》§5.1）
// 新增节点类型 = 写一份 Spec 并 register，核心零改动
import type { NodeTypeId } from '@shared/types'
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
  Body: React.ComponentType<NodeBodyProps>
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
