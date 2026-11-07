import { TopbarIconButton } from '../components/TopbarIconButton'
import { DiagnosticsProducer, newProducerId, newSpanId, newTraceId } from '@shared/observability'
import { emitDiagnosticsEvent } from '../engine/diagnosticsReporter'
import { GenerationLoadingOverlay } from '../canvas/GenerationLoadingOverlay'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LibraryResourceDetail, LibraryResourceSummary, CreateLibraryResourceInput, PublishLibraryRevisionInput } from '@shared/library/types'
import type { LibraryCategory } from '@shared/library/blueprint'
import { Icon } from '../components/Icon'
import { AppSelect } from '../components/AppSelect'
import { mediaUrl } from '../nodes/registry'
import { useConfirmStore } from '../stores/confirm'
import { useToastStore } from '../stores/toast'
import { LibraryCardCover } from './LibraryCardCover'
import { LibraryResourceForm } from './LibraryResourceForm'
import { LibraryCategoryEditor } from './LibraryCategoryEditor'
import { libraryValueTypeLabel, libraryVersionLabel } from './value-type-labels'
import './library.css'

const batchDiagnostics = new DiagnosticsProducer({ process: 'renderer', producerId: newProducerId('renderer') })

const revisionDate = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
})

function formatRevisionDate(timestamp: number): string {
  return revisionDate.format(timestamp).replaceAll('/', '-')
}

function ResourceCard({ resource, onOpen, onDragStart, selected }: { resource: LibraryResourceSummary; onOpen: React.MouseEventHandler<HTMLButtonElement>; selected?: boolean; onDragStart?: React.DragEventHandler<HTMLButtonElement> }): React.JSX.Element {
  return (
    <button className="library-resource-card" aria-pressed={selected} title={resource.title} draggable={Boolean(onDragStart)} onDragStart={onDragStart} onClick={onOpen}>
      {selected !== undefined && <span className="library-card-selection" aria-hidden="true">{selected ? '✓' : ''}</span>}
      {resource.iconKind && <LibraryCardCover icon={resource.iconKind} path={resource.iconKind === 'video' ? resource.videoPreviewPath : resource.coverPath} />}
      <div className="library-resource-card-body">
        <div className="library-resource-card-title"><strong>{resource.title}</strong></div>
        {resource.description && <p>{resource.description}</p>}
      </div>
    </button>
  )
}

function RecipePreview({ component, onCopy }: { component: LibraryResourceDetail['components'][number]; onCopy: (text: string) => void }): React.JSX.Element {
  const detected = [...(component.text ?? '').matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]{0,63})\s*\}\}/g)].map((match) => match[1])
  const configured = Array.isArray(component.metadata.variables)
    ? component.metadata.variables.filter((value): value is string => typeof value === 'string')
    : []
  const variables = [...new Set([...configured, ...detected])]
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(variables.map((name) => [name, ''])))
  const preview = (component.text ?? '').replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]{0,63})\s*\}\}/g, (_match, name: string) => values[name] || `{{${name}}}`)
  return (
    <div className="library-recipe-preview">
      <div className="library-recipe-inputs">
        {variables.map((name) => <label key={name}><span>{name}</span><input value={values[name] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [name]: event.currentTarget.value }))} placeholder={`填写 ${name}`} /></label>)}
        {variables.length === 0 && <small>这个配方没有变量，可直接查看或复制模板。</small>}
      </div>
      <pre>{preview || '（空提示词模板）'}</pre>
      {Boolean(component.metadata.modelParameters) && typeof component.metadata.modelParameters === 'object' && (
        <details className="library-recipe-parameters"><summary>模型参数与参考用途</summary>
          <pre>{JSON.stringify(component.metadata.modelParameters, null, 2)}</pre>
          {Array.isArray(component.metadata.referenceRoles) && <small>参考组件：{component.metadata.referenceRoles.filter((role): role is string => typeof role === 'string').join('、') || '无'}</small>}
        </details>
      )}
      <button className="library-copy-text" onClick={() => onCopy(preview)}><Icon name="copy" size={13} />复制预览提示词</button>
    </div>
  )
}

