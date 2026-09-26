import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import { legacyCategory, planResourceNodes } from '@shared/library/blueprint'
import type { LibraryResourceDetail } from '@shared/library/types'
import { getNodeType } from '../nodes/registry'
import { markUndoPoint } from '../canvas/history'
import { useMediaStore } from '../stores/media'

/** Preflight before copying files, then commit all shapes in one undo segment. */
export async function insertResource(
  editor: Editor,
  projectId: string,
  detail: LibraryResourceDetail,
  componentIds: string[],
  variables: Record<string, Record<string, string>> = {}
): Promise<void> {
  const category = detail.category ?? legacyCategory(detail.formPreset, detail.components)
  const plans = planResourceNodes(
    category,
    detail.components,
    detail.selectedTitle,
    componentIds,
    variables
  )
  const nodes = plans.map((plan) => {
    const spec = getNodeType(plan.nodeType)
    if (!spec || spec.contractVersion !== plan.contractVersion)
      throw new Error(`「${plan.title}」节点未安装或版本不兼容`)
    return { ...plan, spec, id: createShapeId() }
  })
  const pageId = editor.getCurrentPageId()
  const result = await window.api.materializeLibraryResource({
    projectId,
    resourceId: detail.id,
    revisionId: detail.selectedRevisionId,
    componentIds,
    nodeBindings: nodes.map((node) => ({ componentId: node.componentId, nodeId: node.id }))
  })
  if (!result.ok) throw new Error(result.error.message)
  let mark: string | undefined
  try {
    if (editor.isDisposed || editor.getCurrentPageId() !== pageId)
      throw new Error('画布已关闭或切换，请在目标画布重新添加')
    const center = editor.getViewportPageBounds().center
    const columns = category.blueprint.layout === 'row' ? nodes.length : Math.min(3, nodes.length)
    const width = columns * 390 - 50
    const height = Math.ceil(nodes.length / columns) * 310 - 50
    const origin = { x: center.x - width / 2, y: center.y - height / 2 }
    const occupied = editor
      .getCurrentPageShapes()
      .filter((shape) => shape.type === 'node-card')
      .map((shape) => editor.getShapePageBounds(shape.id))
      .filter((bounds) => Boolean(bounds))
    if (
      occupied.some(
        (bounds) =>
          bounds &&
          origin.x < bounds.maxX + 32 &&
          origin.x + width > bounds.x - 32 &&
          origin.y < bounds.maxY + 70 &&
          origin.y + height > bounds.y - 70
      )
    ) {
      origin.y = Math.max(...occupied.map((bounds) => bounds!.maxY)) + 80
    }
    const instanceId = crypto.randomUUID()
    const shapes = nodes.map((node, index) => {
      const component = detail.components.find((item) => item.id === node.componentId)!
      const asset = result.data.componentAssets.find(
        (item) => item.componentId === node.componentId
      )?.asset
      if (component.blobPath && !asset) throw new Error(`「${node.title}」文件复制不完整`)
      return {
        id: node.id,
        type: 'node-card' as const,
        x: origin.x + (index % columns) * 390,
        y: origin.y + Math.floor(index / columns) * 310,
        props: {
          nodeType: node.nodeType,
          title: node.title,
          text: node.text ?? '',
          w: node.spec.defaultSize.w,
          h: node.spec.defaultSize.h,
          ...(asset ? { mediaId: asset.id, mediaPath: asset.path, mediaMime: asset.mime } : {})
        },
        meta: {
          librarySource: {
            resourceId: detail.id,
            revisionId: detail.selectedRevisionId,
            categoryId: category.id,
            categoryVersion: category.version,
            slotId: node.slotId,
            componentId: node.componentId,
            instanceId,
            usageId: result.data.usageId
          }
        }
      }
    })
    mark = editor.markHistoryStoppingPoint('before-insert-resource')
    editor.run(() => {
      editor.createShapes(shapes)
      const ids: TLShapeId[] = nodes.map((node) => node.id)
      if (ids.length > 1) editor.groupShapes(ids)
      else editor.select(...ids)
    })
    markUndoPoint(editor, 'insert-resource')
    editor.zoomToSelection({ animation: { duration: 200 } })
  } catch (error) {
    if (mark) editor.bailToMark(mark)
    const cleanup = await window.api.discardLibraryMaterialization({
      projectId,
      usageId: result.data.usageId
    })
    if (!cleanup.ok)
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}；文件清理失败：${cleanup.error.message}`
      )
    throw error
  }
  void useMediaStore.getState().refresh(projectId)
}
