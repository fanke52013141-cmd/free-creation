// TTS 语音复刻节点 Body（本地 ComfyUI IndexTTS-2.5）
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
import { parseTtsConfig } from '@shared/tts'
import { TTS_LANGS, type TtsConfig, type TtsLang } from '@shared/tts'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import {
  clearSelectedMediaHistory,
  MediaFileActions,
  MediaResultGrid,
  removeMediaResultFromShape,
  selectMediaResult,
  useClickGuard
} from './shared'

const TTS_FORMATS: Array<TtsConfig['format']> = ['wav', 'mp3', 'flac']

export function TtsBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)
  const providers = useGatewayStore((s) => s.providers)
  const providersLoaded = useGatewayStore((s) => s.loaded)
  const loadProviders = useGatewayStore((s) => s.load)
  const config = parseTtsConfig(readNodeConfig(shape))
  const [draft, setDraft] = useState(shape.props.text)
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [refPlaying, setRefPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const refAudioRef = useRef<HTMLAudioElement | null>(null)
  const minimaxModels = modelsByModality(providers, 'audio').filter(
    (option) => option.provider.specId === 'minimax'
  )

  useEffect(() => {
    if (!providersLoaded) void loadProviders()
  }, [providersLoaded, loadProviders])

  // 组件卸载时释放音频元素
  useEffect(() => {
    return () => {
      audioRef.current?.pause()
      refAudioRef.current?.pause()
      if (audioRef.current) audioRef.current.src = ''
      if (refAudioRef.current) refAudioRef.current.src = ''
      audioRef.current = null
      refAudioRef.current = null
    }
  }, [])

  // 输出音频源变化时重置
  useEffect(() => {
    if (!audioRef.current) return
    audioRef.current.pause()
    audioRef.current.src = ''
    audioRef.current = null
    setPlaying(false)
  }, [shape.props.mediaPath])

  const updateConfig = (patch: Partial<TtsConfig>): void => {
    const next = { ...config, ...patch }
    const { text: legacyText, ...persisted } = next
    void legacyText
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: JSON.stringify(persisted) }
    })
  }

  const updateText = (text: string): void => {
    if (text === shape.props.text) return
    editor.updateShape({ id: shape.id, type: 'node-card', props: { text } })
  }

  const uploadRefAudio = async (): Promise<void> => {
    if (!project) return toast('项目未就绪')
    const res = await window.api.pickMedia(project.id)
    if (!res.ok) return toast(`上传失败：${res.error.message}`)
    const audioAsset = res.data.assets.find((a) => a.kind === 'audio')
    if (!audioAsset) return toast('请选择音频文件')
    updateConfig({
      refMediaId: audioAsset.id,
      refMediaPath: audioAsset.path,
      refMediaMime: audioAsset.mime,
      refMediaName: audioAsset.name ?? '参考语音'
    })
    markUndoPoint(editor, 'tts-ref-upload')
  }

  const removeRefAudio = (): void => {
    refAudioRef.current?.pause()
    refAudioRef.current = null
    setRefPlaying(false)
    updateConfig({ refMediaId: '', refMediaPath: '', refMediaMime: '', refMediaName: '' })
    markUndoPoint(editor, 'tts-ref-remove')
  }

  const toggleRefPlay = (): void => {
    if (!config.refMediaPath) return
    if (refPlaying) {
      refAudioRef.current?.pause()
      setRefPlaying(false)
    } else {
      const el = refAudioRef.current
      if (el) {
        el.currentTime = 0
        void el.play().then(() => setRefPlaying(true))
        return
      }
      const created = new Audio(mediaUrl(config.refMediaPath))
      created.currentTime = 0
      created.onended = () => setRefPlaying(false)
      created.onpause = () => setRefPlaying(false)
      refAudioRef.current = created
      void created.play().then(() => setRefPlaying(true))
    }
  }

  const toggleOutputPlay = (): void => {
    if (!shape.props.mediaPath) return
    if (playing) {
      audioRef.current?.pause()
      setPlaying(false)
    } else {
      const el = audioRef.current
      if (el) {
        el.currentTime = 0
        void el.play().then(() => setPlaying(true))
        return
      }
      const created = new Audio(mediaUrl(shape.props.mediaPath))
      created.loop = true
      created.currentTime = 0
      created.onended = () => setPlaying(false)
      created.onpause = () => setPlaying(false)
      audioRef.current = created
      void created.play().then(() => setPlaying(true))
    }
  }

  const generate = async (): Promise<void> => {
    if (!project) return toast('项目未就绪')
    updateConfig(config)
    updateText(draft)
    setBusy(true)
    try {
      await runNodeManually(editor, project.id, [], shape.id)
    } finally {
      setBusy(false)
    }
  }

  const hasRefAudio = Boolean(config.refMediaId && config.refMediaPath)
  const hasOutput = Boolean(shape.props.mediaPath)

  return (
    <div className="node-tts">
      {/* ── 参考语音 ── */}
      <div className="tts-section">
        <div className="tts-section-label">
          <Icon name="audio" size={13} />
          <span>参考语音</span>
        </div>
        {hasRefAudio ? (
          <div className="tts-ref-player">
            <button
              className="audio-play-btn"
              onPointerDown={(e) => stopEventPropagation(e)}
              onClick={(e) => {
                e.stopPropagation()
                toggleRefPlay()
              }}
            >
              {refPlaying ? '暂停' : '试听'}
            </button>
            <span className="tts-ref-name">{config.refMediaName || '参考语音'}</span>
            <button
              className="btn-ghost small danger"
              title="替换参考语音"
              onPointerDown={(e) => stopEventPropagation(e)}
              onClick={(e) => {
                e.stopPropagation()
                void uploadRefAudio()
              }}
            >
              替换
            </button>
            <button
              className="btn-ghost small danger"
              title="移除参考语音"
              onPointerDown={(e) => stopEventPropagation(e)}
              onClick={(e) => {
                e.stopPropagation()
                removeRefAudio()
              }}
            >
              移除
            </button>
          </div>
        ) : (
          <button
            className="tts-upload-btn"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              void uploadRefAudio()
            }}
          >
            <Icon name="upload" size={18} />
            <span>上传参考语音</span>
            <span className="tts-upload-hint">选择一段目标音色的音频</span>
          </button>
        )}
      </div>

      {/* ── 合成文字 ── */}
      <div className="tts-section">
        <div className="tts-section-label">
          <Icon name="text" size={13} />
          <span>合成文字</span>
        </div>
        <textarea
          className="gen-textarea tts"
          value={draft}
          placeholder="输入要朗读的文本，上游文本节点内容会自动合并…"
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => updateText(draft)}
        />
        <div className="audio-text-meta">{draft.length} 字 · 可由文本节点提供</div>
      </div>

      {/* ── 合成参数 ── */}
      <div className="tts-section">
        <div className="tts-section-label">
          <Icon name="settings" size={13} />
          <span>复刻引擎</span>
        </div>
        <div className="tts-options">
          <label className="opt-label">后端</label>
          <AppSelect
            className="gen-select small"
            value={config.backend}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              const backend = e.target.value === 'minimax' ? 'minimax' : 'comfyui'
              updateConfig({
                backend,
                ...(backend === 'minimax' && config.format === 'wav' ? { format: 'mp3' } : {})
              })
            }}
          >
            <option value="comfyui">本地 ComfyUI · IndexTTS</option>
            <option value="minimax">MiniMax · 快速复刻</option>
          </AppSelect>
        </div>
        {config.backend === 'minimax' && (
          <div className="tts-minimax-options">
            <AppSelect
              className="gen-select"
              value={config.providerId ? `${config.providerId}::${config.modelId}` : ''}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                const selected = minimaxModels.find((item) => item.key === e.target.value)
                if (selected)
                  updateConfig({ providerId: selected.provider.id, modelId: selected.model.id })
              }}
            >
              <option value="">{providersLoaded ? '选择 MiniMax 语音模型…' : '加载模型中…'}</option>
              {minimaxModels.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </AppSelect>
            <input
              className="gen-input"
              value={config.voiceId}
              placeholder="可选：自定义 Voice ID"
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => updateConfig({ voiceId: e.target.value })}
            />
            <div className="tts-toggle-row">
              <label>
                <input
                  type="checkbox"
                  checked={config.needNoiseReduction}
                  onChange={(e) => updateConfig({ needNoiseReduction: e.target.checked })}
                />{' '}
                降噪
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={config.needVolumeNormalization}
                  onChange={(e) => updateConfig({ needVolumeNormalization: e.target.checked })}
                />{' '}
                音量归一
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={config.aigcWatermark}
                  onChange={(e) => updateConfig({ aigcWatermark: e.target.checked })}
                />{' '}
                添加水印
              </label>
            </div>
            <div className="gen-capability-note">
              参考音频需为 mp3 / m4a / wav，10 秒至 5 分钟且不超过 20MB；复刻音色会通过 MiniMax T2A
              生成新的独立音频资产。
            </div>
          </div>
        )}
      </div>
      <div className="tts-options">
        <label className="opt-label">语言</label>
        <AppSelect
          className="gen-select small"
          value={config.lang}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => updateConfig({ lang: e.target.value as TtsLang })}
        >
          {TTS_LANGS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </AppSelect>
        <label className="opt-label">格式</label>
        <AppSelect
          className="gen-select small"
          value={config.format}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => updateConfig({ format: e.target.value as TtsConfig['format'] })}
        >
          {(config.backend === 'minimax'
            ? TTS_FORMATS.filter((f) => f !== 'wav')
            : TTS_FORMATS
          ).map((f) => (
            <option key={f} value={f}>
              {f.toUpperCase()}
            </option>
          ))}
        </AppSelect>
      </div>
      <div className="tts-sliders">
        <div className="tts-slider-row">
          <label className="opt-label">语速 {config.speed.toFixed(1)}x</label>
          <input
            type="range"
            min="0.5"
            max="2"
            step="0.1"
            value={config.speed}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => updateConfig({ speed: Number(e.target.value) })}
          />
        </div>
        <div className="tts-slider-row">
          <label className="opt-label">情绪 {config.emotion.toFixed(1)}</label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={config.emotion}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => updateConfig({ emotion: Number(e.target.value) })}
          />
        </div>
      </div>

      <button
        className="btn-generate"
        disabled={busy || !draft.trim() || (config.backend === 'minimax' && !config.providerId)}
        onPointerDown={(e) => stopEventPropagation(e)}
        onClick={(e) => {
          e.stopPropagation()
          void generate()
        }}
      >
        {busy ? (
          '合成中…'
        ) : (
          <>
            <Icon name="audio" size={14} />
            语音复刻
          </>
        )}
      </button>

      {/* ── 合成结果 ── */}
      {hasOutput && (
        <>
          {/* 媒体区统一交互：单击选中节点，双击打开大窗播放器（与图片/视频节点一致） */}
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
              <span className="audio-player-meta">
                {config.lang} · {config.format.toUpperCase()}
              </span>
            </div>
            <div className="audio-player-actions">
              <button
                className="audio-play-btn"
                onPointerDown={(e) => stopEventPropagation(e)}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleOutputPlay()
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
              markUndoPoint(editor, 'tts-select-result')
            }}
            onDelete={(item) => {
              const nodeResult = removeMediaResultFromShape(shape, item)
              if (!nodeResult) return
              editor.updateShape({
                id: shape.id,
                type: 'node-card',
                meta: { ...(shape.meta ?? {}), nodeResult }
              })
              markUndoPoint(editor, 'tts-delete-result')
            }}
            onClear={() => {
              const nodeResult = clearSelectedMediaHistory(shape)
              if (!nodeResult) return
              editor.updateShape({
                id: shape.id,
                type: 'node-card',
                meta: { ...(shape.meta ?? {}), nodeResult }
              })
              markUndoPoint(editor, 'tts-clear-history')
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