function ComponentPreview({ component, onCopy }: { component: LibraryResourceDetail['components'][number]; onCopy: (text: string) => void }): React.JSX.Element {
  if (component.valueType === 'recipe') {
    return <article className="library-component-preview"><RecipePreview component={component} onCopy={onCopy} /></article>
  }
  return (
    <article className="library-component-preview">
      {component.valueType === 'image' && component.blobPath ? (
        <img className="library-preview-image" src={mediaUrl(component.blobPath)} alt={component.role} />
      ) : component.valueType === 'audio' && component.blobPath ? (
        <audio controls src={mediaUrl(component.blobPath)} />
      ) : component.valueType === 'video' && component.blobPath ? (
        <video controls src={mediaUrl(component.blobPath)} />
      ) : component.text !== undefined ? (
        <pre className="library-preview-text">{component.text || '（空内容）'}</pre>
      ) : (
        <div className="library-preview-file"><Icon name="document" size={17} /><span>{component.fileName ?? '资源文件'}</span></div>
      )}
      {component.text !== undefined && component.text && <button className="library-copy-text" onClick={() => onCopy(component.text ?? '')}><Icon name="copy" size={13} />复制文本</button>}
      {component.fileName && <small className="library-component-file-name">{component.fileName}</small>}
    </article>
  )
}

