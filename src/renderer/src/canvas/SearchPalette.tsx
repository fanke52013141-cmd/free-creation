// Search the current canvas and reusable entries saved in the node library.
// T02：新增「创建工具」分组——搜索即可创建节点（F04：搜索承担创建入口）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { stopEventPropagation, type TLShapeId, type Editor } from 'tldraw'
import type { NodeCardShape } from './NodeCardShape'
import { getNodeType, allNodeTypes, nodeIconColor } from '../nodes/registry'
import { useSearchStore } from '../stores/search'
import { useWorkflowStore, type WorkflowTemplate } from '../stores/workflow'
import { addNodeLibraryEntry } from './node-library'
import { aliasMatches } from './node-aliases'
import { Icon } from '../components/Icon'
import { toast } from '../stores/toast'
import type { NodeTypeId } from '@shared/types'

interface CanvasSearchHit {
  id: TLShapeId
  title: string
  nodeType: string
  snippet: string
}

interface LibrarySearchHit {
  entry: WorkflowTemplate
  title: string
  snippet: string
}

export function SearchPalette({
  editor,
  onCreateNode,
  visibleNodeTypeIds
}: {
  editor: Editor
  onCreateNode?: (type: NodeTypeId) => void
  visibleNodeTypeIds?: string[]
}): React.JSX.Element | null {
  const open = useSearchStore((s) => s.open)
  if (!open) return null
  return (
    <SearchPaletteInner
      editor={editor}
      onCreateNode={onCreateNode}
      visibleNodeTypeIds={visibleNodeTypeIds}
    />
  )
}

