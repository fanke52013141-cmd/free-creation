// 图片资产节点 Body（路线图 R6：bodies.tsx 拆分）
import { useEditor } from 'tldraw'
import { stopEventPropagation } from 'tldraw'
import { mediaUrl, type NodeBodyProps } from '../../registry'
import {
  createImageContinuation,
  MediaFileActions,
  MediaSourceBadge,
  useClickGuard
} from './shared'
import { useAppStore } from '../../../stores/app'
import { toast } from '../../../stores/toast'
import { markUndoPoint } from '../../../canvas/history'
import { Icon } from '../../../components/Icon'

export function ImageBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)

  const chooseAsset = async (): Promise<void> => {
    if (!project) return
    const res = await window.api.pickMedia(project.id)
    if (!res.ok) return toast(`导入失败：${res.error.message}`)
    const asset = res.data.assets.find((item) => item.kind === 'image')
    if (!asset) return toast('请选择一张图片文件')
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: {
        title: asset.name || '图片',
        mediaId: asset.id,
        mediaPath: asset.path,
        mediaMime: asset.mime
      }
    })
    markUndoPoint(editor, 'image-asset-import')
  }

  if (!shape.props.mediaPath) {
    return (
      <div className="asset-empty">
        <Icon name="image" size={24} />
        <span>图片资产</span>
        <small>上传或粘贴图片后，可连接给生图、视频等节点。</small>
        <button
          className="btn-ghost small"
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            void chooseAsset()
          }}
        >
          导入图片
        </button>
      </div>
    )
  }

  return (
    <div className="node-media-wrap">
      <div
        className="node-media"
        onPointerDown={guard.onPointerDown}
        onClick={(e) =>
          guard.onClick(e, () =>
            openPreview({
              kind: 'image',
              url: mediaUrl(shape.props.mediaPath),
              title: shape.props.title
            })
          )
        }
      >
        <img src={mediaUrl(shape.props.mediaPath)} alt={shape.props.title} draggable={false} />
      </div>
      <div className="node-media-actions">
        <button
          className="btn-ghost small"
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            void chooseAsset()
          }}
        >
          <Icon name="upload" size={13} />
          替换
        </button>
        <MediaSourceBadge shape={shape} fallback={shape.props.mediaMime || '本地图片'} />
        <MediaFileActions shape={shape} />
      </div>
      <div className="node-media-next-actions" aria-label="图片后续操作">
        <button
          className="btn-ghost small"
          title="创建裁剪节点并连接当前图片"
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            createImageContinuation(editor, shape, 'image-crop')
          }}
        >
          <Icon name="crop" size={12} /> 裁剪图片
        </button>
        <button
          className="btn-ghost small"
          title="创建生图节点并连接当前图片"
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            createImageContinuation(editor, shape, 'image-gen')
          }}
        >
          <Icon name="spark" size={12} /> 继续生图
        </button>
        <button
          className="btn-ghost small"
          title="创建视频节点并将当前图片作为首帧"
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            createImageContinuation(editor, shape, 'video')
          }}
        >
          <Icon name="video" size={12} /> 生成视频
        </button>
      </div>
    </div>
  )
}
