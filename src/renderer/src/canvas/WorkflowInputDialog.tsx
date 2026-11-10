import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { portCompatible } from '../nodes/registry'
import { usePendingInput, type Pending } from '../stores/workflowInput'
import { useMediaStore } from '../stores/media'

function InputForm({ request }: { request: Pending }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [choice, setChoice] = useState<'text' | 'json' | 'image' | 'video' | 'audio' | 'file'>('text')
  const kind = request.port.type === 'any' ? choice : request.port.type
  const media = kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'file'
  const nativePicker = kind === 'audio' || kind === 'file'
  const supported = media || kind === 'text' || kind === 'markdown' || kind === 'json'

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy || !supported) return
    setError('')
    if (!media) {
      if (!text.trim()) return
      if (kind === 'json') {
        try {
          request.finish({ kind: 'json', data: JSON.parse(text) })
        } catch {
          setError('请输入有效的 JSON')
        }
      } else request.finish({ kind: kind === 'markdown' ? 'markdown' : 'text', text: text.trim() })
      return
    }
    if (!nativePicker && !file) return
    setBusy(true)
    try {
      if (nativePicker) {
        const result = await window.api.pickMedia(request.projectId)
        const asset = result.ok && result.data.assets.find((item) => kind === 'file' || item.kind === kind)
        if (!asset) {
          if (!result.ok || result.data.assets.length || result.data.errors.length) setError('没有导入匹配的素材')
          return
        }
        void useMediaStore.getState().refresh(request.projectId)
        request.finish({ kind: 'media', mediaId: asset.id })
        return
      }
      if (!file) return
      if (file.size > 200 * 1024 * 1024) {
        setError('请上传不超过 200 MB 的素材')
        return
      }
      const data = new Uint8Array(await file.arrayBuffer())
      if (usePendingInput.getState().request !== request) return
      const result = await window.api.importMediaBuffer({
        projectId: request.projectId,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        data
      })
      if (!result.ok || !portCompatible(result.data.kind, kind)) {
        setError('无法导入匹配的素材，请重新选择')
        return
      }
      void useMediaStore.getState().refresh(request.projectId)
      request.finish({ kind: 'media', mediaId: result.data.id })
    } catch {
      setError('读取素材失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      className="workflow-input-dialog"
      ref={dialog}
      aria-labelledby="workflow-input-title"
      onCancel={(event) => { event.preventDefault(); request.finish(null) }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <form className="confirm-dialog" onSubmit={(event) => void submit(event)}>
        <div id="workflow-input-title" className="confirm-title">补充运行输入</div>
        {request.port.type === 'any' && (
          <select aria-label="输入类型" value={choice} disabled={busy} onChange={(event) => {
            setChoice(event.target.value as typeof choice)
            setFile(null)
          }}>
            <option value="text">文本</option>
            <option value="json">JSON</option>
            <option value="image">图片</option>
            <option value="video">视频</option>
            <option value="audio">音频</option>
            <option value="file">文件</option>
          </select>
        )}
        <label className="workflow-input-field">
          <span>{request.title} · {request.port.name}</span>
          {nativePicker ? null : media ? (
            <input type="file" accept={`${kind}/*`}
              onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)} />
          ) : supported ? (
            <textarea rows={5} maxLength={100000} placeholder={kind === 'json' ? '输入 JSON' : '输入本次运行使用的文本'}
              value={text} onChange={(event) => setText(event.target.value)} />
          ) : <span>请先在画布上连接此类型的输入</span>}
        </label>
        {error && <div role="alert">{error}</div>}
        <div className="confirm-actions">
          <button type="button" className="btn-ghost" onClick={() => request.finish(null)}>取消运行</button>
          <button type="submit" className="btn-primary" disabled={busy || !supported || (!nativePicker && (media ? !file : !text.trim()))}>
            {busy ? '正在导入…' : nativePicker ? '选择素材并继续' : '继续运行'}
          </button>
        </div>
      </form>
    </dialog>
  )
}

export function WorkflowInputDialog(): React.JSX.Element | null {
  const request = usePendingInput((state) => state.request)
  useEffect(() => () => usePendingInput.getState().request?.finish(null), [])
  return request ? createPortal(<InputForm key={request.id} request={request} />, document.body) : null
}
