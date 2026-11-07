import { useEffect, useRef, useState } from 'react'
import type { Editor } from 'tldraw'
import type { LibraryResourceSummary } from '@shared/library/types'
import { Icon } from '../components/Icon'
import { LibraryCardCover } from './LibraryCardCover'
import { useConfirmStore } from '../stores/confirm'
import { useToastStore } from '../stores/toast'
import { insertResource } from './insertResource'
import { libraryVersionLabel } from './value-type-labels'
import { useDragToCanvas } from '../canvas/drag-to-canvas'

interface LibraryResourcePickerProps {
  projectId: string
  editor: Editor | null
}

const SEARCH_DEBOUNCE_MS = 160
const SEARCH_LIMIT = 100

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${d
    .getHours()
    .toString()
    .padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

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

  // 与资源库页一致：删除是硬删除，必须二次确认。
  const handleDelete = async (resource: LibraryResourceSummary): Promise<void> => {
    const confirmed = await useConfirmStore.getState().confirm({
      title: `删除资源「${resource.title}」？`,
      message: '会同时删除该资源的全部版本与内容，删除后无法恢复。',
      confirmText: '删除',
      cancelText: '取消',
      danger: true
    })
    if (!confirmed) return
    setBusyId(resource.id)
    try {
      const result = await window.api.deleteLibraryResource({ resourceId: resource.id })
      if (!result.ok) throw new Error(result.error.message)
      setResources((current) => current.filter((item) => item.id !== resource.id))
      useToastStore.getState().show(`已删除资源「${resource.title}」`)
    } catch (error) {
      useToastStore.getState().show(
        `删除失败：${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="library-picker">
      <label className="assets-search-row">
        <Icon name="search" size={14} />
        <input
          className="assets-search"
          value={keyword}
          placeholder="搜索资源库"
          onChange={(e) => setKeyword(e.currentTarget.value)}
        />
      </label>

      {loading && resources.length === 0 ? (
        <div className="side-panel-empty">正在加载资源…</div>
      ) : resources.length === 0 ? (
        <div className="side-panel-empty">
          资源库还没有内容，在项目素材里保存素材，或到资源库页面新建资源。
        </div>
      ) : (
        <div className="assets-grid">
          {resources.map((resource) => (
            <LibraryCard
              key={resource.id}
              resource={resource}
              busy={busyId === resource.id}
              onAdd={() => void addResource(resource)}
              onDrop={(x, y) => void addResource(resource, { x, y })}
              onDelete={() => void handleDelete(resource)}
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
  onDelete
}: {
  resource: LibraryResourceSummary
  busy: boolean
  onAdd: () => void
  onDrop: (x: number, y: number) => void
  onDelete: () => void
}): React.JSX.Element {
  const { startDrag, handleClick } = useDragToCanvas()

  return (
    <article
      className="asset-card"
      onPointerDown={(e) =>
        startDrag(
          e,
          {
            label: resource.title,
            icon: resource.iconKind ?? 'assets'
          },
          onDrop
        )
      }
      onClick={() => handleClick(onAdd)}
    >
      {resource.iconKind && <LibraryCardCover icon={resource.iconKind} compact />}

      <div className="asset-info">
        <span className="asset-name" title={resource.title}>
          {resource.title}
        </span>
        <span className="asset-meta">
          {formatTime(resource.updatedAt)} · {libraryVersionLabel(resource.revisionNumber)}
        </span>
      </div>

      <button
        type="button"
        className="asset-delete"
        aria-label="删除资源"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
      >
        <Icon name="trash" size={12} />
      </button>
    </article>
  )
}
