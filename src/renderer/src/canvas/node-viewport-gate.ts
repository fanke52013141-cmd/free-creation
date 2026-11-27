import type { Editor, TLShapeId } from 'tldraw'
import { canvasPerfPolicy } from './canvas-performance-tier'
import type { NodeCardShape } from './NodeCardShape'

/**
 * 离屏节点 LRU 保活表：仅在 Tier 1+ 启用，避免刚移出视口就立即卸载再挂载引起闪烁。
 * 选中、编辑、运行中（pending/queued/running）的节点始终保活。
 */
const lruByEditor = new WeakMap<Editor, Map<TLShapeId, number>>()

function getLru(editor: Editor): Map<TLShapeId, number> {
  let map = lruByEditor.get(editor)
  if (!map) {
    map = new Map()
    lruByEditor.set(editor, map)
  }
  return map
}

export function shouldMountNodeCardView(editor: Editor, shape: NodeCardShape): boolean {
  const policy = canvasPerfPolicy(editor)
  if (!policy.virtualizeOffscreenNodes) return true

  // 运行中 / 排队中节点始终挂载完整视图（进度遮罩与计时器不中断）。
  const exec = shape.props.exec
  if (exec === 'running' || exec === 'pending' || exec === 'queued') return true

  // 选中或编辑中的节点始终挂载。
  if (editor.getEditingShapeId() === shape.id) return true
  if (editor.getSelectedShapeIds().includes(shape.id)) return true

  const viewport = editor.getViewportPageBounds()
  const bounds = editor.getShapePageBounds(shape.id)
  if (!viewport || !bounds) return true

  const margin = policy.viewportMarginPx
  const inViewport =
    bounds.maxX >= viewport.minX - margin &&
    bounds.minX <= viewport.maxX + margin &&
    bounds.maxY >= viewport.minY - margin &&
    bounds.minY <= viewport.maxY + margin

  const lru = getLru(editor)
  if (inViewport) {
    // 刷新 LRU 位置（移到末尾）
    lru.delete(shape.id)
    lru.set(shape.id, Date.now())
    if (lru.size > policy.offscreenLruLimit * 2) {
      const excess = lru.size - policy.offscreenLruLimit
      let removed = 0
      for (const key of lru.keys()) {
        if (removed >= excess) break
        lru.delete(key)
        removed += 1
      }
    }
    return true
  }

  // 离屏但在 LRU 窗口内：保活
  if (lru.has(shape.id)) {
    // 若超出上限则淘汰最老的离屏项
    if (lru.size > policy.offscreenLruLimit) {
      let rank = 0
      const keepFrom = lru.size - policy.offscreenLruLimit
      for (const key of lru.keys()) {
        if (key === shape.id) return rank >= keepFrom
        rank += 1
      }
    }
    return true
  }

  return false
}
