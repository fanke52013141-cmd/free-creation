import { useEffect, useRef, useState } from 'react'
import type { Editor } from 'tldraw'
import type { AssetSubmit, FlowAssetSummary, FlowAssetVersion } from '@shared/agent-flow/assets'
import { newSpanId, newTraceId } from '@shared/observability'
import type { NodeCardShape } from './NodeCardShape'
import { AppSelect } from '../components/AppSelect'
import { ensureCanvasSaved, placeFlowAsset } from './flow-asset-actions'
import { beginAssetPlacement } from './flow-asset-diagnostics'
import './flow-assets.css'

export function FlowAssetPanel({
  editor,
  shape,
  projectId
}: {
  editor: Editor
  shape: NodeCardShape
  projectId: string
}): React.JSX.Element | null {
  const supported = ['text', 'json', 'processor'].includes(shape.props.nodeType)
  const portId =
    shape.props.nodeType === 'text'
      ? 'out-text'
      : shape.props.nodeType === 'json'
        ? 'out-json'
        : 'out-value'
  const [versions, setVersions] = useState<FlowAssetSummary[]>([])
  const [selected, setSelected] = useState('')
  const [version, setVersion] = useState<FlowAssetVersion | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = useRef(true)
  const pending = useRef<AssetSubmit | null>(null)
  useEffect(() => {
    active.current = true
    if (!supported || !window.api.listFlowAssets) return
    void window.api
      .listFlowAssets({ projectId, nodeId: shape.id, portId })
      .then((result) => {
        if (!active.current) return
        if (result.ok && result.data) setVersions(result.data)
        else setError('读取资产版本失败，请重新打开面板')
      })
      .catch(() => {
        if (active.current) setError('读取资产版本失败，请重新打开面板')
      })
    return () => {
      active.current = false
    }
  }, [projectId, shape.id, portId, supported])
  if (!supported || !window.api.submitFlowAsset) return null

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      if (!pending.current) {
        await ensureCanvasSaved()
        const saved = await window.api.openProject(projectId)
        if (!saved.ok || !saved.data) throw new Error('无法读取已保存画布')
        const record = (saved.data.tldrawSnapshot as { store?: Record<string, NodeCardShape> })
          ?.store?.[shape.id]
        const current = editor.getShape<NodeCardShape>(shape.id)
        const signature = (node?: NodeCardShape): string =>
          JSON.stringify([node?.props, node?.meta])
        if (!record || !current || signature(record) !== signature(current))
          throw new Error('节点有尚未保存的修改，请重新提交')
        pending.current = {
          projectId,
          nodeId: shape.id,
          portId,
          submissionId: crypto.randomUUID(),
          expectedGraphVersion: saved.data.meta.graphVersion,
          traceId: newTraceId(),
          spanId: newSpanId()
        }
      }
      const result = await window.api.submitFlowAsset(pending.current)
      if (!result.ok || !result.data) {
        pending.current = null
        throw new Error(result.ok ? '资产提交失败' : result.error.message)
      }
      pending.current = null
      if (!active.current) return
      const created = result.data
      setVersion(created)
      setSelected(created.ref.versionId)
      setVersions((previous) => [{ ...created }, ...previous].slice(0, 100))
    } catch (failure) {
      if (active.current)
        setError(
          pending.current
            ? '提交回执未收到。再次点击将核对同一次提交，不会生成重复版本。'
            : failure instanceof Error
              ? failure.message
              : '资产提交失败'
        )
    } finally {
      if (active.current) setBusy(false)
    }
  }
  const read = async (versionId: string): Promise<void> => {
    setBusy(true)
    setError('')
    setSelected(versionId)
    setVersion(null)
    try {
      const result = await window.api.readFlowAsset({ projectId, versionId })
      if (active.current) {
        if (result.ok && result.data) setVersion(result.data)
        else setError('资产版本读取失败')
      }
    } catch {
      if (active.current) setError('资产版本读取失败')
    } finally {
      if (active.current) setBusy(false)
    }
  }
  return (
    <section className="contract-section flow-asset-panel">
      <h4>资产版本</h4>
      <p>提交已保存的输出。版本保持不变；放到画布后，可以从固定资产节点连接下游。</p>
      <div className="contract-run-actions">
        <button type="button" disabled={busy} onClick={() => void submit()}>
          提交当前输出为新版本
        </button>
      </div>
      {versions.length > 0 && (
        <AppSelect
          aria-label="已提交资产版本"
          value={selected}
          disabled={busy}
          onChange={(event) => void read(event.target.value)}
        >
          <option value="">选择版本</option>
          {versions.map((item) => (
            <option key={item.ref.versionId} value={item.ref.versionId}>
              v{item.ordinal} · {new Date(item.createdAt).toLocaleString()}
            </option>
          ))}
        </AppSelect>
      )}
      {version && (
        <>
          <p>当前查看 v{version.ordinal} · 已固定输出。修改节点正文不会更新这份版本。</p>
          <pre>
            {version.value.kind === 'json'
              ? JSON.stringify(version.value.data, null, 2)
              : version.value.text}
          </pre>
          <div className="contract-run-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const finish = beginAssetPlacement(projectId, shape.id)
                try {
                  placeFlowAsset(editor, version, shape.id)
                  finish(true)
                } catch {
                  finish(false)
                  setError('资产未能放到画布，请重试')
                }
              }}
            >
              将此版本放到画布
            </button>
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
