import { useEffect, useMemo, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import type { CompositeManifest } from '@shared/composite/manifest'
import type { CompositeUpgradePreviewResult } from '@shared/composite/upgrade'
import type { CompositeVersionRecord } from '@shared/composite/types'
import { readCompositeInstanceManifest } from '@shared/composite/outputs'
import { markUndoPoint } from '../canvas/history'
import type { NodeCardShape } from '../canvas/NodeCardShape'
import { Icon } from '../components/Icon'
import { toast } from '../stores/toast'

interface Props {
  editor: Editor
  projectId: string
  shapeId: TLShapeId
  onClose: () => void
}

function versionLabel(version: string): string {
  return version.replace(/\.0\.0$/, '.0')
}

/**
 * 实例升级（W3）：选择已发布目标版本 → 与 CLI/MCP 同一份升级预检
 * （composite:upgrade:preview）→ 通过后以固定版本引用更新实例并保留兼容连线；
 * 取消或预检失败不改变原实例。
 */
export function CompositeUpgradeDialog({
  editor,
  projectId,
  shapeId,
  onClose
}: Props): React.JSX.Element {
  const shape = editor.getShape<NodeCardShape>(shapeId)
  const current = shape ? readCompositeInstanceManifest(shape) : null
  const [versions, setVersions] = useState<CompositeVersionRecord[]>([])
  const [targetVersion, setTargetVersion] = useState('')
  // 预检结果带请求键：切换目标版本/清空选择时按派生值失效，
  // 不在 effect 内同步 setState（避免级联渲染），也不会残留上一次的 busy。
  const [result, setResult] = useState<{
    key: string
    preview: CompositeUpgradePreviewResult | null
    record: CompositeVersionRecord | null
    error: string
  } | null>(null)

  useEffect(() => {
    if (!current) return
    void window.api.composite.versionList(current.capabilityId).then((list) => {
      if (list.ok) {
        setVersions(list.data)
        const newer = list.data.find(
          (record) => Number.parseInt(record.version, 10) > Number.parseInt(current.version, 10)
        )
        if (newer) setTargetVersion(newer.version)
      }
    })
  }, [current?.capabilityId, current?.version])

  const requestKey =
    current && targetVersion ? `${current.capabilityId}@${current.version}->${targetVersion}` : ''
  const active = result && result.key === requestKey ? result : null
  const busy = requestKey !== '' && active === null
  const preview = active?.preview ?? null
  const targetRecord = active?.record ?? null
  const error = active?.error ?? ''

  useEffect(() => {
    if (!current || !targetVersion) return
    const key = `${current.capabilityId}@${current.version}->${targetVersion}`
    let cancelled = false
    void (async () => {
      const record = await window.api.composite.versionGet({
        capabilityId: current.capabilityId,
        version: targetVersion
      })
      if (cancelled) return
      if (!record.ok || !record.data) {
        setResult({ key, preview: null, record: null, error: '读取目标版本失败' })
        return
      }
      const previewResult = await window.api.composite.upgradePreview({
        projectId,
        nodeId: String(shapeId),
        nextManifest: record.data.manifest
      })
      if (cancelled) return
      if (!previewResult.ok) {
        setResult({ key, preview: null, record: null, error: previewResult.error.message })
        return
      }
      setResult({ key, preview: previewResult.data, record: record.data, error: '' })
    })().catch((cause) => {
      if (!cancelled)
        setResult({
          key,
          preview: null,
          record: null,
          error: cause instanceof Error ? cause.message : String(cause)
        })
    })
    return () => {
      cancelled = true
    }
  }, [current?.capabilityId, current?.version, targetVersion, projectId, shapeId])

  const impact = preview?.impact ?? null
  const diffSummary = useMemo(() => {
    if (!impact) return []
    const lines: string[] = []
    if (impact.addedInputs.length) lines.push(`新增输入：${impact.addedInputs.join('、')}`)
    if (impact.addedOutputs.length) lines.push(`新增输出：${impact.addedOutputs.join('、')}`)
    if (impact.removedInputs.length) lines.push(`移除输入：${impact.removedInputs.join('、')}`)
    if (impact.removedOutputs.length) lines.push(`移除输出：${impact.removedOutputs.join('、')}`)
    for (const change of impact.typeChanged)
      lines.push(`类型变更：${change.portId}（${change.from} → ${change.to}）`)
    for (const change of impact.schemaChanged)
      lines.push(`Schema 变更：${change.portId}（${change.from ?? '无'} → ${change.to ?? '无'}）`)
    for (const change of impact.requiredChanged)
      lines.push(
        `必填性：${change.portId}（${change.from ? '必填' : '可选'} → ${change.to ? '必填' : '可选'}）`
      )
    for (const change of impact.cardinalityChanged)
      lines.push(`基数：${change.portId}（${change.from} → ${change.to}）`)
    return lines
  }, [impact])

  if (!shape || !current) {
    return (
      <div
        className="composite-modal-mask"
        onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      >
        <section
          className="composite-modal composite-close-confirm"
          role="dialog"
          aria-modal="true"
          aria-label="升级节点流实例"
        >
          <header className="composite-modal-header">
            <h3>升级节点流实例</h3>
          </header>
          <div className="composite-modal-scroll">
            <p className="composite-close-confirm-text">
              实例的固定版本快照无法读取，请从节点流面板重新插入。
            </p>
          </div>
          <footer className="composite-modal-footer">
            <button type="button" className="btn-ghost small" onClick={onClose}>
              关闭
            </button>
          </footer>
        </section>
      </div>
    )
  }

  const apply = (): void => {
    if (!preview?.ok || !targetRecord) return
    const next: CompositeManifest = targetRecord.manifest
    markUndoPoint(editor, 'composite-upgrade')
    const existingMeta = (editor.getShape(shapeId)?.meta as Record<string, unknown>) ?? {}
    editor.updateShape({
      id: shapeId,
      type: 'node-card',
      props: {
        config: JSON.stringify({
          capabilityId: next.capabilityId,
          version: next.version,
          contentHash: targetRecord.contentHash
        })
      },
      meta: { ...existingMeta, compositeManifest: next }
    } as never)
    toast(`已升级到 v${versionLabel(next.version)}（兼容连线已保留）`)
    onClose()
  }

  return (
    <div
      className="composite-modal-mask"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      <section
        className="composite-modal composite-publish-preview"
        role="dialog"
        aria-modal="true"
        aria-label="升级节点流实例"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape' && !busy) onClose()
        }}
      >
        <header className="composite-modal-header">
          <h3>升级节点流实例</h3>
          <button
            type="button"
            className="composite-modal-close"
            aria-label="关闭升级对话框"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="composite-modal-scroll">
          <div className="composite-publish-versions">
            <span className="composite-publish-version-badge">
              当前 v{versionLabel(current.version)}
            </span>
            <span className="composite-publish-version-arrow" aria-hidden="true">
              →
            </span>
            <label className="composite-upgrade-target">
              <span>目标版本</span>
              <select
                aria-label="目标版本"
                value={targetVersion}
                disabled={busy}
                onChange={(event) => setTargetVersion(event.target.value)}
              >
                <option value="">选择版本</option>
                {versions.map((record) => (
                  <option key={record.version} value={record.version}>
                    v{versionLabel(record.version)}
                    {record.version === current.version ? '（当前）' : ''}
                  </option>
                ))}
              </select>
            </label>
            <span className="composite-publish-name" title={current.name}>
              {current.name}
            </span>
          </div>
          {error && (
            <p className="composite-modal-error" role="alert">
              {error}
            </p>
          )}
          {preview && (
            <>
              <section className="composite-modal-section">
                <h4>接口差异（{diffSummary.length} 项）</h4>
                {diffSummary.length === 0 ? (
                  <p className="composite-modal-empty">接口无变化。</p>
                ) : (
                  <ul className="composite-dep-list">
                    {diffSummary.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="composite-modal-section">
                <h4>预检结果</h4>
                {preview.ok ? (
                  <p className="composite-modal-pass">预检通过，现有连线兼容，可升级。</p>
                ) : (
                  <ul className="composite-issue-list is-blocking">
                    {(preview.impact?.breaking ?? []).map((item, index) => (
                      <li key={`${item.portId}-${index}`}>
                        <code>{item.portId}</code> {item.reason}
                        {item.nodeId
                          ? `（节点 ${item.nodeId}${item.edgeId ? ` / 边 ${item.edgeId}` : ''}）`
                          : ''}
                      </li>
                    ))}
                    {(preview.issues ?? []).map((issue, index) => (
                      <li key={`${issue.code}-${index}`}>
                        <code>[{issue.code}]</code> {issue.path}: {issue.message}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
        <footer className="composite-modal-footer">
          <button type="button" className="btn-ghost small" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="run-btn"
            disabled={busy || !preview?.ok || !targetRecord}
            title={preview?.ok ? '升级实例并保留兼容连线' : '预检未通过，原实例保持不变'}
            onClick={apply}
          >
            {busy ? '预检中…' : '确认升级'}
          </button>
        </footer>
      </section>
    </div>
  )
}
