// 音频资产节点 Body：导入本地音频、预览、输出资产。
//
// 通用配音（speech）已拆到 bodies/speech.tsx——它是模型驱动节点，参数分组与端口
// 随所选协议变化，和「导入一段音频素材」不是同一种职责，共用 Body 只会让两边的
// 语义继续分叉（历史遗留的 mode: 'upload' | 'generate' 双形态已删除）。
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
  pickImportedAsset,
  removeMediaResultFromShape,
  selectMediaResult,
  useClickGuard
} from './shared'

export function AudioBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)

  const uploadAudio = async (): Promise<void> => {
    if (!project) return toast('项目未就绪')
    try {
      const res = await window.api.pickMedia(project.id)
      if (!res.ok) return toast(`上传失败：${res.error.message}`)
      const audioAsset = pickImportedAsset({
        result: res.data,
        kind: 'audio',
        noun: '一个音频',
        mismatch: '请选择一个音频文件',
        projectId: project.id
      })
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
    } catch (error) {
      toast(`导入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ── 已有音频文件：原生播放器视图 ──
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
      <div className="node-audio-player">
        <div className="audio-player-head" title="双击打开大窗播放器">
          <span className="audio-player-icon">
            <Icon name="audio" size={18} />
          </span>
          <span className="audio-player-name">{shape.props.title || '音频'}</span>
        </div>
        <audio
          className="node-inline-audio"
          controls
          preload="metadata"
          src={mediaUrl(shape.props.mediaPath)}
          data-node-interactive="media-preview"
          onPointerDown={guard.onPointerDown}
          onDoubleClick={(event) =>
            guard.onDoubleClick(event, () =>
              openPreview({
                kind: 'audio',
                url: mediaUrl(shape.props.mediaPath),
                title: shape.props.title
              })
            )
          }
        />
        <div className="node-media-actions">
          <button
            className="btn-ghost small"
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
      </div>
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