function SearchPaletteInner({
  editor,
  onCreateNode,
  visibleNodeTypeIds
}: {
  editor: Editor
  onCreateNode?: (type: NodeTypeId) => void
  visibleNodeTypeIds?: string[]
}): React.JSX.Element | null {
  const close = useSearchStore((s) => s.close)
  const templates = useWorkflowStore((s) => s.templates)
  const loadLibrary = useWorkflowStore((s) => s.load)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const resultsRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // 记录打开搜索时的焦点元素：关闭后焦点回到触发入口（A02），而不是丢到 body。
  const openerRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  )

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus())
    void loadLibrary().catch((error) => toast(`加载节点库失败：${String(error)}`))
    return () => {
      openerRef.current?.focus()
    }
  }, [loadLibrary])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  // T02（F04）：创建工具分组——按名称/描述/别名匹配全部可创建节点。
  const creatableSpecs = useMemo(() => allNodeTypes(), [])
  const createHits = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return []
    const out: Array<{ type: NodeTypeId; title: string; snippet: string }> = []
    for (const spec of creatableSpecs) {
      const label = spec.label.toLocaleLowerCase()
      const desc = (spec.description ?? '').toLocaleLowerCase()
      if (label.includes(needle) || desc.includes(needle) || aliasMatches(needle, spec.type)) {
        out.push({ type: spec.type, title: spec.label, snippet: spec.description ?? '' })
      }
    }
    return out.slice(0, 30)
  }, [creatableSpecs, query])

  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return { canvas: [] as CanvasSearchHit[], library: [] as LibrarySearchHit[] }

    const canvas: CanvasSearchHit[] = []
    for (const shape of editor.getCurrentPageShapes()) {
      if (shape.type !== 'node-card') continue
      const node = shape as unknown as NodeCardShape
      const title = node.props.title || getNodeType(node.props.nodeType)?.label || '（未命名）'
      const text = node.props.text || ''
      const titleMatch = title.toLocaleLowerCase().includes(needle)
      const textIndex = text.toLocaleLowerCase().indexOf(needle)
      if (!titleMatch && textIndex < 0) continue

      let snippet = ''
      if (textIndex >= 0) {
        const start = Math.max(0, textIndex - 20)
        const end = Math.min(text.length, textIndex + needle.length + 20)
        snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
      }
      canvas.push({ id: node.id, title, nodeType: node.props.nodeType, snippet })
    }

    const library: LibrarySearchHit[] = templates.flatMap((entry) => {
      const matchingNodes = entry.nodes.filter((node) => {
        const specLabel = getNodeType(node.nodeType)?.label ?? ''
        return [node.title, specLabel, node.nodeType, node.text ?? ''].some((value) =>
          value.toLocaleLowerCase().includes(needle)
        )
      })
      if (!entry.name.toLocaleLowerCase().includes(needle) && matchingNodes.length === 0) return []

      const detail = matchingNodes.length
        ? `包含：${matchingNodes
            .slice(0, 3)
            .map((node) => node.title || getNodeType(node.nodeType)?.label || node.nodeType)
            .join('、')}`
        : `${entry.nodes.length} 个节点 · ${entry.edges.length} 条连线`
      return [{ entry, title: entry.name, snippet: detail }]
    })

    return { canvas: canvas.slice(0, 30), library: library.slice(0, 30) }
  }, [editor, query, templates])

  const jumpToCanvasNode = (hit: CanvasSearchHit): void => {
    editor.setSelectedShapes([hit.id])
    editor.zoomToSelection({ animation: { duration: 300 } })
    close()
  }

  const addLibraryEntry = (hit: LibrarySearchHit): void => {
    const { nodeIds, skippedEdges } = addNodeLibraryEntry(editor, hit.entry)
    if (nodeIds.length) {
      editor.setSelectedShapes(nodeIds)
      editor.zoomToSelection({ animation: { duration: 300 } })
    }
    toast(
      skippedEdges > 0
        ? `已从节点库添加「${hit.entry.name}」，${skippedEdges} 条旧连线未恢复`
        : `已从节点库添加「${hit.entry.name}」（${nodeIds.length} 个节点）`
    )
    close()
  }

  return (
    <div
      className="search-overlay"
      onPointerDown={(e) => stopEventPropagation(e)}
      onClick={(e) => {
        stopEventPropagation(e)
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="search-panel" role="dialog" aria-modal="true" aria-label="搜索节点">
        <div className="search-header">
          <span className="search-icon">
            <Icon name="search" size={22} />
          </span>
          <input
            ref={inputRef}
            className="search-input"
            aria-label="搜索画布节点或节点库"
            value={query}
            placeholder="搜索画布节点或节点库…"
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            onPointerDown={(event) => stopEventPropagation(event)}
            onKeyDown={(event) => {
              // F05：此前对所有键 stopPropagation，Esc 到不了 window 关闭监听。
              // 现在输入框内直接处理 Esc（先于画布快捷键），其余键仍阻断画布。
              if (event.key === 'Escape') {
                event.stopPropagation()
                close()
                return
              }
              event.stopPropagation()
              if (event.nativeEvent.isComposing) return
              const buttons = Array.from(
                resultsRef.current?.querySelectorAll<HTMLButtonElement>('.search-hit') ?? []
              )
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const next = buttons.length
                  ? (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                    buttons.length
                  : 0
                setActiveIndex(next)
                buttons.forEach((button, index) =>
                  button.classList.toggle('search-hit-active', index === next)
                )
                buttons[next]?.scrollIntoView({ block: 'nearest' })
              } else if (event.key === 'Enter') {
                event.preventDefault()
                buttons[Math.min(activeIndex, buttons.length - 1)]?.click()
              }
            }}
          />
          <button className="search-close" aria-label="关闭搜索" onClick={close}>
            <Icon name="close" size={20} />
          </button>
        </div>
        {query.trim() && (
          <div ref={resultsRef} className="search-results" aria-live="polite">
            {createHits.length === 0 &&
            matches.canvas.length === 0 &&
            matches.library.length === 0 ? (
              <div className="search-empty">未找到匹配的创建工具、画布节点或节点库条目</div>
            ) : (
              <>
                {createHits.length > 0 && (
                  <section className="search-result-group" aria-label="创建工具">
                    <h3>创建工具</h3>
                    {createHits.map((hit) => (
                      <button
                        key={hit.type}
                        className="search-hit"
                        aria-label={`创建节点：${hit.title}`}
                        onClick={() => {
                          onCreateNode?.(hit.type)
                          close()
                        }}
                        onPointerDown={(event) => stopEventPropagation(event)}
                      >
                        <span
                          className="search-hit-icon"
                          style={{
                            color: nodeIconColor(getNodeType(hit.type)?.color ?? '#94a3b8')
                          }}
                        >
                          <Icon name={getNodeType(hit.type)?.icon ?? 'help'} size={18} />
                        </span>
                        <div className="search-hit-info">
                          <span className="search-hit-title">
                            创建：{hit.title}
                            <span className="search-hit-action">
                              {visibleNodeTypeIds && !visibleNodeTypeIds.includes(hit.type)
                                ? '已隐藏，可本次添加'
                                : '创建'}
                            </span>
                          </span>
                          {hit.snippet && <span className="search-hit-snippet">{hit.snippet}</span>}
                        </div>
                      </button>
                    ))}
                  </section>
                )}
                {matches.canvas.length > 0 && (
                  <section className="search-result-group" aria-label="画布节点">
                    <h3>画布节点</h3>
                    {matches.canvas.map((hit) => (
                      <button
                        key={hit.id}
                        className="search-hit"
                        aria-label={`画布节点：${hit.title}`}
                        onClick={() => jumpToCanvasNode(hit)}
                        onPointerDown={(event) => stopEventPropagation(event)}
                      >
                        <span
                          className="search-hit-icon"
                          style={{
                            color: nodeIconColor(getNodeType(hit.nodeType)?.color ?? '#94a3b8')
                          }}
                        >
                          <Icon name={getNodeType(hit.nodeType)?.icon ?? 'help'} size={18} />
                        </span>
                        <div className="search-hit-info">
                          <span className="search-hit-title">{hit.title}</span>
                          {hit.snippet && <span className="search-hit-snippet">{hit.snippet}</span>}
                        </div>
                      </button>
                    ))}
                  </section>
                )}
                {matches.library.length > 0 && (
                  <section className="search-result-group" aria-label="节点库">
                    <h3>节点库</h3>
                    {matches.library.map((hit) => (
                      <button
                        key={hit.entry.id}
                        className="search-hit"
                        aria-label={`从节点库添加：${hit.title}`}
                        onClick={() => addLibraryEntry(hit)}
                        onPointerDown={(event) => stopEventPropagation(event)}
                      >
                        <span className="search-hit-icon">
                          <Icon name="workflow" size={18} />
                        </span>
                        <div className="search-hit-info">
                          <span className="search-hit-title">{hit.title}</span>
                          <span className="search-hit-snippet">{hit.snippet}</span>
                        </div>
                      </button>
                    ))}
                  </section>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
