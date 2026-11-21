/* eslint-disable react-hooks/set-state-in-effect -- 弹窗异步加载草稿后填充表单 */
// 节点流「编辑名称」弹窗。2026-11-21 弹窗统一：壳换 ModalShell（保留
// workflow-save-dialog 钩子类与 aria-label 供验收脚本定位），只编辑名称；
// 保存 = 写入草稿并同步名称展示（不产生新版本）。
// 版本只在「编辑节点」里通过「另存为新版本」产生（用户裁决 2026-11-11）。
import { useEffect, useRef, useState } from 'react'
import type { CompositeCapabilitySummary } from '@shared/composite/types'
import type { CompositeManifest } from '@shared/composite/manifest'
import { toast } from '../stores/toast'
import { ModalShell } from '../components/ModalShell'
import { modalBtn } from '../components/modal-btn'
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
  const [revision, setRevision] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)

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
      setRevision(draft.ok && draft.data ? draft.data.revision : null)
    })
  }, [capability])

  // 保存：写入草稿（同步名称展示），不产生新版本；说明保留原值不在此编辑。
  const save = async (): Promise<void> => {
    if (!manifest) return setError('版本尚未加载')
    const title = name.trim()
    if (!title) return setError('请填写名称')
    const edited: CompositeManifest = {
      ...manifest,
      name: title
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
    <ModalShell
      size="s"
      title="编辑名称"
      className="workflow-save-dialog"
      ariaLabel="编辑名称"
      onClose={() => !busy && onClose()}
      closeOnEscape={!busy}
      closeOnOverlay={!busy}
      initialFocusRef={nameRef}
      footer={
        <>
          <button
            type="button"
            className={modalBtn('secondary')}
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className={modalBtn('primary')}
            disabled={busy || !manifest}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div
        onKeyDown={(event) => {
          event.stopPropagation()
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
        {!manifest && !error && <p className="composite-settings-hint">正在读取节点流内容…</p>}
        {manifest && (
          <label className="library-form-field">
            <span>名称</span>
            <input
              ref={nameRef}
              maxLength={100}
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setError('')
              }}
              placeholder="例如：角色设定到分镜"
            />
          </label>
        )}
        {error && (
          <div className="modal-error" role="alert" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
      </div>
    </ModalShell>
  )
}
