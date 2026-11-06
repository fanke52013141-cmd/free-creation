import { useEffect, useRef, useState } from 'react'
import type { Editor } from 'tldraw'
import type { LibraryResourceSummary } from '@shared/library/types'
import { Icon } from '../components/Icon'
import { mediaUrl } from '../nodes/registry'
import { useToastStore } from '../stores/toast'
import { insertResource } from './insertResource'
import { useDragToCanvas } from '../canvas/drag-to-canvas'

interface LibraryResourcePickerProps {
  projectId: string
  editor: Editor | null
}

const SEARCH_DEBOUNCE_MS = 160
const SEARCH_LIMIT = 100

export function LibraryResourcePicker({
  projectId,
  editor
}: LibraryResourcePickerProps): React.JSX.Element {
  const [keyword, setKeyword] = useState('')
  const [resources, setResources] = useState<LibraryResourceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const debounceRef = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      void (async (): Promise<void> => {
        // loading 在异步回调里更新，避免在 effect 同步体触发级联渲染。
        setLoading(true)
        const result = await window.api.searchLibrary({
          query: keyword.trim() || undefined,
          limit: SEARCH_LIMIT
        })
        if (cancelled) return
        if (result.ok) setResources(result.data.items)
        setLoading(false)
      })()
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
  }, [keyword])

  // 点击添加：整份资源加入；拖拽添加时携带光标落点。
  const addResource = async (
    resource: LibraryResourceSummary,
    dropScreen?: { x: number; y: number }
  ): Promise<void> => {
    if (!editor) {
      useToastStore.getState().show('画布尚未就绪，无法添加资源')
      return
    }
    setBusyId(resource.id)
    try {
      const detailResult = await window.api.getLibraryResource({ resourceId: resource.id })
      if (!detailResult.ok) throw new Error(detailResult.error.message)
      const detail = detailResult.data
      if (!detail) throw new Error('资源详情不存在或已被删除')
      const componentIds = detail.components.map((item) => item.id)
      await insertResource(editor, projectId, detail, componentIds, {}, dropScreen)
    } catch (error) {
      useToastStore.getState().show(
        `添加失败：${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      setBusyId(null)
    }
  }

  // 资源库没有硬删除，归档后默认搜索不再返回，可在归档视图恢复。
  const handleArchive = async (resource: LibraryResourceSummary): Promise<void> => {
    setBusyId(resource.id)
    try {
      const result = await window.api.archiveLibraryResource({
        resourceId: resource.id,
        archived: true
      })
      if (!result.ok) throw new Error(result.error.message)
      setResources((current) => current.filter((item) => item.id !== resource.id))
      useToastStore.getState().show('资源已移除，可在归档中恢复')
    } catch (error) {
      useToastStore.getState().show(
        `移除失败：${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="library-picker">
      <label className="library-picker-search">
        <Icon name="search" size={14} />
        <input
          value={keyword}
          placeholder="搜索资源库"
          onChange={(e) => setKeyword(e.currentTarget.value)}
        />
      </label>

      {loading && resources.length === 0 ? (
        <div className="side-panel-empty">正在加载资源…</div>
      ) : resources.length === 0 ? (
        <div className="side-panel-empty">
          资源库还没有内容，在项目素材里保存素材后会出现在这里。
        </div>
      ) : (
        <div className="library-picker-grid">
          {resources.map((resource) => (
            <LibraryCard
              key={resource.id}
              resource={resource}
              busy={busyId === resource.id}
              onAdd={() => void addResource(resource)}
              onDrop={(x, y) => void addResource(resource, { x, y })}
              onArchive={() => void handleArchive(resource)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function LibraryCard({
  resource,
  busy,
  onAdd,
  onDrop,
  onArchive
}: {
  resource: LibraryResourceSummary
  busy: boolean
  onAdd: () => void
  onDrop: (x: number, y: number) => void
  onArchive: () => void
}): React.JSX.Element {
  const { startDrag, handleClick } = useDragToCanvas()

  return (
    <article
      className="library-card"
      onPointerDown={(e) =>
        startDrag(
          e,
          {
            label: resource.title,
            ...(resource.coverPath
              ? { image: mediaUrl(resource.coverPath) }
              : { icon: 'layers' })
          },
          onDrop
        )
      }
      onClick={() => handleClick(onAdd)}
    >
      <div className="library-card-cover">
        {resource.coverPath ? (
          <img src={mediaUrl(resource.coverPath)} alt={resource.title} loading="lazy" />
        ) : (
          <span className="library-card-cover-icon">
            <Icon name="layers" size={24} />
          </span>
        )}
      </div>

      <div className="library-card-info">
        <span className="library-card-name" title={resource.title}>
          {resource.title}
        </span>
      </div>

      <button
        type="button"
        className="library-card-delete"
        aria-label="从资源库移除"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation()
          onArchive()
        }}
      >
        <Icon name="trash" size={12} />
      </button>
    </article>
  )
}
