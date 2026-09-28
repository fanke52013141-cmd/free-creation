import { useState } from 'react'
import type { NodeBodyProps, NodeSettingsProps } from '../../registry'
import { Icon } from '../../../components/Icon'
import { markUndoPoint } from '../../../canvas/history'
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
      <div className="website-node-empty" data-node-interactive="website-empty">
        <span className="website-node-icon">
          <Icon name="external" size={24} />
        </span>
        <strong>配置网址</strong>
        <span>在右侧设置名称和链接</span>
      </div>
    )
  }

  return (
    <a
      className="website-node-link"
      href={link.url}
      target="_blank"
      rel="noreferrer"
      aria-label={`打开 ${link.name}：${link.url}`}
      data-node-interactive="website-link"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <span className="website-node-icon">
        <Icon name="external" size={24} />
      </span>
      <strong>{link.name}</strong>
      <span className="website-node-url">{link.url}</span>
      <span className="website-node-open">
        点击打开 <Icon name="external" size={13} />
      </span>
    </a>
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

  const save = (): void => {
    const name = draft.name.trim()
    const link = readWebsiteLink(JSON.stringify({ name, url: draft.url }))
    if (!name) return setError('请填写网址名称')
    if (!link) return setError('请输入有效的 HTTP 或 HTTPS 网址')

    const config = JSON.stringify(link)
    editor.updateShape({ id: shape.id, type: 'node-card', props: { config } })
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
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') save()
          }}
        />
      </label>
      <p className="contract-settings-hint">
        未填写协议时会自动补上 https://；只允许打开 HTTP 或 HTTPS 网页。
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
