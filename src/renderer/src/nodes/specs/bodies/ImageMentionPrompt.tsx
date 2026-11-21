import { useLayoutEffect, useRef, useState, type ComponentPropsWithRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../components/Icon'
import { mediaUrl } from '../../registry'
import {
  canonicalizeMediaMentions,
  resolvedMentions,
  type PromptMediaReference
} from './media-mentions'
import './image-mention-prompt.css'

interface ImageMentionPromptProps extends Omit<
  ComponentPropsWithRef<'textarea'>,
  'onChange' | 'onBlur' | 'onCompositionEnd'
> {
  value: string
  references: readonly PromptMediaReference[]
  onValueChange: (value: string) => void
  onCommit: (value: string) => void
}

export function ImageMentionPrompt({
  value,
  references,
  onValueChange,
  onCommit,
  ref,
  ...props
}: ImageMentionPromptProps): React.JSX.Element {
  const input = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>()
  const [query, setQuery] = useState<{ start: number; end: number; text: string } | null>(null)
  const [previewItem, setPreviewItem] = useState<PromptMediaReference | null>(null)
  const matches = references.length ? resolvedMentions(value, references) : []
  const candidates = query
    ? references.filter((item) =>
        [item.title, item.name, item.token.slice(1)].some((name) =>
          name?.toLowerCase().includes(query.text.toLowerCase())
        )
      )
    : []
  /** 候选展示名：标题/素材名优先；都没有时回退为「图片 1」这类编号名，绝不显示 UUID。 */
  const candidateName = (item: PromptMediaReference): string =>
    item.title || item.name || item.token.replace(/^@/, '')
  /** 类型徽标文案：编号引用显示「图片 1」，具名引用只显示类型词。 */
  const candidateKind = (item: PromptMediaReference): string => {
    const indexed = /^@(图片|视频)\s*(\d+)$/.exec(item.token)
    return indexed ? `${indexed[1]} ${indexed[2]}` : item.kind === 'video' ? '视频' : '图片'
  }
  const readQuery = (textarea: HTMLTextAreaElement): void => {
    const { value: next, selectionStart } = textarea
    const match = /[@＠]([^@＠\r\n]*)$/.exec(next.slice(0, selectionStart))
    setQuery(
      match &&
        !resolvedMentions(next, references).some(
          ({ index, text }) => index === match.index && text === match[0].trimEnd()
        )
        ? { start: match.index, end: selectionStart, text: match[1].trimStart() }
        : null
    )
  }

  useLayoutEffect(() => {
    const textarea = input.current
    if (!textarea || candidates.length === 0) return
    const positionMenu = (): void => {
      const rect = textarea.getBoundingClientRect()
      const body = textarea.closest('.node-body-content')?.getBoundingClientRect()
      const bottom = Math.min(rect.bottom, body?.bottom ?? rect.bottom, window.innerHeight - 8)
      const top = Math.max(rect.top, body?.top ?? rect.top, 8)
      const below = window.innerHeight - bottom - 12
      const above = top - 12
      // 2026-11-21 用户裁决：候选改为卡片网格（两列 16:9 缩略卡 + 下方文件名），
      // 两行卡片约 230px，上下展开阈值与最大高度随之放大。
      const openAbove = below < 248 && above > below
      const width = Math.min(Math.max(rect.width, 180), window.innerWidth - 16)
      setMenuStyle({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        ...(openAbove ? { bottom: window.innerHeight - top + 4 } : { top: bottom + 4 }),
        width,
        maxHeight: Math.min(248, Math.max(openAbove ? above : below, 0))
      })
    }
    positionMenu()
    const observer = new ResizeObserver(positionMenu)
    observer.observe(textarea)
    window.addEventListener('resize', positionMenu)
    window.addEventListener('scroll', positionMenu, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', positionMenu)
      window.removeEventListener('scroll', positionMenu, true)
    }
  }, [candidates.length])

  const insert = (item: PromptMediaReference): void => {
    if (!query) return
    const replacement = item.token + ' '
    onValueChange(value.slice(0, query.start) + replacement + value.slice(query.end))
    setQuery(null)
    const caret = query.start + replacement.length
    requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.setSelectionRange(caret, caret)
    })
  }

  const highlighted = matches.length > 0
  useLayoutEffect(() => {
    const textarea = input.current
    const layer = mirror.current
    if (!textarea || !layer) return
    const syncScroll = (): void => {
      layer.scrollTop = textarea.scrollTop
      layer.scrollLeft = textarea.scrollLeft
    }
    const syncLayout = (): void => {
      const style = getComputedStyle(textarea)
      for (const property of [
        'font',
        'line-height',
        'letter-spacing',
        'word-spacing',
        'font-kerning',
        'tab-size',
        'text-align',
        'text-indent',
        'text-transform',
        'direction',
        'white-space',
        'overflow-wrap',
        'word-break',
        'padding',
        'border-width',
        'border-radius'
      ]) {
        layer.style.setProperty(property, style.getPropertyValue(property))
      }
      syncScroll()
    }
    const observer = new ResizeObserver(syncLayout)
    observer.observe(textarea)
    textarea.addEventListener('scroll', syncScroll)
    syncLayout()
    return () => {
      observer.disconnect()
      textarea.removeEventListener('scroll', syncScroll)
    }
  }, [highlighted])

  const lastMatch = matches.at(-1)
  return (
    <>
      <div className="image-mention-prompt">
        <textarea
          {...props}
          value={value}
          onChange={(event) => {
            onValueChange(event.currentTarget.value)
            if (!(event.nativeEvent as InputEvent).isComposing) readQuery(event.currentTarget)
          }}
          onCompositionEnd={(event) => readQuery(event.currentTarget)}
          onClick={(event) => {
            props.onClick?.(event)
            if (!event.defaultPrevented) readQuery(event.currentTarget)
          }}
          onBlur={(event) => {
            if (
              event.relatedTarget instanceof Element &&
              event.relatedTarget.closest('.ref-mention-menu')
            )
              return
            setQuery(null)
            onCommit(canonicalizeMediaMentions(value, references))
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Escape') setQuery(null)
            if (event.key === 'Enter' && !event.shiftKey && candidates.length === 1) {
              event.preventDefault()
              insert(candidates[0])
            }
          }}
          ref={(element) => {
            input.current = element
            if (typeof ref === 'function') return ref(element)
            if (ref) ref.current = element
          }}
        />
        {highlighted && (
          <div className="image-mention-mirror" ref={mirror} aria-hidden="true">
            {matches.map(({ index, text: token }, position) => {
              const previous = matches[position - 1]
              const before = value.slice(
                previous ? previous.index + previous.text.length : 0,
                index
              )
              return (
                <span key={index}>
                  {before}
                  <mark>{token}</mark>
                </span>
              )
            })}
            {value.slice(lastMatch ? lastMatch.index + lastMatch.text.length : 0)}
            {'\u200b'}
          </div>
        )}
      </div>
      {candidates.length > 0 &&
        createPortal(
          <div
            className="ref-mention-menu"
            style={menuStyle}
            role="group"
            aria-label="选择参考素材"
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onBlur={(event) => {
              if (
                event.currentTarget.contains(event.relatedTarget) ||
                event.relatedTarget === input.current
              )
                return
              setQuery(null)
              onCommit(canonicalizeMediaMentions(value, references))
            }}
          >
            {candidates.map((item) => (
              <button
                key={item.token}
                type="button"
                className={item.kind === 'video' ? 'ref-card is-video' : 'ref-card'}
                title={item.title || item.name || item.token}
                onPointerDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onClick={(event) => {
                  event.stopPropagation()
                  insert(item)
                }}
              >
                <span className="ref-card-media">
                  {item.kind === 'video' ? (
                    <>
                      <video src={mediaUrl(item.mediaPath)} preload="metadata" muted playsInline />
                      <span className="ref-card-play" aria-hidden="true">
                        <Icon name="play" size={13} />
                      </span>
                    </>
                  ) : (
                    <img src={mediaUrl(item.mediaPath)} alt="" loading="lazy" />
                  )}
                  <span className="ref-card-kind">{candidateKind(item)}</span>
                  <span
                    className="ref-card-preview"
                    role="button"
                    tabIndex={-1}
                    aria-label={`预览 ${candidateName(item)}`}
                    title="预览素材（点击卡片本体插入引用）"
                    onPointerDown={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                    }}
                    onClick={(event) => {
                      event.stopPropagation()
                      setPreviewItem(item)
                    }}
                  >
                    <Icon name="search" size={11} />
                  </span>
                </span>
                <span className="ref-card-name">
                  <span className="ref-card-title">{candidateName(item)}</span>
                  <small>{item.token}</small>
                </span>
              </button>
            ))}
          </div>,
          document.body
        )}
      {previewItem &&
        createPortal(
          <div
            className="ref-preview-lightbox"
            role="dialog"
            aria-label="素材预览"
            onClick={() => setPreviewItem(null)}
          >
            {previewItem.kind === 'video' ? (
              <video src={mediaUrl(previewItem.mediaPath)} controls autoPlay />
            ) : (
              <img src={mediaUrl(previewItem.mediaPath)} alt={candidateName(previewItem)} />
            )}
            <span className="ref-preview-caption">{candidateName(previewItem)}</span>
          </div>,
          document.body
        )}
    </>
  )
}
