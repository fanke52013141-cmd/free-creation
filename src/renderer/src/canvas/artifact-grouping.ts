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

/**
 * 折叠态循环体成员（opacity:0 收拢进紧凑模板卡）必须对 tldraw 命中测试隐身：
 * 成员在展开时被 bringToFront 压在框卡上方，折叠后虽不可见但仍占据几何命中，
 * 画布点击命中的是隐藏成员而非紧凑卡——「展开」按钮永远收不到点击，
 * 表现为"收起顺畅、展开要点半天"。返回 'hidden' 后 tldraw 不渲染也不参与
 * getShapeAtPoint 命中（形状保留在 store，执行/布局逻辑不受影响）。
 */
export function artifactShapeVisibility(
  shape: TLShape,
  editor: Editor
): 'hidden' | 'inherit' {
  if (artifactShapeHidden(shape)) return 'hidden'
  if (shape.type === 'node-card') {
    const meta = shape.meta as Record<string, unknown>
    if (meta?.iterationTemplateMember === true && typeof meta.iterationTemplateLoopId === 'string') {
      const templateCard = editor
        .getCurrentPageShapes()
        .find(
          (s) =>
            s.type === 'node-card' &&
            (s.meta as Record<string, unknown>)?.iterationTemplateCard ===
              meta.iterationTemplateLoopId
        )
      if (
        templateCard &&
        (templateCard.meta as Record<string, unknown>)?.iterationTemplateExpanded !== true
      ) {
        return 'hidden'
      }
    }
  }
  return 'inherit'
}
