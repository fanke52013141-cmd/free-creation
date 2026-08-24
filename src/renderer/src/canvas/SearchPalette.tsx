// 画布节点搜索覆盖层：搜索标题 + 文本内容，点击跳转并选中节点
// 外层 SearchPalette 订阅 store，仅在 open 时挂载 SearchPaletteInner，
// 内层组件每次挂载 useState 自然重置为空，无需 effect 清空搜索词
import { useEffect, useMemo, useRef, useState } from 'react'
import { stopEventPropagation, type TLShapeId, type Editor } from 'tldraw'
import type { NodeCardShape } from './NodeCardShape'
import { getNodeType } from '../nodes/registry'
import { useSearchStore } from '../stores/search'

interface SearchHit {
  id: TLShapeId
  title: string
  nodeType: string
  snippet: string
}

export function SearchPalette({ editor }: { editor: Editor }): React.JSX.Element | null {
  const open = useSearchStore((s) => s.open)
  if (!open) return null
  return <SearchPaletteInner editor={editor} />
}

function SearchPaletteInner({ editor }: { editor: Editor }): React.JSX.Element {
  const close = useSearchStore((s) => s.close)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // 挂载时自动聚焦输入框
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const hits = useMemo<SearchHit[]>(() => {
    if (!query.trim()) return []
    const q = query.toLowerCase()
    const results: SearchHit[] = []
    for (const shape of editor.getCurrentPageShapes()) {
      if (shape.type !== 'node-card') continue
      const s = shape as unknown as NodeCardShape
      const title = s.props.title || ''
      const text = s.props.text || ''
      const titleMatch = title.toLowerCase().includes(q)
      const textMatch = text.toLowerCase().includes(q)
      if (!titleMatch && !textMatch) continue
      let snippet = ''
      if (textMatch) {
        const idx = text.toLowerCase().indexOf(q)
        const start = Math.max(0, idx - 20)
        const end = Math.min(text.length, idx + q.length + 20)
        snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
      }
      results.push({ id: s.id, title: title || '（未命名）', nodeType: s.props.nodeType, snippet })
    }
    return results.slice(0, 30)
  }, [editor, query])

  const jumpTo = (hit: SearchHit): void => {
    editor.setSelectedShapes([hit.id])
    editor.zoomToSelection({ animation: { duration: 300 } })
    close()
  }

  return (
    <div
      className="search-overlay"
      onPointerDown={(e) => stopEventPropagation(e)}
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="search-panel">
        <div className="search-header">
          <span className="search-icon">🔍</span>
          <input
            ref={inputRef}
            className="search-input"
            value={query}
            placeholder="搜索节点标题或内容…"
            onChange={(e) => setQuery(e.target.value)}
            onPointerDown={(e) => stopEventPropagation(e)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <button className="search-close" onClick={close}>
            ✕
          </button>
        </div>
        {query.trim() && (
          <div className="search-results">
            {hits.length === 0 ? (
              <div className="search-empty">未找到匹配的节点</div>
            ) : (
              hits.map((hit) => {
                const icon = getNodeType(hit.nodeType)?.icon ?? '?'
                return (
                  <button
                    key={hit.id}
                    className="search-hit"
                    onClick={() => jumpTo(hit)}
                    onPointerDown={(e) => stopEventPropagation(e)}
                  >
                    <span className="search-hit-icon">{icon}</span>
                    <div className="search-hit-info">
                      <span className="search-hit-title">{hit.title}</span>
                      {hit.snippet && <span className="search-hit-snippet">{hit.snippet}</span>}
                    </div>
                  </button>
                )
              })
            )}
          </div>
        )}
        {!query.trim() && <div className="search-hint">输入关键词搜索画布中的节点</div>}
      </div>
    </div>
  )
}
