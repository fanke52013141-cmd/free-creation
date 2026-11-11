/* eslint-disable react-hooks/set-state-in-effect -- 弹窗异步加载草稿后填充表单 */
// 节点流「编辑」基础信息弹窗：与创建时同一套 library-form 样式。
// 只编辑名称/说明；保存 = 写入草稿并同步名称展示（不产生新版本）。
// 版本只在「编辑节点」里通过「另存为新版本」产生（用户裁决 2026-11-11）。
// 公开输入/输出按内部节点规范自动推导，不在此手动挑选。
import { useEffect, useState } from 'react'
import type { CompositeCapabilitySummary } from '@shared/composite/types'
import type { CompositeManifest } from '@shared/composite/manifest'
import { Icon } from '../components/Icon'
import { toast } from '../stores/toast'
import './composite-editor.css'
import '../library/library.css'

interface Props {
  capability: CompositeCapabilitySummary
  onClose: () => void
  /** 保存成功后刷新列表（名称展示同步）。 */
  onPublished: () => void
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

  // 保存：写入草稿（同步名称/说明展示），不产生新版本。
  const save = async (): Promise<void> => {
    if (!manifest) return setError('版本尚未加载')
    const title = name.trim()
    if (!title) return setError('请填写名称')
    const edited: CompositeManifest = {
      ...manifest,
      name: title,
      description: description.trim() || undefined
    }
    setBusy(true)
    setError('')
    try {
      const saved = await window.api.composite.draftSave({
        manifest: edited,
        expectedRevision: revision ?? 0
      })
      if (!saved.ok) throw new Error(saved.error.message)
      toast('已保存')
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
        className="library-form-dialog workflow-save-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="编辑节点流"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape' && !busy) onClose()
          if (
            event.key === 'Enter' &&
            !busy &&
            event.target instanceof HTMLInputElement &&
            event.target.type === 'text' &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault()
            void save()
          }
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
                <span>名称</span>
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
                <span>说明（可选）</span>
                <input
                  maxLength={600}
                  value={description}
                  onChange={(event) => {
                    setDescription(event.target.value)
                    setError('')
                  }}
                  placeholder="这个节点流做什么"
                />
              </label>
            </>
          )}
          {error && (
            <div className="library-form-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <footer className="library-form-footer">
          <span />
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
            className="library-form-primary"
            disabled={busy || !manifest}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </footer>
      </section>
    </div>
  )
}
