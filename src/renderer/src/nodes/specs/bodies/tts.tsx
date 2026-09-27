// 音色克隆只登记可复用 voice_id；朗读文本由语音合成节点处理。
import { useEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import { mediaUrl, type NodeBodyProps } from '../../registry'
import { toast } from '../../../stores/toast'
import { countIncomingConnections } from '../../../canvas/graph'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { runNodeManually } from '../../../engine/executor'
import { useAppStore } from '../../../stores/app'
import { Icon } from '../../../components/Icon'
import { AppSelect } from '../../../components/AppSelect'
import { MINIMAX_CLONE_MAX_BYTES, MINIMAX_CLONE_MAX_SECONDS, MINIMAX_CLONE_MIN_SECONDS, MINIMAX_CLONE_PROMPT_MAX_SECONDS, MINIMAX_VOICE_CLONE_MODELS, isValidMiniMaxVoiceId, parseTtsConfig, type TtsConfig } from '@shared/tts'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import { parseNodeExtra } from '../../nodeValues'
import { pickImportedAsset } from './shared'

export function TtsBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const project = useAppStore((state) => state.currentProject)
  const providers = useGatewayStore((state) => state.providers)
  const loaded = useGatewayStore((state) => state.loaded)
  const loadProviders = useGatewayStore((state) => state.load)
  const openCatalog = useGatewayStore((state) => state.openCatalog)
  const config = parseTtsConfig(readNodeConfig(shape))
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const models = modelsByModality(providers, 'audio').filter(
    (option) => option.provider.specId === 'minimax' && MINIMAX_VOICE_CLONE_MODELS.includes(option.model.id)
  )
  const selected = models.find((option) => option.provider.id === config.providerId && option.model.id === config.modelId)
    ?? (!config.providerId ? models[0] : undefined)
  const profile = parseNodeExtra(shape.meta?.nodeExtra)['out-json']
  const voiceId = profile && typeof profile === 'object' && !Array.isArray(profile)
    ? String((profile as { voice_id?: unknown }).voice_id ?? '') : ''
  const invalidId = Boolean(config.voiceId.trim()) && !isValidMiniMaxVoiceId(config.voiceId.trim())
  const incomingRef = countIncomingConnections(editor, shape.id, 'in-audio')

  useEffect(() => { if (!loaded) void loadProviders() }, [loaded, loadProviders])
  useEffect(() => () => audioRef.current?.pause(), [])

  const updateConfig = (patch: Partial<TtsConfig>): void => {
    editor.updateShape({ id: shape.id, type: 'node-card', props: { config: JSON.stringify({ ...config, ...patch }) } })
  }

  const uploadAudio = async (prompt: boolean): Promise<void> => {
    if (!project) return toast('项目未就绪')
    const response = await window.api.pickMedia(project.id)
    if (!response.ok) return toast(`上传失败：${response.error.message}`)
    const asset = pickImportedAsset({ result: response.data, kind: 'audio', noun: prompt ? '一段辅助提示音' : '一段参考语音', mismatch: '请选择音频文件', projectId: project.id })
    if (!asset) return
    const extension = asset.path.slice(asset.path.lastIndexOf('.')).toLowerCase()
    if (!['.mp3', '.m4a', '.wav'].includes(extension) || asset.sizeBytes > MINIMAX_CLONE_MAX_BYTES)
      return toast('仅支持 20 MB 以内的 mp3、m4a 或 wav 音频')
    if (typeof asset.durationSec === 'number' && asset.durationSec > 0) {
      if (prompt && asset.durationSec >= MINIMAX_CLONE_PROMPT_MAX_SECONDS) return toast('辅助提示音必须短于 8 秒')
      if (!prompt && (asset.durationSec < MINIMAX_CLONE_MIN_SECONDS || asset.durationSec > MINIMAX_CLONE_MAX_SECONDS)) return toast('参考语音须为 10 秒至 5 分钟')
    }
    if (prompt) updateConfig({ promptMediaId: asset.id, promptMediaPath: asset.path, promptMediaMime: asset.mime, promptMediaName: asset.name ?? '辅助提示音' })
    else updateConfig({ refMediaId: asset.id, refMediaPath: asset.path, refMediaMime: asset.mime, refMediaName: asset.name ?? '参考语音' })
  }

  const clone = async (): Promise<void> => {
    if (!project) return toast('项目未就绪')
    if (!selected) return toast('请选择 MiniMax 语音模型')
    updateConfig({ providerId: selected.provider.id, modelId: selected.model.id })
    setBusy(true)
    try { await runNodeManually(editor, project.id, providers, shape.id) }
    finally { setBusy(false) }
  }

  const toggleReference = (): void => {
    if (!config.refMediaPath) return
    if (playing) return audioRef.current?.pause()
    audioRef.current?.pause()
    const audio = new Audio(mediaUrl(config.refMediaPath))
    audioRef.current = audio
    audio.onpause = () => setPlaying(false)
    audio.onended = () => setPlaying(false)
    void audio.play().then(() => setPlaying(true)).catch(() => toast('参考语音播放失败'))
  }

  return <div className="node-tts">
    <div className="tts-section tts-reference-section">
      <div className="tts-section-label"><Icon name="audio" size={13} /><span>参考语音</span></div>
      {config.refMediaId ? <div className="tts-ref-player">
        <button className="audio-play-btn tts-ref-play" aria-label={playing ? '暂停参考语音' : '试听参考语音'} onPointerDown={stopEventPropagation} onClick={(event) => { event.stopPropagation(); toggleReference() }}><Icon name={playing ? 'pause' : 'play'} size={15} /></button>
        <span className="tts-ref-name">{config.refMediaName || '参考语音'}</span>
        <button className="btn-ghost small" onPointerDown={stopEventPropagation} onClick={(event) => { event.stopPropagation(); void uploadAudio(false) }}>替换</button>
        <button className="btn-ghost small danger" onPointerDown={stopEventPropagation} onClick={(event) => { event.stopPropagation(); audioRef.current?.pause(); audioRef.current = null; updateConfig({ refMediaId: '', refMediaPath: '', refMediaMime: '', refMediaName: '' }) }}>移除</button>
      </div> : <button className="tts-upload-btn" onPointerDown={stopEventPropagation} onClick={(event) => { event.stopPropagation(); void uploadAudio(false) }}><Icon name="upload" size={18} />上传参考语音</button>}
      <small>也可从左侧连接音频；支持 mp3、m4a、wav，10 秒至 5 分钟。</small>
    </div>
    <div className="tts-section tts-engine-section">
      <div className="tts-section-label"><Icon name="settings" size={13} /><span>MiniMax 音色克隆</span></div>
      <AppSelect className="gen-select" aria-label="MiniMax 语音模型" value={selected?.key ?? ''} onPointerDown={(event) => event.stopPropagation()} onChange={(event) => {
        const next = models.find((option) => option.key === event.target.value)
        if (next) updateConfig({ providerId: next.provider.id, modelId: next.model.id })
      }}><option value="">选择 MiniMax 模型…</option>{models.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</AppSelect>
      {loaded && !models.length && <button className="btn-ghost small" onPointerDown={stopEventPropagation} onClick={(event) => { event.stopPropagation(); openCatalog() }}>添加 MiniMax 模型</button>}
      <input className="gen-input" aria-label="自定义音色 ID" placeholder="可选：自定义音色 ID" value={config.voiceId} onPointerDown={(event) => event.stopPropagation()} onChange={(event) => updateConfig({ voiceId: event.target.value })} />
      {invalidId && <small className="gen-capability-note error">音色 ID 需 8～256 位，以字母开头，末位不能是 - 或 _。</small>}
      <input className="gen-input" aria-label="参考语音原文" placeholder="可选：参考语音原文，用于内容校验" value={config.textValidation} onPointerDown={(event) => event.stopPropagation()} onChange={(event) => updateConfig({ textValidation: event.target.value.slice(0, 200) })} />
      <button className="btn-ghost small" onPointerDown={stopEventPropagation} onClick={(event) => { event.stopPropagation(); void uploadAudio(true) }}>{config.promptMediaId ? '替换辅助提示音' : '添加辅助提示音（可选）'}</button>
      {config.promptMediaId && <><small>{config.promptMediaName || '辅助提示音'} · 小于 8 秒</small>
        <input className="gen-input" aria-label="辅助提示音原文" placeholder="填写辅助提示音原文" value={config.promptText} onPointerDown={(event) => event.stopPropagation()} onChange={(event) => updateConfig({ promptText: event.target.value })} />
        <button className="btn-ghost small" onPointerDown={stopEventPropagation} onClick={(event) => { event.stopPropagation(); updateConfig({ promptMediaId: '', promptMediaPath: '', promptMediaMime: '', promptMediaName: '', promptText: '' }) }}>移除辅助提示音</button></>}
    </div>
    <button className="btn-generate" disabled={busy || !selected || (incomingRef === 0 && !config.refMediaId) || invalidId || (Boolean(config.promptMediaId) && !config.promptText.trim())} onPointerDown={stopEventPropagation} onClick={(event) => { event.stopPropagation(); void clone() }}>{busy ? '克隆中…' : '克隆音色'}</button>
    {voiceId && <div className="tts-section voice-id-card"><div className="tts-section-label"><Icon name="check" size={13} /><span>已生成音色 ID</span></div>
      <div className="voice-id-row"><code className="voice-id-value">{voiceId}</code><button className="btn-ghost small" onPointerDown={stopEventPropagation} onClick={(event) => { event.stopPropagation(); void navigator.clipboard.writeText(voiceId).then(() => toast('已复制音色 ID')) }}>复制</button></div>
      <small>将右侧音色档案端口连接到“语音合成”节点，再输入要朗读的文字。</small></div>}
  </div>
}
