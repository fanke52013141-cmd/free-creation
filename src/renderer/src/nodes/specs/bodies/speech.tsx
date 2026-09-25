// 配音节点 Body（MiniMax 异步 / 火山引擎语音合成 1.0）。
//
// 这里不绕过 executor 调用模型：按钮只把当前配置与正文写回节点，然后交给统一的
// runNodeManually 运行路径。参数分组随 config.backend 变化——这正是用户要的
// 「选择模型的不同，也决定了它的输入和输出的结构」。
import { useEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import { mediaUrl, type NodeBodyProps, type NodeSettingsProps } from '../../registry'
import { toast } from '../../../stores/toast'
import { countIncomingConnections } from '../../../canvas/graph'
import { markUndoPoint } from '../../../canvas/history'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { runNodeManually } from '../../../engine/executor'
import { useAppStore } from '../../../stores/app'
import { Icon } from '../../../components/Icon'
import { AppSelect } from '../../../components/AppSelect'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import {
  SPEECH_BACKENDS,
  SPEECH_BITRATES,
  SPEECH_EMOTIONS,
  MINIMAX_ASYNC_SPEECH_MODELS,
  SPEECH_TEXT_LIMITS,
  VOLC_REFERENCE_AUDIO_MAX_BYTES,
  VOLC_REFERENCE_AUDIO_MAX_COUNT,
  VOLC_REFERENCE_AUDIO_MAX_SECONDS,
  volcReferencePromptPrefix,
  defaultSpeechFormat,
  defaultSpeechSampleRate,
  parseSpeechConfig,
  isSpeechEmotionSupported,
  serializeSpeechConfig,
  type SpeechBackend,
  type SpeechConfig,
  type SpeechEmotion
} from '@shared/speech'
import type { ProviderSpecId } from '@shared/types'
import {
  clearSelectedMediaHistory,
  MediaFileActions,
  MediaResultGrid,
  pickImportedAsset,
  removeMediaResultFromShape,
  selectMediaResult,
  useClickGuard
} from './shared'
import { parseNodeExtra } from '../../nodeValues'

interface SubtitleSentence {
  start_time: number
  end_time: number
  text: string
}

/** 每种当前协议只接受对应供应商：MiniMax 与火山引擎原生 API 不能互相顶替。 */
function acceptsProvider(backend: SpeechBackend, specId: ProviderSpecId): boolean {
  if (backend === 'minimax') return specId === 'minimax'
  return specId === 'volc-speech'
}

function subtitleSentences(shape: NodeBodyProps['shape']): SubtitleSentence[] {
  const raw = parseNodeExtra(shape.meta?.nodeExtra)['out-subtitle']
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const sentences = (raw as { sentences?: unknown }).sentences
  if (!Array.isArray(sentences)) return []
  return sentences.filter(
    (item): item is SubtitleSentence =>
      Boolean(item) &&
      typeof item === 'object' &&
      typeof (item as SubtitleSentence).start_time === 'number' &&
      typeof (item as SubtitleSentence).end_time === 'number' &&
      typeof (item as SubtitleSentence).text === 'string'
  )
}

const formatSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

export function SpeechBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)
  const providers = useGatewayStore((s) => s.providers)
  const providersLoaded = useGatewayStore((s) => s.loaded)
  const loadProviders = useGatewayStore((s) => s.load)
  const openSettings = useGatewayStore((s) => s.openSettings)
  const config = parseSpeechConfig(readNodeConfig(shape))
  const [draft, setDraft] = useState(shape.props.text)
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [referencePlaying, setReferencePlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const referenceAudioRef = useRef<HTMLAudioElement | null>(null)

  const incomingReferences = countIncomingConnections(editor, shape.id, 'in-audio')
  const uploadedReference = Boolean(config.referenceAudioId && config.referenceAudioPath)
  const referenceCount =
    config.backend === 'volc' ? incomingReferences + (uploadedReference ? 1 : 0) : 0

  const options = modelsByModality(providers, 'audio').filter(
    (option) =>
      acceptsProvider(config.backend, option.provider.specId) &&
      (config.backend === 'minimax'
        ? MINIMAX_ASYNC_SPEECH_MODELS.includes(option.model.id)
        : option.model.id === 'seed-audio-1.0')
  )
  const emotionOptions = SPEECH_EMOTIONS.filter((item) =>
    isSpeechEmotionSupported(config.modelId, item.value)
  )
  const sentences = subtitleSentences(shape)
  const limit =
    SPEECH_TEXT_LIMITS[config.backend] -
    (config.backend === 'volc' ? volcReferencePromptPrefix(referenceCount).length : 0)

  useEffect(() => {
    if (!providersLoaded) void loadProviders()
  }, [providersLoaded, loadProviders])

  useEffect(() => {
    return () => {
      audioRef.current?.pause()
      referenceAudioRef.current?.pause()
      if (audioRef.current) audioRef.current.src = ''
      if (referenceAudioRef.current) referenceAudioRef.current.src = ''
      audioRef.current = null
      referenceAudioRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!audioRef.current) return
    audioRef.current.pause()
    audioRef.current.src = ''
    audioRef.current = null
    setPlaying(false)
  }, [shape.props.mediaPath])

  const updateConfig = (patch: Partial<SpeechConfig>): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeSpeechConfig({ ...config, ...patch }) }
    })
  }

  const updateText = (text: string): void => {
    if (text === shape.props.text) return
    editor.updateShape({ id: shape.id, type: 'node-card', props: { text } })
  }

  const uploadReferenceAudio = async (): Promise<void> => {
    if (!project) return toast('项目未就绪')
    const result = await window.api.pickMedia(project.id)
    if (!result.ok) return toast(`上传失败：${result.error.message}`)
    const asset = pickImportedAsset({
      result: result.data,
      kind: 'audio',
      noun: '一段参考音频',
      mismatch: '请选择音频文件',
      projectId: project.id
    })
    if (!asset) return
    const extension = asset.path.slice(asset.path.lastIndexOf('.')).toLowerCase()
    if (!['.wav', '.mp3', '.pcm', '.ogg', '.opus'].includes(extension)) {
      toast('火山语音合成 1.0 参考音频仅支持 wav、mp3、pcm 或 ogg_opus 格式')
      return
    }
    if (asset.sizeBytes > VOLC_REFERENCE_AUDIO_MAX_BYTES) {
      toast(
        `火山语音合成 1.0 参考音频单段不能超过 ${VOLC_REFERENCE_AUDIO_MAX_BYTES / (1024 * 1024)} MB`
      )
      return
    }
    updateConfig({
      referenceAudioId: asset.id,
      referenceAudioPath: asset.path,
      referenceAudioName: asset.name ?? '参考音频'
    })
    markUndoPoint(editor, 'speech-reference-upload')
  }

  const removeReferenceAudio = (): void => {
    referenceAudioRef.current?.pause()
    referenceAudioRef.current = null
    setReferencePlaying(false)
    updateConfig({
      referenceAudioId: '',
      referenceAudioPath: '',
      referenceAudioName: ''
    })
    markUndoPoint(editor, 'speech-reference-remove')
  }

  const toggleReferencePlay = (): void => {
    if (!config.referenceAudioPath) return
    if (referencePlaying) {
      referenceAudioRef.current?.pause()
      setReferencePlaying(false)
      return
    }
    referenceAudioRef.current?.pause()
    const player = new Audio(mediaUrl(config.referenceAudioPath))
    player.currentTime = 0
    player.onended = () => setReferencePlaying(false)
    player.onpause = () => setReferencePlaying(false)
    referenceAudioRef.current = player
    void player.play().then(() => setReferencePlaying(true))
  }

  const switchBackend = (backend: SpeechBackend): void => {
    const format = defaultSpeechFormat(backend)
    updateConfig({
      backend,
      format,
      sampleRate: defaultSpeechSampleRate(backend, format),
      // 供应商与协议强绑定：换协议必须重选，不能把 MiniMax 实例留给火山通道。
      providerId: '',
      modelId: backend === 'volc' ? 'seed-audio-1.0' : 'speech-2.8-hd',
      // 两家供应商的音色 ID 不兼容，切换时清空以免把旧 ID 发给另一家。
      voiceId: ''
    })
    markUndoPoint(editor, 'speech-backend')
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
    options.some(
      (option) => option.provider.id === config.providerId && option.model.id === config.modelId
    ) &&
    draft.length <= limit &&
    referenceCount <= VOLC_REFERENCE_AUDIO_MAX_COUNT

  return (
    <div className="node-tts node-speech">
      {/* ── 协议与模型：决定下面所有参数分组与节点端口 ── */}
      <div className="tts-section">
        <div className="tts-section-label">
          <Icon name="settings" size={13} />
          <span>合成通道</span>
        </div>
        <div className="tts-options">
          <label className="opt-label">供应商</label>
          <AppSelect
            className="gen-select small"
            aria-label="语音合成供应商"
            value={config.backend}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => switchBackend(e.target.value as SpeechBackend)}
          >
            {SPEECH_BACKENDS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </AppSelect>
        </div>
        <div className="gen-capability-note">
          {SPEECH_BACKENDS.find((item) => item.value === config.backend)?.hint}
        </div>
        <div className="tts-options">
          <label className="opt-label">模型</label>
          <AppSelect
            className="gen-select"
            aria-label="模型"
            value={config.providerId ? `${config.providerId}::${config.modelId}` : ''}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              const selected = options.find((item) => item.key === e.target.value)
              if (selected) {
                updateConfig({
                  providerId: selected.provider.id,
                  modelId: selected.model.id,
                  emotion: isSpeechEmotionSupported(selected.model.id, config.emotion)
                    ? config.emotion
                    : ''
                })
              }
            }}
          >
            <option value="">{providersLoaded ? '选择语音模型…' : '加载模型中…'}</option>
            {options.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </AppSelect>
        </div>
        {providersLoaded && options.length === 0 && (
          <button
            className="btn-ghost small"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              void openSettings()
            }}
          >
            去配置该协议的供应商
          </button>
        )}
      </div>

      {/* ── 音色：用户强调音色与 ID 是最重要的信息 ── */}
      <div className="tts-section">
        <div className="tts-section-label">
          <Icon name="audio" size={13} />
          <span>音色</span>
        </div>
        <input
          className="gen-input"
          aria-label="音色 ID"
          spellCheck={false}
          value={config.voiceId}
          placeholder={
            config.backend === 'minimax'
              ? // 留空不是"交给服务端"：MiniMax 两条 t2a 通道缺 voice_id 会在建任务前就被拒，
                // 所以网关固定兜底成这个系统音色。写出来才知道留空跑出来的是谁的声音。
                '音色 ID（留空用 MiniMax 系统音色 male-qn-qingse）'
              : 'speaker 音色 ID（可选）'
          }
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => updateConfig({ voiceId: e.target.value })}
        />
        <div className="gen-capability-note">
          {config.backend === 'volc'
            ? '火山 speaker ID 可与参考音频同时使用；MiniMax 音色设计/克隆生成的 voice_id 不兼容。'
            : '连接上游 MiniMax「音色设计 / 语音克隆」节点的音色档案时，以连线传入的 voice_id 为准。'}
        </div>
      </div>

      {/* ── 火山引擎语音合成 1.0 可选参考音频 ── */}
      {config.backend === 'volc' && (
        <div className="tts-section tts-reference-section">
          <div className="tts-section-label">
            <Icon name="audio" size={13} />
            <span>参考音频（可选）</span>
          </div>
          {uploadedReference ? (
            <div className="tts-ref-player">
              <button
                className="audio-play-btn"
                onPointerDown={(e) => stopEventPropagation(e)}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleReferencePlay()
                }}
              >
                {referencePlaying ? '暂停' : '试听'}
              </button>
              <span className="tts-ref-name">{config.referenceAudioName || '参考音频'}</span>
              <button
                className="btn-ghost small"
                title="替换参考音频"
                onPointerDown={(e) => stopEventPropagation(e)}
                onClick={(e) => {
                  e.stopPropagation()
                  void uploadReferenceAudio()
                }}
              >
                替换
              </button>
              <button
                className="btn-ghost small danger"
                title="移除参考音频"
                onPointerDown={(e) => stopEventPropagation(e)}
                onClick={(e) => {
                  e.stopPropagation()
                  removeReferenceAudio()
                }}
              >
                移除
              </button>
            </div>
          ) : (
            <button
              className="tts-upload-btn"
              disabled={referenceCount >= VOLC_REFERENCE_AUDIO_MAX_COUNT}
              onPointerDown={(e) => stopEventPropagation(e)}
              onClick={(e) => {
                e.stopPropagation()
                void uploadReferenceAudio()
              }}
            >
              <Icon name="upload" size={18} />
              <span>上传参考音频</span>
              <span className="tts-upload-hint">
                可留空；最多 {VOLC_REFERENCE_AUDIO_MAX_COUNT} 段，每段不超过{' '}
                {VOLC_REFERENCE_AUDIO_MAX_SECONDS} 秒 /{' '}
                {VOLC_REFERENCE_AUDIO_MAX_BYTES / (1024 * 1024)} MB，支持 wav、mp3、pcm、ogg_opus
              </span>
            </button>
          )}
          <span className={`node-wiring ${referenceCount > 0 ? 'ok' : ''}`}>
            {referenceCount > 0
              ? `使用 ${incomingReferences} 段连线音频${uploadedReference ? '和 1 段本节点上传音频' : ''}`
              : '未设置参考音频，按 text_prompt 描述生成，也可填写 speaker ID'}
          </span>
          <div className="gen-capability-note">
            {referenceCount > 0
              ? `按连线顺序引用音频，本节点上传项追加在末尾；文本会自动引用 @音频1～@音频${Math.min(referenceCount, VOLC_REFERENCE_AUDIO_MAX_COUNT)}。speaker ID 可与参考音频一起发送。`
              : '参考音频可选；speaker ID 也可单独使用。'}
          </div>
          {referenceCount > VOLC_REFERENCE_AUDIO_MAX_COUNT && (
            <div className="gen-capability-note error" role="alert">
              最多使用 {VOLC_REFERENCE_AUDIO_MAX_COUNT} 段参考音频，请减少连线数量。
            </div>
          )}
        </div>
      )}

      {/* ── 朗读文本 ── */}
      <div className="tts-section">
        <div className="tts-section-label">
          <Icon name="text" size={13} />
          <span>朗读文本</span>
        </div>
        <textarea
          className="gen-textarea tts"
          aria-label="朗读文本"
          value={draft}
          placeholder="输入要朗读的文本，上游文本节点内容会自动合并…"
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => updateText(draft)}
        />
        <div
          className={`audio-text-meta ${draft.length > limit ? 'over-limit' : ''}`}
          role={draft.length > limit ? 'alert' : undefined}
        >
          {draft.length} / {limit} 字 · 可由文本节点提供
        </div>
      </div>

      {/* ── MiniMax 语音参数 ── */}
      {config.backend === 'minimax' && (
        <div className="tts-section">
          <div className="tts-section-label">
            <Icon name="spark" size={13} />
            <span>语音参数</span>
          </div>
          <div className="tts-sliders">
            <div className="tts-slider-row">
              <label className="opt-label">语速 {config.speed.toFixed(2)}x</label>
              <input
                type="range"
                aria-label="语速"
                min="0.5"
                max="2"
                step="0.05"
                value={config.speed}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => updateConfig({ speed: Number(e.target.value) })}
              />
            </div>
            <div className="tts-slider-row">
              <label className="opt-label">音量 {config.volume.toFixed(2)}</label>
              <input
                type="range"
                aria-label="音量"
                min="0.01"
                max="10"
                step="0.01"
                value={config.volume}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => updateConfig({ volume: Number(e.target.value) })}
              />
            </div>
            <div className="tts-slider-row">
              <label className="opt-label">音调 {config.pitch}</label>
              <input
                type="range"
                aria-label="音调"
                min="-12"
                max="12"
                step="1"
                value={config.pitch}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => updateConfig({ pitch: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="tts-options">
            <label className="opt-label">情绪</label>
            <AppSelect
              className="gen-select small"
              aria-label="情绪"
              value={config.emotion}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => updateConfig({ emotion: e.target.value as SpeechEmotion })}
            >
              {emotionOptions.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </AppSelect>
          </div>
          <label className="opt-label">读音纠正（可选）</label>
          <textarea
            className="gen-textarea tts short"
            aria-label="读音纠正（可选）"
            value={config.pronunciationTones}
            placeholder={'重庆/(chong2)(qing4)\n银行/(yin2)(hang2)'}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => updateConfig({ pronunciationTones: e.target.value })}
          />
          <div className="gen-capability-note">
            仅 MiniMax
            使用。每行一条，写“词/(拼音)(拼音)”，每个字一个拼音，数字标声调。例：朗读文本写“我去重庆的一家银行。”，这里写“重庆/(chong2)(qing4)”和“银行/(yin2)(hang2)”。
          </div>
        </div>
      )}

      {/* ── 火山引擎语音合成 1.0 参数 ── */}
      {config.backend === 'volc' && (
        <div className="tts-section">
          <div className="tts-section-label">
            <Icon name="spark" size={13} />
            <span>语音参数</span>
          </div>
          <div className="tts-sliders">
            <div className="tts-slider-row">
              <label className="opt-label">语速 {config.speechRate}</label>
              <input
                type="range"
                aria-label="语速"
                min="-50"
                max="100"
                step="1"
                value={config.speechRate}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => updateConfig({ speechRate: Number(e.target.value) })}
              />
            </div>
            <div className="tts-slider-row">
              <label className="opt-label">音量 {config.loudnessRate}</label>
              <input
                type="range"
                aria-label="音量"
                min="-50"
                max="100"
                step="1"
                value={config.loudnessRate}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => updateConfig({ loudnessRate: Number(e.target.value) })}
              />
            </div>
            <div className="tts-slider-row">
              <label className="opt-label">音调 {config.pitchRate}</label>
              <input
                type="range"
                aria-label="音调"
                min="-12"
                max="12"
                step="1"
                value={config.pitchRate}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => updateConfig({ pitchRate: Number(e.target.value) })}
              />
            </div>
          </div>
          <label className="tts-inline-toggle">
            <input
              type="checkbox"
              checked={config.enableSubtitle}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => updateConfig({ enableSubtitle: e.target.checked })}
            />
            返回字幕时间轴（新增 out-subtitle 输出）
          </label>
        </div>
      )}

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
          '合成中…'
        ) : (
          <>
            <Icon name="audio" size={14} />
            生成配音
          </>
        )}
      </button>

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
              <span className="audio-player-meta">{config.voiceId || '默认音色'}</span>
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
              markUndoPoint(editor, 'speech-select-result')
            }}
            onDelete={(item) => {
              const nodeResult = removeMediaResultFromShape(shape, item)
              if (!nodeResult) return
              editor.updateShape({
                id: shape.id,
                type: 'node-card',
                meta: { ...(shape.meta ?? {}), nodeResult }
              })
              markUndoPoint(editor, 'speech-delete-result')
            }}
            onClear={() => {
              const nodeResult = clearSelectedMediaHistory(shape)
              if (!nodeResult) return
              editor.updateShape({
                id: shape.id,
                type: 'node-card',
                meta: { ...(shape.meta ?? {}), nodeResult }
              })
              markUndoPoint(editor, 'speech-clear-history')
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

      {/* ── 字幕：只有火山语音合成 1.0 开启字幕时才有内容 ── */}
      {sentences.length > 0 && (
        <div className="tts-section speech-subtitle">
          <div className="tts-section-label">
            <Icon name="text" size={13} />
            <span>字幕时间轴（{sentences.length} 句）</span>
          </div>
          <ol className="speech-subtitle-list">
            {sentences.slice(0, 8).map((sentence, index) => (
              <li key={`${sentence.start_time}-${index}`}>
                <span className="speech-subtitle-time">
                  {formatSeconds(sentence.start_time)}–{formatSeconds(sentence.end_time)}
                </span>
                <span className="speech-subtitle-text">{sentence.text}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}

/** 配音节点的右侧设置面板：高级输出参数，不挤占卡片正文。 */
export function SpeechSettings({ shape, editor }: NodeSettingsProps): React.JSX.Element {
  const config = parseSpeechConfig(readNodeConfig(shape))
  const save = (patch: Partial<SpeechConfig>): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeSpeechConfig({ ...config, ...patch }) }
    })
  }

  return (
    <div className="node-settings speech-settings">
      {config.backend === 'minimax' && (
        <>
          {/* 码率与声道只被 MiniMax 异步通道的 audio_setting 读取；其他后端不收这两个字段，故不呈现。 */}
          <div className="settings-row">
            <label className="opt-label">码率</label>
            <AppSelect
              className="gen-select small"
              aria-label="码率"
              value={String(config.bitrate)}
              onChange={(e) => save({ bitrate: Number(e.target.value) })}
            >
              {SPEECH_BITRATES.map((rate) => (
                <option key={rate} value={rate}>
                  {rate / 1000} kbps
                </option>
              ))}
            </AppSelect>
          </div>
          <div className="settings-row">
            <label className="opt-label">声道</label>
            <AppSelect
              className="gen-select small"
              aria-label="声道"
              value={String(config.audioChannel)}
              onChange={(e) => save({ audioChannel: Number(e.target.value) === 2 ? 2 : 1 })}
            >
              <option value="1">单声道</option>
              <option value="2">双声道</option>
            </AppSelect>
          </div>
          <label className="tts-inline-toggle">
            <input
              type="checkbox"
              checked={config.englishNormalization}
              onChange={(e) => save({ englishNormalization: e.target.checked })}
            />
            英文规范化
          </label>
          <div className="tts-sliders">
            <div className="tts-slider-row">
              <label className="opt-label">音色修饰 · 音调 {config.voicePitch}</label>
              <input
                type="range"
                aria-label="音色修饰 · 音调"
                min="-100"
                max="100"
                step="1"
                value={config.voicePitch}
                onChange={(e) => save({ voicePitch: Number(e.target.value) })}
              />
            </div>
            <div className="tts-slider-row">
              <label className="opt-label">音色修饰 · 强度 {config.voiceIntensity}</label>
              <input
                type="range"
                aria-label="音色修饰 · 强度"
                min="-100"
                max="100"
                step="1"
                value={config.voiceIntensity}
                onChange={(e) => save({ voiceIntensity: Number(e.target.value) })}
              />
            </div>
            <div className="tts-slider-row">
              <label className="opt-label">音色修饰 · 音色 {config.voiceTimbre}</label>
              <input
                type="range"
                aria-label="音色修饰 · 音色"
                min="-100"
                max="100"
                step="1"
                value={config.voiceTimbre}
                onChange={(e) => save({ voiceTimbre: Number(e.target.value) })}
              />
            </div>
          </div>
        </>
      )}
      <label className="tts-inline-toggle">
        <input
          type="checkbox"
          checked={config.aigcWatermark}
          onChange={(e) => save({ aigcWatermark: e.target.checked })}
        />
        AIGC 音频水印
      </label>
    </div>
  )
}
