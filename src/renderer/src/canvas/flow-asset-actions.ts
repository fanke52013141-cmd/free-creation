import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import type { FlowAssetVersion, FlowAssetValue } from '@shared/agent-flow/assets'
import { useSaveCoordinator } from '../stores/save-coordinator'
import { getNodeType } from '../nodes/registry'
import { markUndoPoint } from './history'
import { findNodeContinuationPlacement } from './node-placement'

function nextAssetPosition(
  editor: Editor,
  sourceId: TLShapeId,
  size: { w: number; h: number }
): { x: number; y: number } {
  const source = editor.getShapePageBounds(sourceId) ?? { x: 0, y: 100, w: 340, h: 260 }
  const existing = editor
    .getCurrentPageShapes()
    .filter((shape) => shape.type === 'node-card')
    .flatMap((shape) => {
      const bounds = editor.getShapePageBounds(shape.id)
      return bounds ? [bounds] : []
    })
  return findNodeContinuationPlacement({ source, existing, targetW: size.w, targetH: size.h })
}

/** flush() alone may return while an earlier save is still in flight. */
export async function ensureCanvasSaved(): Promise<void> {
  const state = useSaveCoordinator.getState()
  if (!state.deps || state.phase === 'paused') throw new Error('当前画布无法保存')
  state.markDirty()
  await new Promise<void>((resolve, reject) => {
    let unsubscribe = (): void => {}
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error('等待画布保存超时，请重试'))
    }, 15000)
    const finish = (error?: Error): void => {
      clearTimeout(timeout)
      unsubscribe()
      if (error) reject(error)
      else resolve()
    }
    unsubscribe = useSaveCoordinator.subscribe((next) => {
      if (next.phase === 'saved' && !next.inFlight && next.dirtyVersion === next.persistedVersion)
        finish()
      else if ((!next.inFlight && next.lastError) || next.phase === 'paused')
        finish(new Error('画布保存失败或存在版本冲突'))
    })
    void state.flush()
  })
}

/** An ordinary text/JSON node with the existing immutable pinned-output protocol. */
export function placeFlowAsset(
  editor: Editor,
  version: FlowAssetVersion,
  sourceId: TLShapeId
): TLShapeId {
  const nodeType =
    version.value.kind === 'image'
      ? 'image'
      : version.value.kind === 'video'
        ? 'video-asset'
        : version.value.kind === 'audio'
          ? 'audio'
          : version.value.kind === 'json'
            ? 'json'
            : 'text'
  const portId =
    nodeType === 'image'
      ? 'out-image'
      : nodeType === 'video-asset'
        ? 'out-video'
        : nodeType === 'audio'
          ? 'out-audio'
          : nodeType === 'json'
            ? 'out-json'
            : 'out-text'
  const spec = getNodeType(nodeType)
  if (!spec) throw new Error('资产节点类型不可用')
  const position = nextAssetPosition(editor, sourceId, spec.defaultSize)
  const id = createShapeId()
  const text =
    version.value.kind === 'video' ||
    version.value.kind === 'image' ||
    version.value.kind === 'audio'
      ? ''
      : version.value.kind === 'json'
        ? JSON.stringify(version.value.data, null, 2)
        : version.value.text
  markUndoPoint(editor, 'flow-asset-place')
  editor.createShape({
    id,
    type: 'node-card',
    ...position,
    props: {
      nodeType,
      title: `资产 v${version.ordinal}`,
      text,
      config: '',
      ...(version.value.kind === 'video' ||
      version.value.kind === 'image' ||
      version.value.kind === 'audio'
        ? {
            mediaId: version.value.mediaId,
            mediaPath: version.value.mediaPath,
            mediaMime: version.value.mime
          }
        : {}),
      w: spec.defaultSize.w,
      h: spec.defaultSize.h
    },
    meta: {
      pinnedOutput: JSON.stringify({ version: 1, outputs: { [portId]: version.value } }),
      flowAssetRef: JSON.stringify(version.ref)
    }
  })
  editor.select(id)
  return id
}

export function createEditableAssetDraft(
  editor: Editor,
  source: import('./NodeCardShape').NodeCardShape,
  value: FlowAssetValue
): void {
  if (value.kind === 'video' || value.kind === 'image' || value.kind === 'audio')
    throw new Error('媒体资产为固定媒体引用，请创建新生成任务')
  const id = createShapeId()
  const nodeType = value.kind === 'json' ? 'json' : 'text'
  const spec = getNodeType(nodeType)
  if (!spec) throw new Error('资产节点类型不可用')
  const position = nextAssetPosition(editor, source.id, spec.defaultSize)
  markUndoPoint(editor, 'flow-asset-draft')
  editor.createShape({
    id,
    type: 'node-card',
    ...position,
    props: {
      nodeType,
      title: '资产草稿',
      text: value.kind === 'json' ? JSON.stringify(value.data, null, 2) : value.text
    }
  })
  editor.select(id)
  const created = editor.getShapePageBounds(id)
  if (created) editor.centerOnPoint(created.center, { animation: { duration: 180 } })
}
