import type { Editor, TLShapeId } from 'tldraw'
import type { BuildPreview } from '@shared/agent-flow/builder'
import type { FlowGraphPreview } from '@shared/agent-flow/flow-graph-compiler'
import { canvasSemanticRevision } from '../engine/flow-command-bridge'
import { useAppStore } from '../stores/app'
import { getNodeType } from '../nodes/registry'
import { createEdge } from './graph'
import { markUndoPoint } from './history'
import { ensureCanvasSaved } from './flow-asset-actions'

/** 落画布共享内核消费的最小预览结构（builder 与外部 FlowGraph 预览同构）。 */
interface ApplicablePreview {
  buildId: string
  nodes: ReadonlyArray<{
    id: string
    type: string
    title: string
    text: string
    config: string
    contractVersion: number
    x: number
    y: number
  }>
  edges: ReadonlyArray<{ from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string } }>
}

/**
 * 渲染器权威落画布内核：逐节点契约 preflight → 单撤销步 → createShape/createEdge →
 * 失败仅回滚本步新建 → 保存屏障。builder 与外部 FlowGraph 共用，不另建第二权威。
 */
async function applyPreviewToCanvas(editor: Editor, preview: ApplicablePreview): Promise<void> {
  const specs = preview.nodes.map((node) => {
    const spec = getNodeType(node.type)
    if (
      !spec ||
      spec.contractVersion !== node.contractVersion ||
      editor.getShape(node.id as TLShapeId)
    )
      throw new Error('节点契约或身份冲突')
    return spec
  })
  markUndoPoint(editor, 'flow-build-commit')
  const beforeIds = new Set(editor.getCurrentPageShapeIds())
  try {
    editor.run(() => {
      preview.nodes.forEach((node, index) => {
        editor.createShape({
          id: node.id as TLShapeId,
          type: 'node-card',
          x: node.x,
          y: node.y,
          props: {
            nodeType: node.type,
            title: node.title,
            text: node.text,
            config: node.config,
            ...specs[index].defaultSize
          },
          meta: { flowBuildId: preview.buildId }
        })
      })
      for (const edge of preview.edges)
        if (
          !createEdge(
            editor,
            { shapeId: edge.from.nodeId as TLShapeId, portId: edge.from.portId },
            { shapeId: edge.to.nodeId as TLShapeId, portId: edge.to.portId },
            false
          )
        )
          throw new Error('端口连线未通过公共校验')
    })
  } catch (error) {
    // Only synchronously-created records are removed; existing canvas edits are preserved.
    editor.deleteShapes([...editor.getCurrentPageShapeIds()].filter((id) => !beforeIds.has(id)))
    throw error
  }
  // A save/IPC failure may already be committed. Preserve this graph for explicit reconciliation.
  await ensureCanvasSaved()
}

/** One history operation; deterministic identities allow confirmation after a lost IPC reply. */
export async function commitFlowBuild(
  editor: Editor,
  preview: BuildPreview
): Promise<BuildPreview> {
  if (useAppStore.getState().currentProject?.id !== preview.projectId) throw new Error('项目已切换')
  await ensureCanvasSaved()
  const grant = await window.api.buildFlowAgent({
    projectId: preview.projectId,
    nodeId: preview.nodeId,
    buildId: preview.buildId,
    action: 'authorize'
  })
  if (!grant.ok) throw new Error(grant.error.message)
  if (!grant.data) throw new Error('建图预览不存在')
  preview = grant.data
  if (preview.state === 'committed') return preview
  if (preview.state !== 'preview') throw new Error('预览已取消')
  const file = await window.api.openProject(preview.projectId)
  if (
    !file.ok ||
    !file.data ||
    (await canvasSemanticRevision(editor, file.data)) !== preview.semanticRevision
  )
    throw new Error('画布已修改，请重新生成预览')
  await applyPreviewToCanvas(editor, preview)
  const result = await window.api.buildFlowAgent({
    projectId: preview.projectId,
    nodeId: preview.nodeId,
    buildId: preview.buildId,
    action: 'confirm'
  })
  if (!result.ok || !result.data)
    throw new Error(result.ok ? '建图保存尚未确认' : result.error.message)
  editor.select(...preview.nodes.map((node) => node.id as TLShapeId))
  return result.data
}

/**
 * P5.3：外部 FlowGraph 预览落画布。与 commitFlowBuild 同一渲染器权威内核
 * （authorize → 语义修订 CAS → 单撤销步应用 → 保存屏障 → confirm），仅宿主 IPC 不同
 * （graphFlowAgent，source=graph）。外部 Agent 不能自确认：必须经此渲染器动作。
 */
export async function commitFlowGraph(
  editor: Editor,
  preview: FlowGraphPreview
): Promise<FlowGraphPreview> {
  if (useAppStore.getState().currentProject?.id !== preview.projectId) throw new Error('项目已切换')
  await ensureCanvasSaved()
  const grant = await window.api.graphFlowAgent({
    projectId: preview.projectId,
    buildId: preview.buildId,
    action: 'authorize'
  })
  if (!grant.ok) throw new Error(grant.error.message)
  if (!grant.data) throw new Error('建图预览不存在')
  preview = grant.data as FlowGraphPreview
  if (preview.state === 'committed') return preview
  if (preview.state !== 'preview') throw new Error('预览已取消')
  const file = await window.api.openProject(preview.projectId)
  if (
    !file.ok ||
    !file.data ||
    (await canvasSemanticRevision(editor, file.data)) !== preview.semanticRevision
  )
    throw new Error('画布已修改，请重新生成预览')
  await applyPreviewToCanvas(editor, preview)
  const result = await window.api.graphFlowAgent({
    projectId: preview.projectId,
    buildId: preview.buildId,
    action: 'confirm'
  })
  if (!result.ok || !result.data)
    throw new Error(result.ok ? '建图保存尚未确认' : result.error.message)
  editor.select(...preview.nodes.map((node) => node.id as TLShapeId))
  return result.data as FlowGraphPreview
}