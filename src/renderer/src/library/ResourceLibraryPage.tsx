import { GenerationLoadingOverlay } from '../canvas/GenerationLoadingOverlay'
import { useResourceInsertRequest } from './insertRequestStore'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LibraryPreset, LibraryResourceDetail, LibraryResourceSummary, CreateLibraryResourceInput, PublishLibraryRevisionInput } from '@shared/library/types'
import type { LibraryCategory } from '@shared/library/blueprint'
import type { ProjectMeta } from '@shared/types'
import { Icon } from '../components/Icon'
import { mediaUrl } from '../nodes/registry'
import { useAppStore } from '../stores/app'
import { useToastStore } from '../stores/toast'
import { LibraryResourceForm } from './LibraryResourceForm'
import { LibraryCategoryEditor } from './LibraryCategoryEditor'
import './library.css'

function typeName(preset: LibraryPreset, categoryName?: string): string {
  if (categoryName) return categoryName
  if (preset === 'image') return '图片资产'
  if (preset === 'prompt') return '文本资产'
  return '组合资产'
}

function ResourceCard({ resource, onOpen, onDragStart }: { resource: LibraryResourceSummary; onOpen: () => void; onDragStart?: React.DragEventHandler<HTMLButtonElement> }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  return (
    <button className="library-resource-card" draggable={Boolean(onDragStart)} onDragStart={onDragStart} onClick={onOpen}>
      <div className="library-resource-cover">
        {resource.coverPath && !failed ? (
          <img src={mediaUrl(resource.coverPath)} alt="" loading="lazy" onError={() => setFailed(true)} />
        ) : (
          <span className="library-resource-placeholder"><Icon name={resource.formPreset === 'image' || resource.formPreset === 'style' ? 'image' : 'assets'} size={27} /></span>
        )}
        <span className="library-resource-type">{typeName(resource.formPreset, resource.category?.name)}</span>
      </div>
      <div className="library-resource-card-body">
        <div className="library-resource-card-title"><strong>{resource.title}</strong><span>v{resource.revisionNumber}</span></div>
        <p>{resource.description || (resource.formPreset === 'prompt' ? '提示词资源' : '暂无说明')}</p>
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
    return <article className="library-component-preview"><div className="library-component-preview-head"><strong>{component.role}</strong><span>提示词配方</span></div><RecipePreview component={component} onCopy={onCopy} /></article>
  }
  return (
    <article className="library-component-preview">
      <div className="library-component-preview-head"><strong>{component.role}</strong><span>{component.valueType}</span></div>
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

type ComponentComparison = {
  key: string
  role: string
  current?: LibraryResourceDetail['components'][number]
  compared?: LibraryResourceDetail['components'][number]
  status: 'added' | 'removed' | 'changed' | 'same'
}

function componentMap(components: LibraryResourceDetail['components']): Map<string, LibraryResourceDetail['components'][number]> {
  const occurrences = new Map<string, number>()
  return new Map(components.map((component) => {
    const occurrence = occurrences.get(component.role) ?? 0
    occurrences.set(component.role, occurrence + 1)
    return [`${component.role}#${occurrence}`, component] as const
  }))
}

function compareComponents(
  current: LibraryResourceDetail['components'],
  compared: LibraryResourceDetail['components']
): ComponentComparison[] {
  const currentMap = componentMap(current)
  const comparedMap = componentMap(compared)
  return [...new Set([...currentMap.keys(), ...comparedMap.keys()])].map((key) => {
    const currentComponent = currentMap.get(key)
    const comparedComponent = comparedMap.get(key)
    const equal = Boolean(currentComponent && comparedComponent &&
      currentComponent.valueType === comparedComponent.valueType &&
      (currentComponent.text !== undefined || comparedComponent.text !== undefined
        ? currentComponent.text === comparedComponent.text
        : Boolean(currentComponent.contentHash && comparedComponent.contentHash && currentComponent.contentHash === comparedComponent.contentHash)))
    const status: ComponentComparison['status'] = !currentComponent
      ? 'removed'
      : !comparedComponent
        ? 'added'
        : equal ? 'same' : 'changed'
    return {
      key,
      role: currentComponent?.role ?? comparedComponent?.role ?? '组件',
      ...(currentComponent ? { current: currentComponent } : {}),
      ...(comparedComponent ? { compared: comparedComponent } : {}),
      status
    }
  })
}

function comparisonValue(component: LibraryResourceDetail['components'][number] | undefined): string {
  if (!component) return '此版本没有这个组件'
  if (component.text !== undefined) return component.text || '（空内容）'
  return [component.fileName ?? '资源文件', component.mime, component.sizeBytes ? `${component.sizeBytes} 字节` : undefined]
    .filter(Boolean).join(' · ')
}

export function ResourceLibraryPage({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [resources, setResources] = useState<LibraryResourceSummary[]>([])
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [categories, setCategories] = useState<LibraryCategory[]>([])
  const [categoryId, setCategoryId] = useState('legacy')
  const [showArchived, setShowArchived] = useState(false)
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false)
  const [categoryEditor, setCategoryEditor] = useState<{ initial?: LibraryCategory } | null>(null)
  const [query, setQuery] = useState('')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | undefined>()
  const [detail, setDetail] = useState<LibraryResourceDetail | null>(null)
  const [compareRevisionSelection, setCompareRevisionSelection] = useState('')
  const [compareDetail, setCompareDetail] = useState<LibraryResourceDetail | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [targetProjectId, setTargetProjectId] = useState('')
  const [selectedComponents, setSelectedComponents] = useState<Set<string>>(new Set())
  const searchInputRef = useRef<HTMLInputElement>(null)
  const openProject = useAppStore((state) => state.openProject)
  const activeCategoryName = categoryId === 'legacy'
    ? '未分类'
    : categories.find((category) => category.id === categoryId)?.name
  const activeRevisionId = selectedRevisionId ?? (detail?.id === selectedId ? detail.selectedRevisionId : undefined)
  const availableCompareRevisionId = detail?.id === selectedId
    ? detail.revisions.find((revision) => revision.id !== activeRevisionId)?.id ?? ''
    : ''
  const compareRevisionId = detail?.id === selectedId
    && compareRevisionSelection !== activeRevisionId
    && detail.revisions.some((revision) => revision.id === compareRevisionSelection)
    ? compareRevisionSelection
    : availableCompareRevisionId
  const detailLoading = Boolean(selectedId) && (!detail || detail.id !== selectedId || detail.selectedRevisionId !== selectedRevisionId)
  const currentCompareDetail = detail && compareDetail?.id === detail.id && compareDetail.selectedRevisionId === compareRevisionId
    ? compareDetail
    : null
  const loadPageData = useCallback(async (): Promise<void> => {
    const [projectResult, categoryResult] = await Promise.all([
      window.api.listProjects(),
      window.api.listLibraryCategories()
    ])
    if (projectResult.ok) {
      setProjects(projectResult.data)
      setTargetProjectId((current) => current || projectResult.data[0]?.id || '')
    }
    if (categoryResult.ok) setCategories(categoryResult.data)
  }, [])

  const loadResources = useCallback(async (cursor?: string, append = false): Promise<void> => {
    // 2026-11-06：归档资源默认不出现在列表；「已归档」视图通过 includeArchived 取回后再过滤，
    // 这样用户能明确知道归档去哪了、并可在同一处恢复。
    const result = await window.api.searchLibrary({
      query,
      categoryId: showArchived ? undefined : categoryId || undefined,
      includeArchived: showArchived,
      cursor,
      limit: 48
    })
    if (!result.ok) {
      useToastStore.getState().show(`资源库读取失败：${result.error.message}`)
      return
    }
    const items = result.data.items.filter((item) => (showArchived ? Boolean(item.archivedAt) : !item.archivedAt))
    setResources((current) => append ? [...current, ...items] : items)
    setNextCursor(result.data.nextCursor)
  }, [categoryId, query, showArchived])

  useEffect(() => {
    if (!categoryMenuOpen) return undefined
    const close = (event: PointerEvent): void => {
      if (!(event.target instanceof Element) || !event.target.closest('.library-category-manage')) {
        setCategoryMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [categoryMenuOpen])

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
        setSelectedComponents(new Set(result.data?.components.map((component) => component.id) ?? []))
      } else {
        useToastStore.getState().show(`读取资源详情失败：${result.error.message}`)
      }
    })
    return () => { cancelled = true }
  }, [selectedId, selectedRevisionId])

  useEffect(() => {
    const activeRevision = selectedRevisionId ?? (detail?.id === selectedId ? detail.selectedRevisionId : undefined)
    if (!selectedId || !compareRevisionId || compareRevisionId === activeRevision) return
    let cancelled = false
    void window.api.getLibraryResource({ resourceId: selectedId, revisionId: compareRevisionId }).then((result) => {
      if (cancelled) return
      setCompareDetail(result.ok ? result.data : null)
    })
    return () => { cancelled = true }
  }, [selectedId, selectedRevisionId, compareRevisionId, detail?.id, detail?.selectedRevisionId])

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
    useToastStore.getState().show(isRevision ? `已发布「${result.data.title}」v${result.data.revisionNumber}` : `已保存资源「${result.data.title}」`)
  }

  const archive = async (archived: boolean): Promise<void> => {
    if (!detail) return
    const result = await window.api.archiveLibraryResource({ resourceId: detail.id, archived })
    if (!result.ok) return useToastStore.getState().show(`更新资源失败：${result.error.message}`)
    setDetail(null)
    setSelectedId(null)
    await loadResources()
    useToastStore.getState().show(archived ? '资源已移入归档，可在「已归档」中恢复' : '资源已恢复')
  }

  const copyText = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      useToastStore.getState().show('文本已复制')
    } catch {
      useToastStore.getState().show('无法访问剪贴板，请手动选择文本复制')
    }
  }

  const materialize = async (): Promise<void> => {
    if (!detail || !targetProjectId || selectedComponents.size === 0) return
    const project = projects.find((item) => item.id === targetProjectId)
    if (!project) return
    useResourceInsertRequest.getState().set({ projectId: project.id, resourceId: detail.id,
      revisionId: detail.selectedRevisionId, componentIds: [...selectedComponents] })
    openProject(project)
  }

  const exportLibrary = async (): Promise<void> => {
    const result = await window.api.exportLibrary({})
    if (!result.ok) {
      if (result.error.code !== 'CANCELLED') useToastStore.getState().show(`导出失败：${result.error.message}`)
      return
    }
    useToastStore.getState().show(`资产包已导出到 ${result.data.path}`)
  }

  const importLibrary = async (): Promise<void> => {
    const result = await window.api.importLibrary()
    if (!result.ok) {
      if (result.error.code !== 'CANCELLED') useToastStore.getState().show(`导入失败：${result.error.message}`)
      return
    }
    await loadResources()
    await loadPageData()
    useToastStore.getState().show(`已导入 ${result.data.imported} 份资源`)
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
          <button className="library-back" onClick={onBack} title="返回（Esc）"><Icon name="home" size={15} />返回</button>
          <span className="library-header-divider" aria-hidden="true" />
          <span className="library-header-label"><Icon name="assets" size={15} />资源库</span>
        </div>
        <div className="library-page-actions">
          <label className="library-search library-header-search"><Icon name="search" size={15} /><input ref={searchInputRef} aria-label="搜索资源" value={query} placeholder="搜索资源" onChange={(event) => setQuery(event.currentTarget.value)} /></label>
          <div className="library-tool-group" role="group" aria-label="资源库工具">
            <button type="button" className="library-tool-btn" title="导入资产包" aria-label="导入资产包" onClick={() => void importLibrary()}><Icon name="upload" size={16} /></button>
            <button type="button" className="library-tool-btn" title="导出资产包" aria-label="导出资产包" onClick={() => void exportLibrary()}><Icon name="download" size={16} /></button>
            <button type="button" className="library-tool-btn" title="新建分类" aria-label="新建分类" onClick={() => setCategoryEditor({})}><Icon name="layers" size={16} /></button>
          </div>
          <button className="library-primary" onClick={() => { setSelectedId(null); setFormOpen(true) }}><span className="library-primary-icon"><Icon name="add" size={14} /></span>新建资源</button>
        </div>
      </header>

      <nav className="library-filter-row" aria-label="资源分类">
        <div className="library-category-tabs">
          <button className={!showArchived && !categoryId ? 'active' : ''} onClick={() => { setShowArchived(false); setCategoryId('') }}>全部</button>
          <button className={!showArchived && categoryId === 'legacy' ? 'active' : ''} onClick={() => { setShowArchived(false); setCategoryId('legacy') }}>未分类</button>
          {categories.map((category) => (
            <button
              key={category.id}
              className={!showArchived && categoryId === category.id ? 'active' : ''}
              onClick={() => { setShowArchived(false); setCategoryId(category.id) }}
              title={`浏览分类：${category.name}`}
            >
              {category.name}
            </button>
          ))}
        </div>
        <span className="library-result-count">共 {resources.length} 项</span>
        <button
          className={`library-archive-tab${showArchived ? ' active' : ''}`}
          onClick={() => setShowArchived((current) => !current)}
          title="查看已归档资源"
        >
          <Icon name="history" size={14} />已归档
        </button>
        <div className="library-category-manage">
          <button
            className="library-category-manage-btn"
            onClick={() => setCategoryMenuOpen((current) => !current)}
            aria-haspopup="menu"
            aria-expanded={categoryMenuOpen}
            title="管理分类"
          >
            <Icon name="settings" size={14} />管理分类
          </button>
          {categoryMenuOpen && (
            <div className="library-category-menu" role="menu" aria-label="分类管理">
              {categories.map((category) => (
                <button
                  key={category.id}
                  role="menuitem"
                  onClick={() => {
                    setCategoryMenuOpen(false)
                    setCategoryEditor({ initial: category })
                  }}
                >
                  <Icon name="edit" size={12} />
                  <span>{category.name}</span>
                </button>
              ))}
              <button
                role="menuitem"
                onClick={() => {
                  setCategoryMenuOpen(false)
                  setCategoryEditor({})
                }}
              >
                <Icon name="add" size={12} />
                <span>新建分类</span>
              </button>
            </div>
          )}
        </div>
      </nav>

      <div className="library-workspace">
          <main className="library-resource-browser">
            {resources.length ? (
              <div className="library-resource-grid">
                {resources.map((resource) => <ResourceCard key={resource.id} resource={resource} onOpen={() => { setSelectedId(resource.id); setSelectedRevisionId(resource.latestRevisionId) }} onDragStart={(event) => event.dataTransfer.setData('application/x-canvas-library-resource', resource.id)} />)}
              </div>
            ) : (
              <div className="library-empty-state">
                <div className="library-empty-art" aria-hidden="true"><span className="library-empty-icon"><Icon name="assets" size={32} /></span></div>
                <h2>{query.trim() ? '没有找到匹配的资源' : showArchived ? '没有已归档的资源' : activeCategoryName ? `「${activeCategoryName}」分类下暂无资源` : '资源库还没有内容'}</h2>
                <p>{query.trim() ? '试试其他关键词，或清除搜索条件。' : showArchived ? '资源归档后会出现在这里，可随时恢复。' : '可点击下方快速创建资源，或从顶部导入已有资产包。'}</p>
                {!showArchived && (
                  <div className="library-empty-actions"><button className="library-primary" onClick={() => { setSelectedId(null); setFormOpen(true) }}><span className="library-primary-icon"><Icon name="add" size={14} /></span>新建资源</button><button className="library-secondary" onClick={() => setCategoryEditor({})}>管理分类</button></div>
                )}
              </div>
            )}
            {nextCursor && <button className="library-load-more" onClick={() => void loadResources(nextCursor, true)}>加载更多</button>}
          </main>
        </div>
      {selectedId && (
        <div className="library-detail-mask" onMouseDown={(event) => event.target === event.currentTarget && setSelectedId(null)}>
          <aside className="library-detail-panel" role="dialog" aria-modal="true" aria-label="资源详情">
            <header className="library-detail-header">
              <span className="library-detail-header-title">资源详情</span>
              <button className="library-icon-button" aria-label="关闭详情" onClick={() => setSelectedId(null)}><Icon name="close" size={17} /></button>
            </header>
            {detailLoading || !detail ? <GenerationLoadingOverlay title="正在读取资源" compact /> : (
              <>
                <div className="library-detail-scroll">
                  <div className="library-detail-title">
                    <div className="library-detail-badges">
                      <span className="library-resource-type">{typeName(detail.formPreset, detail.category?.name)}</span>
                      <span className="library-version-badge">v{detail.selectedRevisionNumber}</span>
                      {detail.archivedAt && <span className="library-archived-badge">已归档</span>}
                    </div>
                    <h2>{detail.selectedTitle}</h2>
                    <p className="library-detail-meta">更新于 {new Date(detail.updatedAt).toLocaleDateString()} · {detail.componentCount} 个组件</p>
                    <p>{detail.selectedDescription || '暂无说明'}</p>
                    <div className="library-detail-tags">{detail.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
                  </div>
                  <div className="library-detail-section">
                    <div className="library-detail-section-title"><h3>资源内容</h3><span>选择要复用的组件</span></div>
                    {detail.components.map((component) => (
                      <div className="library-detail-component-row" key={component.id}>
                        <label><input type="checkbox" checked={selectedComponents.has(component.id)} onChange={() => setSelectedComponents((current) => {
                          const next = new Set(current)
                          if (next.has(component.id)) next.delete(component.id)
                          else next.add(component.id)
                          return next
                        })} /><span>{component.role}</span></label>
                        <ComponentPreview component={component} onCopy={(text) => void copyText(text)} />
                      </div>
                    ))}
                  </div>
                  <div className="library-detail-section">
                    <div className="library-detail-section-title"><h3>资源版本记录</h3><span>{detail.revisions.length} 次迭代</span></div>
                    <div className="library-version-history" role="group" aria-label="资源版本历史">
                      {detail.revisions.map((revision) => {
                        const selected = revision.id === detail.selectedRevisionId
                        const latest = revision.id === detail.latestRevisionId
                        return <button type="button" aria-pressed={selected} key={revision.id} className={`library-version-entry${selected ? ' selected' : ''}`} onClick={() => { setCompareRevisionSelection(''); setSelectedRevisionId(revision.id) }}>
                          <span className="library-version-entry-marker" />
                          <span className="library-version-entry-body"><span className="library-version-entry-title"><strong>v{revision.revisionNumber} · {revision.title}</strong>{latest && <i>最新</i>}{selected && <i className="selected-tag">查看中</i>}</span>
                            <small>{new Date(revision.createdAt).toLocaleString()} · {revision.componentCount} 个组件</small>
                            <span className="library-version-entry-note">{revision.changeNote || '未填写版本说明'}</span>
                          </span>
                        </button>
                      })}
                    </div>
                    {detail.selectedRevisionId !== detail.latestRevisionId && <p className="library-old-version-hint">正在查看历史版本；右下角「以 v{detail.selectedRevisionNumber} 为基础新建版本」会复制该版本内容并保存为新的最新版本。</p>}
                    {detail.revisions.length > 1 && (
                      <details className="library-version-compare">
                        <summary>比较两个版本</summary>
                        <label>对比版本
                          <select value={compareRevisionId} onChange={(event) => setCompareRevisionSelection(event.currentTarget.value)}>
                            <option value="">选择另一个版本</option>
                            {detail.revisions.filter((revision) => revision.id !== detail.selectedRevisionId).map((revision) => (
                              <option key={revision.id} value={revision.id}>v{revision.revisionNumber} · {revision.changeNote || new Date(revision.createdAt).toLocaleDateString()}</option>
                            ))}
                          </select>
                        </label>
                        {currentCompareDetail && (
                          <div className="library-version-compare-body">
                            <div className="library-version-compare-heading">
                              <span>v{detail.selectedRevisionNumber}（当前选择）</span>
                              <span>v{currentCompareDetail.selectedRevisionNumber}（对比）</span>
                            </div>
                            {compareComponents(detail.components, currentCompareDetail.components).map((row) => (
                              <article key={row.key} className={`library-version-compare-row ${row.status}`}>
                                <strong>{row.role}</strong>
                                <div><pre>{comparisonValue(row.current)}</pre><pre>{comparisonValue(row.compared)}</pre></div>
                                <small>{row.status === 'same' ? '相同' : row.status === 'added' ? '所选版本新增' : row.status === 'removed' ? '所选版本已移除' : '内容已改变'}</small>
                              </article>
                            ))}
                          </div>
                        )}
                      </details>
                    )}
                  </div>
                  <div className="library-detail-section">
                    <div className="library-detail-section-title"><h3>放入项目</h3><span>素材复制到项目并保留版本来源</span></div>
                    <div className="library-use-row">
                      <select value={targetProjectId} onChange={(event) => setTargetProjectId(event.currentTarget.value)}>
                        <option value="">选择项目…</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                      </select>
                      <button disabled={!targetProjectId || selectedComponents.size === 0} onClick={() => void materialize()}>打开画布并创建节点</button>
                    </div>
                    <p className="library-use-hint">打开目标项目后预览节点名称、填写配方变量，再将所选内容一次加入画布。</p>
                  </div>
                </div>
                <footer className="library-detail-actions">
                  <button className="library-detail-archive" onClick={() => void archive(!detail.archivedAt)}>
                    {detail.archivedAt ? '恢复资源' : '移入归档'}
                  </button>
                  <span className="library-detail-archive-hint">
                    {detail.archivedAt ? '恢复后重新回到资源列表。' : '归档后可在「已归档」恢复。'}
                  </span>
                  <button className="library-primary" onClick={() => setFormOpen(true)}>
                    <Icon name="edit" size={14} />
                    {detail.selectedRevisionId === detail.latestRevisionId
                      ? '编辑资源'
                      : `以 v${detail.selectedRevisionNumber} 为基础新建版本`}
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
