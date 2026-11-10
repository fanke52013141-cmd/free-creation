/* eslint-disable react-hooks/set-state-in-effect -- 弹窗异步加载固定版本后填充表单 */
import { useEffect, useState } from 'react'
import type { CompositeCapabilitySummary } from '@shared/composite/types'
import type { CompositeManifest } from '@shared/composite/manifest'
import { Icon } from '../components/Icon'
import { toast } from '../stores/toast'
import { CompositeBoundaryEditor } from '../composite/CompositeBoundaryEditor'
import '../library/library.css'

interface Props {
  capability: CompositeCapabilitySummary
  mode: 'edit' | 'next'
  onClose: () => void
  onPublished: () => void
}

function nextVersion(version: string | null): string {
  const major = Number.parseInt(version ?? '0', 10)
  return `${Number.isFinite(major) ? major + 1 : 1}.0`
}

export function CompositeVersionDialog({
  capability,
  mode,
  onClose,
  onPublished
}: Props): React.JSX.Element {
  const [manifest, setManifest] = useState<CompositeManifest | null>(null)
  const [name, setName] = useState(capability.name)
  const [description, setDescription] = useState(capability.description)
  const [version, setVersion] = useState(nextVersion(capability.latestVersion))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const latest = capability.latestVersion
    if (!latest) {
      setError('该组合还没有已发布版本')
      return
    }
    // 载入固定版本后填充表单；这是弹窗初始化，不是派生状态同步。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void window.api.composite.versionGet({ capabilityId: capability.id, version: latest }).then((result) => {
      if (!result.ok || !result.data) {
        setError('读取组合版本失败')
        return
      }
      setManifest(result.data.manifest)
      setName(result.data.manifest.name)
      setDescription(result.data.manifest.description ?? '')
      setVersion(mode === 'edit' ? latest.replace(/\.0\.0$/, '.0') : nextVersion(latest))
    })
  }, [capability, mode])

  const publish = async (): Promise<void> => {
    if (!manifest) return setError('版本尚未加载')
    const edited: CompositeManifest = {
      ...manifest,
      version,
      name: name.trim() || manifest.name,
      description: description.trim() || undefined
    }
    setBusy(true)
    setError('')
    try {
      const validated = await window.api.composite.validate({ manifest: edited })
      if (!validated.ok) throw new Error(validated.error.message)
      if (!validated.data.ok) {
        throw new Error(
          validated.data.issues.map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`).join('；')
        )
      }
      const published = await window.api.composite.publish({ manifest: edited })
      if (!published.ok) throw new Error(published.error.message)
      toast(
        mode === 'edit'
          ? `已修改组合「${edited.name}」v${version}`
          : `已发布新版本「${edited.name}」v${version}`
      )
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
      <section className="library-form-dialog workflow-save-dialog" role="dialog" aria-modal="true" aria-label="组合版本">
        <header className="library-form-header">
          <div>
            <h2>{mode === 'edit' ? '修改组合版本' : '发布新版本'}</h2>
          </div>
          <button type="button" className="library-form-close" aria-label="关闭" disabled={busy} onClick={onClose}>
            <Icon name="close" size={17} />
          </button>
        </header>
        <div className="library-form-scroll">
          <label className="library-form-field">
            <span>名称</span>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="library-form-field">
            <span>说明</span>
            <input value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <label className="library-form-field">
            <span>版本（主版本整数，如 1.0 / 2.0 / 3.0）</span>
            <input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="1.0" />
          </label>
          <p className="workflow-save-composite-note">
            内部图沿用当前固定版本；可修改公开输入输出、映射、必填与默认值。主版本号按整数递增。
          </p>
          {manifest ? <CompositeBoundaryEditor manifest={manifest} disabled={busy} onChange={setManifest} /> : null}
          {error && (
            <div className="library-form-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <footer className="library-form-footer">
          <span>{capability.id}</span>
          <button type="button" className="library-form-secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="button" className="library-form-primary" disabled={busy || !manifest} onClick={() => void publish()}>
            {busy ? '保存中…' : mode === 'edit' ? '保存修改' : '发布新版本'}
          </button>
        </footer>
      </section>
    </div>
  )
}
