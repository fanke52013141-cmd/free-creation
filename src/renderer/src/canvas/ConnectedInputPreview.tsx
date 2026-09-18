// 已连接输入的统一画布呈现（呈现规范 v1.0 §11–§17）。数据只来自真实边与节点输出投影，
// 不按标题或节点类型猜测。图片引用为 48×36 缩略图卡（无名称文字），
// hover 300ms 显示全貌浮层，点击打开媒体预览；其余类型保持单行 chip。
import { useValue, type Editor } from 'tldraw'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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

/** 非图片引用的正文：媒体类型只留类型图标，文本/JSON 留摘要；
 *  来源名称由统一的 connected-input-source 呈现，不再重复。 */
function previewBody(input: ConnectedNodeInput): React.JSX.Element | null {
  switch (input.value?.kind) {
    case 'image':
      return null // 图片走缩略图卡（ReferenceThumb）
    case 'video':
      return <Icon name="video" size={13} />
    case 'audio':
      return <Icon name="audio" size={13} />
    case 'file':
      return <Icon name="document" size={13} />
    case 'json':
      return <span className="connected-input-value">{compactJson(input.value.data)}</span>
    case 'markdown':
    case 'text':
      return <span className="connected-input-value">{input.value.text || '空文本'}</span>
    default:
      return null
  }
}

type OpenPreview = (next: { url: string; kind: 'image' | 'video' | 'audio'; title: string }) => void

/** 图片引用缩略图：hover 延时 300ms 显示全貌浮层（portal 到 body、不拦截指针），
 *  点击进入媒体预览。缩略图本身参与节点拖拽会破坏点击语义，因此停止冒泡。 */
function ReferenceThumb({
  input,
  openPreview
}: {
  input: ConnectedNodeInput
  openPreview: OpenPreview
}): React.JSX.Element {
  const thumbRef = useRef<HTMLDivElement | null>(null)
  const timerRef = useRef<number | null>(null)
  const [fullRect, setFullRect] = useState<DOMRect | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  if (input.value?.kind !== 'image') return <></>
  const mediaPath = input.value.mediaPath

  const showFullView = (): void => {
    const el = thumbRef.current
    if (el) setFullRect(el.getBoundingClientRect())
  }
  const hideFullView = (): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    setFullRect(null)
  }

  // 全貌浮层统一落在缩略图上方（用户 2026-09-18 拍板：下方会遮挡节点内容）；
  // 上方空间不足时才翻到下方。
  let overlayStyle: React.CSSProperties | undefined
  if (fullRect) {
    const estimatedHeight = 340
    const placeBelow = fullRect.top - 8 - estimatedHeight < 0
    overlayStyle = {
      left: Math.max(8, Math.min(fullRect.left, window.innerWidth - 480)),
      top: placeBelow ? fullRect.bottom + 8 : undefined,
      bottom: placeBelow ? undefined : window.innerHeight - fullRect.top + 8
    }
  }

  return (
    <>
      <div
        ref={thumbRef}
        className="reference-thumb"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          openPreview({ url: mediaUrl(mediaPath), kind: 'image', title: input.sourceNodeName })
        }}
        onMouseEnter={() => {
          if (timerRef.current !== null) window.clearTimeout(timerRef.current)
          timerRef.current = window.setTimeout(showFullView, 300)
        }}
        onMouseLeave={hideFullView}
      >
        <img src={mediaUrl(mediaPath)} alt="" draggable={false} />
        {input.targetPortCardinality === 'many' && (
          <span className="connected-input-order">{input.order}</span>
        )}
      </div>
      {fullRect &&
        createPortal(
          <div className="reference-fullview" style={overlayStyle}>
            <img src={mediaUrl(mediaPath)} alt="" draggable={false} />
          </div>,
          document.body
        )}
    </>
  )
}

/** 引用区可见项上限：约两行（呈现规范 §17），超出折叠为 +N，点击展开。 */
const REFERENCE_VISIBLE_LIMIT = 12

export function ConnectedInputPreview({
  editor,
  shape,
  openPreview
}: {
  editor: Editor
  shape: NodeCardShape
  openPreview: OpenPreview
}): React.JSX.Element | null {
  const inputs = useValue(
    'connected node inputs',
    () => readConnectedNodeInputs(editor, shape.id),
    [editor, shape.id]
  )
  const [expanded, setExpanded] = useState(false)
  // 连线变化后重新折叠：渲染期比较上一次 inputs（官方“随 props 重置 state”模式），
  // 避免 effect 内同步 setState 触发级联渲染；不同节点状态间不残留展开态。
  const [seenInputs, setSeenInputs] = useState(inputs)
  if (seenInputs !== inputs) {
    setSeenInputs(inputs)
    setExpanded(false)
  }

  // 只呈现真正有值的上游输入：已连线但尚未产出结果的输入不再显示“等待上游输出”
  // 这类操作提示（用户 2026-09-18 拍板：没有必要的提示语都不需要）。
  const resolved = inputs.filter((input) => input.value !== null)
  if (resolved.length === 0) return null
  const visible = expanded ? resolved : resolved.slice(0, REFERENCE_VISIBLE_LIMIT)
  const hiddenCount = resolved.length - visible.length

  return (
    <section className="connected-inputs" aria-label="已连接输入">
      <div className="connected-input-list">
        {visible.map((input) =>
          input.value?.kind === 'image' ? (
            <ReferenceThumb
              key={`${input.targetPortId}:${input.sourceNodeId}:${input.sourcePortId}:${input.order}`}
              input={input}
              openPreview={openPreview}
            />
          ) : (
            <div
              className={`connected-input-item connected-input-${input.value?.kind ?? 'pending'}`}
              key={`${input.targetPortId}:${input.sourceNodeId}:${input.sourcePortId}:${input.order}`}
            >
              <span className="connected-input-target">{input.targetPortName}</span>
              {input.targetPortCardinality === 'many' && (
                <span className="connected-input-order">{input.order}</span>
              )}
              {previewBody(input)}
              <span
                className="connected-input-source"
                title={`${input.sourceNodeName} · ${input.sourcePortName}`}
              >
                {input.sourceNodeName}
              </span>
            </div>
          )
        )}
        {hiddenCount > 0 && (
          <button
            type="button"
            className="reference-more"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              setExpanded(true)
            }}
          >
            +{hiddenCount}
          </button>
        )}
      </div>
    </section>
  )
}
