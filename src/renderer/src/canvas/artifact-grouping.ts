import type { Editor, TLShape } from 'tldraw'
import { markUndoPoint } from './history'

/**
 * 结果折叠功能已按用户要求整体移除（2026-10-05）：本轮产物始终全部可见。
 * 函数保留是因为旧项目快照里可能残留 resultGroupCollapsed: true 的历史标记，
 * 这里无条件视为可见，保证旧画布打开即自动展开且无法再进入折叠态。
 */
export function artifactShapeHidden(shape: TLShape): boolean {
  // 折叠功能已移除：无条件可见。参数仅为保持既有调用方与测试的签名。
  void shape
  return false
}

/** 清理旧快照遗留的折叠标记；对现役画布是无害的幂等操作。 */
export function showArtifactGroups(editor: Editor): void {
  markUndoPoint(editor, 'result-group-visibility')
  editor.run(() => {
    for (const shape of editor.getCurrentPageShapes()) {
      if (shape.type !== 'node-card' || shape.meta.resultGroupCollapsed !== true) continue
      editor.updateShape({
        id: shape.id,
        type: shape.type,
        meta: { resultGroupCollapsed: false }
      })
    }
  })
}

export function artifactShapeVisibility(shape: TLShape): 'hidden' | 'inherit' {
  return artifactShapeHidden(shape) ? 'hidden' : 'inherit'
}
