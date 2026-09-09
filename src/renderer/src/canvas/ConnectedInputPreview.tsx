// 已连接输入的统一画布呈现。数据只来自真实边与节点输出投影，不按标题或节点类型猜测。
import { useValue, type Editor } from 'tldraw'
import { Icon } from '../components/Icon'
import { mediaUrl } from '../nodes/registry'
import type { NodeCardShape } from './NodeCardShape'
import { readConnectedNodeInputs, type ConnectedNodeInput } from './graph'

function compactJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value)
    return serialized.length > 68 ? `${serialized.slice(0, 67)}…` : serialized
  } catch {
    return '结构化数据'
  }
}

function previewText(input: ConnectedNodeInput): React.JSX.Element {
  if (!input.value) return <span className="connected-input-empty">等待上游输出</span>
  switch (input.value.kind) {
    case 'image':
      return (
        <span className="connected-input-media image">
          <img src={mediaUrl(input.value.mediaPath)} alt="" draggable={false} />
          <span>图片</span>
        </span>
      )
    case 'video':
      return (
        <span className="connected-input-media video">
          <Icon name="video" size={13} />
          <span>视频</span>
        </span>
      )
    case 'audio':
      return (
        <span className="connected-input-media audio">
          <Icon name="audio" size={13} />
          <span>音频</span>
        </span>
      )
    case 'file':
      return (
        <span className="connected-input-media file">
          <Icon name="document" size={13} />
          <span>文件</span>
        </span>
      )
    case 'json':
      return <span className="connected-input-value">{compactJson(input.value.data)}</span>
    case 'markdown':
    case 'text':
      return <span className="connected-input-value">{input.value.text || '空文本'}</span>
  }
}

export function ConnectedInputPreview({
  editor,
  shape
}: {
  editor: Editor
  shape: NodeCardShape
}): React.JSX.Element | null {
  const inputs = useValue(
    'connected node inputs',
    () => readConnectedNodeInputs(editor, shape.id),
    [editor, shape.id]
  )
  if (inputs.length === 0) return null

  return (
    <section className="connected-inputs" aria-label="已连接输入">
      <div className="connected-inputs-title">
        <Icon name="workflow" size={13} />
        <span>已连接输入</span>
      </div>
      <div className="connected-input-list">
        {inputs.map((input) => (
          <div
            className={`connected-input-item connected-input-${input.value?.kind ?? 'pending'}`}
            key={`${input.targetPortId}:${input.sourceNodeId}:${input.sourcePortId}:${input.order}`}
          >
            <span className="connected-input-target">{input.targetPortName}</span>
            {input.targetPortCardinality === 'many' && (
              <span className="connected-input-order">{input.order}</span>
            )}
            {previewText(input)}
            <span
              className="connected-input-source"
              title={`${input.sourceNodeName} · ${input.sourcePortName}`}
            >
              {input.sourceNodeName} · {input.sourcePortName}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
