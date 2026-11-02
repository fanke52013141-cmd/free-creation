import { useValue, type Editor } from 'tldraw'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Icon, type IconName } from '../components/Icon'
import { mediaUrl } from '../nodes/registry'
import type { NodeCardShape } from './NodeCardShape'
import { readConnectedNodeInputs, type ConnectedNodeInput } from './graph'
import { referenceLayout } from './reference-layout'
import { NODE_UI } from './node-ui-tokens'

type OpenPreview = (next: { url: string; kind: 'image' | 'video' | 'audio'; title: string }) => void
/** 上方可读空间的最小值：低于该值浮层才回退到缩略图下方展开。 */
const REFERENCE_FALLBACK_BELOW_SPACE = 140
const keyOf = (input: ConnectedNodeInput): string =>
  `${input.targetPortId}:${input.sourceNodeId}:${input.sourcePortId}:${input.order}`
const isMediaThumb = (input: ConnectedNodeInput): boolean =>
  input.value?.kind === 'image' || input.value?.kind === 'video'
function voiceId(input: ConnectedNodeInput): string | null {
  const value = input.value
  if (input.sourcePortSchema?.id !== 'voice.profile' || value?.kind !== 'json') return null
  return value.data &&
    typeof value.data === 'object' &&
    'voice_id' in value.data &&
    typeof value.data.voice_id === 'string'
    ? value.data.voice_id
    : null
}
function summary(input: ConnectedNodeInput): string {
  const value = input.value
  if (!value) return ''
  if (value.kind === 'text' || value.kind === 'markdown')
    return value.text.replace(/\s+/g, ' ') || '空文本'
  if (value.kind === 'json' || value.kind === 'camera')
    return voiceId(input) ?? JSON.stringify(value.data)
  return value.name || input.sourceNodeName || value.kind
}
/** 2026-11-02 用户裁决：浮层标题只保留「文件名」，类型改用图标表达，不再显示端口名与来源行。 */
function nameOf(input: ConnectedNodeInput): string {
  const value = input.value
  if (!value) return input.targetPortName
  if (
    value.kind === 'text' ||
    value.kind === 'markdown' ||
    value.kind === 'json' ||
    value.kind === 'camera'
  )
    return input.sourceNodeName || input.targetPortName
  return value.name || input.sourceNodeName || input.targetPortName
}
function iconOf(input: ConnectedNodeInput): IconName {
  if (voiceId(input) !== null) return 'mic'
  switch (input.value?.kind) {
    case 'image':
      return 'image'
    case 'video':
      return 'video'
    case 'audio':
      return 'audio'
    case 'file':
      return 'document'
    case 'json':
      return 'json'
    case 'camera':
      return 'director'
    default:
      return 'text'
  }
}
function ReferenceVisual({ input }: { input: ConnectedNodeInput }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const value = input.value
  if (value?.kind === 'image' || value?.kind === 'video')
    return (
      <>
        {failed ? (
          <Icon name="warning" size={16} />
        ) : value.kind === 'image' ? (
          <img
            src={mediaUrl(value.mediaPath)}
            alt=""
            draggable={false}
            onError={() => setFailed(true)}
          />
        ) : (
          <video
            src={mediaUrl(value.mediaPath)}
            preload="metadata"
            muted
            playsInline
            onError={() => setFailed(true)}
          />
        )}
        {value.kind === 'video' && <Icon name="play" size={12} className="reference-video-mark" />}
      </>
    )
  return (
    <>
      <Icon name={iconOf(input)} size={16} />
      <span className="connected-input-target">{input.targetPortName}</span>
      <span className="connected-input-value">{summary(input)}</span>
    </>
  )
}
function ReferenceDetail({
  input,
  openPreview
}: {
  input: ConnectedNodeInput
  openPreview: OpenPreview
}): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const value = input.value
  const text =
    value?.kind === 'text' || value?.kind === 'markdown'
      ? value.text
      : value?.kind === 'json' || value?.kind === 'camera'
        ? JSON.stringify(value.data, null, 2)
        : null
  const title = nameOf(input)
  return (
    <article className="reference-detail">
      <header>
        <Icon name={iconOf(input)} size={14} />
        <strong title={title}>{title}</strong>
        {text !== null && (
          <button
            type="button"
            className="reference-copy"
            onClick={() => {
              void navigator.clipboard.writeText(voiceId(input) ?? text)
            }}
            aria-label={voiceId(input) !== null ? '复制音色 ID' : '复制完整内容'}
          >
            <Icon name="copy" size={14} />
          </button>
        )}
      </header>
      {value?.kind === 'markdown' ? (
        <div className="reference-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
            {value.text}
          </ReactMarkdown>
        </div>
      ) : text !== null ? (
        <pre>{text || '空文本'}</pre>
      ) : value?.kind === 'image' && !failed ? (
        <img
          className="reference-detail-media"
          src={mediaUrl(value.mediaPath)}
          alt={title}
          onError={() => setFailed(true)}
          onClick={() =>
            openPreview({
              url: mediaUrl(value.mediaPath),
              kind: 'image',
              title: input.sourceNodeName
            })
          }
        />
      ) : value?.kind === 'video' && !failed ? (
        <video
          className="reference-detail-media"
          src={mediaUrl(value.mediaPath)}
          preload="metadata"
          muted
          playsInline
          onError={() => setFailed(true)}
          onClick={() =>
            openPreview({
              url: mediaUrl(value.mediaPath),
              kind: 'video',
              title: input.sourceNodeName
            })
          }
        />
      ) : value?.kind === 'audio' ? (
        <audio
          controls
          preload="metadata"
          src={mediaUrl(value.mediaPath)}
          onError={() => setFailed(true)}
        />
      ) : value?.kind === 'file' ? (
        <small>{value.mime}</small>
      ) : null}
      {failed && <small role="alert">媒体无法读取</small>}
    </article>
  )
}

