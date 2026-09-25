// TTS 语音克隆节点 Body（MiniMax voice_clone）。
import { useEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import { mediaUrl, type NodeBodyProps } from '../../registry'
import { toast } from '../../../stores/toast'
import { countIncomingConnections } from '../../../canvas/graph'
import { markUndoPoint } from '../../../canvas/history'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { runNodeManually } from '../../../engine/executor'
import { useAppStore } from '../../../stores/app'
import { Icon } from '../../../components/Icon'
import { AppSelect } from '../../../components/AppSelect'
import { parseTtsConfig } from '@shared/tts'
import { SPEECH_TEXT_LIMITS, isSpeechLanguageBoostSupported } from '@shared/speech'
import {
  MINIMAX_CLONE_RETENTION_DAYS,
  MINIMAX_CLONE_MAX_BYTES,
  MINIMAX_CLONE_MAX_SECONDS,
  MINIMAX_CLONE_MIMES,
  MINIMAX_CLONE_MIN_SECONDS,
  MINIMAX_CLONE_PROMPT_MAX_SECONDS,
  MINIMAX_VOICE_CLONE_MODELS,
  TTS_FORMATS_BY_BACKEND,
  TTS_LANGUAGE_BOOSTS,
  isValidMiniMaxVoiceId,
  type TtsConfig,
  type TtsFormat
} from '@shared/tts'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import { parseNodeExtra } from '../../nodeValues'
import {
  clearSelectedMediaHistory,
  MediaFileActions,
  MediaResultGrid,
  pickImportedAsset,
  removeMediaResultFromShape,
  selectMediaResult,
  useClickGuard
} from './shared'

/** 本次运行登记出的可复用音色 ID（来自 out-json 音色档案）。 */
function clonedVoiceId(shape: NodeBodyProps['shape']): string {
  const value = parseNodeExtra(shape.meta?.nodeExtra)['out-json']
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const voiceId = (value as { voice_id?: unknown }).voice_id
  return typeof voiceId === 'string' ? voiceId : ''
}

export function TtsBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)
  const providers = useGatewayStore((s) => s.providers)
  const providersLoaded = useGatewayStore((s) => s.loaded)
  const loadProviders = useGatewayStore((s) => s.load)
  const openSettings = useGatewayStore((s) => s.openSettings)
  const config = parseTtsConfig(readNodeConfig(shape))
  const [draft, setDraft] = useState(shape.props.text)
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [refPlaying, setRefPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const refAudioRef = useRef<HTMLAudioElement | null>(null)
  const minimaxModels = modelsByModality(providers, 'audio').filter(
    (option) =>
      option.provider.specId === 'minimax' && MINIMAX_VOICE_CLONE_MODELS.includes(option.model.id)
  )
  const languageBoostOptions = TTS_LANGUAGE_BOOSTS.filter((item) =>
    isSpeechLanguageBoostSupported(config.modelId, item.value)
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
    const audioAsset = pickImportedAsset({
      result: res.data,
      kind: 'audio',
      noun: '一段参考语音',
      mismatch: '请选择音频文件',
      projectId: project.id
    })
    if (!audioAsset) return
    const extension = audioAsset.path.slice(audioAsset.path.lastIndexOf('.')).toLowerCase()
    if (!['.mp3', '.m4a', '.wav'].includes(extension)) {
      toast('MiniMax 复刻参考音频仅支持 mp3、m4a 或 wav 格式')
      return
    }
    if (audioAsset.sizeBytes > MINIMAX_CLONE_MAX_BYTES) {
      toast(`MiniMax 复刻参考音频不能超过 ${MINIMAX_CLONE_MAX_BYTES / (1024 * 1024)} MB`)
      return
    }
    if (
      typeof audioAsset.durationSec === 'number' &&
      audioAsset.durationSec > 0 &&
      (audioAsset.durationSec < MINIMAX_CLONE_MIN_SECONDS ||
        audioAsset.durationSec > MINIMAX_CLONE_MAX_SECONDS)
    ) {
      toast(
        `MiniMax 复刻参考音频需 ${MINIMAX_CLONE_MIN_SECONDS} 秒至 ${MINIMAX_CLONE_MAX_SECONDS / 60} 分钟`
      )
      return
    }
    if (!MINIMAX_CLONE_MIMES.includes(audioAsset.mime.toLowerCase())) {
      toast('MiniMax 复刻参考音频仅支持 mp3、m4a 或 wav 格式')
      return
    }
    updateConfig({
      refMediaId: audioAsset.id,
      refMediaPath: audioAsset.path,
      refMediaMime: audioAsset.mime,
      refMediaName: audioAsset.name ?? '参考语音'
    })
    markUndoPoint(editor, 'tts-ref-upload')
  }

  const uploadPromptAudio = async (): Promise<void> => {
    if (!project) return toast('项目未就绪')
    const res = await window.api.pickMedia(project.id)
    if (!res.ok) return toast(`上传失败：${res.error.message}`)
    const audioAsset = pickImportedAsset({
      result: res.data,
      kind: 'audio',
      noun: '一段提示音',
      mismatch: '请选择音频文件',
      projectId: project.id
    })
    if (!audioAsset) return
    const extension = audioAsset.path.slice(audioAsset.path.lastIndexOf('.')).toLowerCase()
    if (!['.mp3', '.m4a', '.wav'].includes(extension)) {
      toast('MiniMax 克隆提示音仅支持 mp3、m4a 或 wav 格式')
      return
    }
    if (audioAsset.sizeBytes > MINIMAX_CLONE_MAX_BYTES) {
      toast(`MiniMax 克隆提示音不能超过 ${MINIMAX_CLONE_MAX_BYTES / (1024 * 1024)} MB`)
      return
    }
    if (
      typeof audioAsset.durationSec === 'number' &&
      audioAsset.durationSec >= MINIMAX_CLONE_PROMPT_MAX_SECONDS
    ) {
      toast(`MiniMax 克隆提示音必须小于 ${MINIMAX_CLONE_PROMPT_MAX_SECONDS} 秒`)
      return
    }
    if (!MINIMAX_CLONE_MIMES.includes(audioAsset.mime.toLowerCase())) {
      toast('MiniMax 克隆提示音仅支持 mp3、m4a 或 wav 格式')
      return
    }
    updateConfig({
      promptMediaId: audioAsset.id,
      promptMediaPath: audioAsset.path,
      promptMediaMime: audioAsset.mime,
      promptMediaName: audioAsset.name ?? '克隆提示音'
    })
    markUndoPoint(editor, 'tts-prompt-upload')
  }

  const removePromptAudio = (): void => {
    updateConfig({
      promptMediaId: '',
      promptMediaPath: '',
      promptMediaMime: '',
      promptMediaName: '',
      promptText: ''
    })
    markUndoPoint(editor, 'tts-prompt-remove')
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

  // 执行器取 in-audio 连线的参考音频，其次才用节点内上传的那份；朗读文本是本框正文与
  // in-text 连线合并的结果（shared/engine/executors/tts.ts）。
  const uploadedRef = Boolean(config.refMediaId && config.refMediaPath)
  const incomingRef = countIncomingConnections(editor, shape.id, 'in-audio')
  const incomingText = countIncomingConnections(editor, shape.id, 'in-text')
  const hasOutput = Boolean(shape.props.mediaPath)
  const voiceIdInvalid =
    config.backend === 'minimax' &&
    Boolean(config.voiceId.trim()) &&
    !isValidMiniMaxVoiceId(config.voiceId.trim())
  const resultVoiceId = clonedVoiceId(shape)

  return (
    <div className="node-tts">
      {/* ── 参考语音 ── */}
      <div className="tts-section tts-reference-section">
        <div className="tts-section-label">
          <Icon name="audio" size={13} />
          <span>参考语音</span>
        </div>
        {uploadedRef ? (
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
            <span className="tts-upload-hint">
              目标音色的录音，10 秒～5 分钟、不超过 20MB 的 mp3/m4a/wav
            </span>
          </button>
        )}
        <span className={`node-wiring ${incomingRef > 0 || uploadedRef ? 'ok' : 'warn'}`}>
          {incomingRef > 0
            ? `参考语音：取 in-audio 连线（${incomingRef} 个，用第一个）`
            : uploadedRef
              ? '参考语音：取本节点上传的那份'
              : '参考语音：未上传且 in-audio 未连线，运行会跳过'}
        </span>
        <label className="opt-label">参考语音原文（可选，最多 200 字）</label>
        <input
          className="gen-input"
          aria-label="参考语音原文（可选，最多 200 字）"
          value={config.textValidation}
          maxLength={200}
          placeholder="填写后校验录音内容是否与原文相符"
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => updateConfig({ textValidation: e.target.value })}
        />
        {config.textValidation.trim() && (
          <div className="tts-slider-row">
            <label className="opt-label">
              原文校验阈值 {config.accuracy > 0 ? config.accuracy.toFixed(2) : '默认 0.70'}
            </label>
            <input
              type="range"
              aria-label="原文校验阈值"
              min="0"
              max="1"
              step="0.05"
              value={config.accuracy}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => updateConfig({ accuracy: Number(e.target.value) })}
            />
          </div>
        )}
      </div>

      {/* ── 合成文字 ── */}
      <div className="tts-section tts-text-section">
        <div className="tts-section-label">
          <Icon name="text" size={13} />
          <span>合成文字</span>
        </div>
        <textarea
          className="gen-textarea tts"
          aria-label="合成文字"
          value={draft}
          placeholder="输入要朗读的文本…"
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => updateText(draft)}
        />
        <div className={`audio-text-meta ${draft.length > SPEECH_TEXT_LIMITS.minimax ? 'over-limit' : ''}`}>
          {draft.length} / {SPEECH_TEXT_LIMITS.minimax} 字 ·{' '}
          {incomingText > 0
            ? `in-text 已连线 ${incomingText} 个，运行会与本文合并`
            : 'in-text 未连线，运行只用本文'}
        </div>
      </div>

      {/* ── 合成参数 ── */}
      <div className="tts-section tts-engine-section">
        <div className="tts-section-label">
          <Icon name="settings" size={13} />
          <span>MiniMax 音色克隆</span>
        </div>
        {config.backend === 'comfyui' && (
          <div className="gen-capability-note warn">
            此节点保存了旧的本地 IndexTTS 配置。音色克隆现统一使用 MiniMax，请切换后选择 MiniMax 语音模型。
            <button
              className="btn-ghost small"
              onPointerDown={(e) => stopEventPropagation(e)}
              onClick={(e) => {
                e.stopPropagation()
                updateConfig({
                  backend: 'minimax',
                  providerId: '',
                  modelId: 'speech-2.8-turbo',
                  ...(config.format === 'wav' ? { format: 'mp3' } : {})
                })
              }}
            >
              切换到 MiniMax
            </button>
          </div>
        )}
        {config.backend === 'minimax' && (
          <div className="tts-minimax-options">
            <AppSelect
              className="gen-select"
              aria-label="MiniMax 语音模型"
              value={config.providerId ? `${config.providerId}::${config.modelId}` : ''}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                const selected = minimaxModels.find((item) => item.key === e.target.value)
                if (selected)
                  updateConfig({
                    providerId: selected.provider.id,
                    modelId: selected.model.id,
                    languageBoost: isSpeechLanguageBoostSupported(
                      selected.model.id,
                      config.languageBoost
                    )
                      ? config.languageBoost
                      : ''
                  })
              }}
            >
              <option value="">{providersLoaded ? '选择 MiniMax 语音模型…' : '加载模型中…'}</option>
              {minimaxModels.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </AppSelect>
            {providersLoaded && minimaxModels.length === 0 && (
              <button
                className="btn-ghost small"
                onPointerDown={(e) => stopEventPropagation(e)}
                onClick={(e) => {
                  e.stopPropagation()
                  void openSettings()
                }}
              >
                去配置 MiniMax 音色克隆模型
              </button>
            )}
            <input
              className={`gen-input ${voiceIdInvalid ? 'invalid' : ''}`}
              aria-label="自定义 Voice ID"
              spellCheck={false}
              value={config.voiceId}
              placeholder="可选：自定义 Voice ID"
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => updateConfig({ voiceId: e.target.value })}
            />
            {voiceIdInvalid && (
              <div className="gen-capability-note error" role="alert">
                Voice ID 需 8～256 位、以字母开头、只含字母数字与 - _，末位不能是 - 或 _
              </div>
            )}
            <div className="tts-options">
              <label className="opt-label">语言增强</label>
              <AppSelect
                className="gen-select small"
                aria-label="语言增强"
                value={config.languageBoost}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => updateConfig({ languageBoost: e.target.value })}
              >
                {languageBoostOptions.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </AppSelect>
            </div>
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

            {/* ── 克隆提示音（clone_prompt）：可选的第二段参考音频 + 其原文 ── */}
            <div className="tts-prompt-block">
              <div className="tts-section-label">
                <Icon name="audio" size={12} />
                <span>克隆提示音（可选）</span>
              </div>
              {config.promptMediaId ? (
                <>
                  <div className="tts-ref-player">
                    <span className="tts-ref-name">{config.promptMediaName || '克隆提示音'}</span>
                    <button
                      className="btn-ghost small danger"
                      title="替换克隆提示音"
                      onPointerDown={(e) => stopEventPropagation(e)}
                      onClick={(e) => {
                        e.stopPropagation()
                        void uploadPromptAudio()
                      }}
                    >
                      替换
                    </button>
                    <button
                      className="btn-ghost small danger"
                      title="移除克隆提示音"
                      onPointerDown={(e) => stopEventPropagation(e)}
                      onClick={(e) => {
                        e.stopPropagation()
                        removePromptAudio()
                      }}
                    >
                      移除
                    </button>
                  </div>
                  <input
                    className="gen-input"
                    aria-label="提示音对应的原文（必填）"
                    spellCheck={false}
                    value={config.promptText}
                    placeholder="提示音对应的原文（必填）"
                    onPointerDown={(e) => e.stopPropagation()}
                    onChange={(e) => updateConfig({ promptText: e.target.value })}
                  />
                  {!config.promptText.trim() && (
                    <div className="gen-capability-note error" role="alert">
                      使用克隆提示音时，必须填写与该音频对应的原文。
                    </div>
                  )}
                </>
              ) : (
                <button
                  className="btn-ghost small"
                  onPointerDown={(e) => stopEventPropagation(e)}
                  onClick={(e) => {
                    e.stopPropagation()
                    void uploadPromptAudio()
                  }}
                >
                  上传提示音
                </button>
              )}
            </div>

            <div className="gen-capability-note">
              参考音频需为 mp3 / m4a / wav，10 秒至 5 分钟且不超过 20MB；可选克隆提示音需小于 8
              秒且不超过 20MB。复刻音色会通过 MiniMax 异步语音合成生成新的独立音频资产。
            </div>
            <div className="gen-capability-note warn">
              复刻音色连续 {MINIMAX_CLONE_RETENTION_DAYS} 天未被调用会被 MiniMax
              自动删除；长期不用请重新复刻。
            </div>
          </div>
        )}
      </div>
      <div className="tts-options tts-output-options">
        {config.backend === 'minimax' && (
          <>
            <label className="opt-label">试听格式</label>
            <AppSelect
              className="gen-select small"
              aria-label="试听格式"
              value={config.format}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => updateConfig({ format: e.target.value as TtsFormat })}
            >
              {TTS_FORMATS_BY_BACKEND.minimax.map((format) => (
                <option key={format} value={format}>
                  {format.toUpperCase()}
                </option>
              ))}
            </AppSelect>
          </>
        )}
      </div>

      <button
        className="btn-generate"
      disabled={
        busy ||
        config.backend !== 'minimax' ||
          (!draft.trim() && incomingText === 0) ||
          draft.length > SPEECH_TEXT_LIMITS.minimax ||
        (incomingRef === 0 && !uploadedRef) ||
        (Boolean(config.promptMediaId) && !config.promptText.trim()) ||
        !minimaxModels.some(
          (item) => item.provider.id === config.providerId && item.model.id === config.modelId
        )
      }
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
          {resultVoiceId && (
            <div className="tts-section voice-id-card">
              <div className="tts-section-label">
                <Icon name="check" size={13} />
                <span>复刻音色 ID</span>
              </div>
              <div className="voice-id-row">
                <code className="voice-id-value">{resultVoiceId}</code>
                <button
                  className="btn-ghost small"
                  title="复制音色 ID"
                  onPointerDown={(e) => stopEventPropagation(e)}
                  onClick={(e) => {
                    e.stopPropagation()
                    void navigator.clipboard
                      .writeText(resultVoiceId)
                      .then(() => toast('已复制音色 ID'))
                  }}
                >
                  复制
                </button>
              </div>
              <div className="gen-capability-note">
                该 ID 已通过 out-json 输出给下游语音合成节点；也可手动填入语音合成节点的音色 ID。
              </div>
            </div>
          )}
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
                {config.backend === 'minimax' ? config.modelId : config.lang} ·{' '}
                {config.format.toUpperCase()}
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
