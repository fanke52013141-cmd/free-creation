// Search the active canvas and workspace libraries.
// T02：新增「创建工具」分组——搜索即可创建节点（F04：搜索承担创建入口）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { stopEventPropagation, type TLShapeId, type Editor } from 'tldraw'
import type { NodeCardShape } from './NodeCardShape'
import { getNodeType, allNodeTypes, nodeIconColor } from '../nodes/registry'
import { useWorkflowStore, type WorkflowTemplate } from '../stores/workflow'
import { addNodeLibraryEntry, insertPublishedNodeFlow } from './node-library'
import { useDragToCanvas } from './drag-to-canvas'
import { markUndoPoint } from './history'
import { insertLibraryResourceById } from '../library/insertResource'
import { aliasMatches } from './node-aliases'
import { Icon } from '../components/Icon'
import { toast } from '../stores/toast'
import { DiagnosticsProducer, newProducerId, newSpanId, newTraceId } from '@shared/observability'
import { emitDiagnosticsEvent } from '../engine/diagnosticsReporter'
import type { CompositeManifest } from '@shared/composite/manifest'
import type { LibraryResourceSummary } from '@shared/library/types'
import type { IconName } from '../components/Icon'
import { buildMediaAssetIndex, filterMediaAssets } from '../assets/media-index'
import type { MediaAsset, NodeTypeId } from '@shared/types'

export interface SearchDestination {
  kind: 'media' | 'resource' | 'workflow'
  id: string
  title: string
}

interface SearchPaletteProps {
  editor: Editor
  projectId: string
  onOpenResult: (destination: SearchDestination) => void
  onCreateNode?: (type: NodeTypeId) => void
  onDropNode: (type: NodeTypeId, x: number, y: number) => void
  onDropMedia: (asset: MediaAsset, x: number, y: number) => void
  visibleNodeTypeIds?: string[]
}

interface PublishedFlow {
  id: string
  title: string
  version: string | null
  tags: string[]
  manifests?: CompositeManifest[]
}

const searchDiagnostics = new DiagnosticsProducer({
  process: 'renderer',
  producerId: newProducerId('renderer')
})

function trackSearchRead(projectId: string, source: string) {
  const context = { projectId, traceId: newTraceId(), spanId: newSpanId() }
  const startedAt = performance.now()
  let finished = false
  emitDiagnosticsEvent(
    searchDiagnostics.build('search.read.started', undefined, '开始读取搜索来源', context, {
      attributes: { source }
    })
  )
  return (status: 'success' | 'failed' | 'cancelled'): void => {
    if (finished) return
    finished = true
    const stage = status === 'success' ? 'completed' : status
    emitDiagnosticsEvent(
      searchDiagnostics.build(`search.read.${stage}`, undefined, '搜索来源读取结束', context, {
        status,
        durationMs: performance.now() - startedAt,
        attributes: { source }
      })
    )
  }
}

interface CanvasSearchHit {
  id: TLShapeId
  title: string
  group?: true
  snippet: string
}

interface LibrarySearchHit {
  entry: WorkflowTemplate
  title: string
  snippet: string
}

export function SearchPalette(props: SearchPaletteProps): React.JSX.Element {
  return <SearchPaletteInner key={props.projectId} {...props} />
}