type DetailState = { key: string | null; anchor: HTMLElement; rect: DOMRect }
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
  const resolved = inputs.filter((input) => input.value !== null)
  const row = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [width, setWidth] = useState(NODE_UI.width - NODE_UI.content.padding * 2)
  const [detail, setDetail] = useState<DetailState | null>(null)
  const [position, setPosition] = useState<CSSProperties>({ left: 8, top: 8 })
  const layout = referenceLayout(resolved.map(isMediaThumb), width)
  const visible = resolved.slice(0, layout.widths.length)
  const active = detail?.key ? resolved.find((input) => keyOf(input) === detail.key) : undefined
  const showing = Boolean(detail && (detail.key === null ? layout.hidden > 0 : active))

  useEffect(() => {
    const element = row.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [resolved.length > 0])
  useEffect(
    () => () => {
      if (openTimer.current) clearTimeout(openTimer.current)
      if (closeTimer.current) clearTimeout(closeTimer.current)
    },
    []
  )
  useEffect(() => {
    if (!showing || !detail) return
    const place = (): void => {
      const anchor = detail.anchor.isConnected ? detail.anchor.getBoundingClientRect() : detail.rect
      const box = panel.current?.getBoundingClientRect()
      const panelWidth = box?.width ?? 480
      const panelHeight = box?.height ?? 340
      const theme = getComputedStyle(row.current ?? detail.anchor)
      const colors = Object.fromEntries(
        ['--bg', '--line', '--txt', '--muted', '--brand'].map((name) => [
          name,
          theme.getPropertyValue(name)
        ])
      )
      // 2026-11-02 用户裁决：浮层向上展开（贴缩略图上方），不再向下遮挡节点正文；
      // 上方空间不足时通过 --ref-fullview-max 压缩浮层高度，只有上方小到无法阅读时才回退到下方。
      const spaceAbove = anchor.top - 16
      const maxHeight =
        spaceAbove >= REFERENCE_FALLBACK_BELOW_SPACE ? `${Math.round(spaceAbove)}px` : undefined
      const top =
        maxHeight !== undefined
          ? Math.max(8, anchor.top - panelHeight - 8)
          : Math.max(8, Math.min(anchor.bottom + 8, window.innerHeight - panelHeight - 8))
      setPosition({
        ...colors,
        ...(maxHeight ? { '--ref-fullview-max': maxHeight } : {}),
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - panelWidth - 8)),
        top
      })
    }
    const observer = new ResizeObserver(place)
    if (panel.current) observer.observe(panel.current)
    place()
    const dismiss = (event: PointerEvent): void => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !detail.anchor.contains(event.target as Node)
      )
        setDetail(null)
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setDetail(null)
        detail.anchor.focus()
        if (openTimer.current) clearTimeout(openTimer.current)
      }
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('keydown', key)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('keydown', key)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [showing, detail])
  const keep = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
  }
  const hide = (): void => {
    if (openTimer.current) clearTimeout(openTimer.current)
    keep()
    closeTimer.current = setTimeout(() => setDetail(null), 150)
  }
  const show = (anchor: HTMLElement, key: string | null, delay = 0): void => {
    keep()
    if (openTimer.current) clearTimeout(openTimer.current)
    const rect = anchor.getBoundingClientRect()
    openTimer.current = setTimeout(() => setDetail({ anchor, key, rect }), delay)
  }
  if (!resolved.length) return null
  const variables = {
    '--reference-height': `${NODE_UI.reference.height}px`,
    '--reference-gap': `${NODE_UI.reference.gap}px`,
    '--reference-bottom-gap': `${NODE_UI.reference.bottomGap}px`
  } as CSSProperties
  return (
    <section className="connected-inputs" aria-label="已连接输入" style={variables}>
      <div ref={row} className="connected-input-list">
        {visible.map((input, index) => (
          <button
            type="button"
            key={keyOf(input)}
            className={
              isMediaThumb(input)
                ? 'reference-thumb'
                : `connected-input-item connected-input-${input.value?.kind}`
            }
            style={{ width: layout.widths[index] }}
            aria-label={`${input.targetPortName}：${summary(input)}，来源 ${input.sourceNodeName}`}
            aria-haspopup="dialog"
            aria-expanded={showing && detail?.key === keyOf(input)}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseEnter={(event) => show(event.currentTarget, keyOf(input), 300)}
            onMouseLeave={hide}
            onFocus={(event) => show(event.currentTarget, keyOf(input))}
            onBlur={hide}
            onClick={(event) => {
              event.stopPropagation()
              const value = input.value
              if (value?.kind === 'image' || value?.kind === 'video') {
                setDetail(null)
                if (openTimer.current) clearTimeout(openTimer.current)
                openPreview({
                  url: mediaUrl(value.mediaPath),
                  kind: value.kind,
                  title: input.sourceNodeName
                })
              } else show(event.currentTarget, keyOf(input))
            }}
          >
            <ReferenceVisual key={`${keyOf(input)}:${summary(input)}`} input={input} />
          </button>
        ))}
        {layout.hidden > 0 && (
          <button
            type="button"
            className="reference-more"
            aria-label={`查看另外 ${layout.hidden} 项引用`}
            aria-haspopup="dialog"
            onPointerDown={(event) => event.stopPropagation()}
            onMouseEnter={(event) => show(event.currentTarget, null, 300)}
            onMouseLeave={hide}
            onFocus={(event) => show(event.currentTarget, null)}
            onBlur={hide}
            onClick={(event) => {
              event.stopPropagation()
              show(event.currentTarget, null)
            }}
          >
            +{layout.hidden}
          </button>
        )}
      </div>
      {showing &&
        createPortal(
          <div
            ref={panel}
            className="reference-fullview"
            role="dialog"
            aria-label="引用详情"
            style={position}
            onMouseEnter={keep}
            onMouseLeave={hide}
            onFocusCapture={keep}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) hide()
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            {active ? (
              <ReferenceDetail key={keyOf(active)} input={active} openPreview={openPreview} />
            ) : (
              <>
                <strong className="reference-list-title">更多引用 · {layout.hidden}</strong>
                {resolved.slice(visible.length).map((input) => (
                  <button
                    type="button"
                    className="reference-overflow-item"
                    key={keyOf(input)}
                    onMouseEnter={(event) => show(event.currentTarget, keyOf(input), 300)}
                    onClick={(event) => show(event.currentTarget, keyOf(input))}
                  >
                    <Icon name={iconOf(input)} size={16} />
                    <span>
                      {input.targetPortName} · {summary(input)}
                    </span>
                    <small>
                      {input.sourceNodeName} · {input.sourcePortName}
                    </small>
                  </button>
                ))}
              </>
            )}
          </div>,
          document.body
        )}
    </section>
  )
}
