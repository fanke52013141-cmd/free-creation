import { useResourceInsertRequest } from './insertRequestStore'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LibraryFolder, LibraryPreset, LibraryResourceDetail, LibraryResourceSummary, LibraryBoard, LibraryBoardItem, CreateLibraryResourceInput, PublishLibraryRevisionInput } from '@shared/library/types'
import type { LibraryCategory } from '@shared/library/blueprint'
import type { ProjectMeta } from '@shared/types'
import { Icon } from '../components/Icon'
import { mediaUrl } from '../nodes/registry'
import { useAppStore } from '../stores/app'
import { useToastStore } from '../stores/toast'
import { LibraryResourceForm } from './LibraryResourceForm'
import { LibraryCategoryEditor } from './LibraryCategoryEditor'
import { useConfirmStore } from '../stores/confirm'
import './library.css'

function typeName(preset: LibraryPreset, categoryName?: string): string {
  if (categoryName) return categoryName
  if (preset === 'image') return '图片资产'
  if (preset === 'prompt') return '文本资产'
  return '组合资产'
}

function initialExpandedFolders(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('canvas.library.expanded-folders') ?? '[]')
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

function folderPathOptions(folders: LibraryFolder[]): Array<{ id: string; label: string }> {
  const children = new Map<string | null, LibraryFolder[]>()
  for (const folder of folders) children.set(folder.parentId, [...(children.get(folder.parentId) ?? []), folder])
  const result: Array<{ id: string; label: string }> = []
  const visit = (parentId: string | null, path: string, ancestors: Set<string>): void => {
    for (const folder of children.get(parentId) ?? []) {
      if (ancestors.has(folder.id)) continue
      const nextPath = path ? `${path} / ${folder.name}` : folder.name
      result.push({ id: folder.id, label: nextPath })
      visit(folder.id, nextPath, new Set(ancestors).add(folder.id))
    }
  }
  visit(null, '', new Set())
  return result
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
        <div className="library-resource-card-meta">
          <span>{resource.componentCount} 个组件</span>
          {resource.tags.slice(0, 2).map((tag) => <i key={tag}>{tag}</i>)}
        </div>
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
  const [categoryId, setCategoryId] = useState('')
  const [categoryEditor, setCategoryEditor] = useState<{ initial?: LibraryCategory } | null>(null)
  const [query, setQuery] = useState('')
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const [folderId, setFolderId] = useState('')
  const [folderDraft, setFolderDraft] = useState('')
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(initialExpandedFolders)
  const [folderDraftParentId, setFolderDraftParentId] = useState<string | null | undefined>()
  const [folderActionId, setFolderActionId] = useState<string | null>(null)
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [folderRenameDraft, setFolderRenameDraft] = useState('')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | undefined>()
  const [detail, setDetail] = useState<LibraryResourceDetail | null>(null)
  const [compareRevisionSelection, setCompareRevisionSelection] = useState('')
  const [compareDetail, setCompareDetail] = useState<LibraryResourceDetail | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [targetProjectId, setTargetProjectId] = useState('')
  const [selectedComponents, setSelectedComponents] = useState<Set<string>>(new Set())
  const [view, setView] = useState<'resources' | 'boards'>('resources')
  const [boards, setBoards] = useState<LibraryBoard[]>([])
  const [boardId, setBoardId] = useState('')
  const [boardItems, setBoardItems] = useState<LibraryBoardItem[]>([])
  const [boardDetails, setBoardDetails] = useState<Record<string, LibraryResourceDetail>>({})
  const [loadedBoardId, setLoadedBoardId] = useState('')
  const [boardName, setBoardName] = useState('')
  const boardCanvasRef = useRef<HTMLDivElement>(null)
  const openProject = useAppStore((state) => state.openProject)
  const currentBoardItems = loadedBoardId === boardId ? boardItems : []
  const currentBoardDetails = loadedBoardId === boardId ? boardDetails : {}
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
  const folderOptions = useMemo(() => folderPathOptions(folders), [folders])

  const loadPageData = useCallback(async (): Promise<void> => {
    const [projectResult, boardResult, folderResult, categoryResult] = await Promise.all([
      window.api.listProjects(),
      window.api.listLibraryBoards(),
      window.api.listLibraryFolders(),
      window.api.listLibraryCategories()
    ])
    if (projectResult.ok) {
      setProjects(projectResult.data)
      setTargetProjectId((current) => current || projectResult.data[0]?.id || '')
    }
    if (boardResult.ok) {
      setBoards(boardResult.data)
      setBoardId((current) => current || boardResult.data[0]?.id || '')
    }
    if (folderResult.ok) setFolders(folderResult.data)
    if (categoryResult.ok) setCategories(categoryResult.data)
  }, [])

  const loadResources = useCallback(async (cursor?: string, append = false): Promise<void> => {
    const result = await window.api.searchLibrary({ query, folderId: folderId || undefined, categoryId: categoryId || undefined, cursor, limit: 48 })
    if (!result.ok) {
      useToastStore.getState().show(`资源库读取失败：${result.error.message}`)
      return
    }
    setResources((current) => append ? [...current, ...result.data.items] : result.data.items)
    setNextCursor(result.data.nextCursor)
  }, [categoryId, folderId, query])

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadPageData() }, 0)
    return () => window.clearTimeout(timer)
  }, [loadPageData])
  useEffect(() => {
    const timer = window.setTimeout(() => { void loadResources() }, 180)
    return () => window.clearTimeout(timer)
  }, [loadResources])

  useEffect(() => {
    try { localStorage.setItem('canvas.library.expanded-folders', JSON.stringify([...expandedFolders])) } catch { /* optional UI preference */ }
  }, [expandedFolders])

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

  useEffect(() => {
    if (!boardId) return
    let cancelled = false
    void (async () => {
      const result = await window.api.getLibraryBoardItems(boardId)
      if (!result.ok || cancelled) return
      setBoardItems(result.data)
      const pairs = await Promise.all(result.data.map(async (item) => {
        const resource = await window.api.getLibraryResource({ resourceId: item.resourceId, revisionId: item.revisionId })
        return [`${item.resourceId}:${item.revisionId}`, resource.ok && resource.data ? resource.data : null] as const
      }))
      const details: Record<string, LibraryResourceDetail> = {}
      for (const [key, detail] of pairs) {
        if (detail) details[key] = detail
      }
      if (!cancelled) {
        setBoardDetails(details)
        setLoadedBoardId(boardId)
      }
    })()
    return () => { cancelled = true }
  }, [boardId])

  const saveResource = async (input: CreateLibraryResourceInput | PublishLibraryRevisionInput): Promise<void> => {
    const isRevision = 'resourceId' in input
    const result = isRevision
      ? await window.api.publishLibraryRevision(input as PublishLibraryRevisionInput)
      : await window.api.createLibraryResource({ ...input, ...(folderId && folderId !== 'root' ? { folderId } : {}) })
    if (!result.ok) throw new Error(result.error.message)
    setFormOpen(false)
    setSelectedId(result.data.id)
    setSelectedRevisionId(result.data.latestRevisionId)
    await loadResources()
    await loadPageData()
    useToastStore.getState().show(isRevision ? `已发布「${result.data.title}」v${result.data.revisionNumber}` : `已保存资源「${result.data.title}」`)
  }

  const createFolder = async (): Promise<void> => {
    if (!folderDraft.trim() || folderDraftParentId === undefined) return
    const parentId = folderDraftParentId
    const result = await window.api.createLibraryFolder({ name: folderDraft.trim(), parentId })
    if (!result.ok) return useToastStore.getState().show(`创建文件夹失败：${result.error.message}`)
    setFolderDraft('')
    setFolderDraftParentId(undefined)
    setFolders((current) => [...current, result.data])
    if (parentId) setExpandedFolders((current) => new Set(current).add(parentId))
    setFolderId(result.data.id)
  }

  const startFolderCreation = (parentId: string | null): void => {
    setFolderDraft('')
    setFolderDraftParentId(parentId)
    setFolderActionId(null)
    if (parentId) {
      setExpandedFolders((current) => new Set(current).add(parentId))
      setFolderId(parentId)
    }
  }

  const cancelFolderCreation = (): void => {
    setFolderDraft('')
    setFolderDraftParentId(undefined)
  }

  const renderFolderCreator = (parentId: string | null, depth: number): React.JSX.Element => (
    <form
      className="library-folder-create"
      style={{ paddingLeft: 10 + depth * 15 }}
      onSubmit={(event) => { event.preventDefault(); void createFolder() }}
    >
      <Icon name="assets" size={13} />
      <input
        autoFocus
        value={folderDraft}
        maxLength={100}
        aria-label={parentId ? '新建子文件夹名称' : '新建文件夹名称'}
        placeholder={parentId ? '输入子文件夹名称' : '输入文件夹名称'}
        onChange={(event) => setFolderDraft(event.currentTarget.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') cancelFolderCreation() }}
      />
      <button type="submit" aria-label="创建文件夹" disabled={!folderDraft.trim()}><Icon name="check" size={12} /></button>
      <button type="button" aria-label="取消创建文件夹" onClick={cancelFolderCreation}><Icon name="close" size={12} /></button>
    </form>
  )

  const renameFolder = async (folder: LibraryFolder): Promise<void> => {
    const name = folderRenameDraft.trim()
    if (!name || name === folder.name) {
      setRenamingFolderId(null)
      return
    }
    const result = await window.api.renameLibraryFolder({ folderId: folder.id, name })
    if (!result.ok) return useToastStore.getState().show(`重命名文件夹失败：${result.error.message}`)
    setFolders((current) => current.map((item) => item.id === folder.id ? result.data : item))
    setRenamingFolderId(null)
    useToastStore.getState().show('文件夹名称已更新')
  }

  const removeFolder = async (folder: LibraryFolder): Promise<void> => {
    const accepted = await useConfirmStore.getState().confirm({
      title: `删除文件夹「${folder.name}」`,
      message: '文件夹中的资源会移到上一级，子文件夹会一起提升一级；资源本身不会删除。',
      confirmText: '删除文件夹',
      danger: true
    })
    if (!accepted) return
    const result = await window.api.deleteLibraryFolder(folder.id)
    if (!result.ok) return useToastStore.getState().show(`删除文件夹失败：${result.error.message}`)
    if (folderDraftParentId === folder.id) setFolderDraftParentId(undefined)
    if (folderId === folder.id) setFolderId(folder.parentId ?? 'root')
    await loadPageData()
  }

  const moveResourceToFolder = async (nextFolderId: string): Promise<void> => {
    if (!detail) return
    const result = await window.api.setLibraryResourceFolder({ resourceId: detail.id, folderId: nextFolderId || null })
    if (!result.ok) return useToastStore.getState().show(`移动资源失败：${result.error.message}`)
    await loadResources()
    const updated = await window.api.getLibraryResource({ resourceId: detail.id, revisionId: detail.selectedRevisionId })
    if (updated.ok && updated.data) setDetail(updated.data)
    useToastStore.getState().show('资源已移到所选文件夹')
  }

  const archive = async (archived: boolean): Promise<void> => {
    if (!detail) return
    const result = await window.api.archiveLibraryResource({ resourceId: detail.id, archived })
    if (!result.ok) return useToastStore.getState().show(`更新资源失败：${result.error.message}`)
    setDetail(null)
    setSelectedId(null)
    await loadResources()
    useToastStore.getState().show(archived ? '资源已归档' : '资源已恢复')
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

  const addToBoard = async (summary: LibraryResourceSummary): Promise<void> => {
    if (!boardId) return useToastStore.getState().show('请先创建或选择一个展板')
    const index = currentBoardItems.length
    const next = [...currentBoardItems, {
      id: crypto.randomUUID(), resourceId: summary.id, revisionId: summary.latestRevisionId,
      x: 24 + (index % 3) * 300, y: 24 + Math.floor(index / 3) * 350,
      width: 270, height: 310, note: '', order: index
    }]
    setBoardItems(next)
    const result = await window.api.saveLibraryBoard({ boardId, items: next })
    if (!result.ok) useToastStore.getState().show(`展板保存失败：${result.error.message}`)
  }

  const dropOnBoard = async (event: React.DragEvent<HTMLDivElement>): Promise<void> => {
    event.preventDefault()
    const resourceId = event.dataTransfer.getData('application/x-canvas-library-resource')
    if (!resourceId || !boardCanvasRef.current || !boardId) return
    const summary = resources.find((resource) => resource.id === resourceId)
    if (!summary || currentBoardItems.some((item) => item.resourceId === resourceId)) return
    const rect = boardCanvasRef.current.getBoundingClientRect()
    const next = [...currentBoardItems, {
      id: crypto.randomUUID(), resourceId, revisionId: summary.latestRevisionId,
      x: Math.max(0, event.clientX - rect.left - 120), y: Math.max(0, event.clientY - rect.top - 60),
      width: 270, height: 310, note: '', order: currentBoardItems.length
    }]
    setBoardItems(next)
    const result = await window.api.saveLibraryBoard({ boardId, items: next })
    if (!result.ok) useToastStore.getState().show(`展板保存失败：${result.error.message}`)
  }

  const moveBoardItem = async (event: React.DragEvent<HTMLElement>, item: LibraryBoardItem): Promise<void> => {
    event.preventDefault()
    if (!boardCanvasRef.current) return
    const rect = boardCanvasRef.current.getBoundingClientRect()
    const next = currentBoardItems.map((current) => current.id === item.id
      ? { ...current, x: Math.max(0, event.clientX - rect.left - 130), y: Math.max(0, event.clientY - rect.top - 20) }
      : current)
    setBoardItems(next)
    const result = await window.api.saveLibraryBoard({ boardId, items: next })
    if (!result.ok) useToastStore.getState().show(`展板保存失败：${result.error.message}`)
  }

  const createBoard = async (): Promise<void> => {
    if (!boardName.trim()) return
    const result = await window.api.createLibraryBoard({ title: boardName.trim() })
    if (!result.ok) return useToastStore.getState().show(`创建展板失败：${result.error.message}`)
    setBoards((items) => [result.data, ...items])
    setBoardId(result.data.id)
    setBoardName('')
    setView('boards')
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

  const renderFolder = (folder: LibraryFolder, depth = 0): React.JSX.Element => {
    const hasChildren = folders.some((item) => item.parentId === folder.id)
    const expanded = expandedFolders.has(folder.id)
    return (
      <Fragment key={folder.id}>
        <div className="library-folder-row">
          {renamingFolderId === folder.id ? (
            <form className="library-folder-rename" style={{ paddingLeft: 10 + depth * 15 }} onSubmit={(event) => { event.preventDefault(); void renameFolder(folder) }}>
              <input autoFocus value={folderRenameDraft} maxLength={100} aria-label={`重命名文件夹 ${folder.name}`} onChange={(event) => setFolderRenameDraft(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Escape') setRenamingFolderId(null) }} />
              <button type="submit" aria-label="保存文件夹名称">保存</button>
            </form>
          ) : (
            <>
              <button className={`library-folder-select${folderId === folder.id ? ' active' : ''}`} style={{ paddingLeft: 10 + depth * 15 }} onClick={() => { setFolderId(folder.id); setFolderDraftParentId(undefined) }}>
                <span className="library-folder-caret" onClick={(event) => { event.stopPropagation(); setExpandedFolders((current) => { const next = new Set(current); if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id); return next }) }}>{hasChildren ? expanded ? '⌄' : '›' : ''}</span>
                <Icon name="assets" size={13} /><span>{folder.name}</span><small>{folder.resourceCount}</small>
              </button>
              <button className="library-folder-add-child" title={`在「${folder.name}」下新建子文件夹`} aria-label={`在「${folder.name}」下新建子文件夹`} onClick={() => startFolderCreation(folder.id)}><Icon name="add" size={13} /></button>
              <div className="library-folder-menu-wrap">
                <button className="library-folder-actions" title={`文件夹操作：${folder.name}`} aria-label={`文件夹操作：${folder.name}`} aria-expanded={folderActionId === folder.id} onClick={() => setFolderActionId((current) => current === folder.id ? null : folder.id)}>⋯</button>
                {folderActionId === folder.id && <div className="library-folder-menu">
                  <button onClick={() => { setRenamingFolderId(folder.id); setFolderRenameDraft(folder.name); setFolderActionId(null) }}><Icon name="edit" size={12} />重命名</button>
                  <button className="danger" onClick={() => { setFolderActionId(null); void removeFolder(folder) }}><Icon name="trash" size={12} />删除</button>
                </div>}
              </div>
            </>
          )}
        </div>
        {folderDraftParentId === folder.id && renderFolderCreator(folder.id, depth + 1)}
        {expanded && folders.filter((item) => item.parentId === folder.id).map((child) => renderFolder(child, depth + 1))}
      </Fragment>
    )
  }

  return (
    <div className="resource-library-page">
      <header className="library-page-header">
        <div className="library-page-actions">
          <span className="library-current-view"><Icon name="assets" size={15} />资源</span>
          <button className="library-secondary" onClick={() => void importLibrary()}><Icon name="upload" size={15} />导入资产包</button>
          <button className="library-secondary" onClick={() => void exportLibrary()}><Icon name="download" size={15} />导出资产包</button>
          <button className="library-primary" onClick={() => { setSelectedId(null); setFormOpen(true) }}><span className="library-primary-icon"><Icon name="add" size={14} /></span>新建资源</button>
          <button className="library-back" onClick={onBack}><Icon name="home" size={16} />返回项目</button>
        </div>
      </header>

      {view === 'resources' ? (
        <div className="library-workspace">
          <aside className="library-collections">
            <div className="library-category-heading"><strong>资源分类</strong><button title="新建分类" aria-label="新建资源分类" onClick={() => setCategoryEditor({})}><Icon name="add" size={14} /></button></div>
            <button className={!categoryId ? 'active' : ''} onClick={() => setCategoryId('')}><Icon name="assets" size={14} /><span>全部分类</span></button>
            <button className={categoryId === 'legacy' ? 'active' : ''} onClick={() => setCategoryId('legacy')}><Icon name="assets" size={14} /><span>未分类资源</span></button>
            {categories.map((category) => <div className="library-category-row" key={category.id}>
              <button className={categoryId === category.id ? 'active' : ''} onClick={() => setCategoryId(category.id)}><Icon name="assets" size={14} /><span>{category.name}</span><small>v{category.version}</small></button>
              <button aria-label={`编辑分类 ${category.name}`} title={`编辑分类 ${category.name}`} onClick={() => setCategoryEditor({ initial: category })}><Icon name="edit" size={12} /></button>
            </div>)}
            <div className="library-collection-heading library-folder-heading">
              <strong>文件夹</strong><span>{folders.length}</span>
              <button className="library-folder-create-trigger" title="新建文件夹" aria-label="新建文件夹" onClick={() => startFolderCreation(null)}><Icon name="add" size={13} /></button>
            </div>
            {folderDraftParentId === null && renderFolderCreator(null, 0)}
            <button className={!folderId ? 'active' : ''} onClick={() => { setFolderId(''); setFolderDraftParentId(undefined) }}><Icon name="assets" size={14} /><span>全部资源</span></button>
            <button className={folderId === 'root' ? 'active' : ''} onClick={() => { setFolderId('root'); setFolderDraftParentId(undefined) }}><Icon name="assets" size={14} /><span>根目录</span></button>
            {folders.filter((item) => item.parentId === null).map((folder) => renderFolder(folder))}
          </aside>
          <main className="library-resource-browser">
            <div className="library-browser-toolbar">
              <label className="library-search"><Icon name="search" size={15} /><input aria-label="搜索资源库" value={query} placeholder="搜索名称、说明、标签和提示词" onChange={(event) => setQuery(event.currentTarget.value)} /></label>
            </div>
            {resources.length ? (
              <div className="library-resource-grid">
                {resources.map((resource) => <ResourceCard key={resource.id} resource={resource} onOpen={() => { setSelectedId(resource.id); setSelectedRevisionId(resource.latestRevisionId) }} onDragStart={(event) => event.dataTransfer.setData('application/x-canvas-library-resource', resource.id)} />)}
              </div>
            ) : (
              <div className="library-empty-state"><span><Icon name="assets" size={25} /></span><h2>这个位置还没有资源</h2><p>从画布选中节点后，右键选择“保存所选节点到资源库”，或手动新建资源。</p><button className="library-primary" onClick={() => setFormOpen(true)}><span className="library-primary-icon"><Icon name="add" size={14} /></span>新建资源</button></div>
            )}
            {nextCursor && <button className="library-load-more" onClick={() => void loadResources(nextCursor, true)}>加载更多</button>}
          </main>
        </div>
      ) : (
        <div className="library-board-view">
          <aside className="library-board-list">
            <strong>我的展板</strong>
            {boards.map((board) => <button key={board.id} className={board.id === boardId ? 'active' : ''} onClick={() => setBoardId(board.id)}>{board.title}</button>)}
            <div className="library-board-create"><input value={boardName} placeholder="展板名称" maxLength={120} onChange={(event) => setBoardName(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createBoard() }} /><button disabled={!boardName.trim()} onClick={() => void createBoard()}><Icon name="add" size={14} /></button></div>
            <p>从资源卡片拖到展板，或打开资源详情加入。展板会固定加入时的资源版本。</p>
          </aside>
          <div className="library-board-canvas-scroll">
            {boardId ? (
              <div className="library-board-canvas" ref={boardCanvasRef} onDragOver={(event) => event.preventDefault()} onDrop={(event) => void dropOnBoard(event)}>
                {currentBoardItems.map((item) => {
                  const resource = currentBoardDetails[`${item.resourceId}:${item.revisionId}`]
                  return (
                    <article key={item.id} className="library-board-card" style={{ left: item.x, top: item.y, width: item.width, minHeight: item.height }} draggable onDragStart={(event) => event.dataTransfer.setData('application/x-canvas-library-board-item', item.id)} onDragEnd={(event) => void moveBoardItem(event, item)} onDrop={(event) => event.stopPropagation()}>
                      {resource ? <button className="library-board-resource-open" onClick={() => { setSelectedId(resource.id); setSelectedRevisionId(item.revisionId) }}>
                        {resource.components.find((component) => component.valueType === 'image' && component.blobPath) ? <img src={mediaUrl(resource.components.find((component) => component.valueType === 'image' && component.blobPath)!.blobPath!)} alt="" /> : <span className="library-board-no-image"><Icon name="assets" size={20} /></span>}
                        <strong>{resource.selectedTitle}</strong><small>固定版本 v{resource.selectedRevisionNumber}</small>
                        {resource.revisionNumber > resource.selectedRevisionNumber && <em>已有新版本 v{resource.revisionNumber}</em>}
                      </button> : <div className="library-board-missing">资源已不可用</div>}
                      <textarea value={item.note} placeholder="写下对照观察或灵感…" onChange={(event) => setBoardItems((items) => items.map((current) => current.id === item.id ? { ...current, note: event.currentTarget.value } : current))} onBlur={() => void window.api.saveLibraryBoard({ boardId, items: currentBoardItems })} />
                      <button className="library-board-remove" aria-label="从展板移除" onClick={() => {
                        const next = currentBoardItems.filter((current) => current.id !== item.id)
                        setBoardItems(next)
                        void window.api.saveLibraryBoard({ boardId, items: next })
                      }}><Icon name="close" size={13} /></button>
                    </article>
                  )
                })}
                {currentBoardItems.length === 0 && <div className="library-board-empty">打开资源详情，点击“加入展板”，开始整理你的风格参考。</div>}
              </div>
            ) : <div className="library-empty-state"><h2>创建一个展板</h2><p>展板可固定资源版本，便于并排观察图片、设定和灵感。</p></div>}
          </div>
        </div>
      )}

      {selectedId && (
        <div className="library-detail-mask" onMouseDown={(event) => event.target === event.currentTarget && setSelectedId(null)}>
          <aside className="library-detail-panel" role="dialog" aria-modal="true" aria-label="资源详情">
            <header className="library-detail-header">
              <button className="library-back" onClick={() => setSelectedId(null)}>← 返回资源</button>
              <button className="library-icon-button" aria-label="关闭详情" onClick={() => setSelectedId(null)}><Icon name="close" size={17} /></button>
            </header>
            {detailLoading || !detail ? <div className="library-detail-loading">正在读取资源…</div> : (
              <>
                <div className="library-detail-scroll">
                  <div className="library-detail-title"><span className="library-resource-type">{typeName(detail.formPreset, detail.category?.name)}</span><h2>{detail.selectedTitle}</h2><p>{detail.selectedDescription || '暂无说明'}</p><div className="library-detail-tags">{detail.tags.map((tag) => <span key={tag}>{tag}</span>)}</div></div>
                  <div className="library-detail-section library-resource-location">
                    <label>所在文件夹<select value={detail.folderIds[0] ?? ''} onChange={(event) => void moveResourceToFolder(event.currentTarget.value)}>
                      <option value="">资源库根目录</option>
                      {folderOptions.map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
                    </select></label>
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
                    <div className="library-detail-section-title"><h3>版本记录</h3><span>{detail.revisions.length} 个版本</span></div>
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
                    {detail.selectedRevisionId !== detail.latestRevisionId && <p className="library-old-version-hint">正在查看历史版本。可基于此版本发布为新的当前版本。</p>}
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
                    {view === 'boards' && boardId && <button className="library-detail-board-add" onClick={() => {
                      const summary = resources.find((item) => item.id === detail.id) ?? detail
                      void addToBoard(summary)
                    }}><Icon name="add" size={14} />加入当前展板（固定最新版本）</button>}
                  </div>
                </div>
                <footer className="library-detail-actions">
                  <button className="library-secondary" onClick={() => setFormOpen(true)}><Icon name="edit" size={14} />基于此版本编辑</button>
                  <button className="library-detail-archive" onClick={() => void archive(!detail.archivedAt)}>{detail.archivedAt ? '恢复资源' : '归档'}</button>
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
        useToastStore.getState().show(`分类「${category.name}」已保存为 v${category.version}`)
      }} />}
    </div>
  )
}
