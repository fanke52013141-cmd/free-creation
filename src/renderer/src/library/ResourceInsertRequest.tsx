// 将资源加入画布。2026-11-21 弹窗统一：library-form 壳退役，换 ModalShell M 档；
// 内容字段沿用无作用域的 library-form-field 样式。
import { useEffect, useState } from 'react'
import { useResourceInsertRequest } from './insertRequestStore'
import type { Editor } from 'tldraw'
import type { LibraryResourceDetail } from '@shared/library/types'
import { legacyCategory, planResourceNodes } from '@shared/library/blueprint'
import { insertResource } from './insertResource'
import { resourceReusePreview } from './reusePreview'
import { useConfirmStore } from '../stores/confirm'
import { ModalShell } from '../components/ModalShell'
import { modalBtn } from '../components/modal-btn'

export function ResourceInsertRequest({
  editor,
  projectId
}: {
  editor: Editor
  projectId: string
}): React.JSX.Element | null {
  const request = useResourceInsertRequest((state) => state.request)
  const clear = (): void => useResourceInsertRequest.getState().set(null)
  const [detail, setDetail] = useState<LibraryResourceDetail | null>(null)
  const [values, setValues] = useState<Record<string, Record<string, string>>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!request || request.projectId !== projectId) return
    let cancelled = false
    void window.api
      .getLibraryResource(request)
      .then((result) => {
        if (cancelled) return
        if (result.ok && result.data) setDetail(result.data)
        else setError(result.ok ? '资源版本已不存在' : result.error.message)
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [request, projectId])
  if (!request || request.projectId !== projectId) return null
  const current =
    detail?.id === request.resourceId && detail.selectedRevisionId === request.revisionId
      ? detail
      : null
  let preview: string[] = []
  let invalid = ''
  if (current) {
    try {
      preview = planResourceNodes(
        current.category ?? legacyCategory(current.formPreset, current.components),
        current.components,
        current.selectedTitle,
        request.componentIds,
        values
      ).map((node) => node.title)
    } catch (cause) {
      invalid = cause instanceof Error ? cause.message : String(cause)
    }
  }
  const insert = async (): Promise<void> => {
    if (!current) return
    setBusy(true)
    setError('')
    try {
      const preview = resourceReusePreview(current, request.componentIds, values)
      const files = await window.api.previewLibraryFiles({
        resourceId: current.id,
        revisionId: current.selectedRevisionId,
        componentIds: request.componentIds
      })
      if (!files.ok || files.data.missingComponentIds.length)
        throw new Error('资源的部分文件缺失或检查未通过，还没有创建节点')
      if (
        !(await useConfirmStore.getState().confirm({
          title: '确认加入画布？',
          message: `将创建 ${preview.nodes.length} 个节点、复制 ${preview.fileCount} 个文件；不会自动连线，也不会自动开始生成。`,
          confirmText: '确认加入'
        }))
      )
        return
      await insertResource(editor, projectId, current, request.componentIds, values)
      clear()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <ModalShell
      size="m"
      title={`将「${current?.selectedTitle ?? '资源'}」加入画布`}
      ariaLabel="加入资源节点"
      onClose={() => !busy && clear()}
      closeOnEscape={!busy}
      closeOnOverlay={!busy}
      footer={
        <>
          <button type="button" className={modalBtn('secondary')} disabled={busy} onClick={clear}>
            取消
          </button>
          <button
            type="button"
            className={modalBtn('primary')}
            disabled={busy || !current || Boolean(invalid)}
            onClick={() => void insert()}
          >
            {busy ? '加入中…' : '加入画布'}
          </button>
        </>
      }
    >
      {!current && !error && <p>读取所选资源版本…</p>}
      {current?.components
        .filter(
          (component) =>
            request.componentIds.includes(component.id) && component.valueType === 'recipe'
        )
        .map((component) => (
          <div key={component.id}>
            <strong>{component.role}</strong>
            {[
              ...new Set(
                [
                  ...(Array.isArray(component.metadata.variables)
                    ? component.metadata.variables
                        .filter((value): value is string => typeof value === 'string')
                        .map((name) => [name, name])
                    : []),
                  ...(component.text ?? '').matchAll(
                    /\{\{\s*([A-Za-z_][A-Za-z0-9_-]{0,63})\s*\}\}/g
                  )
                ].map((match) => match[1])
              )
            ].map((name) => (
              <label className="library-form-field" key={name}>
                <span>{name}</span>
                <input
                  disabled={busy}
                  value={values[component.id]?.[name] ?? ''}
                  onChange={(event) =>
                    setValues((all) => ({
                      ...all,
                      [component.id]: { ...all[component.id], [name]: event.target.value }
                    }))
                  }
                />
              </label>
            ))}
          </div>
        ))}
      <p>将按资源当前保存的版本生成以下节点。</p>
      <ul>
        {preview.map((title, index) => (
          <li key={index}>{title}</li>
        ))}
      </ul>
      {(error || invalid) && (
        <p className="modal-error" role="alert">
          {error || invalid}
        </p>
      )}
    </ModalShell>
  )
}
