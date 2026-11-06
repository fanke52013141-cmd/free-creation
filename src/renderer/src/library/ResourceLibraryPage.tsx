import { GenerationLoadingOverlay } from '../canvas/GenerationLoadingOverlay'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LibraryPreset, LibraryResourceDetail, LibraryResourceSummary, CreateLibraryResourceInput, PublishLibraryRevisionInput } from '@shared/library/types'
import type { LibraryCategory } from '@shared/library/blueprint'
import { Icon } from '../components/Icon'
import { mediaUrl } from '../nodes/registry'
import { useConfirmStore } from '../stores/confirm'
import { useToastStore } from '../stores/toast'
import { LibraryResourceForm } from './LibraryResourceForm'
import { LibraryCategoryEditor } from './LibraryCategoryEditor'
import { libraryValueTypeLabel } from './value-type-labels'
import './library.css'

function typeName(preset: LibraryPreset, categoryName?: string): string {
  if (categoryName) return categoryName
  if (preset === 'image') return '图片资产'
  if (preset === 'prompt') return '文本资产'
  return '组合资产'
}

type Point = [number, number]

/**
 * 资源卡片默认封面：等距立体魔方（按 Stitch 参考稿 assets/243d105b 落地）。
 * 30° 真等距、h=s 正立方体比例、青灰单色三面明暗与 3×3 细线分格，无渐变/光晕。
 */
