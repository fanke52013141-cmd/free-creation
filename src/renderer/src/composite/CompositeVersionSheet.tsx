// 节点流全屏编辑器的「历史版本」底部弹层：查看旧版本（载入画布）或切换为旧版本。
// 行样式复用应用历史记录面板（history-card），整体走应用主题变量。
// 已发布版本不可变：切换 = 以旧版本内容发布新的主版本；历史与已绑定实例全部保留。
import { useEffect, useState } from 'react'
import type { CompositeCapabilitySummary, CompositeVersionRecord } from '@shared/composite/types'
import type { CompositeManifest } from '@shared/composite/manifest'
import { Icon } from '../components/Icon'
import { toast } from '../stores/toast'
import { useConfirmStore } from '../stores/confirm'

interface Props {
  capability: CompositeCapabilitySummary
  /** 编辑器当前有未保存修改：切换/载入的确认里必须明示这些修改会被丢弃。 */
  dirty?: boolean
  onClose: () => void
  /** 查看：把旧版本内容载入编辑器画布继续编辑（不直接发布）。 */
  onLoadVersion: (manifest: CompositeManifest) => void
  /** 切换成功后：刷新列表并退出编辑器（当前编辑内容已被新版本取代）。 */
  onSwitched: () => void
}

function nextVersion(version: string | null): string {
  const major = Number.parseInt(version ?? '0', 10)
  return `${Number.isFinite(major) ? major + 1 : 1}.0`
}

function versionLabel(version: string): string {
  return version.replace(/\.0\.0$/, '.0')
}

export function CompositeVersionSheet({
  capability,
  dirty = false,
  onClose,
  onLoadVersion,
  onSwitched
}: Props): React.JSX.Element {
  const [versions, setVersions] = useState<CompositeVersionRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const targetVersion = nextVersion(capability.latestVersion)

  useEffect(() => {
    void window.api.composite.versionList(capability.id).then((result) => {
      if (result.ok) setVersions(result.data)
      else setError('读取版本历史失败')
    })
  }, [capability.id])

  const loadVersion = async (record: CompositeVersionRecord): Promise<void> => {
    if (
      dirty &&
      !(await useConfirmStore.getState().confirm({
        title: `载入 v${versionLabel(record.version)}`,
        message: '编辑器当前有未保存的修改，载入旧版本会覆盖这些内容。仍要载入吗？',
        confirmText: '载入'
      }))
    )
      return
    setBusy(true)
    setError('')
    try {
      const result = await window.api.composite.versionGet({
        capabilityId: capability.id,
        version: record.version
      })
      if (!result.ok || !result.data) throw new Error('读取版本失败')
      onLoadVersion(result.data.manifest)
      toast(`已载入 v${versionLabel(record.version)}，可继续编辑；保存或另存为新版本后生效`)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const switchToVersion = async (record: CompositeVersionRecord): Promise<void> => {
    if (
      !(await useConfirmStore.getState().confirm({
        title: `切换为 v${versionLabel(record.version)}`,
        message: `将以 v${versionLabel(record.version)} 的内容发布新版本 v${versionLabel(targetVersion)} 并作为当前版本。${dirty ? '编辑器当前有未保存的修改，切换后这些修改将被丢弃。' : ''}`,
        confirmText: '切换'
      }))
    )
      return
    setBusy(true)
    setError('')
    try {
      const result = await window.api.composite.versionGet({
        capabilityId: capability.id,
        version: record.version
      })
      if (!result.ok || !result.data) throw new Error('读取版本失败')
      const next: CompositeManifest = { ...result.data.manifest, version: targetVersion }
      const published = await window.api.composite.publish({ manifest: next })
      if (!published.ok) throw new Error(published.error.message)
      toast(
        `已切换为 v${versionLabel(record.version)} 的内容（当前 v${versionLabel(targetVersion)}）`
      )
      onSwitched()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="nf-sheet-mask"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      <section className="nf-sheet" role="dialog" aria-modal="true" aria-label="历史版本">
        <header className="nf-sheet-header">
          <Icon name="history" size={15} />
          <strong>历史版本</strong>
          <span className="nf-sheet-count">{versions.length} 个版本</span>
          <button
            type="button"
            className="nf-sheet-close"
            aria-label="关闭历史版本"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" size={15} />
          </button>
        </header>
        <div className="nf-sheet-body scrollbar-hidden">
          {versions.length === 0 && !error && <p className="nf-sheet-empty">暂无历史版本</p>}
          {versions.map((record) => {
            const isCurrent = record.version === capability.latestVersion
            return (
              <div
                className={`history-card nf-version-row${isCurrent ? ' is-current' : ''}`}
                key={record.version}
              >
                <div className="history-card-info">
                  <span className="history-card-label">
                    v{versionLabel(record.version)}
                    {isCurrent && <em className="nf-version-current">当前版本</em>}
                  </span>
                  <time className="history-card-meta">
                    {new Date(record.publishedAt).toLocaleString('zh-CN', { hour12: false })}
                  </time>
                </div>
                {!isCurrent && (
                  <div className="history-card-actions">
                    <button
                      type="button"
                      className="btn-ghost small"
                      disabled={busy}
                      onClick={() => void loadVersion(record)}
                    >
                      查看
                    </button>
                    <button
                      type="button"
                      className="btn-ghost small"
                      disabled={busy}
                      onClick={() => void switchToVersion(record)}
                    >
                      切换为此版本
                    </button>
                  </div>
                )}
              </div>
            )
          })}
          {error && (
            <p className="nf-sheet-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </section>
    </div>
  )
}
