// 配音节点 Body（模型驱动：MiniMax 异步 / 豆包语音 / OpenAI 兼容）。
//
// 这里不绕过 executor 调用模型：按钮只把当前配置与正文写回节点，然后交给统一的
// runNodeManually 运行路径。参数分组随 config.backend 变化——这正是用户要的
// 「选择模型的不同，也决定了它的输入和输出的结构」。
import { useEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import { mediaUrl, type NodeBodyProps, type NodeSettingsProps } from '../../registry'
import { toast } from '../../../stores/toast'
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
  SPEECH_FORMATS_BY_BACKEND,
  SPEECH_LANGUAGE_BOOSTS,
  SPEECH_SAMPLE_RATE_BACKENDS,
  SPEECH_SAMPLE_RATES,
  SPEECH_SOUND_EFFECTS,
  SPEECH_TEXT_LIMITS,
  VOLC_CLUSTERS,
  parseSpeechConfig,
  serializeSpeechConfig,
  type SpeechBackend,
  type SpeechConfig,
  type SpeechEmotion,
  type SpeechFormat
} from '@shared/speech'
import type { ProviderSpecId } from '@shared/types'
import {
  clearSelectedMediaHistory,
  MediaFileActions,
  MediaResultGrid,
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

/** 每种协议只接受对应供应商：原生协议与 OpenAI 兼容端点不能互相顶替。 */
function acceptsProvider(backend: SpeechBackend, specId: ProviderSpecId): boolean {
  if (backend === 'minimax') return specId === 'minimax'
  // 火山 1.0 与豆包共用 openspeech.bytedance.com 的供应商实例：同一份 baseURL 与
  // access token，只是路径不同（/api/v1/tts 与 /api/v3/tts/create）。
  if (backend === 'doubao' || backend === 'volc') return specId === 'doubao-speech'
  return specId !== 'minimax' && specId !== 'doubao-speech'
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
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const options = modelsByModality(providers, 'audio').filter((option) =>
    acceptsProvider(config.backend, option.provider.specId)
  )
  const formats = SPEECH_FORMATS_BY_BACKEND[config.backend]
  const sentences = subtitleSentences(shape)
  const limit = SPEECH_TEXT_LIMITS[config.backend]

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

  const switchBackend = (backend: SpeechBackend): void => {
    const allowed = SPEECH_FORMATS_BY_BACKEND[backend]
    updateConfig({
      backend,
      // 换协议时把不适用的格式收敛到该协议的第一档，避免配置与请求体互相矛盾。
      ...(allowed.includes(config.format) ? {} : { format: allowed[0] }),
      // 供应商与协议强绑定：换协议必须重选，不能把 MiniMax 实例留给豆包通道。
      providerId: '',
      modelId: backend === 'doubao' ? 'seed-audio-1.0' : 'speech-2.8-hd'
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
  // 火山 1.0 的 appid 与 voice_type 都是请求体必填项，缺任何一项执行器都会跳过，
  // 所以按钮与卡片上的事实句都按同一判据给出（§16.16：运行前就能看出会不会跳过）。
  const volcMissing =
    config.backend !== 'volc'
      ? ''
      : !config.volcAppId
        ? '未填写 AppID，运行会跳过'
        : !config.voiceId.trim()
          ? '未填写音色 ID（voice_type），运行会跳过'
          : ''
  const canGenerate =
    Boolean(draft.trim()) && Boolean(config.providerId) && draft.length <= limit && !volcMissing

  return (
    <div className="node-tts node-speech">
      {/* ── 协议与模型：决定下面所有参数分组与节点端口 ── */}
      <div className="tts-section">
        <div className="tts-section-label">
          <Icon name="settings" size={13} />
          <span>合成通道</span>
        </div>
        <div className="tts-options">
          <label className="opt-label">协议</label>
          <AppSelect
            className="gen-select small"
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
            value={config.providerId ? `${config.providerId}::${config.modelId}` : ''}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              const selected = options.find((item) => item.key === e.target.value)
              if (selected) {
                updateConfig({ providerId: selected.provider.id, modelId: selected.model.id })
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
          value={config.voiceId}
          placeholder={
            config.backend === 'volc'
              ? 'voice_type，例如 BV001_streaming'
              : '音色 ID（留空用服务端默认音色）'
          }
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => updateConfig({ voiceId: e.target.value })}
        />
        <div className="gen-capability-note">
          {config.backend === 'volc'
            ? '火山 1.0 只认自家的 voice_type；上游「音色设计 / 语音克隆」的 MiniMax 音色档案不是它的输入，节点上也没有 in-voice 端口。'
            : '连接上游「音色设计 / 语音克隆」节点的音色档案时，以连线传入的 voice_id 为准。'}
        </div>
      </div>

      {/* ── 火山引擎语音合成 1.0：appid 与 cluster 是请求体字段，不是供应商凭据 ── */}
      {config.backend === 'volc' && (
        <div className="tts-section">
          <div className="tts-options">
            <label className="opt-label" title="请求体 app.appid，取自火山引擎控制台的应用 ID">
              AppID
            </label>
            <input
              className="gen-input"
              value={config.volcAppId}
              placeholder="控制台应用 AppID"
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => updateConfig({ volcAppId: e.target.value })}
            />
          </div>
          <div className="tts-options">
            <label
              className="opt-label"
              title="请求体 app.cluster，音色所属集群；两个集群的音色不互通"
            >
              集群
            </label>
            <AppSelect
              className="gen-select small"
              value={config.volcCluster}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => updateConfig({ volcCluster: e.target.value })}
            >
              {VOLC_CLUSTERS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </AppSelect>
          </div>
          <div className="tts-slider-row">
            <label className="opt-label" title="请求体 audio.speed_ratio">
              语速 {config.speed}
            </label>
            <input
              type="range"
              min="0.5"
              max="2"
              step="0.05"
              value={config.speed}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => updateConfig({ speed: Number(e.target.value) })}
            />
          </div>
          <span className={`node-wiring ${volcMissing ? 'warn' : 'ok'}`}>
            {volcMissing || `AppID 与 voice_type 已填写，POST /api/v1/tts`}
          </span>
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
          value={draft}
          placeholder="输入要朗读的文本，上游文本节点内容会自动合并…"
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => updateText(draft)}
        />
        <div className={`audio-text-meta ${draft.length > limit ? 'over-limit' : ''}`}>
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
                min="0.5"
                max="2"
                step="0.05"
                value={config.speed}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => updateConfig({ speed: Number(e.target.value) })}
              />
            </div>
            <div className="tts-slider-row">
              <label className="opt-label">音量 {config.volume.toFixed(1)}</label>
              <input
                type="range"
                min="0.1"
                max="10"
                step="0.1"
                value={config.volume}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => updateConfig({ volume: Number(e.target.value) })}
              />
            </div>
            <div className="tts-slider-row">
              <label className="opt-label">音调 {config.pitch}</label>
              <input
                type="range"
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
              value={config.emotion}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => updateConfig({ emotion: e.target.value as SpeechEmotion })}
            >
              {SPEECH_EMOTIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </AppSelect>
            <label className="opt-label">音效</label>
            <AppSelect
              className="gen-select small"
              value={config.soundEffects}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => updateConfig({ soundEffects: e.target.value })}
            >
              {SPEECH_SOUND_EFFECTS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </AppSelect>
          </div>
          <div className="tts-options">
            <label className="opt-label">语言增强</label>
            <AppSelect
              className="gen-select small"
              value={config.languageBoost}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => updateConfig({ languageBoost: e.target.value })}
            >
              {SPEECH_LANGUAGE_BOOSTS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </AppSelect>
          </div>
          <label className="opt-label">发音词典（每行「词 拼音」）</label>
          <textarea
            className="gen-textarea tts short"
            value={config.pronunciationTones}
            placeholder={'例如：\n调音台 tiao2 yin1 tai2'}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => updateConfig({ pronunciationTones: e.target.value })}
          />
        </div>
      )}

      {/* ── 豆包语音参数 ── */}
      {config.backend === 'doubao' && (
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

      {/* ── 输出格式：所有协议都要；采样率只有 MiniMax 与豆包的请求体读取 ── */}
      <div className="tts-options">
        <label className="opt-label">格式</label>
        <AppSelect
          className="gen-select small"
          value={config.format}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => updateConfig({ format: e.target.value as SpeechFormat })}
        >
          {formats.map((f) => (
            <option key={f} value={f}>
              {f.toUpperCase()}
            </option>
          ))}
        </AppSelect>
        {SPEECH_SAMPLE_RATE_BACKENDS.includes(config.backend) && (
          <>
            <label className="opt-label">采样率</label>
            <AppSelect
              className="gen-select small"
              value={String(config.sampleRate)}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => updateConfig({ sampleRate: Number(e.target.value) })}
            >
              {SPEECH_SAMPLE_RATES.map((rate) => (
                <option key={rate} value={rate}>
                  {rate / 1000} kHz
                </option>
              ))}
            </AppSelect>
          </>
        )}
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
              <span className="audio-player-meta">
                {config.voiceId || '默认音色'} · {config.format.toUpperCase()}
              </span>
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

      {/* ── 字幕：只有豆包开启字幕时才有内容 ── */}
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
