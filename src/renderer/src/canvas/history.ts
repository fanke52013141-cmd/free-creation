// 撤销历史分段：tldraw 的变更默认累积到 pendingDiff，没有分段点时一次 Ctrl+Z
// 会回退多步操作。每个逻辑操作结束后同步打一个分段点（stop mark）。
// 不用 rAF/microtask 延迟：页面不可见时 rAF 不触发，会导致分段点丢失。
import type { Editor } from 'tldraw'

export function markUndoPoint(editor: Editor, name: string): void {
  editor.markHistoryStoppingPoint(name)
}
