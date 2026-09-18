// 音频资产节点 Body：导入本地音频、预览、输出资产。
//
// 通用配音（speech）已拆到 bodies/speech.tsx——它是模型驱动节点，参数分组与端口
// 随所选协议变化，和「导入一段音频素材」不是同一种职责，共用 Body 只会让两边的
// 语义继续分叉（历史遗留的 mode: 'upload' | 'generate' 双形态已删除）。
import { useEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import { mediaUrl, type NodeBodyProps } from '../../registry'
import { toast } from '../../../stores/toast'
import { markUndoPoint } from '../../../canvas/history'
import { useAppStore } from '../../../stores/app'
import { Icon } from '../../../components/Icon'
import {
  clearSelectedMediaHistory,
  MediaFileActions,
  MediaResultGrid,
  removeMediaResultFromShape,
  MediaSourceBadge,
  selectMediaResult,
  useClickGuard
} from './shared'

export function AudioBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // 组件卸载时释放音频元素，避免后台持续播放与音频流泄漏（A8）
  useEffect(() => {
    return () => {
      audioRef.current?.pause()
      if (audioRef.current) audioRef.current.src = ''
      audioRef.current = null
    }
  }, [])

  // 音频源变化（替换文件）时丢弃旧元素，下次播放用新 URL 重建，避免播放旧内容
  useEffect(() => {
    if (!audioRef.current) return
    audioRef.current.pause()
    audioRef.current.src = ''
    audioRef.current = null
    setPlaying(false)
  }, [shape.props.mediaPath])

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

  // ── 已有音频文件：播放器视图 ──
  if (shape.props.mediaPath) {
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
            <span className="audio-player-meta">{shape.props.mediaMime || '本地音频'}</span>
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
              className="btn-ghost small danger"
              title="替换文件"
              onPointerDown={(e) => stopEventPropagation(e)}
              onClick={(e) => {
                e.stopPropagation()
                void uploadAudio()
              }}
            >
              替换
            </button>
            <MediaFileActions shape={shape} />
          </div>
          <div className="audio-player-source">
            <MediaSourceBadge shape={shape} fallback="本地音频" />
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

  // 音频资产节点只有「导入」一种职责；配音与语音克隆各自有独立节点。
  return (
    <div className="node-audio-empty">
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
    </div>
  )
}
