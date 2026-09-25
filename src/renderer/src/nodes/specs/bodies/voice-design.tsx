// 音色设计节点 Body（MiniMax voice_design）。
//
// 节点定位：输入音色描述 → 输出试听音频与可复用的音色 ID。
// 音色 ID 同时以 out-json（voice.profile@1）暴露给下游语音合成节点，并在这里就地展示
// 与复制，方便用户在没有连线时也能手动引用。
import { useEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import { mediaUrl, type NodeBodyProps } from '../../registry'
import { toast } from '../../../stores/toast'
import { markUndoPoint } from '../../../canvas/history'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { runNodeManually } from '../../../engine/executor'
import { useAppStore } from '../../../stores/app'
import { Icon } from '../../../components/Icon'
import { AppSelect } from '../../../components/AppSelect'
import { useGatewayStore } from '../../../stores/gateway'
import {
  DEFAULT_VOICE_DESIGN_CONFIG,
  VOICE_DESIGN_PREVIEW_LIMIT,
  parseVoiceDesignConfig,
  serializeVoiceDesignConfig,
  type VoiceDesignConfig
} from '@shared/voice-design'
import {
  clearSelectedMediaHistory,
  MediaFileActions,
  MediaResultGrid,
  removeMediaResultFromShape,
  selectMediaResult,
  useClickGuard
} from './shared'
import { parseNodeExtra } from '../../nodeValues'

/** 从本次运行的 out-json 投影里取出设计出的音色 ID。 */
function designedVoiceId(shape: NodeBodyProps['shape']): string {
  const value = parseNodeExtra(shape.meta?.nodeExtra)['out-json']
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const voiceId = (value as { voice_id?: unknown }).voice_id
  return typeof voiceId === 'string' ? voiceId : ''
}

export function VoiceDesignBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)
  const providers = useGatewayStore((s) => s.providers)
  const providersLoaded = useGatewayStore((s) => s.loaded)
  const loadProviders = useGatewayStore((s) => s.load)
  const openSettings = useGatewayStore((s) => s.openSettings)
  const config = parseVoiceDesignConfig(readNodeConfig(shape))
  const [draft, setDraft] = useState(shape.props.text)
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // voice_design 的请求体没有 model 字段；这里按供应商选择 MiniMax 账号，
  // 内部取一个已配置的音频模型用于模型网关的 voice.design 能力路由。
  const minimaxProviders = providers.flatMap((provider) => {
    if (provider.specId !== 'minimax') return []
    const model = provider.models.find(
      (item) =>
        item.modality === 'audio' &&
        (!item.operations || item.operations.includes('voice.design'))
    )
    return model ? [{ provider, model }] : []
  })
  const voiceId = designedVoiceId(shape)

  useEffect(() => {
    if (!providersLoaded) void loadProviders()
  }, [providersLoaded, loadProviders])

  useEffect(() => {
    return () => {
      audioRef.current?.pause()
      if (audioRef.current) audioRef.current.src = ''
      audioRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!audioRef.current) return
    audioRef.current.pause()
    audioRef.current.src = ''
    audioRef.current = null
    setPlaying(false)
  }, [shape.props.mediaPath])

  const updateConfig = (patch: Partial<VoiceDesignConfig>): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeVoiceDesignConfig({ ...config, ...patch }) }
    })
  }

  const updateText = (text: string): void => {
    if (text === shape.props.text) return
    editor.updateShape({ id: shape.id, type: 'node-card', props: { text } })
  }

  const togglePlay = (): void => {
    if (!shape.props.mediaPath) return
    if (playing) {
      audioRef.current?.pause()
      setPlaying(false)
      return
    }
    const el = audioRef.current
    if (el) {
      el.currentTime = 0
      void el.play().then(() => setPlaying(true))
      return
    }
    const created = new Audio(mediaUrl(shape.props.mediaPath))
    created.currentTime = 0
    created.onended = () => setPlaying(false)
    created.onpause = () => setPlaying(false)
    audioRef.current = created
    void created.play().then(() => setPlaying(true))
  }

  const generate = async (): Promise<void> => {
    if (!project) return toast('项目未就绪')
    updateText(draft)
    setBusy(true)
    try {
      await runNodeManually(editor, project.id, providers, shape.id)
    } finally {
      setBusy(false)
    }
  }

  const hasOutput = Boolean(shape.props.mediaPath)
  const canGenerate =
    Boolean(draft.trim()) &&
    Boolean(config.previewText.trim()) &&
    minimaxProviders.some(
      (item) => item.provider.id === config.providerId && item.model.id === config.modelId
    )

  return (
    <div className="node-tts node-voice-design">
      <div className="tts-section voice-design-provider-section">
        <div className="tts-section-label">
          <Icon name="settings" size={13} />
          <span>MiniMax 供应商</span>
        </div>
        <AppSelect
          className="gen-select voice-design-provider-select"
          aria-label="MiniMax 供应商"
          value={config.providerId}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            const selected = minimaxProviders.find((item) => item.provider.id === e.target.value)
            if (selected)
              updateConfig({ providerId: selected.provider.id, modelId: selected.model.id })
          }}
        >
          <option value="">{providersLoaded ? '选择 MiniMax 供应商…' : '加载中…'}</option>
          {minimaxProviders.map(({ provider }) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </AppSelect>
        {providersLoaded && !minimaxProviders.length && (
          <button
            className="btn-ghost small"
            data-purpose="config-model-button"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              void openSettings()
            }}
          >
            去配置 MiniMax 供应商
          </button>
        )}
      </div>

      <div className="tts-section voice-design-description-section">
        <div className="tts-section-label">
          <Icon name="text" size={13} />
          <span>音色描述</span>
        </div>
        <textarea
          className="gen-textarea tts voice-design-prompt"
          rows={3}
          aria-label="音色描述"
          value={draft}
          placeholder="描述想要的音色，例如：年轻女性，声音清亮温柔，语速偏慢，略带笑意…"
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => updateText(draft)}
        />
        <div className="audio-text-meta voice-design-char-count" aria-live="polite">
          {draft.length} 字 · 可由文本节点提供
        </div>
      </div>

      <div className="tts-section voice-design-parameters-section">
        <div className="tts-section-label">
          <Icon name="settings" size={13} />
          <span>设计参数</span>
        </div>
        <label
          className="opt-label voice-design-field-label"
          htmlFor={`voice-design-preview-${shape.id}`}
        >
          试听文本
        </label>
        <input
          className="gen-input"
          id={`voice-design-preview-${shape.id}`}
          aria-label="试听文本"
          value={config.previewText}
          maxLength={VOICE_DESIGN_PREVIEW_LIMIT}
          placeholder={DEFAULT_VOICE_DESIGN_CONFIG.previewText}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => updateConfig({ previewText: e.target.value })}
        />
        <div className="audio-text-meta" aria-live="polite">
          {config.previewText.length} / {VOICE_DESIGN_PREVIEW_LIMIT} 字 · 试听按 2 元/万字计费
        </div>
        <label
          className="opt-label voice-design-field-label"
          htmlFor={`voice-design-id-${shape.id}`}
        >
          自定义 Voice ID（可选）
        </label>
        <input
          className="gen-input voice-design-id-input"
          id={`voice-design-id-${shape.id}`}
          aria-label="自定义 Voice ID（可选）"
          spellCheck={false}
          value={config.voiceId}
          placeholder="留空由服务端生成"
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => updateConfig({ voiceId: e.target.value })}
        />
      </div>

      <button
        className="btn-generate"
        disabled={busy || !canGenerate}
        onPointerDown={(e) => stopEventPropagation(e)}
        onClick={(e) => {
          e.stopPropagation()
          void generate()
        }}
      >
        {busy ? (
          '设计中…'
        ) : (
          <>
            <span>设计音色</span>
            <Icon name="spark" size={14} />
          </>
        )}
      </button>

      {voiceId && (
        <div className="tts-section voice-id-card">
          <div className="tts-section-label">
            <Icon name="check" size={13} />
            <span>音色 ID</span>
          </div>
          <div className="voice-id-row">
            <code className="voice-id-value">{voiceId}</code>
            <button
              className="btn-ghost small"
              title="复制音色 ID"
              onPointerDown={(e) => stopEventPropagation(e)}
              onClick={(e) => {
                e.stopPropagation()
                void navigator.clipboard.writeText(voiceId).then(() => toast('已复制音色 ID'))
              }}
            >
              复制
            </button>
          </div>
          <div className="gen-capability-note">
            已通过 out-json 输出给下游语音合成节点；连接「音色档案」输入即可直接使用。
          </div>
        </div>
      )}

      {hasOutput && (
        <>
          <div
            className="node-audio-player"
            data-node-interactive="media-preview"
            title="双击打开大窗播放器"
            onPointerDown={guard.onPointerDown}
            onDoubleClick={(e) =>
              guard.onDoubleClick(e, () => {
                if (playing) {
                  audioRef.current?.pause()
                  setPlaying(false)
                }
                openPreview({
                  kind: 'audio',
                  url: mediaUrl(shape.props.mediaPath),
                  title: shape.props.title
                })
              })
            }
          >
            <div className={`audio-player-wave ${playing ? 'playing' : ''}`}>
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                <span key={i} style={{ animationDelay: `${i * 0.12}s` }} />
              ))}
            </div>
            <div className="audio-player-info">
              <span className="audio-player-name">{shape.props.title}</span>
              <span className="audio-player-meta">试听音频 · {config.previewText.length} 字</span>
            </div>
            <div className="audio-player-actions">
              <button
                className="audio-play-btn"
                onPointerDown={(e) => stopEventPropagation(e)}
                onClick={(e) => {
                  e.stopPropagation()
                  togglePlay()
                }}
              >
                {playing ? '暂停' : '播放'}
              </button>
              <MediaFileActions shape={shape} />
            </div>
          </div>
          <MediaResultGrid
            shape={shape}
            kind="audio"
            onSelect={(item) => {
              const selected = selectMediaResult(shape, item)
              editor.updateShape({
                id: shape.id,
                type: 'node-card',
                props: selected.props,
                meta: { ...(shape.meta ?? {}), nodeResult: selected.nodeResult }
              })
              markUndoPoint(editor, 'voice-design-select-result')
            }}
            onDelete={(item) => {
              const nodeResult = removeMediaResultFromShape(shape, item)
              if (!nodeResult) return
              editor.updateShape({
                id: shape.id,
                type: 'node-card',
                meta: { ...(shape.meta ?? {}), nodeResult }
              })
              markUndoPoint(editor, 'voice-design-delete-result')
            }}
            onClear={() => {
              const nodeResult = clearSelectedMediaHistory(shape)
              if (!nodeResult) return
              editor.updateShape({
                id: shape.id,
                type: 'node-card',
                meta: { ...(shape.meta ?? {}), nodeResult }
              })
              markUndoPoint(editor, 'voice-design-clear-history')
            }}
            openPreview={(item) =>
              openPreview({
                kind: 'audio',
                url: mediaUrl(item.mediaPath),
                title: shape.props.title
              })
            }
          />
        </>
      )}
    </div>
  )
}
