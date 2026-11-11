/* eslint-disable react-hooks/set-state-in-effect -- 弹窗异步加载版本与草稿后填充表单 */
// 节点流「编辑」基础信息弹窗：与创建时（WorkflowSaveDialog 组合模式）同一套
// library-form 弹窗样式——名称/说明 + 公开端口映射。
// 内部节点不在此编辑——「编辑节点」走全屏画布（CompositeCanvasEditor）。
// 保存 = 写入草稿（下次编辑自动恢复）；另存为新版本 = 发布不可变版本（版本号自动递增）。
import { useEffect, useState } from 'react'
import type { CompositeCapabilitySummary } from '@shared/composite/types'
import type { CompositeManifest } from '@shared/composite/manifest'
import { Icon } from '../components/Icon'
import { toast } from '../stores/toast'
import { CompositeBoundaryEditor } from '../composite/CompositeBoundaryEditor'
import './composite-editor.css'
import '../library/library.css'

interface Props {
  capability: CompositeCapabilitySummary
  onClose: () => void
  onPublished: () => void
}

function nextVersion(version: string | null): string {
  const major = Number.parseInt(version ?? '0', 10)
  return `${Number.isFinite(major) ? major + 1 : 1}.0`
}

function versionLabel(version: string | null): string {
  return (version ?? '—').replace(/\.0\.0$/, '.0')
}

export function CompositeVersionDialog({
  capability,
  onClose,
  onPublished
}: Props): React.JSX.Element {
  const [manifest, setManifest] = useState<CompositeManifest | null>(null)
  const [name, setName] = useState(capability.name)
  const [description, setDescription] = useState(capability.description)
  const [revision, setRevision] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // 发布目标版本始终高于当前最新发布，不提供手填，避免同版本覆盖被拒的困惑。
  const targetVersion = nextVersion(capability.latestVersion)

  useEffect(() => {
    const latest = capability.latestVersion
    if (!latest) {
      setError('该节点流还没有已发布版本')
      return
    }
    void Promise.all([
      window.api.composite.versionGet({ capabilityId: capability.id, version: latest }),
      window.api.composite.draftGet(capability.id)
    ]).then(([current, draft]) => {
      if (!current.ok || !current.data) {
        setError('读取节点流版本失败')
        return
      }
      // 有未发布草稿时优先恢复草稿，与「编辑节点」的恢复规则一致。
      const base = draft.ok && draft.data ? draft.data.manifest : current.data.manifest
      setManifest(base)
      setName(base.name)
      setDescription(base.description ?? '')
      setRevision(draft.ok && draft.data ? draft.data.revision : null)
    })
  }, [capability])

  const editedManifest = (): CompositeManifest | null =>
    manifest
      ? {
          ...manifest,
          version: targetVersion,
          name: name.trim() || manifest.name,
          description: description.trim() || undefined
        }
      : null

  // 保存：写入草稿，不产生新版本；下次「编辑 / 编辑节点」自动恢复。
  const saveDraft = async (): Promise<void> => {
    const edited = editedManifest()
    if (!edited) return setError('版本尚未加载')
    setBusy(true)
    setError('')
    try {
      const saved = await window.api.composite.draftSave({
        manifest: edited,
        expectedRevision: revision ?? 0
      })
      if (!saved.ok) throw new Error(saved.error.message)
      setRevision(saved.data.revision)
      setManifest(edited)
      toast('已保存，下次编辑会自动恢复')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  // 另存为新版本：校验后发布不可变新版本；旧版本与已绑定实例保持原样。
  const publish = async (): Promise<void> => {
    const edited = editedManifest()
    if (!edited) return setError('版本尚未加载')
    setBusy(true)
    setError('')
    try {
      const validated = await window.api.composite.validate({ manifest: edited })
      if (!validated.ok) throw new Error(validated.error.message)
      if (!validated.data.ok) {
        throw new Error(
          validated.data.issues
            .map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`)
            .join('；')
        )
      }
      const saved = await window.api.composite.draftSave({
        manifest: edited,
        expectedRevision: revision ?? 0
      })
      if (!saved.ok) throw new Error(saved.error.message)
      const published = await window.api.composite.publish({
        manifest: edited,
        expectedRevision: saved.data.revision
      })
      if (!published.ok) throw new Error(published.error.message)
      toast(`已另存为「${edited.name}」v${versionLabel(targetVersion)}`)
      onPublished()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="library-form-mask"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      <section
        className="library-form-dialog workflow-save-dialog is-composite"
        role="dialog"
        aria-modal="true"
        aria-label="编辑节点流"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape' && !busy) onClose()
        }}
      >
        <header className="library-form-header">
          <div>
            <h2>编辑节点流</h2>
          </div>
          <button
            type="button"
            className="library-form-close"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" size={17} />
          </button>
        </header>
        <div className="library-form-scroll">
          {!manifest && !error && <p className="composite-settings-hint">正在读取节点流内容…</p>}
          {manifest && (
            <>
              <label className="library-form-field">
                <span>内容名称</span>
                <input
                  autoFocus
                  maxLength={100}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value)
                    setError('')
                  }}
                  placeholder="例如：角色设定到分镜"
                />
              </label>
              <label className="library-form-field">
                <span>说明</span>
                <input
                  maxLength={600}
                  value={description}
                  onChange={(event) => {
                    setDescription(event.target.value)
                    setError('')
                  }}
                  placeholder="这个节点流做什么（可选）"
                />
              </label>
              <div className="workflow-save-composite">
                <CompositeBoundaryEditor
                  manifest={manifest}
                  disabled={busy}
                  onChange={setManifest}
                />
              </div>
            </>
          )}
          {error && (
            <div className="library-form-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <footer className="library-form-footer">
          <span>当前 v{versionLabel(capability.latestVersion)}</span>
          <button
            type="button"
            className="library-form-secondary"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="library-form-secondary"
            disabled={busy || !manifest}
            title="暂存修改，下次编辑自动恢复；不产生新版本"
            onClick={() => void saveDraft()}
          >
            保存
          </button>
          <button
            type="button"
            className="library-form-primary"
            disabled={busy || !manifest}
            onClick={() => void publish()}
          >
            {busy ? '处理中…' : `另存为新版本 v${versionLabel(targetVersion)}`}
          </button>
        </footer>
      </section>
    </div>
  )
}
