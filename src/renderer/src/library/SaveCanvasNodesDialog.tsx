import { useEffect, useMemo, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import type { LibraryCategory } from '@shared/library/blueprint'
import type { LibraryResourceSummary } from '@shared/library/types'
import type { NodeCardShape } from '../canvas/NodeCardShape'
import { Icon } from '../components/Icon'
import { useToastStore } from '../stores/toast'

interface Props {
  editor: Editor
  projectId: string
  nodeIds: TLShapeId[]
  onClose: () => void
  onSaved: () => void
}

function categoryKey(category: LibraryCategory): string {
  return `${category.id}@${category.version}`
}

function slotMatchesCanvasNode(slotType: string, nodeType: string): boolean {
  if (nodeType === 'video' || nodeType === 'video-asset') return slotType === 'video-asset'
  return slotType === nodeType
}

function initialSlotAssignments(
  category: LibraryCategory,
  shapes: NodeCardShape[]
): Record<string, string> {
  const counts = new Map<string, number>()
  const result: Record<string, string> = {}
  for (const shape of shapes) {
    const matchingSlots = category.blueprint.slots.filter((slot) =>
      slotMatchesCanvasNode(slot.nodeType, shape.props.nodeType)
    )
    const slot = matchingSlots.find((candidate) => candidate.multiple || (counts.get(candidate.id) ?? 0) === 0)
    if (!slot) continue
    result[shape.id] = slot.id
    counts.set(slot.id, (counts.get(slot.id) ?? 0) + 1)
  }
  return result
}

export function SaveCanvasNodesDialog({ editor, projectId, nodeIds, onClose, onSaved }: Props): React.JSX.Element {
  const shapes = useMemo(() => nodeIds.map((id) => editor.getShape<NodeCardShape>(id))
    .filter((shape): shape is NodeCardShape => shape?.type === 'node-card'), [editor, nodeIds])
  const supported = useMemo(() => shapes.filter((shape) => {
    const { nodeType, mediaId } = shape.props
    return nodeType === 'text'
      ? Boolean(shape.props.text.trim())
      : ['image', 'audio', 'video', 'video-asset'].includes(nodeType) && Boolean(mediaId)
  }), [shapes])
  const [categories, setCategories] = useState<LibraryCategory[]>([])
  const [selectedCategoryKey, setSelectedCategoryKey] = useState('')
  const [slotAssignments, setSlotAssignments] = useState<Record<string, string>>({})
  const [mode, setMode] = useState<'new' | 'revision'>('new')
  const [resourceQuery, setResourceQuery] = useState('')
  const [resources, setResources] = useState<LibraryResourceSummary[]>([])
  const [resourceId, setResourceId] = useState('')
  const [changeNote, setChangeNote] = useState('')
  const [title, setTitle] = useState(() => shapes.length === 1
    ? shapes[0].props.title
    : shapes[0] ? `${shapes[0].props.title}等${shapes.length}项` : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const targetResource = resources.find((resource) => resource.id === resourceId)
  const categoryChoices = targetResource?.category
    ? [...categories.filter((item) => item.id !== targetResource.category!.id), targetResource.category]
    : [...categories]
  const selectedCategory = categoryChoices.find((item) => categoryKey(item) === selectedCategoryKey)

  useEffect(() => {
    let cancelled = false
    void window.api.listLibraryCategories().then((categoryResult) => {
      if (cancelled) return
      if (categoryResult.ok) setCategories(categoryResult.data)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (mode !== 'revision') return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.api.searchLibrary({ query: resourceQuery, limit: 100 }).then((result) => {
        if (!cancelled && result.ok) {
          setResources(result.data.items)
          setResourceId((current) => result.data.items.some((item) => item.id === current) ? current : '')
        }
      })
    }, 160)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [mode, resourceQuery])

  const save = async (): Promise<void> => {
    if (!title.trim()) return setError('请填写资源名称')
    if (supported.length === 0) return setError('所选节点没有可保存的文本或媒体内容')
    if (supported.length > 100) return setError('一次最多保存 100 个节点，请分批保存')
    if (selectedCategory) {
      const missingMapping = supported.find((shape) => !slotAssignments[shape.id])
      if (missingMapping) return setError(`请为「${missingMapping.props.title || '未命名节点'}」选择分类槽位`)
      for (const slot of selectedCategory.blueprint.slots) {
        const count = Object.values(slotAssignments).filter((slotId) => slotId === slot.id).length
        if (slot.required && count === 0) return setError(`分类要求至少关联一个「${slot.label}」节点`)
        if (!slot.multiple && count > 1) return setError(`「${slot.label}」只允许关联一个节点`)
      }
    }
    setBusy(true)
    setError('')
    const result = await window.api.captureLibraryNodes({
      projectId,
      title: title.trim(),
      ...(mode === 'revision' && targetResource ? {
        resourceId: targetResource.id,
        baseRevisionId: targetResource.latestRevisionId,
        changeNote: changeNote.trim() || '从画布保存新版本'
      } : {}),
      ...(selectedCategory ? { category: { id: selectedCategory.id, version: selectedCategory.version } } : {}),
      nodes: supported.map((shape) => ({
        nodeId: shape.id,
        title: shape.props.title,
        nodeType: shape.props.nodeType,
        ...(selectedCategory && slotAssignments[shape.id] ? { slotId: slotAssignments[shape.id] } : {}),
        text: shape.props.text,
        mediaId: shape.props.mediaId || undefined,
        mediaMime: shape.props.mediaMime || undefined
      }))
    }).catch((cause: unknown) => ({ ok: false as const, error: { message: cause instanceof Error ? cause.message : String(cause) } }))
    setBusy(false)
    if (!result.ok) return setError(result.error.message)
    useToastStore.getState().show(mode === 'revision'
      ? `已将 ${supported.length} 个节点保存为「${result.data.title}」v${result.data.revisionNumber}`
      : `已将 ${supported.length} 个节点保存为资源「${result.data.title}」v1`)
    onSaved()
  }

  return (
    <div className="library-form-mask" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="library-form-dialog library-canvas-save-dialog" role="dialog" aria-modal="true" aria-label="保存所选节点到资源库">
        <header className="library-form-header">
          <div><span className="library-eyebrow">CREATION LIBRARY</span><h2>保存所选节点到资源库</h2></div>
          <button className="library-icon-button" aria-label="关闭" disabled={busy} onClick={onClose}><Icon name="close" size={17} /></button>
        </header>
        <div className="library-form-scroll">
          <p className="library-canvas-save-intro">保存时会复制所选节点的当前文本和媒体，成为资源库中的独立版本。以后画布内容变化时，需要再次保存为新版本。</p>
          <div className="library-canvas-save-modes">
            <button className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')}>新建资源</button>
            <button className={mode === 'revision' ? 'active' : ''} onClick={() => setMode('revision')}>保存为已有资源的新版本</button>
          </div>
          <label className="library-form-field"><span>资源分类与节点映射</span>
            <select value={selectedCategoryKey} onChange={(event) => {
              const nextKey = event.currentTarget.value
              const nextCategory = categoryChoices.find((item) => categoryKey(item) === nextKey)
              setSelectedCategoryKey(nextKey)
              setSlotAssignments(nextCategory ? initialSlotAssignments(nextCategory, supported) : {})
            }}>
              <option value="">{mode === 'new' ? '不选分类，保存为自由组合' : '保持未分类'}</option>
              {categoryChoices.map((category) => <option key={categoryKey(category)} value={categoryKey(category)}>{category.name}</option>)}
            </select>
            <small>{selectedCategory ? '节点会按所选槽位绑定到这份资源蓝图。' : '可直接保存为未分类自由组合，之后也能再选择分类。'}</small>
          </label>
          {mode === 'new' ? <>
            <label className="library-form-field"><span>资源名称</span><input autoFocus maxLength={180} value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="例如：主角设定" /></label>
          </> : <>
            <label className="library-form-field"><span>查找资源</span><input value={resourceQuery} onChange={(event) => setResourceQuery(event.currentTarget.value)} placeholder="搜索资源名称" /></label>
            <label className="library-form-field"><span>更新哪一份资源</span><select value={resourceId} onChange={(event) => {
              const id = event.currentTarget.value
              setResourceId(id)
              const resource = resources.find((item) => item.id === id)
              if (resource) {
                setTitle(resource.title)
                setSelectedCategoryKey(resource.category ? categoryKey(resource.category) : '')
                setSlotAssignments(resource.category ? initialSlotAssignments(resource.category, supported) : {})
              }
            }}>
              <option value="">选择资源…</option>
              {resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.title} · v{resource.revisionNumber}</option>)}
            </select></label>
            {targetResource && <>
              <label className="library-form-field"><span>资源名称</span><input maxLength={180} value={title} onChange={(event) => setTitle(event.currentTarget.value)} /></label>
              <label className="library-form-field"><span>版本说明</span><input maxLength={1000} value={changeNote} onChange={(event) => setChangeNote(event.currentTarget.value)} placeholder="从画布保存新版本" /></label>
            </>}
          </>}
          <div className="library-canvas-save-nodes">
            <strong>将保存 {supported.length} / {shapes.length} 个节点</strong>
            {shapes.map((shape) => {
              const isSupported = supported.includes(shape)
              const matchingSlots = selectedCategory?.blueprint.slots.filter((slot) => slotMatchesCanvasNode(slot.nodeType, shape.props.nodeType)) ?? []
              return <div key={shape.id} className={isSupported ? '' : 'unsupported'}>
                <Icon name={shape.props.nodeType === 'image' ? 'image' : shape.props.nodeType === 'video' || shape.props.nodeType === 'video-asset' ? 'video' : shape.props.nodeType === 'audio' ? 'audio' : 'text'} size={14} />
                <span>{shape.props.title || '未命名节点'}</span>
                {isSupported && selectedCategory && <label className="library-canvas-slot-select"><small>关联槽位</small><select aria-label={`${shape.props.title || '未命名节点'}关联槽位`} value={slotAssignments[shape.id] ?? ''} onChange={(event) => { const slotId = event.currentTarget.value; setSlotAssignments((current) => ({ ...current, [shape.id]: slotId })) }}>
                  <option value="">选择槽位…</option>
                  {matchingSlots.map((slot) => {
                    const mappedElsewhere = !slot.multiple && Object.entries(slotAssignments).some(([nodeId, slotId]) => nodeId !== shape.id && slotId === slot.id)
                    return <option key={slot.id} value={slot.id} disabled={mappedElsewhere}>{slot.label}{mappedElsewhere ? '（单项已占用）' : ''}</option>
                  })}
                </select></label>}
                {!isSupported && <small>无可保存的文本或媒体内容</small>}
                {isSupported && selectedCategory && matchingSlots.length === 0 && <small>分类中没有兼容的节点槽位</small>}
              </div>
            })}
          </div>
          {error && <div className="library-form-error" role="alert">{error}</div>}
        </div>
        <footer className="library-form-footer">
          <span>所选节点内容将独立保存</span>
          <button type="button" className="library-form-secondary" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="library-form-primary" disabled={busy || supported.length === 0 || (mode === 'revision' && !targetResource)} onClick={() => void save()}>{busy ? '保存中…' : mode === 'revision' ? '保存为新版本' : '保存资源'}</button>
        </footer>
      </section>
    </div>
  )
}
