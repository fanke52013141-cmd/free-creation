import { useEffect, useState } from 'react'
import { useResourceInsertRequest } from './insertRequestStore'
import type { Editor } from 'tldraw'
import type { LibraryResourceDetail } from '@shared/library/types'
import { legacyCategory, planResourceNodes } from '@shared/library/blueprint'
import { insertResource } from './insertResource'

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
    try {
      await insertResource(editor, projectId, current, request.componentIds, values)
      clear()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="library-form-mask">
      <section
        className="library-form-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="加入资源节点"
      >
        <header className="library-form-header">
          <h2>将「{current?.selectedTitle ?? '资源'}」加入画布</h2>
          <button disabled={busy} onClick={clear}>
            关闭
          </button>
        </header>
        <div className="library-form-scroll">
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
                      ...(component.text ?? '').matchAll(
                        /\{\{\s*([A-Za-z_][A-Za-z0-9_-]{0,63})\s*\}\}/g
                      )
                    ].map((match) => match[1])
                  )
                ].map((name) => (
                  <label className="library-form-field" key={name}>
                    <span>{name}</span>
                    <input
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
          <p>所选内容将按固定版本生成以下节点，包括当前工作台已隐藏创建入口的节点。</p>
          <ul>
            {preview.map((title, index) => (
              <li key={index}>{title}</li>
            ))}
          </ul>
          {(error || invalid) && (
            <p className="library-form-error" role="alert">
              {error || invalid}
            </p>
          )}
        </div>
        <footer className="library-form-footer">
          <button disabled={busy} onClick={clear}>
            取消
          </button>
          <button
            disabled={busy || !current || Boolean(invalid)}
            className="library-form-primary"
            onClick={() => void insert()}
          >
            {busy ? '加入中…' : '创建节点'}
          </button>
        </footer>
      </section>
    </div>
  )
}
