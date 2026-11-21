import { useEffect, useRef, useState } from 'react'
import { NodeIdentity, NodePrimaryButton } from '../../../canvas/NodePresentation'
import type { NodeBodyProps, NodeSettingsProps } from '../../registry'
import { Icon } from '../../../components/Icon'
import { markUndoPoint } from '../../../canvas/history'
import { useNodePanelStore } from '../../../stores/nodePanel'
import { readWebsiteLink } from '@shared/website-link'

interface WebsiteDraft {
  name: string
  url: string
}

function parseDraft(config: string): WebsiteDraft {
  try {
    const value = JSON.parse(config || '{}') as Record<string, unknown>
    return {
      name: typeof value.name === 'string' ? value.name : '',
      url: typeof value.url === 'string' ? value.url : ''
    }
  } catch {
    return { name: '', url: '' }
  }
}

export function WebsiteBody({ shape }: NodeBodyProps): React.JSX.Element {
  const link = readWebsiteLink(shape.props.config)

  if (!link) {
    return (
      <div
        className="website-node-empty"
        data-node-interactive="website-empty"
        title="单击选中 · 双击打开设置"
        onDoubleClick={(event) => {
          event.stopPropagation()
          useNodePanelStore.getState().open('contract', shape.id, 'settings')
        }}
      >
        <NodeIdentity />
        <NodePrimaryButton
          onClick={() => useNodePanelStore.getState().open('contract', shape.id, 'settings')}
        >
          <Icon name="settings" size={16} />
          配置网址
        </NodePrimaryButton>
      </div>
    )
  }

  return (
    <div
      className="website-node-link"
      aria-label={`${link.name}：${link.url}（双击打开）`}
      data-node-interactive="website-link"
      title="单击选中节点 · 双击打开网址"
      onDoubleClick={(event) => {
        event.stopPropagation()
        window.open(link.url, '_blank', 'noreferrer')
      }}
    >
      <div className="website-node-summary">
        <strong>{link.name}</strong>
        <span className="website-node-url">{link.url}</span>
      </div>
      <div className="website-node-actions">
        <NodePrimaryButton onClick={() => useNodePanelStore.getState().open('contract', shape.id, 'settings')}>
          修改网址
        </NodePrimaryButton>
        <NodePrimaryButton
          className="btn-ghost website-node-open"
          title="打开网址"
          onClick={() => window.open(link.url, '_blank', 'noreferrer')}
        >
          打开网址
        </NodePrimaryButton>
      </div>
    </div>
  )
}

export function WebsiteSettings({ shape, editor }: NodeSettingsProps): React.JSX.Element {
  const [draft, setDraft] = useState<WebsiteDraft>(() => parseDraft(shape.props.config))
  const [error, setError] = useState('')
  const [savedConfig, setSavedConfig] = useState(shape.props.config)

  if (savedConfig !== shape.props.config) {
    // React's guarded render-time update keeps settings in sync with canvas undo/redo without
    // scheduling an extra effect-driven render after every external config change.
    setDraft(parseDraft(shape.props.config))
    setSavedConfig(shape.props.config)
  }

  // 实时保存：合法草稿防抖写入节点；校验只在草稿稳定后提示，不打断输入过程。
  // 保存网址按钮与 Enter 保留为显式提交（立即校验并提示错误）。
  const draftRef = useRef(draft)
  const timerRef = useRef<number | null>(null)
  const applySave = (): boolean => {
    const current = draftRef.current
    const name = current.name.trim()
    const link = readWebsiteLink(JSON.stringify({ name, url: current.url }))
    if (!name) return false
    if (!link) return false
    const config = JSON.stringify(link)
    if (config === shape.props.config && shape.props.title === link.name) return true
    // 2026-11-03 用户裁决：确定网址名称后，节点标题同步为该名称。
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config, title: link.name }
    })
    markUndoPoint(editor, 'website-config')
    setSavedConfig(config)
    return true
  }
  const applySaveRef = useRef(applySave)
  const flushSave = (): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    applySaveRef.current()
  }
  const flushRef = useRef(flushSave)
  // ref 同步在渲染后的 effect 里完成（react-hooks/refs）；事件与定时器读到的是最新值。
  useEffect(() => {
    draftRef.current = draft
    applySaveRef.current = applySave
    flushRef.current = flushSave
  })
  useEffect(() => () => flushRef.current(), [])
  const scheduleSave = (): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    const attempted = draftRef.current
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      // 草稿在防抖期间继续变化时不弹校验错误，等最后一次输入的防抖窗口再试。
      if (applySaveRef.current()) setError('')
      else if (attempted === draftRef.current) {
        setError(
          draftRef.current.name.trim() ? '请输入有效的 HTTP 或 HTTPS 网址' : '请填写网址名称'
        )
      }
    }, 600)
  }

  const save = (): void => {
    const name = draft.name.trim()
    const link = readWebsiteLink(JSON.stringify({ name, url: draft.url }))
    if (!name) return setError('请填写网址名称')
    if (!link) return setError('请输入有效的 HTTP 或 HTTPS 网址')

    const config = JSON.stringify(link)
    // 2026-11-03 用户裁决：确定网址名称后，节点标题同步为该名称。
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config, title: link.name }
    })
    markUndoPoint(editor, 'website-config')
    setDraft(link)
    setSavedConfig(config)
    setError('')
  }

  return (
    <section className="node-settings website-settings">
      <label className="settings-field" htmlFor={`website-name-${shape.id}`}>
        名称
        <input
          id={`website-name-${shape.id}`}
          type="text"
          maxLength={100}
          value={draft.name}
          placeholder="例如：Canvas Studio 官网"
          onChange={(event) => {
            setDraft((current) => ({ ...current, name: event.target.value }))
            setError('')
            scheduleSave()
          }}
        />
      </label>
      <label className="settings-field" htmlFor={`website-url-${shape.id}`}>
        网址
        <input
          id={`website-url-${shape.id}`}
          type="text"
          maxLength={2048}
          value={draft.url}
          placeholder="https://example.com"
          spellCheck={false}
          onChange={(event) => {
            setDraft((current) => ({ ...current, url: event.target.value }))
            setError('')
            scheduleSave()
          }}
          onBlur={flushSave}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              if (timerRef.current !== null) {
                window.clearTimeout(timerRef.current)
                timerRef.current = null
              }
              save()
            }
          }}
        />
      </label>
      <p className="contract-settings-hint">
        未填写协议时会自动补上 https://；只允许打开 HTTP 或 HTTPS 网页。修改会自动保存。
      </p>
      {error && (
        <p className="website-settings-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="website-settings-save" onClick={save}>
        <Icon name="check" size={15} /> 保存网址
      </button>
    </section>
  )
}
