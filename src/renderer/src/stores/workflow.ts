// 工作流模板存储（LibTV 工作流 Tab）：保存/列出/套用节点组合模板
// 使用 localStorage 持久化，零数据库迁移成本
import { create } from 'zustand'
import type { NodeCardShape } from '../canvas/NodeCardShape'

export interface TemplateNode {
  nodeType: string
  title: string
  dx: number
  dy: number
  w: number
  h: number
  text?: string
  mediaId?: string
  mediaPath?: string
  mediaMime?: string
}

export interface TemplateEdge {
  fromIdx: number
  toIdx: number
  fromPort?: string
  toPort?: string
}

export interface WorkflowTemplate {
  id: string
  name: string
  createdAt: number
  nodes: TemplateNode[]
  edges: TemplateEdge[]
  nodeCount: number
}

export interface SavePayload {
  nodes: TemplateNode[]
  edges: TemplateEdge[]
}

interface WorkflowState {
  templates: WorkflowTemplate[]
  loaded: boolean
  load: () => void
  save: (name: string, data: SavePayload) => void
  remove: (id: string) => void
}

const STORAGE_KEY = 'canvas-studio:wf-templates'

function readStore(): WorkflowTemplate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as WorkflowTemplate[]
    if (!Array.isArray(arr)) return []
    return arr
  } catch {
    return []
  }
}

function writeStore(templates: WorkflowTemplate[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates))
  } catch {
    // localStorage 满或被禁用时静默失败
  }
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  templates: [],
  loaded: false,

  load: () => {
    if (get().loaded) return
    set({ templates: readStore(), loaded: true })
  },

  save: (name, data) => {
    if (data.nodes.length === 0) return
    const tmpl: WorkflowTemplate = {
      id: `wf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: name.trim() || `模板 ${get().templates.length + 1}`,
      createdAt: Date.now(),
      nodes: data.nodes,
      edges: data.edges,
      nodeCount: data.nodes.length
    }
    const next = [tmpl, ...get().templates]
    writeStore(next)
    set({ templates: next })
  },

  remove: (id) => {
    const next = get().templates.filter((t) => t.id !== id)
    writeStore(next)
    set({ templates: next })
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
    mediaId: n.props.mediaId,
    mediaPath: n.props.mediaPath,
    mediaMime: n.props.mediaMime
  }))
  return { nodes, edges: arrowMeta }
}