function SearchPaletteInner({
  editor,
  projectId,
  onOpenResult,
  onCreateNode,
  onDropNode,
  onDropMedia,
  visibleNodeTypeIds
}: SearchPaletteProps): React.JSX.Element {
  const templates = useWorkflowStore((s) => s.templates)
  const loadLibrary = useWorkflowStore((s) => s.load)
  const { startDrag, handleClick } = useDragToCanvas()
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const [started, setStarted] = useState(false)
  const [assets, setAssets] = useState<MediaAsset[]>([])
  const [flows, setFlows] = useState<PublishedFlow[]>([])
  const [resources, setResources] = useState<{ query: string; items: LibraryResourceSummary[] }>()
  const [loadIssues, setLoadIssues] = useState<string[]>([])
  const [resourceIssue, setResourceIssue] = useState('')
  const [sourceReadsPending, setSourceReadsPending] = useState(3)
  const searchRef = useRef<HTMLDivElement>(null)
  const searchTerm = focused ? query.trim() : ''

  const [activeIndex, setActiveIndex] = useState(0)
  const resultsRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const activate = (value: string): void => {
    setFocused(true)
    const hasQuery = Boolean(value.trim())
    if (hasQuery && !started) {
      setSourceReadsPending(3)
      setLoadIssues([])
      setResources(undefined)
      setResourceIssue('')
    }
    setStarted(hasQuery)
  }

  const clear = (): void => {
    setStarted(false)
    setQuery('')
    setActiveIndex(0)
  }

  const close = (): void => {
    clear()
    setFocused(false)
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement && searchRef.current?.contains(activeElement)) {
      activeElement.blur()
    }
  }

  useEffect(() => {
    if (!focused) return
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && !searchRef.current?.contains(event.target)) {
        setFocused(false)
        setStarted(false)
      }
    }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [focused])

  useEffect(() => {
    if (!started) return
    let cancelled = false
    const report = (source: string): void => {
      if (!cancelled)
        setLoadIssues((issues) => (issues.includes(source) ? issues : [...issues, source]))
    }
    const onSourceSettled = (): void => {
      if (!cancelled) setSourceReadsPending((remaining) => remaining - 1)
    }
    const finishTemplates = trackSearchRead(projectId, 'templates')
    const finishMedia = trackSearchRead(projectId, 'media')
    const finishFlows = trackSearchRead(projectId, 'flows')
    void loadLibrary()
      .then(() => finishTemplates('success'))
      .catch(() => {
        finishTemplates('failed')
        report('节点流模板')
      })
      .finally(onSourceSettled)
    void window.api
      .listMedia(projectId)
      .then((result) => {
        if (cancelled) return
        finishMedia(result.ok ? 'success' : 'failed')
        if (result.ok) setAssets(result.data)
        else report('项目素材')
      })
      .catch(() => {
        finishMedia('failed')
        report('项目素材')
      })
      .finally(onSourceSettled)
    const loadFlows = async (): Promise<void> => {
      const result = await window.api.composite.search({ limit: 200 })
      if (cancelled) return
      if (!result.ok) {
        finishFlows('failed')
        return report('节点流')
      }
      const entries = result.data.map((flow) => ({
        id: flow.id,
        title: flow.name,
        tags: flow.tags ?? [],
        version: flow.latestVersion
      }))
      setFlows(entries)
      // Limit concurrent version reads when the workspace has many published flows.
      const indexed: PublishedFlow[] = []
      let incomplete = false
      for (let start = 0; start < entries.length && !cancelled; start += 8) {
        const batch = await Promise.all(
          entries.slice(start, start + 8).map(async (flow) => {
            const reads = await Promise.allSettled([
              window.api.composite.draftGet(flow.id),
              flow.version
                ? window.api.composite.versionGet({ capabilityId: flow.id, version: flow.version })
                : Promise.resolve(null)
            ])
            const manifests: CompositeManifest[] = []
            for (const read of reads) {
              if (read.status === 'fulfilled' && (read.value === null || read.value.ok)) {
                if (read.value?.data) manifests.push(read.value.data.manifest)
              } else {
                incomplete = true
                report('部分节点流内容')
              }
            }
            return { ...flow, manifests }
          })
        )
        indexed.push(...batch)
      }
      if (!cancelled) {
        setFlows(indexed)
        finishFlows(incomplete ? 'failed' : 'success')
      }
    }
    void loadFlows()
      .catch(() => {
        finishFlows('failed')
        report('节点流')
      })
      .finally(onSourceSettled)
    return () => {
      cancelled = true
      finishTemplates('cancelled')
      finishMedia('cancelled')
      finishFlows('cancelled')
    }
  }, [projectId, loadLibrary, started])

  useEffect(() => {
    if (!searchTerm) return
    let cancelled = false
    let finish: ReturnType<typeof trackSearchRead> | undefined
    const timer = window.setTimeout(() => {
      finish = trackSearchRead(projectId, 'resource-library')
      void window.api
        .searchLibrary({ query: searchTerm, limit: 30 })
        .then((result) => {
          if (cancelled) return
          finish?.(result.ok ? 'success' : 'failed')
          setResources({ query: searchTerm, items: result.ok ? result.data.items : [] })
          setResourceIssue(result.ok ? '' : searchTerm)
        })
        .catch(() => {
          if (cancelled) return
          finish?.('failed')
          setResources({ query: searchTerm, items: [] })
          setResourceIssue(searchTerm)
        })
    }, 160)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      finish?.('cancelled')
    }
  }, [projectId, searchTerm])

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
    if (!needle) return { canvas: [], library: [], media: [], published: [] }

    const canvas: CanvasSearchHit[] = []
    const shapes = editor.getCurrentPageShapes()
    const nodes = shapes.filter((shape): shape is NodeCardShape => shape.type === 'node-card')
    for (const node of nodes) {
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
      canvas.push({ id: node.id, title, snippet })
    }

    for (const shape of shapes) {
      const label = shape.meta.label
      if (shape.type !== 'group' || typeof label !== 'string') continue
      if (label.toLocaleLowerCase().includes(needle)) {
        canvas.push({ id: shape.id, title: label, group: true, snippet: '' })
      }
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

    const media = filterMediaAssets(buildMediaAssetIndex(assets, nodes), {
      keyword: needle,
      filter: 'all',
      sourceNodeId: 'all',
      runStatus: 'all',
      timeRange: 'all'
    })
    const published = flows.flatMap((flow) => {
      const manifests = flow.manifests ?? []
      const node = manifests
        .flatMap((manifest) => manifest.graph.nodes)
        .find((item) =>
          [item.title, item.nodeType, getNodeType(item.nodeType)?.label, item.text].some((value) =>
            value?.toLocaleLowerCase().includes(needle)
          )
        )
      const summary = [
        flow.title,
        flow.id,
        ...flow.tags,
        ...manifests.flatMap((manifest) => [
          manifest.name,
          manifest.description,
          ...(manifest.tags ?? []),
          ...[...manifest.inputs, ...manifest.outputs].flatMap((port) => [
            port.id,
            port.label,
            port.description
          ])
        ])
      ]
      if (!node && !summary.some((value) => value?.toLocaleLowerCase().includes(needle))) return []
      return [
        {
          ...flow,
          snippet: node ? `包含：${node.title || node.nodeType}` : manifests[0]?.description
        }
      ]
    })
    return {
      canvas: canvas.slice(0, 30),
      library: library.slice(0, 30),
      media: media.slice(0, 30),
      published: published.slice(0, 30)
    }
  }, [editor, query, templates, assets, flows])

  const jumpToCanvasNode = (hit: CanvasSearchHit): void => {
    editor.setSelectedShapes([hit.id])
    editor.zoomToSelection({ animation: { duration: 300 } })
    close()
  }

  const addLibraryEntry = (hit: LibrarySearchHit, drop?: { x: number; y: number }): void => {
    const { nodeIds, skippedEdges } = addNodeLibraryEntry(editor, hit.entry, true, drop)
    if (nodeIds.length) {
      editor.setSelectedShapes(nodeIds)
      if (!drop) editor.zoomToSelection({ animation: { duration: 300 } })
    }
    toast(
      skippedEdges > 0
        ? `已从节点流添加「${hit.entry.name}」，${skippedEdges} 条旧连线未恢复`
        : `已从节点流添加「${hit.entry.name}」（${nodeIds.length} 个节点）`
    )
    close()
  }

  const dragResult = (
    event: React.PointerEvent,
    title: string,
    icon: IconName,
    onDrop: (x: number, y: number) => void
  ): void => {
    startDrag(
      event,
      { label: title, icon },
      (x, y) => {
        close()
        onDrop(x, y)
      },
      (x, y) => {
        const target = document.elementFromPoint(x, y)
        return !editor.isDisposed && !!target && editor.getContainer().contains(target)
      }
    )
  }

  const moveCanvasResult = (id: TLShapeId, x: number, y: number): void => {
    const shape = editor.getShape(id)
    const bounds = editor.getShapePageBounds(id)
    const origin = editor.getShapePageTransform(id)?.point()
    if (!shape || !bounds || !origin || editor.isShapeOrAncestorLocked(shape)) return
    const point = editor.screenToPage({ x, y })
    const position = editor.getPointInParentSpace(shape, {
      x: origin.x + point.x - bounds.center.x,
      y: origin.y + point.y - bounds.center.y
    })
    markUndoPoint(editor, 'move-search-result')
    editor.updateShape({ id, type: shape.type, x: position.x, y: position.y })
    editor.select(id)
  }

  const dropPublishedFlow = async (flow: PublishedFlow, x: number, y: number): Promise<void> => {
    const finish = trackSearchRead(projectId, 'published-flow-drop')
    finish(
      await insertPublishedNodeFlow(
        editor,
        { id: flow.id, name: flow.title, latestVersion: flow.version },
        { x, y }
      )
    )
  }

  const dropResource = async (id: string, x: number, y: number): Promise<void> => {
    const finish = trackSearchRead(projectId, 'resource-drop')
    try {
      finish(await insertLibraryResourceById(editor, projectId, id, { x, y }))
    } catch {
      finish('failed')
      toast('添加资源失败')
    }
  }

  const resourceHits = resources?.query === searchTerm ? resources.items : []
  const searchPending = resources?.query !== searchTerm || sourceReadsPending > 0
  const openResult = (destination: SearchDestination): void => {
    onOpenResult(destination)
    close()
  }

  const destinationHit = (
    destination: SearchDestination,
    source: string,
    icon: IconName,
    snippet: string | undefined,
    drop?: (x: number, y: number) => void
  ): React.JSX.Element => (
    <button
      key={destination.id}
      className="search-hit"
      aria-label={`${source}：${destination.title}`}
      onClick={() => handleClick(() => openResult(destination))}
      onPointerDown={drop ? (event) => dragResult(event, destination.title, icon, drop) : undefined}
    >
      <span className="search-hit-icon" title={source}>
        <Icon name={icon} size={18} />
      </span>
      <span className="search-hit-info">
        <span className="search-hit-title" title={destination.title}>
          {destination.title}
        </span>
        {snippet && (
          <span className="search-hit-snippet" title={snippet}>
            {snippet}
          </span>
        )}
      </span>
    </button>
  )

  return (
    <div
      className="dock-search"
      ref={searchRef}
      role="search"
      aria-label="全局搜索"
      onPointerDown={(event) => stopEventPropagation(event)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false)
          setStarted(false)
        }
      }}
    >
      <div className="search-header">
        <input
          ref={inputRef}
          className="search-input"
          aria-label="全局搜索关键词"
          value={query}
          maxLength={200}
          onFocus={() => activate(query)}
          onChange={(event) => {
            activate(event.target.value)
            setQuery(event.target.value)
            setActiveIndex(0)
          }}
          onPointerDown={(event) => stopEventPropagation(event)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Escape') {
              if (query) clear()
              else close()
              return
            }
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
        {query && (
          <button
            className="search-close"
            type="button"
            aria-label="清空搜索"
            onClick={() => {
              clear()
              inputRef.current?.focus()
            }}
          >
            <Icon name="close" size={13} />
          </button>
        )}
        <button
          className="search-icon"
          type="button"
          aria-label="聚焦搜索输入框"
          onClick={() => inputRef.current?.focus()}
        >
          <Icon name="search" size={15} />
        </button>
      </div>
      {searchTerm && (
        <div ref={resultsRef} className="search-results" aria-live="polite">
          {createHits.length === 0 &&
          matches.canvas.length === 0 &&
          matches.library.length === 0 &&
          matches.published.length === 0 &&
          matches.media.length === 0 &&
          resourceHits.length === 0 &&
          !searchPending ? (
            <div className="search-empty">未找到匹配结果</div>
          ) : (
            <>
              {matches.canvas.length > 0 && (
                <section className="search-result-group" aria-label="画布">
                  <h3>画布</h3>
                  {matches.canvas.map((hit) => (
                    <button
                      key={hit.id}
                      className="search-hit"
                      aria-label={`${hit.group ? '画布流程' : '画布节点'}：${hit.title}`}
                      onClick={() => handleClick(() => jumpToCanvasNode(hit))}
                      onPointerDown={(event) =>
                        dragResult(
                          event,
                          hit.title,
                          hit.group ? 'node-library' : 'layers',
                          (x, y) => moveCanvasResult(hit.id, x, y)
                        )
                      }
                    >
                      <span className="search-hit-icon" title={hit.group ? '画布流程' : '画布节点'}>
                        <Icon name={hit.group ? 'node-library' : 'layers'} size={18} />
                      </span>
                      <div className="search-hit-info">
                        <span className="search-hit-title" title={hit.title}>
                          {hit.title}
                        </span>
                        {hit.snippet && (
                          <span className="search-hit-snippet" title={hit.snippet}>
                            {hit.snippet}
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                </section>
              )}
              {(matches.library.length > 0 || matches.published.length > 0) && (
                <section className="search-result-group" aria-label="节点流">
                  <h3>节点流</h3>
                  {matches.published.map((hit) =>
                    destinationHit(
                      { kind: 'workflow', id: hit.id, title: hit.title },
                      '节点流',
                      'node-library',
                      hit.snippet,
                      hit.version ? (x, y) => void dropPublishedFlow(hit, x, y) : undefined
                    )
                  )}
                  {matches.library.map((hit) => (
                    <button
                      key={hit.entry.id}
                      className="search-hit"
                      aria-label={`从节点流添加：${hit.title}`}
                      onClick={() => handleClick(() => addLibraryEntry(hit))}
                      onPointerDown={(event) =>
                        dragResult(event, hit.title, 'node-library', (x, y) =>
                          addLibraryEntry(hit, { x, y })
                        )
                      }
                    >
                      <span className="search-hit-icon">
                        <Icon name="node-library" size={18} />
                      </span>
                      <div className="search-hit-info">
                        <span className="search-hit-title" title={hit.title}>
                          {hit.title}
                        </span>
                        <span className="search-hit-snippet" title={hit.snippet}>
                          {hit.snippet}
                        </span>
                      </div>
                    </button>
                  ))}
                </section>
              )}
              {matches.media.length > 0 && (
                <section className="search-result-group" aria-label="项目素材">
                  <h3>项目素材</h3>
                  {matches.media.map((asset) =>
                    destinationHit(
                      {
                        kind: 'media',
                        id: asset.id,
                        title: asset.name || asset.path.split(/[/\\]/).pop() || asset.id
                      },
                      '项目素材',
                      'assets',
                      asset.mime,
                      (x, y) => onDropMedia(asset, x, y)
                    )
                  )}
                </section>
              )}
              {resourceHits.length > 0 && (
                <section className="search-result-group" aria-label="资源库">
                  <h3>资源库</h3>
                  {resourceHits.map((resource) =>
                    destinationHit(
                      { kind: 'resource', id: resource.id, title: resource.title },
                      '资源库',
                      'folder',
                      resource.description,
                      (x, y) => void dropResource(resource.id, x, y)
                    )
                  )}
                </section>
              )}
              {createHits.length > 0 && (
                <section className="search-result-group" aria-label="创建工具">
                  <h3>创建工具</h3>
                  {createHits.map((hit) => (
                    <button
                      key={hit.type}
                      className="search-hit"
                      aria-label={`创建节点：${hit.title}`}
                      onClick={() =>
                        handleClick(() => {
                          onCreateNode?.(hit.type)
                          close()
                        })
                      }
                      onPointerDown={(event) =>
                        dragResult(
                          event,
                          hit.title,
                          getNodeType(hit.type)?.icon ?? 'help',
                          (x, y) => onDropNode(hit.type, x, y)
                        )
                      }
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
                        <span className="search-hit-title" title={`创建：${hit.title}`}>
                          创建：{hit.title}
                          <span className="search-hit-action">
                            {visibleNodeTypeIds && !visibleNodeTypeIds.includes(hit.type)
                              ? '已隐藏，可本次添加'
                              : '创建'}
                          </span>
                        </span>
                        {hit.snippet && (
                          <span className="search-hit-snippet" title={hit.snippet}>
                            {hit.snippet}
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                </section>
              )}
            </>
          )}
          {searchPending && <div className="search-empty">正在搜索…</div>}
          {(loadIssues.length > 0 || resourceIssue === searchTerm) && (
            <div className="search-empty">
              加载失败：
              {[...loadIssues, ...(resourceIssue === searchTerm ? ['资源库'] : [])].join('、')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
