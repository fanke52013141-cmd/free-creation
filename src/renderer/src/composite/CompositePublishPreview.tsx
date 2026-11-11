import { useMemo } from 'react'
import type { CompositeManifest } from '@shared/composite/manifest'
import { planCompositeUpgrade } from '@shared/composite/upgrade'
import { Icon } from '../components/Icon'

export interface CompositePublishValidationIssue {
  code: string
  path: string
  message: string
}

interface Props {
  capabilityName: string
  /** 最新已发布版本 manifest；首次发布为 null。 */
  baseManifest: CompositeManifest | null
  nextManifest: CompositeManifest
  validationIssues: CompositePublishValidationIssue[]
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

function versionLabel(version: string): string {
  return version.replace(/\.0\.0$/, '.0')
}

/**
 * 发布预览（W2-B，Stitch 屏幕 799a9a6cac9a4709ad5af67fc910dcfa）：
 * 基准/目标版本、接口差异、阻断问题与引用版本。差异复用实例升级同一份
 * planCompositeUpgrade 纯函数；校验问题阻断发布，升级阻断只作警示——
 * 已绑定实例仍按固定版本运行，升级需另行预检。
 */
export function CompositePublishPreview({
  capabilityName,
  baseManifest,
  nextManifest,
  validationIssues,
  busy,
  onCancel,
  onConfirm
}: Props): React.JSX.Element {
  const plan = useMemo(
    () => (baseManifest ? planCompositeUpgrade(baseManifest, nextManifest, []) : null),
    [baseManifest, nextManifest]
  )
  const impact = plan?.impact ?? null
  const diffCount = impact
    ? impact.addedInputs.length +
      impact.removedInputs.length +
      impact.addedOutputs.length +
      impact.removedOutputs.length +
      impact.typeChanged.length +
      impact.requiredChanged.length +
      impact.schemaChanged.length +
      impact.cardinalityChanged.length
    : 0
  const capabilityDeps = (nextManifest.dependencies ?? []).filter(
    (dep) => dep.kind === 'capability'
  )
  const blocked = validationIssues.length > 0

  return (
    <div
      className="composite-modal-mask"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onCancel()}
    >
      <section
        className="composite-modal composite-publish-preview"
        role="dialog"
        aria-modal="true"
        aria-label="另存为新版本预览"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape' && !busy) onCancel()
        }}
      >
        <header className="composite-modal-header">
          <h3>另存为新版本</h3>
          <button
            type="button"
            className="composite-modal-close"
            aria-label="关闭发布预览"
            disabled={busy}
            onClick={onCancel}
          >
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="composite-modal-scroll">
          <div className="composite-publish-versions">
            <span className="composite-publish-version-badge">
              基准 v{baseManifest ? versionLabel(baseManifest.version) : '—'}
            </span>
            <span className="composite-publish-version-arrow" aria-hidden="true">
              →
            </span>
            <span className="composite-publish-version-badge is-target">
              目标 v{versionLabel(nextManifest.version)}
            </span>
            <span className="composite-publish-name" title={capabilityName}>
              {capabilityName}
            </span>
          </div>

          <section className="composite-modal-section">
            <h4>接口差异{impact ? `（${diffCount} 项）` : ''}</h4>
            {!impact ? (
              <p className="composite-modal-empty">首次发布，无历史接口可比较。</p>
            ) : diffCount === 0 ? (
              <p className="composite-modal-empty">接口无变化。</p>
            ) : (
              <ul className="composite-diff-list">
                {impact.addedInputs.map((portId) => (
                  <li key={`ai-${portId}`}>
                    <span className="composite-diff-tag is-added">+ 新增输入</span>
                    <code>{portId}</code>
                  </li>
                ))}
                {impact.addedOutputs.map((portId) => (
                  <li key={`ao-${portId}`}>
                    <span className="composite-diff-tag is-added">+ 新增输出</span>
                    <code>{portId}</code>
                  </li>
                ))}
                {impact.removedInputs.map((portId) => (
                  <li key={`ri-${portId}`}>
                    <span className="composite-diff-tag is-removed">− 移除输入</span>
                    <code>{portId}</code>
                  </li>
                ))}
                {impact.removedOutputs.map((portId) => (
                  <li key={`ro-${portId}`}>
                    <span className="composite-diff-tag is-removed">− 移除输出</span>
                    <code>{portId}</code>
                  </li>
                ))}
                {impact.typeChanged.map((change) => (
                  <li key={`tc-${change.portId}`}>
                    <span className="composite-diff-tag is-changed">~ 类型变更</span>
                    <code>{change.portId}</code>
                    <span className="composite-diff-detail">
                      {change.from} → {change.to}
                    </span>
                  </li>
                ))}
                {impact.schemaChanged.map((change) => (
                  <li key={`sc-${change.portId}`}>
                    <span className="composite-diff-tag is-changed">~ Schema 变更</span>
                    <code>{change.portId}</code>
                    <span className="composite-diff-detail">
                      {change.from ?? '无'} → {change.to ?? '无'}
                    </span>
                  </li>
                ))}
                {impact.requiredChanged.map((change) => (
                  <li key={`rc-${change.portId}`}>
                    <span className="composite-diff-tag is-changed">~ 必填性</span>
                    <code>{change.portId}</code>
                    <span className="composite-diff-detail">
                      {change.from ? '必填' : '可选'} → {change.to ? '必填' : '可选'}
                    </span>
                  </li>
                ))}
                {impact.cardinalityChanged.map((change) => (
                  <li key={`cc-${change.portId}`}>
                    <span className="composite-diff-tag is-changed">~ 基数</span>
                    <code>{change.portId}</code>
                    <span className="composite-diff-detail">
                      {change.from} → {change.to}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="composite-modal-section">
            <h4>阻断问题</h4>
            {blocked ? (
              <ul className="composite-issue-list is-blocking">
                {validationIssues.map((issue, index) => (
                  <li key={`${issue.code}-${index}`}>
                    <code>[{issue.code}]</code> {issue.path}: {issue.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="composite-modal-pass">发布校验通过。</p>
            )}
            {impact && impact.breaking.length > 0 && (
              <ul className="composite-issue-list is-warning">
                {impact.breaking.map((item, index) => (
                  <li key={`${item.portId}-${index}`}>
                    <code>{item.portId}</code> {item.reason}
                    {item.nodeId
                      ? `（节点 ${item.nodeId}${item.edgeId ? ` / 边 ${item.edgeId}` : ''}）`
                      : ''}
                    <span className="composite-diff-detail">
                      已绑定实例仍按原版本运行；升级到本版本前需先处理。
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="composite-modal-section">
            <h4>引用版本</h4>
            {capabilityDeps.length === 0 ? (
              <p className="composite-modal-empty">不引用其他节点流。</p>
            ) : (
              <ul className="composite-dep-list">
                {capabilityDeps.map((dep) => (
                  <li key={`${dep.id}@${dep.version ?? '?'}`}>
                    <code>
                      {dep.id}@{dep.version ?? '?'}
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <footer className="composite-modal-footer">
          <button type="button" className="btn-ghost small" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="run-btn"
            disabled={busy || blocked}
            title={blocked ? '发布校验未通过，请先修复阻断问题' : '确认发布新版本'}
            onClick={onConfirm}
          >
            {busy ? '发布中…' : '确认发布'}
          </button>
        </footer>
      </section>
    </div>
  )
}
