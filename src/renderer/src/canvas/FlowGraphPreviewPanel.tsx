import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { Editor } from 'tldraw'
import type { FlowGraphPreview } from '@shared/agent-flow/flow-graph-compiler'
import type {
  CompositeResolutionMap,
  GraphPatchOp,
  MediaResolutionMap
} from '@shared/agent-access/graph-ops'
import { commitFlowGraph } from './flow-build-actions'
import {
  clearFlowGraphPreview,
  setFlowBuildPreview,
  setFlowGraphPreview,
  type FlowBuildPreviewLike
} from './flow-build-preview-store'
import { planGraphPatch } from './graph-patch'
import { applyFlowLayout } from './flow-layout-apply'
import { markUndoPoint } from './history'
import { ensureCanvasSaved } from './flow-asset-actions'
import { useGatewayStore } from '../stores/gateway'
import './flow-graph-preview-panel.css'

type PatchPreviewEntry = FlowBuildPreviewLike & {
  previewKind: 'patch'
  name: string
  autoLayout: boolean
  summary: {
    nodeCreated: number
    nodeUpdated: number
    nodeDeleted: number
    edgeCreated: number
    edgeDeleted: number
  }
}

type UnifiedPreview = FlowGraphPreview | PatchPreviewEntry

function isPatchPreview(preview: UnifiedPreview): preview is PatchPreviewEntry {
  return (preview as PatchPreviewEntry).previewKind === 'patch'
}

/**
 * 项目级「外部建图预览」面板（同时支持 FlowGraph 预览与方案 A 全 34 节点 graph.patch.propose 幽灵预览）。
 * 外部 Agent 提议建图后，这里列出待确认预览并复用幽灵预览层显示节点/边，
 * 人明确「确认落画布」才经渲染器权威应用；外部不能绕过确认。无待确认预览时不渲染。
 */
export function FlowGraphPreviewPanel({
  editor,
  projectId
}: {
  editor: Editor
  projectId: string
}): JSX.Element | null {
  const [previews, setPreviews] = useState<UnifiedPreview[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const previewsRef = useRef(previews)
  useEffect(() => {
    previewsRef.current = previews
  }, [previews])

  const refresh = useCallback(async (): Promise<void> => {
    const reply = await window.api.graphFlowAgent({ action: 'list', projectId })
    if (!reply.ok) return
    const list = ((reply.data as UnifiedPreview[] | null) ?? []).filter(
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
      if (preview.state === 'preview') {
        if (isPatchPreview(preview)) setFlowBuildPreview(projectId, preview.nodeId, preview)
        else setFlowGraphPreview(projectId, preview)
      } else {
        clearFlowGraphPreview(projectId, preview.nodeId)
      }
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

  const confirm = async (preview: UnifiedPreview): Promise<void> => {
    setBusy(preview.buildId)
    setError(null)
    try {
      if (isPatchPreview(preview)) {
        const prepared = await window.api.graphFlowAgent({
          action: 'prepare-patch',
          projectId,
          buildId: preview.buildId
        })
        if (!prepared.ok || !prepared.data) {
          throw new Error(prepared.ok ? '预览数据已失效' : prepared.error.message)
        }
        const payload = prepared.data as unknown as {
          preview: { ops: GraphPatchOp[]; autoLayout: boolean }
          mediaResolutions?: MediaResolutionMap
          compositeResolutions?: CompositeResolutionMap
        }
        const bindings = useGatewayStore.getState().modelBindings
        const planned = planGraphPatch(
          editor,
          payload.preview.ops,
          bindings,
          payload.mediaResolutions,
          payload.compositeResolutions
        )
        if (!planned.ok) {
          throw new Error(
            `画布变更校验失败：${planned.issue.code}${planned.issue.detail ? `（${planned.issue.detail}）` : ''}`
          )
        }
        markUndoPoint(editor, 'external-graph-patch-preview-commit')
        planned.plan.apply(editor)
        if (payload.preview.autoLayout) {
          applyFlowLayout(editor, 'auto')
        }
        await ensureCanvasSaved()
        await window.api.graphFlowAgent({
          action: 'mark-patch-committed',
          projectId,
          buildId: preview.buildId
        })
      } else {
        await commitFlowGraph(editor, preview)
      }
      clearFlowGraphPreview(projectId, preview.nodeId)
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const discard = async (preview: UnifiedPreview): Promise<void> => {
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
      {pending.map((preview) => {
        const title = isPatchPreview(preview) ? preview.name : preview.graph.name
        const metaText = isPatchPreview(preview)
          ? `+${preview.summary.nodeCreated} 节点 · +${preview.summary.edgeCreated} 连线${
              preview.summary.nodeUpdated > 0 ? ` · 改 ${preview.summary.nodeUpdated}` : ''
            }${preview.summary.nodeDeleted > 0 ? ` · 删 ${preview.summary.nodeDeleted}` : ''}`
          : `${preview.nodes.length} 节点 · ${preview.edges.length} 数据边`
        return (
          <div className="flow-graph-preview-panel-item" key={preview.buildId}>
            <div className="flow-graph-preview-panel-item-head">
              <strong>{title}</strong>
              <span>{metaText}</span>
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
        )
      })}
    </div>
  )
}
