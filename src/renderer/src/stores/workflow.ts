// 工作流模板存储（LibTV 工作流 Tab）：经主进程 SQLite 保存为本机全局模板。
import { create } from 'zustand'
import type { WorkflowTemplateRecord } from '@shared/contracts'
import type { NodeCardShape } from '../canvas/NodeCardShape'

export interface TemplateNode {
  nodeType: string
  title: string
  dx: number
  dy: number
  w: number
  h: number
  text?: string
  config?: string
}

export interface TemplateEdge {
  fromIdx: number
  toIdx: number
  fromPort?: string
  toPort?: string
}

export interface WorkflowTemplate extends Omit<WorkflowTemplateRecord, 'nodes' | 'edges'> {
  nodes: TemplateNode[]
  edges: TemplateEdge[]
}

export interface SavePayload {
  nodes: TemplateNode[]
  edges: TemplateEdge[]
}

/** 统一将模板节点还原为画布节点。模板是流程蓝图，不能携带项目媒体。 */
export function templateNodeProps(node: TemplateNode): Partial<NodeCardShape['props']> {
  return {
    nodeType: node.nodeType,
    title: node.title,
    w: node.w,
    h: node.h,
    text: node.text ?? '',
    config: node.config ?? '',
    mediaId: '',
    mediaPath: '',
    mediaMime: ''
  }
}

interface WorkflowState {
  templates: WorkflowTemplate[]
  loaded: boolean
  load: () => Promise<void>
  save: (name: string, data: SavePayload) => Promise<WorkflowTemplate>
  remove: (id: string) => Promise<void>
}

function asTemplate(value: WorkflowTemplateRecord): WorkflowTemplate {
  return value as WorkflowTemplate
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  templates: [],
  loaded: false,

  load: async () => {
    if (get().loaded) return
    const result = await window.api.workspace.listTemplates()
    if (!result.ok) throw new Error(result.error.message)
    set({ templates: result.data.map(asTemplate), loaded: true })
  },

  save: async (name, data) => {
    if (data.nodes.length === 0) throw new Error('模板至少需要一个节点')
    const result = await window.api.workspace.saveTemplate({
      name: name.trim() || `模板 ${get().templates.length + 1}`,
      nodes: data.nodes,
      edges: data.edges,
      nodeCount: data.nodes.length
    })
    if (!result.ok) throw new Error(result.error.message)
    const template = asTemplate(result.data)
    set({ templates: [template, ...get().templates] })
    return template
  },

  remove: async (id) => {
    const result = await window.api.workspace.deleteTemplate(id)
    if (!result.ok) throw new Error(result.error.message)
    set({ templates: get().templates.filter((template) => template.id !== id) })
  }
}))

// 工具函数：从编辑器选中形状提取可保存的模板数据
export function extractTemplateFromSelection(
  nodeShapes: NodeCardShape[],
  arrowMeta: { fromIdx: number; toIdx: number; fromPort?: string; toPort?: string }[]
): SavePayload {
  if (nodeShapes.length === 0) return { nodes: [], edges: [] }
  const cx = nodeShapes.reduce((s, n) => s + n.x, 0) / nodeShapes.length
  const cy = nodeShapes.reduce((s, n) => s + n.y, 0) / nodeShapes.length
  const nodes: TemplateNode[] = nodeShapes.map((n) => ({
    nodeType: n.props.nodeType,
    title: n.props.title,
    dx: n.x - cx,
    dy: n.y - cy,
    w: n.props.w,
    h: n.props.h,
    text: n.props.text,
    config: n.props.config
  }))
  return { nodes, edges: arrowMeta }
}
