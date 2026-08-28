import { stopEventPropagation, useEditor } from 'tldraw'
import type { NodeBodyProps } from '../../registry'
import {
  parseDirectorProject,
  parseDirectorPublishRecord,
  isDirectorPublishCurrent,
  type DirectorPublishRecord
} from '../../director-data'
import { useNodePanelStore } from '../../../stores/nodePanel'
import { Icon } from '../../../components/Icon'
import { readNodeConfig } from '../../../canvas/node-persistence'

/** 画布卡片只显示导演工程摘要；完整编辑器始终在独立工作区中打开。 */
export function DirectorBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const project = parseDirectorProject(readNodeConfig(shape))
  let publish: DirectorPublishRecord | null = null
  try {
    publish = parseDirectorPublishRecord(
      typeof shape.meta?.nodeResult === 'string' ? JSON.parse(shape.meta.nodeResult) : null
    )
  } catch {
    // 不完整的历史记录按未发布处理。
  }
  const active = project.shots.find((shot) => shot.id === project.activeShotId) ?? project.shots[0]
  const publishCurrent = isDirectorPublishCurrent(project, publish)

  return (
    <div className="director-node-body" onPointerDown={(event) => stopEventPropagation(event)}>
      <div className="director-node-preview">
        <div className="director-node-frame">
          <span className="director-node-grid" />
          <span className="director-node-subject" />
          <small>{active.camera.aspectRatio}</small>
        </div>
        <div className="director-node-status">
          <strong>{active.name}</strong>
          <span>
            {project.shots.length} 个镜头 · {active.camera.focalLengthMm} mm
          </span>
        </div>
      </div>
      <div className={`director-node-publish ${publishCurrent ? 'published' : ''}`}>
        <span className="node-status-dot" />
        {publishCurrent
          ? '已发布，可供下游使用'
          : publish
            ? '工程已更新，请重新发布'
            : '尚未发布输出'}
      </div>
      <button
        className="director-open-btn"
        onClick={(event) => {
          event.stopPropagation()
          editor.select(shape.id)
          useNodePanelStore.getState().open('director', shape.id)
        }}
      >
        <Icon name="director" size={15} /> 打开导演台
      </button>
    </div>
  )
}
