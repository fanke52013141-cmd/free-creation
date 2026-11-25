import { useEffect, useMemo, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import type { CompositeManifest } from '@shared/composite/manifest'
import type { CompositeUpgradePreviewResult } from '@shared/composite/upgrade'
import type { CompositeVersionRecord } from '@shared/composite/types'
import { readCompositeInstanceManifest } from '@shared/composite/outputs'
import { ensureCanvasSaved } from '../canvas/flow-asset-actions'
import type { NodeCardShape } from '../canvas/NodeCardShape'
import { toast } from '../stores/toast'
import { ModalShell } from '../components/ModalShell'
import { modalBtn } from '../components/modal-btn'

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
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState('')
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
        const [major, minor] = current.version.split('.').map(Number)
        const newer = list.data.find(({ version }) => {
          const [candidateMajor, candidateMinor] = version.split('.').map(Number)
          return candidateMajor > major || (candidateMajor === major && candidateMinor > minor)
        })
        if (newer) setTargetVersion(newer.version)
      }
    })
  }, [current?.capabilityId, current?.version])

  const requestKey =
    current && targetVersion ? `${current.capabilityId}@${current.version}->${targetVersion}` : ''
  const active = result && result.key === requestKey ? result : null
  const busy = applying || (requestKey !== '' && active === null)
  const preview = active?.preview ?? null
  const targetRecord = active?.record ?? null
  const error = applyError || active?.error || ''

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
      <ModalShell
        size="s"
        title="升级节点流"
        ariaLabel="升级节点流"
        onClose={onClose}
        footer={
          <button type="button" className={modalBtn('secondary')} onClick={onClose}>
            关闭
          </button>
        }
      >
        <p className="composite-close-confirm-text">
          这个节点流的版本信息无法读取，请从右侧「节点流」面板重新插入。
        </p>
      </ModalShell>
    )
  }

  const apply = async (): Promise<void> => {
    if (!preview?.ok || !targetRecord || applying) return
    setApplying(true)
    setApplyError('')
    const next: CompositeManifest = targetRecord.manifest
    const mark = editor.markHistoryStoppingPoint('composite-upgrade')
    const existingMeta = (editor.getShape(shapeId)?.meta as Record<string, unknown>) ?? {}
    try {
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
      await ensureCanvasSaved()
    } catch {
      editor.bailToMark(mark)
      await ensureCanvasSaved().catch(() => undefined)
      setApplyError('升级未保存，已恢复画布中的原版本。请重试。')
      return
    } finally {
      setApplying(false)
    }
    toast(`已升级到 v${versionLabel(next.version)}，原有连线全部保留`)
    onClose()
  }

  return (
    <ModalShell
      size="m"
      title="升级节点流"
      className="composite-publish-preview"
      ariaLabel="升级节点流"
      onClose={() => !busy && onClose()}
      closeOnEscape={!busy}
      closeOnOverlay={!busy}
      footer={
        <>
          <button type="button" className={modalBtn('secondary')} disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={modalBtn('primary')}
            disabled={busy || !preview?.ok || !targetRecord}
            title={preview?.ok ? '升级后现有连线会保留' : '有问题需要先处理，暂时不能升级'}
            onClick={() => void apply()}
          >
            {busy ? '正在检查…' : '确认升级'}
          </button>
        </>
      }
    >
      {/* 2026-11-21 弹窗统一：壳换 ModalShell（composite-publish-preview 为验收钩子类），
          版本选择/差异/检查内容类无作用域原样保留。 */}
      <div
        onKeyDown={(event) => {
          event.stopPropagation()
        }}
      >
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
              onChange={(event) => {
                setApplyError('')
                setTargetVersion(event.target.value)
              }}
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
              <h4>检查结果</h4>
              {preview.ok ? (
                <p className="composite-modal-pass">检查通过，可以直接升级，现有连线都会保留。</p>
              ) : (
                <ul className="composite-issue-list is-blocking">
                  {(preview.impact?.breaking ?? []).map((item, index) => (
                    <li key={`${item.portId}-${index}`}>{item.reason}</li>
                  ))}
                  {(preview.issues ?? []).map((issue, index) => (
                    <li key={`${issue.code}-${index}`}>{issue.message}</li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </ModalShell>
  )
}
