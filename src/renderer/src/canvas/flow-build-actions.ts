import type { Editor, TLShapeId } from 'tldraw'
import type { BuildPreview } from '@shared/agent-flow/builder'
import { canvasSemanticRevision } from '../engine/flow-command-bridge'
import { useAppStore } from '../stores/app'
import { getNodeType } from '../nodes/registry'
import { createEdge } from './graph'
import { markUndoPoint } from './history'
import { ensureCanvasSaved } from './flow-asset-actions'

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
  const specs = preview.nodes.map((node) => {
    const spec = getNodeType(node.type)
    if (!spec || spec.contractVersion !== 1 || editor.getShape(node.id as TLShapeId))
      throw new Error('节点契约或身份冲突')
    return spec
  })
  const anchor = editor.getShapePageBounds(preview.nodeId as TLShapeId) ?? {
    x: 0,
    y: 0,
    w: 340,
    h: 260
  }
  markUndoPoint(editor, 'flow-build-commit')
  const beforeIds = new Set(editor.getCurrentPageShapeIds())
  try {
    editor.run(() => {
      preview.nodes.forEach((node, index) => {
        editor.createShape({
          id: node.id as TLShapeId,
          type: 'node-card',
          x: anchor.x + anchor.w + 100 + Math.floor(index / 2) * 440,
          y: anchor.y + (index % 2) * 360,
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