function CubeCover(): React.JSX.Element {
  const s = 40
  const cx = 60
  const cy = 52
  const dx = 0.866 * s
  const dy = 0.5 * s
  const top: Point = [cx, cy - s]
  const topLeft: Point = [cx - dx, cy - dy]
  const topRight: Point = [cx + dx, cy - dy]
  const center: Point = [cx, cy]
  const bottomLeft: Point = [cx - dx, cy - dy + s]
  const bottomRight: Point = [cx + dx, cy - dy + s]
  const bottom: Point = [cx, cy + s]
  const lerp = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  const polygon = (points: Point[]): string => points.map((point) => point.join(',')).join(' ')
  const faceGrid = (p0: Point, p1: Point, p2: Point, p3: Point): React.JSX.Element[] => {
    const lines: React.JSX.Element[] = []
    for (const t of [1 / 3, 2 / 3]) {
      const a = lerp(p0, p3, t)
      const b = lerp(p1, p2, t)
      lines.push(<line key={`u${t}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />)
      const c = lerp(p0, p1, t)
      const d = lerp(p3, p2, t)
      lines.push(<line key={`v${t}`} x1={c[0]} y1={c[1]} x2={d[0]} y2={d[1]} />)
    }
    return lines
  }
  return (
    <span className="library-cover-cube" aria-hidden="true">
      <svg viewBox="0 0 120 120" role="presentation">
        <polygon className="cube-face cube-top" points={polygon([top, topLeft, center, topRight])} />
        <polygon className="cube-face cube-left" points={polygon([topLeft, center, bottom, bottomLeft])} />
        <polygon className="cube-face cube-right" points={polygon([topRight, center, bottom, bottomRight])} />
        <g className="cube-grid">
          {faceGrid(top, topRight, center, topLeft)}
          {faceGrid(topLeft, center, bottom, bottomLeft)}
          {faceGrid(topRight, center, bottom, bottomRight)}
        </g>
        <path
          className="cube-highlight"
          d={`M ${top[0]} ${top[1]} L ${topLeft[0]} ${topLeft[1]} L ${center[0]} ${center[1]} L ${topRight[0]} ${topRight[1]}`}
        />
        <circle className="cube-vertex" cx={top[0]} cy={top[1]} r={1.4} />
      </svg>
    </span>
  )
}

function ResourceCard({ resource, onOpen, onDragStart }: { resource: LibraryResourceSummary; onOpen: () => void; onDragStart?: React.DragEventHandler<HTMLButtonElement> }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  return (
    <button className="library-resource-card" draggable={Boolean(onDragStart)} onDragStart={onDragStart} onClick={onOpen}>
      <div className="library-resource-cover">
        {resource.coverPath && !failed ? (
          <img src={mediaUrl(resource.coverPath)} alt="" loading="lazy" onError={() => setFailed(true)} />
        ) : (
          <CubeCover />
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
  const [categories, setCategories] = useState<LibraryCategory[]>([])
  const [categoryId, setCategoryId] = useState('legacy')
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
  const searchInputRef = useRef<HTMLInputElement>(null)
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
    const categoryResult = await window.api.listLibraryCategories()
    if (categoryResult.ok) setCategories(categoryResult.data)
  }, [])

  const loadResources = useCallback(async (cursor?: string, append = false): Promise<void> => {
    const result = await window.api.searchLibrary({ query, categoryId: categoryId || undefined, cursor, limit: 48 })
    if (!result.ok) {
      useToastStore.getState().show(`资源库读取失败：${result.error.message}`)
      return
    }
    const items = result.data.items.filter((item) => !item.archivedAt)
    setResources((current) => append ? [...current, ...items] : items)
    setNextCursor(result.data.nextCursor)
  }, [categoryId, query])

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

  const copyText = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      useToastStore.getState().show('文本已复制')
    } catch {
      useToastStore.getState().show('无法访问剪贴板，请手动选择文本复制')
    }
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
          {/* 2026-11-06 用户反馈：进入资源库后找不到返回入口——在系统窗口按钮左侧再放一个固定返回图标。 */}
          <button type="button" className="library-home-btn" title="返回项目列表" aria-label="返回项目列表" onClick={onBack}>
            <Icon name="home" size={16} />
          </button>
        </div>
      </header>

      <nav className="library-filter-row" aria-label="资源分类">
        <div className="library-category-tabs">
          <button className={!categoryId ? 'active' : ''} onClick={() => setCategoryId('')}>全部</button>
          <button className={categoryId === 'legacy' ? 'active' : ''} onClick={() => setCategoryId('legacy')}>未分类</button>
          {categories.map((category) => (
            <button
              key={category.id}
              className={categoryId === category.id ? 'active' : ''}
              onClick={() => setCategoryId(category.id)}
              title={`浏览分类：${category.name}`}
            >
              {category.name}
            </button>
          ))}
        </div>
        <span className="library-result-count">共 {resources.length} 项</span>
        <button className="library-new-category-btn" onClick={() => setCategoryEditor({})} title="新建分类">
          <Icon name="add" size={13} />新建分类
        </button>
        <div className="library-category-manage">
          <button
            className="library-category-manage-btn"
            onClick={() => setCategoryMenuOpen((current) => !current)}
            aria-haspopup="menu"
            aria-expanded={categoryMenuOpen}
            title="编辑分类"
          >
            <Icon name="settings" size={14} />编辑分类
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
                <h2>{query.trim() ? '没有找到匹配的资源' : activeCategoryName ? `「${activeCategoryName}」分类下暂无资源` : '资源库还没有内容'}</h2>
                <p>{query.trim() ? '试试其他关键词，或清除搜索条件。' : '可点击下方快速创建资源，或从顶部导入已有资产包。'}</p>
                <div className="library-empty-actions"><button className="library-primary" onClick={() => { setSelectedId(null); setFormOpen(true) }}><span className="library-primary-icon"><Icon name="add" size={14} /></span>新建资源</button><button className="library-secondary" onClick={() => setCategoryEditor({})}>管理分类</button></div>
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
                    </div>
                    <h2>{detail.selectedTitle}</h2>
                    <p>{detail.selectedDescription || '暂无说明'}</p>
                    <div className="library-detail-tags">{detail.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
                  </div>
                  <div className="library-detail-section">
                    <div className="library-detail-section-title"><h3>资源内容</h3></div>
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
                        return <button type="button" aria-pressed={selected} key={revision.id} className={`library-version-entry${selected ? ' selected' : ''}`} onClick={() => { setCompareRevisionSelection(''); setSelectedRevisionId(revision.id) }}>
                          <span className="library-version-entry-marker" />
                          <span className="library-version-entry-body">
                            <span className="library-version-entry-title">
                              <strong>v{revision.revisionNumber}</strong>
                              <i className="library-version-date">{new Date(revision.createdAt).toLocaleDateString()}</i>
                            </span>
                            {revision.changeNote && <span className="library-version-entry-note">{revision.changeNote}</span>}
                          </span>
                        </button>
                      })}
                    </div>
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
                </div>
                <footer className="library-detail-actions">
                  <button className="library-detail-delete" onClick={() => void deleteResource()} title="删除资源">
                    <Icon name="trash" size={14} />删除资源
                  </button>
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
