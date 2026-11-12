import type { Editor } from 'tldraw'
import { layoutGraph, type LayoutMode, type LayoutNode, type ResolvedLayoutMode } from '@shared/flow-layout'
import type { CanvasNode } from '@shared/types'
import { deriveGraph } from './graph'
import { markUndoPoint } from './history'
import { focusCanvas } from './focus-canvas'
import type { NodeCardShape } from './NodeCardShape'

/**
 * 智能整理应用层（L2）：GUI 底部坞按钮、graph.layout op、graph.patch autoLayout
 * 共用本函数 → 同一 layoutGraph 纯函数，满足三入口 parity。
 * 只改 shape x/y（视图操作），不碰 config/meta/业务语义；单撤销步可回退。
 */

/** 从画布节点派生布局输入：角色/控制目标只读 config，解析失败按无角色处理。 */
export function toLayoutNode(node: CanvasNode): LayoutNode {
  let role: LayoutNode['role']
  let controls: string[] | undefined
  if (node.type === 'agent' || node.type === 'ai-review') {
    try {
      const config = JSON.parse(String(node.params.config ?? '{}')) as {
        role?: unknown
        allowedNodeIds?: unknown
        gatedNodeIds?: unknown
      }
      if (config.role === 'builder' || config.role === 'coordinator' || config.role === 'specialist')
        role = config.role
      const targets = node.type === 'agent' ? config.allowedNodeIds : config.gatedNodeIds
      if (Array.isArray(targets))
        controls = targets.filter((id): id is string => typeof id === 'string')
    } catch {
      // 配置损坏不影响布局：按无角色/无控制处理。
    }
  }
  return {
    id: node.id,
    type: node.type,
    x: node.x,
    y: node.y,
    w: node.w,
    h: node.h,
    title: node.title,
    ...(role ? { role } : {}),
    ...(controls ? { controls } : {})
  }
}

export interface FlowLayoutApplyResult {
  mode: ResolvedLayoutMode
  moved: number
}

export interface FlowLayoutApplyOptions {
  /** 缺省 true；graph.patch autoLayout 内嵌调用时传 false，由外层统一记单撤销步。 */
  undo?: boolean
  /** 缺省 true；内嵌调用时传 false，避免移动用户相机。 */
  focus?: boolean
}

export function applyFlowLayout(
  editor: Editor,
  mode: LayoutMode = 'auto',
  nodeIds?: readonly string[],
  opts: FlowLayoutApplyOptions = {}
): FlowLayoutApplyResult {
  const graph = deriveGraph(editor)
  const scope = nodeIds ? new Set(nodeIds) : null
  const nodes = scope ? graph.nodes.filter((node) => scope.has(node.id)) : graph.nodes
  const edges = graph.edges
    .filter((edge) => !scope || (scope.has(edge.from.nodeId) && scope.has(edge.to.nodeId)))
    .map((edge) => ({ from: edge.from.nodeId, to: edge.to.nodeId }))
  const result = layoutGraph(nodes.map(toLayoutNode), edges, mode)
  if (result.positions.length > 0) {
    editor.run(() => {
      editor.updateShapes(
        result.positions.map((pos) => ({
          id: pos.id as NodeCardShape['id'],
          type: 'node-card' as const,
          x: pos.x,
          y: pos.y
        }))
      )
    })
    if (opts.undo !== false) markUndoPoint(editor, 'flow-layout')
    if (opts.focus !== false) focusCanvas(editor)
  }
  return { mode: result.mode, moved: result.positions.length }
}