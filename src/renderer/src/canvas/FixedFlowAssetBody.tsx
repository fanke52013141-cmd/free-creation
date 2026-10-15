import { useEditor } from 'tldraw'
import { readFlowAssetSnapshot } from './flow-asset-snapshot'
import type { NodeCardShape } from './NodeCardShape'
import { NodePrimaryButton } from './NodePresentation'
import { createEditableAssetDraft } from './flow-asset-actions'
import { beginAssetPlacement } from './flow-asset-diagnostics'
import { useAppStore } from '../stores/app'
import { toast } from '../stores/toast'
import { mediaUrl, type NodeBodyProps } from '../nodes/registry'
import { useClickGuard } from '../nodes/specs/bodies/shared'
import { Icon } from '../components/Icon'

/** Committed result preview, rather than an editable document input. */
export function FixedFlowAssetBody({
  shape,
  openPreview
}: {
  shape: NodeCardShape
  openPreview?: NodeBodyProps['openPreview']
}): React.JSX.Element | null {
  const editor = useEditor()
  const projectId = useAppStore((state) => state.currentProject?.id)
  const value = readFlowAssetSnapshot(shape)
  const guard = useClickGuard()
  if (!value) return null
  if (value.kind === 'audio')
    return (
      <div className="node-media-wrap">
        <div
          className="node-media"
          style={{ minHeight: 72, gap: 8, color: 'var(--muted)' }}
          data-node-interactive="media-preview"
          onPointerDown={guard.onPointerDown}
          onDoubleClick={(event) =>
            guard.onDoubleClick(event, () =>
              openPreview?.({
                kind: 'audio',
                url: mediaUrl(value.mediaPath),
                title: shape.props.title
              })
            )
          }
        >
          <Icon name="audio" size={24} />
          <span>{shape.props.title}</span>
        </div>
        <audio
          src={mediaUrl(value.mediaPath)}
          preload="metadata"
          controls
          data-node-pointer="control"
          aria-label="固定音频播放"
          style={{ width: '100%' }}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        />
      </div>
    )
  if (value.kind === 'video' || value.kind === 'image')
    return (
      <div
        className={
          value.kind === 'video' ? 'node-media-wrap video-thumbnail-wrap' : 'node-media-wrap'
        }
      >
        <div
          className="node-media"
          data-node-interactive="media-preview"
          onPointerDown={guard.onPointerDown}
          onDoubleClick={(event) =>
            guard.onDoubleClick(event, () =>
              openPreview?.({
                kind: value.kind,
                url: mediaUrl(value.mediaPath),
                title: shape.props.title
              })
            )
          }
        >
          {value.kind === 'image' ? (
            <img src={mediaUrl(value.mediaPath)} alt={shape.props.title} draggable={false} />
          ) : (
            <video src={mediaUrl(value.mediaPath)} preload="metadata" muted playsInline />
          )}
          {value.kind === 'video' && (
            <span className="play-badge">
              <Icon name="play" size={24} />
            </span>
          )}
        </div>
      </div>
    )
  return (
    <div className="node-text fixed-flow-asset-body">
      <span className="node-text-body">
        {value.kind === 'json' ? JSON.stringify(value.data, null, 2) : value.text}
      </span>
      <NodePrimaryButton
        disabled={!projectId}
        onClick={() => {
          if (!projectId) return
          const finish = beginAssetPlacement(projectId, shape.id, 'draft-apply')
          try {
            createEditableAssetDraft(editor, shape, value)
            finish(true)
          } catch {
            finish(false)
            toast('创建资产草稿失败，请重试')
          }
        }}
      >
        创建可编辑副本
      </NodePrimaryButton>
    </div>
  )
}