export function ResourceLibraryPage({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [resources, setResources] = useState<LibraryResourceSummary[]>([])
  const [categories, setCategories] = useState<LibraryCategory[]>([])
  const [categoryId, setCategoryId] = useState('legacy')
  const [categoryEditor, setCategoryEditor] = useState<{ initial?: LibraryCategory } | null>(null)
  const [query, setQuery] = useState('')
  const [loadedFilter, setLoadedFilter] = useState('')
  const filter = JSON.stringify([categoryId, query])
  const batchReady = loadedFilter === filter
  const filterRef = useRef(filter)
  useEffect(() => { filterRef.current = filter }, [filter])
  const [batchMode, setBatchMode] = useState(false)
  const [batchIds, setBatchIds] = useState(new Set<string>())
  const [batchBusy, setBatchBusy] = useState(false)
  const batchAnchor = useRef<string | null>(null)
  const clearBatchSelection = (): void => {
    batchAnchor.current = null
    setBatchIds(new Set())
  }
  const allSelected = resources.length > 0 && resources.every((item) => batchIds.has(item.id))
  const selectCard = (id: string, range: boolean): void => {
    const start = resources.findIndex((item) => item.id === batchAnchor.current)
    const end = resources.findIndex((item) => item.id === id)
    if (!range || start < 0) batchAnchor.current = id
    setBatchIds((current) => {
      const next = new Set(current)
      if (range && start >= 0) {
        resources.slice(Math.min(start, end), Math.max(start, end) + 1).forEach((item) => next.add(item.id))
      } else if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | undefined>()
  const [detail, setDetail] = useState<LibraryResourceDetail | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const browserRef = useRef<HTMLElement | null>(null)
  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  const loadingMoreRef = useRef(false)
  const nextCursorRef = useRef<string | null>(null)
  const maybeLoadMoreRef = useRef<() => void>(() => {})
  const detailLoading = Boolean(selectedId) && (!detail || detail.id !== selectedId || detail.selectedRevisionId !== selectedRevisionId)
  const loadPageData = useCallback(async (): Promise<void> => {
    const categoryResult = await window.api.listLibraryCategories()
    if (categoryResult.ok) setCategories(categoryResult.data)
  }, [])

  const loadResources = useCallback(async (cursor?: string, append = false): Promise<void> => {
    const result = await window.api.searchLibrary({ query, categoryId: categoryId || undefined, cursor, limit: 48 })
    if (filterRef.current !== filter) return
    if (!result.ok) {
      useToastStore.getState().show(`资源库读取失败：${result.error.message}`)
      return
    }
    const items = result.data.items.filter((item) => !item.archivedAt)
    setResources((current) => append ? [...current, ...items] : items)
    setNextCursor(result.data.nextCursor)
    setLoadedFilter(filter)
  }, [categoryId, query, filter])

  // 自动加载：滚动接近底部时按 cursor 续页，替代手动「加载更多」按钮。
  useEffect(() => {
    maybeLoadMoreRef.current = () => {
      const sentinel = loadMoreRef.current
      const cursor = nextCursorRef.current
      if (!sentinel || !cursor || loadingMoreRef.current) return
      const viewport = browserRef.current?.clientHeight ?? window.innerHeight
      if (sentinel.getBoundingClientRect().top > viewport + 480) return
      loadingMoreRef.current = true
      void loadResources(cursor, true).finally(() => {
        loadingMoreRef.current = false
        maybeLoadMoreRef.current()
      })
    }
  }, [loadResources])
  useEffect(() => {
    nextCursorRef.current = nextCursor
    maybeLoadMoreRef.current()
  }, [nextCursor])
  useEffect(() => {
    const container = browserRef.current
    if (!container) return
    const onScroll = (): void => maybeLoadMoreRef.current()
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadPageData() }, 0)
    return () => window.clearTimeout(timer)
  }, [loadPageData])
  useEffect(() => {
    const timer = window.setTimeout(() => { void loadResources() }, 180)
    return () => window.clearTimeout(timer)
  }, [loadResources])

  useEffect(() => {
    if (!selectedId) return
    let cancelled = false
    void window.api.getLibraryResource({ resourceId: selectedId, revisionId: selectedRevisionId }).then((result) => {
      if (cancelled) return
      if (result.ok) {
        setDetail(result.data)
      } else {
        useToastStore.getState().show(`读取资源详情失败：${result.error.message}`)
      }
    })
    return () => { cancelled = true }
  }, [selectedId, selectedRevisionId])

  const saveResource = async (input: CreateLibraryResourceInput | PublishLibraryRevisionInput): Promise<void> => {
    const isRevision = 'resourceId' in input
    const result = isRevision
      ? await window.api.publishLibraryRevision(input as PublishLibraryRevisionInput)
      : await window.api.createLibraryResource(input as CreateLibraryResourceInput)
    if (!result.ok) throw new Error(result.error.message)
    setFormOpen(false)
    setCategoryId(result.data.category?.id ?? 'legacy')
    setSelectedId(result.data.id)
    setSelectedRevisionId(result.data.latestRevisionId)
    await loadResources()
    await loadPageData()
    useToastStore.getState().show(isRevision ? `已保存「${result.data.title}」为 ${libraryVersionLabel(result.data.revisionNumber)}` : `已保存资源「${result.data.title}」`)
  }

  /** 2026-11-06 用户裁决：资源库不做归档，确认后彻底删除（含全部版本）。 */
  const deleteResource = async (): Promise<void> => {
    if (!detail) return
    const confirmed = await useConfirmStore.getState().confirm({
      title: `删除资源「${detail.title}」？`,
      message: '会同时删除该资源的全部版本与内容，删除后无法恢复。',
      confirmText: '删除',
      cancelText: '取消',
      danger: true
    })
    if (!confirmed) return
    const result = await window.api.deleteLibraryResource({ resourceId: detail.id })
    if (!result.ok) return useToastStore.getState().show(`删除失败：${result.error.message}`)
    setDetail(null)
    setSelectedId(null)
    await loadResources()
    useToastStore.getState().show(`已删除资源「${detail.title}」`)
  }

  const runBatch = async (action: 'delete' | 'export'): Promise<void> => {
    const ids = [...batchIds]
    if (!ids.length || batchBusy || !batchReady) return
    setBatchBusy(true)
    try {
      if (action === 'export') {
        await exportLibrary(ids)
        return
      }
      const confirmed = await useConfirmStore.getState().confirm({
        title: `删除所选的 ${ids.length} 项资源？`,
        message: '会同时删除这些资源的全部版本与内容，删除后无法恢复。',
        confirmText: '删除所选',
        danger: true
      })
      const context = { traceId: newTraceId(), spanId: newSpanId() }
      const count = ids.length
      if (!confirmed) {
        emitDiagnosticsEvent(batchDiagnostics.build('library.batch_delete_cancelled', undefined, '已取消批量删除资源', context, { status: 'cancelled', attributes: { count } }))
        return
      }
      emitDiagnosticsEvent(batchDiagnostics.build('library.batch_delete_started', undefined, '开始批量删除资源', context, { attributes: { count } }))
      const deleted = new Set<string>()
      for (const resourceId of ids) {
        const result = await window.api.deleteLibraryResource({ resourceId }).catch(() => null)
        if (result?.ok && result.data) deleted.add(resourceId)
      }
      setBatchIds((current) => new Set([...current].filter((id) => !deleted.has(id))))
      setResources((current) => current.filter((item) => !deleted.has(item.id)))
      batchAnchor.current = null
      const failed = count - deleted.size
      emitDiagnosticsEvent(batchDiagnostics.build(
        failed ? 'library.batch_delete_failed' : 'library.batch_delete_completed',
        undefined, failed ? '部分资源删除失败' : '批量删除资源完成', context,
        { status: failed ? 'failed' : 'success', attributes: { count, deleted: deleted.size, failed } }
      ))
      if (filterRef.current === filter) await loadResources()
      useToastStore.getState().show(failed ? `已删除 ${deleted.size} 项，${failed} 项删除失败` : `已删除 ${deleted.size} 项资源`)
    } catch {
      useToastStore.getState().show(action === 'export' ? '导出资源失败' : '无法刷新资源列表')
    } finally {
      setBatchBusy(false)
    }
  }

  const copyText = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      useToastStore.getState().show('文本已复制')
    } catch {
      useToastStore.getState().show('无法访问剪贴板，请手动选择文本复制')
    }
  }

  const importLibrary = async (): Promise<void> => {
    const result = await window.api.importLibrary()
    if (!result.ok) {
      if (result.error.code !== 'CANCELLED') useToastStore.getState().show(`导入失败：${result.error.message}`)
      return
    }
    await loadPageData()
    await loadResources()
    useToastStore.getState().show(`已导入 ${result.data.imported} 项资源`)
  }

  const exportLibrary = async (resourceIds?: string[]): Promise<void> => {
    const result = await window.api.exportLibrary({ resourceIds })
    if (!result.ok) {
      if (result.error.code !== 'CANCELLED') useToastStore.getState().show(`导出失败：${result.error.message}`)
      return
    }
    useToastStore.getState().show(`资产包已导出到 ${result.data.path}`)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        setSelectedId(null)
        setFormOpen(true)
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchInputRef.current?.focus()
      } else if (event.key === 'Escape') {
        if (categoryEditor) setCategoryEditor(null)
        else if (formOpen) setFormOpen(false)
        else if (selectedId) setSelectedId(null)
        else onBack()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [categoryEditor, formOpen, onBack, selectedId])

  return (
    <div className="resource-library-page">
      <header className="library-page-header">
        <div className="library-header-context">
          <span className="library-header-label"><Icon name="assets" size={15} />资源库</span>
        </div>
        <div className="library-page-actions">
          <label className="library-search library-header-search"><Icon name="search" size={15} /><input ref={searchInputRef} aria-label="搜索资源" value={query} onChange={(event) => { clearBatchSelection(); setQuery(event.currentTarget.value) }} /></label>
          <div className="library-tool-group" role="group" aria-label="资源库工具">
            <TopbarIconButton type="button" className="library-tool-btn" aria-label="导入资产包" onClick={() => void importLibrary()}><Icon name="upload" size={16} /></TopbarIconButton>
            <TopbarIconButton type="button" className="library-tool-btn" aria-label="导出资产包" onClick={() => void exportLibrary()}><Icon name="download" size={16} /></TopbarIconButton>
          </div>
          <button type="button" className="library-header-text-btn" onClick={() => setCategoryEditor({})}>
            <Icon name="add" size={13} />新建分类
          </button>
          <AppSelect
            className="library-edit-category-select"
            value=""
            aria-label="编辑分类"
            onChange={(event) => {
              const category = categories.find((item) => item.id === event.target.value)
              if (category) setCategoryEditor({ initial: category })
            }}
          >
            <option value="">编辑分类</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </AppSelect>
          <button className="library-primary" onClick={() => { setSelectedId(null); setFormOpen(true) }}><span className="library-primary-icon"><Icon name="add" size={14} /></span>新建资源</button>
          {/* 2026-11-06 用户反馈：进入资源库后找不到返回入口——在系统窗口按钮左侧再放一个固定返回图标。 */}
          <TopbarIconButton type="button" className="library-home-btn" aria-label="返回项目列表" onClick={onBack}>
            <Icon name="home" size={16} />
          </TopbarIconButton>
        </div>
      </header>

      <nav className="library-filter-row" aria-label="资源分类">
        <div className="library-category-tabs">
          <button className={!categoryId ? 'active' : ''} onClick={() => { clearBatchSelection(); setCategoryId('') }}>全部</button>
          <button className={categoryId === 'legacy' ? 'active' : ''} onClick={() => { clearBatchSelection(); setCategoryId('legacy') }}>未分类</button>
          {categories.map((category) => (
            <button
              key={category.id}
              className={categoryId === category.id ? 'active' : ''}
              onClick={() => { clearBatchSelection(); setCategoryId(category.id) }}
              title={`浏览分类：${category.name}`}
            >
              {category.name}
            </button>
          ))}
        </div>
      </nav>

      <div className="library-batch-toolbar">
        <button type="button" className="library-secondary" disabled={batchBusy} aria-pressed={batchMode} onClick={() => { clearBatchSelection(); setBatchMode(!batchMode) }}>
          {batchMode ? '退出批量管理' : '批量管理'}
        </button>
        {batchMode && <>
          <span role="status">已选 {batchIds.size} 项</span>
          <button type="button" className="library-secondary" disabled={!batchIds.size || batchBusy || !batchReady} onClick={() => void runBatch('export')}>批量导出</button>
          <button type="button" className="library-secondary library-batch-delete" disabled={!batchIds.size || batchBusy || !batchReady} onClick={() => void runBatch('delete')}>批量删除</button>
          <button type="button" className="library-secondary library-batch-select-all" disabled={!resources.length || batchBusy || !batchReady} onClick={() => {
            batchAnchor.current = null
            setBatchIds(allSelected ? new Set() : new Set(resources.map((item) => item.id)))
          }}>{allSelected ? '取消全选' : nextCursor ? '全选已加载' : '全选'}</button>
        </>}
      </div>
      <div className="library-workspace">
          <main ref={browserRef} className="library-resource-browser">
            {resources.length > 0 && (
              <div className="library-resource-grid">
                {resources.map((resource) => <ResourceCard key={resource.id} resource={resource} selected={batchMode ? batchIds.has(resource.id) : undefined} onOpen={(event) => { if (batchMode) { if (!batchBusy && batchReady) selectCard(resource.id, event.shiftKey); return } setSelectedId(resource.id); setSelectedRevisionId(resource.latestRevisionId) }} onDragStart={batchMode ? undefined : (event) => event.dataTransfer.setData('application/x-canvas-library-resource', resource.id)} />)}
              </div>
            )}
            {nextCursor && <div ref={loadMoreRef} className="library-load-more" aria-hidden="true">正在加载更多…</div>}
          </main>
        </div>
      {selectedId && (
        <div className="library-detail-mask" onMouseDown={(event) => event.target === event.currentTarget && setSelectedId(null)}>
          <aside className="library-detail-panel" role="dialog" aria-modal="true" aria-label="资源详情">
            <header className="library-detail-header">
              <h2 className="library-detail-header-title" title={detail?.selectedTitle}>{detailLoading ? '资源详情' : detail?.selectedTitle ?? '资源详情'}</h2>
              <button className="library-icon-button" aria-label="关闭详情" onClick={() => setSelectedId(null)}><Icon name="close" size={17} /></button>
            </header>
            {detailLoading || !detail ? <GenerationLoadingOverlay title="正在读取资源" compact /> : (
              <>
                <div className="library-detail-scroll">
                  <div className="library-detail-section">
                    <div className="library-detail-section-title"><h3>资源内容</h3></div>
                    {detail.selectedDescription && <p className="library-detail-description">{detail.selectedDescription}</p>}
                    <div className="library-detail-tags">{detail.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
                    {detail.components.map((component) => (
                      <div className="library-detail-component-row" key={component.id}>
                        <div className="library-detail-component-head">
                          <span>{component.role}</span>
                          <small>{libraryValueTypeLabel(component.valueType)}</small>
                        </div>
                        <ComponentPreview component={component} onCopy={(text) => void copyText(text)} />
                      </div>
                    ))}
                  </div>
                  <div className="library-detail-section">
                    <div className="library-detail-section-title"><h3>版本记录</h3></div>
                    <div className="library-version-history" role="group" aria-label="资源版本历史">
                      {detail.revisions.map((revision) => {
                        const selected = revision.id === detail.selectedRevisionId
                        return <button type="button" aria-pressed={selected} key={revision.id} className={`library-version-entry${selected ? ' selected' : ''}`} onClick={() => setSelectedRevisionId(revision.id)}>
                          <span className="library-version-entry-marker" />
                          <span className="library-version-entry-body">
                            <span className="library-version-entry-title">
                              <strong>{libraryVersionLabel(revision.revisionNumber)}</strong>
                              <time className="library-version-date" dateTime={new Date(revision.createdAt).toISOString()}>{formatRevisionDate(revision.createdAt)}</time>
                            </span>
                            {revision.changeNote && <span className="library-version-entry-note">{revision.changeNote}</span>}
                          </span>
                        </button>
                      })}
                    </div>
                  </div>
                </div>
                <footer className="library-detail-actions">
                  <button className="library-detail-delete" onClick={() => void deleteResource()} title="删除资源">
                    <Icon name="trash" size={14} />删除资源
                  </button>
                  <button className="library-primary" onClick={() => setFormOpen(true)}>
                    <Icon name="edit" size={14} />
                    {detail.selectedRevisionId === detail.latestRevisionId
                      ? '编辑资源'
                      : `以 ${libraryVersionLabel(detail.selectedRevisionNumber)} 为基础新建版本`}
                  </button>
                </footer>
              </>
            )}
          </aside>
        </div>
      )}

      {formOpen && <LibraryResourceForm categories={categories} detail={selectedId ? detail ?? undefined : undefined} onCancel={() => setFormOpen(false)} onSave={saveResource} />}
      {categoryEditor && <LibraryCategoryEditor initial={categoryEditor.initial} onClose={() => setCategoryEditor(null)} onSaved={(category) => {
        setCategoryEditor(null)
        setCategories((current) => [...current.filter((item) => item.id !== category.id), category].sort((a, b) => a.name.localeCompare(b.name)))
        useToastStore.getState().show(`分类「${category.name}」已保存`)
      }} />}
    </div>
  )
}
