import { useEffect, useRef, useState } from 'react'

/** 阅读正文滚动条：显式占有拖动，避免画布捕获指针。 */
export function NodeReadingScrollbar({
  scroll
}: {
  scroll: HTMLDivElement | null
}): React.JSX.Element | null {
  const [range, setRange] = useState({ viewport: 0, total: 0, top: 0 })
  const drag = useRef<{ y: number; top: number } | null>(null)
  useEffect(() => {
    if (!scroll) return
    const update = (): void =>
      setRange({ viewport: scroll.clientHeight, total: scroll.scrollHeight, top: scroll.scrollTop })
    const resize = new ResizeObserver(update)
    resize.observe(scroll)
    if (scroll.firstElementChild) resize.observe(scroll.firstElementChild)
    const changes = new MutationObserver(update)
    changes.observe(scroll, { childList: true, subtree: true, characterData: true })
    scroll.addEventListener('scroll', update)
    update()
    return () => {
      resize.disconnect()
      changes.disconnect()
      scroll.removeEventListener('scroll', update)
    }
  }, [scroll])
  const max = range.total - range.viewport
  if (!scroll || max <= 1) return null
  const thumb = Math.max(28, (range.viewport * range.viewport) / range.total)
  const travel = range.viewport - thumb
  return (
    <div className="node-reading-scrollbar" style={{ height: range.viewport }}>
      <div
        className="node-reading-scroll-thumb"
        role="scrollbar"
        aria-label="处理结果滚动"
        aria-orientation="vertical"
        aria-controls={scroll.id}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.round(range.top)}
        tabIndex={0}
        style={{ height: thumb, top: (range.top / max) * travel }}
        onPointerDown={(event) => {
          event.stopPropagation()
          event.preventDefault()
          drag.current = { y: event.clientY, top: scroll.scrollTop }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (!drag.current) return
          event.stopPropagation()
          const scale =
            event.currentTarget.parentElement!.getBoundingClientRect().height / range.viewport
          scroll.scrollTo({
            top: drag.current.top + ((event.clientY - drag.current.y) / scale / travel) * max
          })
        }}
        onPointerUp={(event) => {
          event.stopPropagation()
          drag.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
        onKeyDown={(event) => {
          const delta =
            event.key === 'ArrowDown'
              ? 40
              : event.key === 'ArrowUp'
                ? -40
                : event.key === 'PageDown'
                  ? range.viewport
                  : event.key === 'PageUp'
                    ? -range.viewport
                    : 0
          if (delta || event.key === 'Home' || event.key === 'End') {
            event.preventDefault()
            event.stopPropagation()
            scroll.scrollTo({
              top: event.key === 'Home' ? 0 : event.key === 'End' ? max : scroll.scrollTop + delta
            })
          }
        }}
      />
    </div>
  )
}
