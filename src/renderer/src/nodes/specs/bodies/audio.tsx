// 音频节点 Body（路线图 R6：bodies.tsx 拆分）
import { useEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import { mediaUrl, type NodeBodyProps } from '../../registry'
import { toast } from '../../../stores/toast'
import { markUndoPoint } from '../../../canvas/history'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { runNodeManually } from '../../../engine/executor'
import { useAppStore } from '../../../stores/app'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import { Icon } from '../../../components/Icon'
import {
  clearSelectedMediaHistory,
  MediaFileActions,
  MediaResultGrid,
  removeMediaResultFromShape,
  MediaSourceBadge,
  ModelSelect,
  parseJsonProp,
  selectMediaResult
} from './shared'

type AudioMode = 'upload' | 'generate'

interface AudioData {
  mode: AudioMode
  modelKey: string
  text: string
  voice: string
  format: string
}

function parseAudioGen(text: string): AudioData {
  return parseJsonProp(
    text,
    (v) => {
      const o = v as Record<string, unknown>
      if (typeof o === 'object' && o !== null) {
        return {
          mode: o.mode === 'generate' ? 'generate' : 'upload',
          modelKey: typeof o.modelKey === 'string' ? o.modelKey : '',
          text: typeof o.text === 'string' ? o.text : '',
          voice: typeof o.voice === 'string' ? o.voice : 'alloy',
          format: typeof o.format === 'string' ? o.format : 'mp3'
        }
      }
      return null
    },
    { mode: 'upload', modelKey: '', text: '', voice: 'alloy', format: 'mp3' }
  )
}

const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']
const AUDIO_FORMATS = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']

export function AudioBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)
  const providers = useGatewayStore((s) => s.providers)
  const loaded = useGatewayStore((s) => s.loaded)
  const loadProviders = useGatewayStore((s) => s.load)
  const openSettings = useGatewayStore((s) => s.openSettings)
  const options = modelsByModality(providers, 'audio')
  const data = parseAudioGen(readNodeConfig(shape))
  const [draft, setDraft] = useState(data.text)
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

  // 组件卸载时释放音频元素，避免后台持续播放与音频流泄漏（A8）
  useEffect(() => {
    return () => {
      audioRef.current?.pause()
      if (audioRef.current) audioRef.current.src = ''
      audioRef.current = null
    }
  }, [])

  // 音频源变化（重新生成 / 替换文件）时丢弃旧元素，下次播放用新 URL 重建，避免播放旧内容
  useEffect(() => {
    if (!audioRef.current) return
    audioRef.current.pause()
    audioRef.current.src = ''
    audioRef.current = null
    setPlaying(false)
  }, [shape.props.mediaPath])

  const update = (next: AudioData): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: JSON.stringify(next) }
    })
  }

  const uploadAudio = async (): Promise<void> => {
    if (!project) return toast('项目未就绪')
    const res = await window.api.pickMedia(project.id)
    if (!res.ok) return toast(`上传失败：${res.error.message}`)
    const audioAsset = res.data.assets.find((a) => a.kind === 'audio')
    if (!audioAsset) return
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: {
        mediaId: audioAsset.id,
        mediaPath: audioAsset.path,
        mediaMime: audioAsset.mime,
        title: audioAsset.name ?? shape.props.title
      }
    })
    markUndoPoint(editor, 'audio-upload')
  }

  const togglePlay = (): void => {
    if (!shape.props.mediaPath) return
    if (playing) {
      audioRef.current?.pause()
      setPlaying(false)
    } else {
      // 先在局部变量上配置新元素，再写入 ref；避免把 ref 中的可变对象当作状态直接修改。
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

  const removeAudio = (): void => {
    audioRef.current?.pause()
    audioRef.current = null
    setPlaying(false)
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { mediaId: '', mediaPath: '', mediaMime: '' }
    })
    markUndoPoint(editor, 'audio-remove')
  }

  const generate = async (): Promise<void> => {
    if (!project) return toast('项目未就绪')
    // 文本与配置先落到节点，再由统一执行路径填充真实上游输入。
    update({ ...data, mode: 'generate', text: draft })
    setBusy(true)
    try {
      await runNodeManually(editor, project.id, providers, shape.id)
    } finally {
      setBusy(false)
    }
  }

  // ── 已有音频文件：播放器视图（上传或生成共用） ──
  if (shape.props.mediaPath) {
    const isGenerated = data.mode === 'generate'
    const chooseResult = (item: Parameters<typeof selectMediaResult>[1]): void => {
      const selected = selectMediaResult(shape, item)
      editor.updateShape({
        id: shape.id,
        type: 'node-card',
        props: selected.props,
        meta: { ...(shape.meta ?? {}), nodeResult: selected.nodeResult }
      })
      markUndoPoint(editor, 'audio-select-result')
    }
    return (
      <>
        <div className="node-audio-player">
          <div className={`audio-player-wave ${playing ? 'playing' : ''}`}>
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
              <span key={i} style={{ animationDelay: `${i * 0.12}s` }} />
            ))}
          </div>
          <div className="audio-player-info">
            <span className="audio-player-name">{shape.props.title}</span>
            <span className="audio-player-meta">
              {isGenerated ? `${data.voice} · ${data.format}` : shape.props.mediaMime || '本地音频'}
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
            <button
              className="btn-ghost small"
              title="打开播放器"
              onPointerDown={(e) => stopEventPropagation(e)}
              onClick={(e) => {
                e.stopPropagation()
                if (playing) {
                  audioRef.current?.pause()
                  setPlaying(false)
                }
                openPreview({
                  kind: 'audio',
                  url: mediaUrl(shape.props.mediaPath),
                  title: shape.props.title
                })
              }}
            >
              展开
            </button>
            <button
              className="btn-ghost small danger"
              title={isGenerated ? '重新生成' : '替换文件'}
              onPointerDown={(e) => stopEventPropagation(e)}
              onClick={(e) => {
                e.stopPropagation()
                if (isGenerated) {
                  removeAudio()
                } else {
                  void uploadAudio()
                }
              }}
            >
              {isGenerated ? '重新生成' : '替换'}
            </button>
            <MediaFileActions shape={shape} />
          </div>
          <div className="audio-player-source">
            <MediaSourceBadge shape={shape} fallback={isGenerated ? 'AI 生成' : '本地音频'} />
          </div>
        </div>
        <MediaResultGrid
          shape={shape}
          kind="audio"
          onSelect={chooseResult}
          onDelete={(item) => {
            const nodeResult = removeMediaResultFromShape(shape, item)
            if (!nodeResult) return
            editor.updateShape({
              id: shape.id,
              type: 'node-card',
              meta: { ...(shape.meta ?? {}), nodeResult }
            })
            markUndoPoint(editor, 'audio-delete-result')
          }}
          onClear={() => {
            const nodeResult = clearSelectedMediaHistory(shape)
            if (!nodeResult) return
            editor.updateShape({
              id: shape.id,
              type: 'node-card',
              meta: { ...(shape.meta ?? {}), nodeResult }
            })
            markUndoPoint(editor, 'audio-clear-result-history')
          }}
          openPreview={(item) =>
            openPreview({ kind: 'audio', url: mediaUrl(item.mediaPath), title: shape.props.title })
          }
        />
      </>
    )
  }

  // ── 无音频文件：模式切换 ──
  return (
    <div className="node-audio-empty">
      <div className="audio-mode-tabs">
        <button
          className={`audio-tab ${data.mode === 'upload' ? 'active' : ''}`}
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            update({ ...data, mode: 'upload' })
          }}
        >
          <>
            <Icon name="upload" size={14} />
            上传文件
          </>
        </button>
        <button
          className={`audio-tab ${data.mode === 'generate' ? 'active' : ''}`}
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            update({ ...data, mode: 'generate' })
          }}
        >
          <>
            <Icon name="audio" size={14} />
            语音合成
          </>
        </button>
      </div>

      {data.mode === 'upload' ? (
        <div className="audio-upload-zone">
          <button
            className="audio-upload-btn"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              void uploadAudio()
            }}
          >
            <span className="audio-upload-icon">
              <Icon name="audio" size={22} />
            </span>
            <span className="audio-upload-text">点击上传音频文件</span>
            <span className="audio-upload-hint">支持 mp3 / wav / aac / flac 等</span>
          </button>
        </div>
      ) : (
        <div className="node-audio-gen">
          <div className="gen-capability-note">
            <Icon name="info" size={13} />
            <span>上游文本会与此处文本合并后再合成</span>
          </div>
          <div className="gen-toolbar">
            {options.length === 0 ? (
              loaded ? (
                <span className="hint">未配置音频模型</span>
              ) : (
                <span className="hint">加载中…</span>
              )
            ) : (
              <ModelSelect
                value={data.modelKey}
                options={options}
                onChange={(key) => update({ ...data, modelKey: key })}
              />
            )}
            {loaded && options.length === 0 && (
              <button
                className="btn-ghost small"
                onPointerDown={(e) => stopEventPropagation(e)}
                onClick={(e) => {
                  e.stopPropagation()
                  void openSettings()
                }}
              >
                配置
              </button>
            )}
          </div>
          <textarea
            className="gen-textarea audio"
            value={draft}
            placeholder="输入要朗读的文本…"
            onPointerDown={(e) => stopEventPropagation(e)}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="audio-text-meta">{draft.length} 字 · 可由文本节点提供内容</div>
          <div className="audio-options">
            <label className="opt-label">音色</label>
            <select
              className="gen-select small"
              value={data.voice}
              onPointerDown={(e) => stopEventPropagation(e)}
              onChange={(e) => update({ ...data, voice: e.target.value })}
            >
              {VOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <label className="opt-label">格式</label>
            <select
              className="gen-select small"
              value={data.format}
              onPointerDown={(e) => stopEventPropagation(e)}
              onChange={(e) => update({ ...data, format: e.target.value })}
            >
              {AUDIO_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
          <button
            className="btn-generate"
            disabled={busy}
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              void generate()
            }}
          >
            {busy ? (
              '生成中…'
            ) : (
              <>
                <Icon name="audio" size={14} />
                生成语音
              </>
            )}
          </button>
        </div>
      )}
    </div>
  )
}
