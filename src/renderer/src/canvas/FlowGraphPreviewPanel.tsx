import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { Editor } from 'tldraw'
import type { FlowGraphPreview } from '@shared/agent-flow/flow-graph-compiler'
import { commitFlowGraph } from './flow-build-actions'
import { setFlowGraphPreview, clearFlowGraphPreview } from './flow-build-preview-store'
import './flow-graph-preview-panel.css'

/**
 * P5.2：项目级「外部建图预览」面板。外部上帝 Agent 经 CLI/MCP flowGraph.propose 产出
 * 预览后，这里列出待确认预览（复用幽灵预览层显示节点/边），人明确「确认落画布」才经
 * 渲染器权威 commitFlowGraph 应用；外部不能自确认。无待确认预览时不渲染。
 */
export function FlowGraphPreviewPanel({
  editor,
  projectId
}: {
  editor: Editor
  projectId: string
}): JSX.Element | null {
  const [previews, setPreviews] = useState<FlowGraphPreview[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const previewsRef = useRef(previews)
  useEffect(() => {
    previewsRef.current = previews
  }, [previews])

  const refresh = useCallback(async (): Promise<void> => {
    const reply = await window.api.graphFlowAgent({ action: 'list', projectId })
    if (!reply.ok) return
    const list = ((reply.data as FlowGraphPreview[] | null) ?? []).filter(
      (preview) => preview.projectId === projectId
    )
    // 无变化时保持同一引用，避免空轮询触发无谓重渲染（干扰画布键盘焦点时序）。
    setPreviews((prev) =>
      prev.length === list.length &&
      prev.every(
        (preview, index) =>
          preview.buildId === list[index].buildId &&
          preview.state === list[index].state &&
          preview.semanticRevision === list[index].semanticRevision
      )
        ? prev
        : list
    )
    for (const preview of list) {
      if (preview.state === 'preview') setFlowGraphPreview(projectId, preview)
      else clearFlowGraphPreview(projectId, preview.nodeId)
    }
  }, [projectId])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    let stopped = false
    const tick = async (): Promise<void> => {
      if (stopped) return
      if (!document.hidden) await refresh()
      if (stopped) return
      const pending = previewsRef.current.some((preview) => preview.state === 'preview')
      timer = setTimeout(tick, pending ? 1500 : 5000)
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [refresh])

  const confirm = async (preview: FlowGraphPreview): Promise<void> => {
    setBusy(preview.buildId)
    setError(null)
    try {
      await commitFlowGraph(editor, preview)
      clearFlowGraphPreview(projectId, preview.nodeId)
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const discard = async (preview: FlowGraphPreview): Promise<void> => {
    setBusy(preview.buildId)
    setError(null)
    try {
      const reply = await window.api.graphFlowAgent({
        action: 'discard',
        projectId,
        buildId: preview.buildId
      })
      if (!reply.ok) throw new Error(reply.error.message)
      clearFlowGraphPreview(projectId, preview.nodeId)
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const pending = previews.filter((preview) => preview.state === 'preview')
  if (pending.length === 0) return null
  return (
    <div className="flow-graph-preview-panel">
      <div className="flow-graph-preview-panel-title">外部建图预览（{pending.length}）</div>
      {error && <div className="flow-graph-preview-panel-error">{error}</div>}
      {pending.map((preview) => (
        <div className="flow-graph-preview-panel-item" key={preview.buildId}>
          <div className="flow-graph-preview-panel-item-head">
            <strong>{preview.graph.name}</strong>
            <span>
              {preview.nodes.length} 节点 · {preview.edges.length} 数据边
            </span>
          </div>
          <div className="flow-graph-preview-panel-actions">
            <button
              type="button"
              className="flow-graph-preview-confirm"
              disabled={busy !== null}
              onClick={() => void confirm(preview)}
            >
              {busy === preview.buildId ? '提交中…' : '确认落画布'}
            </button>
            <button
              type="button"
              className="flow-graph-preview-discard"
              disabled={busy !== null}
              onClick={() => void discard(preview)}
            >
              取消
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}