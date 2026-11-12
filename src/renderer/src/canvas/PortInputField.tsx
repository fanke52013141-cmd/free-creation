import { useState } from 'react'
import type { WorkflowInput } from '@shared/agent-access/run-ops'
import type { PortDecl } from '@shared/types'
import { portCompatible } from '../nodes/registry'
import { useMediaStore } from '../stores/media'

type InputValue = WorkflowInput['value']
type MediaKind = 'image' | 'video' | 'audio' | 'file'

/**
 * 单个输入端口的受控控件：文本/Markdown/JSON 用 textarea，图片/视频用文件选择，
 * 音频/文件走系统选择器，any 提供类型下拉。值就绪时经 onChange 上报；清空/无效上报 null。
 * 由汇总表单（WorkflowInputsDialog）与单端口兜底弹窗（WorkflowInputDialog）共用。
 */
export function PortInputField({
  projectId,
  port,
  value,
  onChange,
  disabled
}: {
  projectId: string
  port: PortDecl
  value: InputValue | null
  onChange: (value: InputValue | null) => void
  disabled?: boolean
}): React.JSX.Element {
  const initialText =
    value && value.kind !== 'media'
      ? value.kind === 'json'
        ? JSON.stringify(value.data)
        : value.text
      : ''
  const [text, setText] = useState(initialText)
  const [choice, setChoice] = useState<'text' | 'json' | MediaKind>('text')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [mediaLabel, setMediaLabel] = useState(value?.kind === 'media' ? '已选素材' : '')

  const kind = port.type === 'any' ? choice : port.type
  const media = kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'file'
  const nativePicker = kind === 'audio' || kind === 'file'
  const supported = media || kind === 'text' || kind === 'markdown' || kind === 'json'

  const onText = (raw: string): void => {
    setText(raw)
    setError('')
    if (!raw.trim()) {
      onChange(null)
      return
    }
    if (kind === 'json') {
      try {
        onChange({ kind: 'json', data: JSON.parse(raw) })
      } catch {
        setError('请输入有效的 JSON')
        onChange(null)
      }
      return
    }
    onChange({ kind: kind === 'markdown' ? 'markdown' : 'text', text: raw.trim() })
  }

  const importFile = async (file: File): Promise<void> => {
    setError('')
    if (file.size > 200 * 1024 * 1024) {
      setError('请上传不超过 200 MB 的素材')
      return
    }
    setBusy(true)
    try {
      const data = new Uint8Array(await file.arrayBuffer())
      const result = await window.api.importMediaBuffer({
        projectId,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        data
      })
      if (!result.ok || !portCompatible(result.data.kind, kind)) {
        setError('无法导入匹配的素材，请重新选择')
        onChange(null)
        return
      }
      void useMediaStore.getState().refresh(projectId)
      setMediaLabel(file.name)
      onChange({ kind: 'media', mediaId: result.data.id })
    } catch {
      setError('读取素材失败，请重试')
      onChange(null)
    } finally {
      setBusy(false)
    }
  }

  const pickNative = async (): Promise<void> => {
    setError('')
    setBusy(true)
    try {
      const result = await window.api.pickMedia(projectId)
      const asset =
        result.ok && result.data.assets.find((item) => kind === 'file' || item.kind === kind)
      if (!asset) {
        if (!result.ok || result.data.assets.length || result.data.errors.length)
          setError('没有导入匹配的素材')
        onChange(null)
        return
      }
      void useMediaStore.getState().refresh(projectId)
      setMediaLabel(asset.name ?? '已选素材')
      onChange({ kind: 'media', mediaId: asset.id })
    } catch {
      setError('选择素材失败，请重试')
      onChange(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="workflow-input-fieldset">
      {port.type === 'any' && (
        <select
          aria-label="输入类型"
          value={choice}
          disabled={disabled || busy}
          onChange={(event) => {
            setChoice(event.target.value as typeof choice)
            setMediaLabel('')
            onChange(null)
          }}
        >
          <option value="text">文本</option>
          <option value="json">JSON</option>
          <option value="image">图片</option>
          <option value="video">视频</option>
          <option value="audio">音频</option>
          <option value="file">文件</option>
        </select>
      )}
      {nativePicker ? (
        <button
          type="button"
          className="btn-ghost"
          disabled={disabled || busy}
          onClick={() => void pickNative()}
        >
          {busy ? '正在导入…' : mediaLabel ? `已选：${mediaLabel}（重新选择）` : '选择素材'}
        </button>
      ) : media ? (
        <label className="workflow-input-file">
          <input
            type="file"
            accept={`${kind}/*`}
            disabled={disabled || busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              if (file) void importFile(file)
            }}
          />
          {busy ? <span>正在导入…</span> : mediaLabel ? <span>已选：{mediaLabel}</span> : null}
        </label>
      ) : supported ? (
        <textarea
          rows={4}
          maxLength={100000}
          disabled={disabled || busy}
          placeholder={kind === 'json' ? '输入 JSON' : '输入本次运行使用的文本'}
          value={text}
          onChange={(event) => onText(event.target.value)}
        />
      ) : (
        <span className="workflow-input-unsupported">请先在画布上连接此类型的输入</span>
      )}
      {error && (
        <div role="alert" className="workflow-input-error">
          {error}
        </div>
      )}
    </div>
  )
}
