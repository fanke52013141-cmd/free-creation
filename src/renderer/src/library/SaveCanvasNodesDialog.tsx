import { useEffect, useMemo, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import type { LibraryFolder, LibraryResourceSummary } from '@shared/library/types'
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

function folderOptions(folders: LibraryFolder[]): Array<{ id: string; label: string }> {
  const children = new Map<string | null, LibraryFolder[]>()
  for (const folder of folders) children.set(folder.parentId, [...(children.get(folder.parentId) ?? []), folder])
  const result: Array<{ id: string; label: string }> = []
  const visit = (parentId: string | null, prefix: string, visited: Set<string>): void => {
    for (const folder of children.get(parentId) ?? []) {
      if (visited.has(folder.id)) continue
      result.push({ id: folder.id, label: `${prefix}${folder.name}` })
      const next = new Set(visited).add(folder.id)
      visit(folder.id, `${prefix}${folder.name} / `, next)
    }
  }
  visit(null, '', new Set())
  return result
}

export function SaveCanvasNodesDialog({ editor, projectId, nodeIds, onClose, onSaved }: Props): React.JSX.Element {
  const shapes = useMemo(() => nodeIds.map((id) => editor.getShape<NodeCardShape>(id))
    .filter((shape): shape is NodeCardShape => shape?.type === 'node-card'), [editor, nodeIds])
  const supported = useMemo(() => shapes.filter((shape) => {
    const { nodeType, mediaId } = shape.props
    return nodeType === 'text'
      ? Boolean(shape.props.text.trim()) && shapes.findIndex((item) => item.props.nodeType === 'text' && item.props.text.trim()) === shapes.indexOf(shape)
      : (['image', 'audio', 'video', 'video-asset'].includes(nodeType) && Boolean(mediaId) &&
        (nodeType !== 'audio' || shapes.findIndex((item) => item.props.nodeType === 'audio' && item.props.mediaId) === shapes.indexOf(shape)))
  }), [shapes])
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const [folderId, setFolderId] = useState('')
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
  const options = useMemo(() => folderOptions(folders), [folders])

  useEffect(() => {
    let cancelled = false
    void window.api.listLibraryFolders().then((result) => {
      if (!cancelled && result.ok) setFolders(result.data)
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

  const targetResource = resources.find((resource) => resource.id === resourceId)

  const save = async (): Promise<void> => {
    if (!title.trim()) return setError('请填写资源名称')
    if (supported.length === 0) return setError('所选节点没有可保存的文本或媒体内容')
    setBusy(true)
    setError('')
    const result = await window.api.captureLibraryNodes({
      projectId,
      title: title.trim(),
      ...(mode === 'new' && folderId ? { folderId } : {}),
      ...(mode === 'revision' && targetResource ? {
        resourceId: targetResource.id,
        baseRevisionId: targetResource.latestRevisionId,
        changeNote: changeNote.trim() || '从画布保存新版本'
      } : {}),
      nodes: supported.map((shape) => ({
        nodeId: shape.id,
        title: shape.props.title,
        nodeType: shape.props.nodeType,
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
          {mode === 'new' ? <>
            <label className="library-form-field"><span>资源名称</span><input autoFocus maxLength={180} value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="例如：主角设定" /></label>
            <label className="library-form-field"><span>保存到文件夹</span><select value={folderId} onChange={(event) => setFolderId(event.currentTarget.value)}>
              <option value="">资源库根目录</option>
              {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select></label>
          </> : <>
            <label className="library-form-field"><span>查找资源</span><input value={resourceQuery} onChange={(event) => setResourceQuery(event.currentTarget.value)} placeholder="搜索资源名称" /></label>
            <label className="library-form-field"><span>更新哪一份资源</span><select value={resourceId} onChange={(event) => {
              const id = event.currentTarget.value
              setResourceId(id)
              const resource = resources.find((item) => item.id === id)
              if (resource) setTitle(resource.title)
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
            {shapes.map((shape) => <div key={shape.id} className={supported.includes(shape) ? '' : 'unsupported'}>
              <Icon name={shape.props.nodeType === 'image' ? 'image' : shape.props.nodeType === 'video' || shape.props.nodeType === 'video-asset' ? 'video' : shape.props.nodeType === 'audio' ? 'audio' : 'text'} size={14} />
              <span>{shape.props.title || '未命名节点'}</span>
              {!supported.includes(shape) && <small>无可保存内容或已达单项上限</small>}
            </div>)}
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
