import { useEffect, useState } from 'react'
import type { Editor } from 'tldraw'
import type { MediaAsset, MediaKind } from '@shared/types'
import {
  buildMediaAssetIndex,
  filterMediaAssets,
  mediaSourceOptions,
  type IndexedMediaAsset,
  type MediaRunFilter,
  type MediaTimeFilter
} from '../../assets/media-index'
import { useMediaStore } from '../../stores/media'
import { Icon, type IconName } from '../../components/Icon'
import { AppSelect } from '../../components/AppSelect'
import { mediaUrl } from '../../nodes/registry'
import { useConfirmStore } from '../../stores/confirm'
import { useToastStore } from '../../stores/toast'
import { useDragToCanvas } from '../drag-to-canvas'
import type { NodeCardShape } from '../NodeCardShape'
import { LibraryResourcePicker } from '../../library/LibraryResourcePicker'

interface AssetsPanelProps {
  projectId: string
  editor: Editor | null
  onImport: () => void
  onDropMedia: (asset: MediaAsset, x: number, y: number) => void
}

const TYPE_FILTERS: { key: MediaKind | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
  { key: 'audio', label: '音频' },
  { key: 'file', label: '文件' }
]

const RUN_STATUS_OPTIONS: { value: MediaRunFilter; label: string }[] = [
  { value: 'all', label: '全部状态' },
  { value: 'success', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'running', label: '运行中' },
  { value: 'unavailable', label: '无运行记录' }
]

const TIME_OPTIONS: { value: MediaTimeFilter; label: string }[] = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' }
]

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${d
    .getHours()
    .toString()
    .padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

// 按资产 id 确定性生成装饰波形，保证同一素材每次渲染一致，不读取真实音频。
function waveBars(id: string): number[] {
  let seed = 0
  for (let i = 0; i < id.length; i += 1) seed = (seed * 31 + id.charCodeAt(i)) >>> 0
  return Array.from({ length: 21 }, () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return 28 + (seed % 60)
  })
}

function kindIcon(kind: MediaKind): IconName {
  if (kind === 'image') return 'image'
  if (kind === 'video') return 'video'
  if (kind === 'audio') return 'audio'
  return 'document'
}

export function AssetsPanel({
  projectId,
  editor,
  onImport,
  onDropMedia
}: AssetsPanelProps): React.JSX.Element {
  const assets = useMediaStore((s) => s.assets)
  const keyword = useMediaStore((s) => s.keyword)
  const setKeyword = useMediaStore((s) => s.setKeyword)
  const sourceNodeId = useMediaStore((s) => s.sourceNodeId)
  const setSourceNodeId = useMediaStore((s) => s.setSourceNodeId)
  const runStatus = useMediaStore((s) => s.runStatus)
  const setRunStatus = useMediaStore((s) => s.setRunStatus)
  const timeRange = useMediaStore((s) => s.timeRange)
  const setTimeRange = useMediaStore((s) => s.setTimeRange)
  const load = useMediaStore((s) => s.load)
  const remove = useMediaStore((s) => s.remove)

  const [typeFilter, setTypeFilter] = useState<MediaKind | 'all'>('all')
  const [selectionMode, setSelectionMode] = useState(false)
  const [libraryMode, setLibraryMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    void load(projectId)
  }, [projectId, load])

  const shapes = editor
    ? editor
        .getCurrentPageShapes()
        .filter((shape): shape is NodeCardShape => shape.type === 'node-card')
    : []
  const indexed = buildMediaAssetIndex(assets, shapes)
  const sourceOptions = mediaSourceOptions(indexed)
  const visible = filterMediaAssets(indexed, {
    filter: typeFilter,
    keyword,
    sourceNodeId,
    runStatus,
    timeRange
  })

  const counts: Record<string, number> = {
    all: indexed.length,
    image: 0,
    video: 0,
    audio: 0,
    file: 0
  }
  for (const item of indexed) counts[item.kind] += 1

  // 退出多选时在事件处理里清空已选，避免残留选中态（不使用 effect 触发级联渲染）。
  const toggleSelectionMode = (): void => {
    if (selectionMode) setSelectedIds(new Set())
    setSelectionMode((v) => !v)
  }

  const toggleSelect = (id: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const selectedAssets = indexed.filter((item) => selectedIds.has(item.id))

  const handleDelete = async (asset: IndexedMediaAsset): Promise<void> => {
    const confirmed = await useConfirmStore.getState().confirm({
      title: `删除素材「${asset.name}」`,
      message: '删除后素材将从项目媒体库移除，引用它的节点会显示素材缺失，此操作不可撤销。',
      confirmText: '删除',
      danger: true
    })
    if (!confirmed) return
    await remove(projectId, asset.id)
    useToastStore.getState().show('素材已删除')
  }

  const handleSaveToLibrary = async (asset: IndexedMediaAsset): Promise<void> => {
    const result = await window.api.captureLibraryMedia({
      projectId,
      mediaId: asset.id,
      title: asset.name ?? '未命名素材'
    })
    if (!result.ok) {
      useToastStore.getState().show(`保存到资源库失败：${result.error.message}`)
      return
    }
    useToastStore.getState().show(`已保存到资源库：${result.data.title}`)
  }

  const locateSource = (asset: IndexedMediaAsset): void => {
    if (!asset.source || !editor) {
      useToastStore.getState().show('该素材没有关联的来源节点')
      return
    }
    const shape = editor.getShape(asset.source.nodeId as never)
    if (!shape) {
      useToastStore.getState().show('来源节点已删除')
      return
    }
    editor.setSelectedShapes([shape.id])
    editor.zoomToSelection({ animation: { duration: 220 } })
  }

  const handleBatchExport = async (list: IndexedMediaAsset[]): Promise<void> => {
    if (!list.length) {
      useToastStore.getState().show('当前没有可导出的素材')
      return
    }
    setExporting(true)
    try {
      const result = await window.api.batchExportMedia(
        projectId,
        list.map((item) => item.id)
      )
      if (!result.ok) {
        if (result.error.code !== 'CANCELLED')
          useToastStore.getState().show(`导出失败：${result.error.message}`)
        return
      }
      if (result.data.exported > 0)
        useToastStore.getState().show(
          `已导出 ${result.data.exported} 个素材到：${result.data.targetDir}`
        )
    } finally {
      setExporting(false)
    }
  }

  return (
    <div
      className={`side-panel-body assets-panel${
        selectionMode ? ' assets-panel-selection-mode' : ''
      }`}
    >
      <div className="assets-source-switch">
        <button
          type="button"
          className={!libraryMode ? 'active' : ''}
          onClick={() => setLibraryMode(false)}
        >
          项目素材
        </button>
        <button
          type="button"
          className={libraryMode ? 'active' : ''}
          onClick={() => setLibraryMode(true)}
        >
          资源库
        </button>
      </div>
      {libraryMode ? (
        <LibraryResourcePicker projectId={projectId} editor={editor} />
      ) : (
        <>
      <label className="assets-search-row">
        <Icon name="search" size={14} />
        <input
          className="assets-search"
          value={keyword}
          placeholder="搜索素材、来源或模型"
          onChange={(e) => setKeyword(e.currentTarget.value)}
        />
      </label>

      <div className="assets-toolbar">
        <button type="button" className="side-panel-primary" onClick={onImport}>
          <Icon name="upload" size={14} />
          导入素材
        </button>
        <button
          type="button"
          className={`assets-toolbar-btn${selectionMode ? ' active' : ''}`}
          aria-pressed={selectionMode}
          onClick={toggleSelectionMode}
        >
          <Icon name="check" size={14} />
          多选导出
        </button>
        <button
          type="button"
          className="assets-toolbar-btn"
          disabled={exporting}
          onClick={() => void handleBatchExport(visible)}
        >
          <Icon name="download" size={14} />
          导出筛选
        </button>
      </div>

      <div className="assets-filters">
        {TYPE_FILTERS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`asset-filter-tab${typeFilter === tab.key ? ' active' : ''}`}
            onClick={() => setTypeFilter(tab.key)}
          >
            {tab.label}
            <i className="asset-filter-count">{formatCount(counts[tab.key] ?? 0)}</i>
          </button>
        ))}
      </div>

      <div className="assets-advanced-filters">
        <AppSelect
          className="assets-filter-select"
          value={sourceNodeId}
          onChange={(e) => setSourceNodeId(e.currentTarget.value)}
          title="按来源节点筛选"
        >
          <option value="all">全部来源</option>
          {sourceOptions.map((option) => (
            <option key={option.nodeId} value={option.nodeId}>
              {option.nodeTitle}
            </option>
          ))}
        </AppSelect>
        <AppSelect
          className="assets-filter-select"
          value={runStatus}
          onChange={(e) => setRunStatus(e.currentTarget.value as MediaRunFilter)}
          title="按运行状态筛选"
        >
          {RUN_STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </AppSelect>
        <AppSelect
          className="assets-filter-select"
          value={timeRange}
          onChange={(e) => setTimeRange(e.currentTarget.value as MediaTimeFilter)}
          title="按时间筛选"
        >
          {TIME_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </AppSelect>
      </div>

      {selectionMode && (
        <div className="assets-batch-bar">
          <span className="assets-batch-count">已选 {selectedIds.size} 个</span>
          <button
            type="button"
            className="assets-batch-btn"
            disabled={selectedIds.size === 0 || exporting}
            onClick={() => void handleBatchExport(selectedAssets)}
          >
            <Icon name="download" size={12} />
            导出所选
          </button>
          <button
            type="button"
            className="assets-batch-btn ghost"
            onClick={() => setSelectedIds(new Set())}
          >
            清除
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="side-panel-empty">没有找到匹配的素材，调整筛选条件或导入新素材。</div>
      ) : (
        <div className="assets-grid">
          {visible.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              selectionMode={selectionMode}
              selected={selectedIds.has(asset.id)}
              onToggleSelect={() => toggleSelect(asset.id)}
              onLocate={() => locateSource(asset)}
              onSaveLibrary={() => void handleSaveToLibrary(asset)}
              onDelete={() => void handleDelete(asset)}
              onDragDrop={(x, y) => onDropMedia(asset, x, y)}
            />
          ))}
        </div>
      )}
        </>
      )}
    </div>
  )
}

function AssetCard({
  asset,
  selectionMode,
  selected,
  onToggleSelect,
  onLocate,
  onSaveLibrary,
  onDelete,
  onDragDrop
}: {
  asset: IndexedMediaAsset
  selectionMode: boolean
  selected: boolean
  onToggleSelect: () => void
  onLocate: () => void
  onSaveLibrary: () => void
  onDelete: () => void
  onDragDrop: (x: number, y: number) => void
}): React.JSX.Element {
  const { startDrag } = useDragToCanvas()
  const isVisual = asset.kind === 'image' || asset.kind === 'video'

  return (
    <article
      className={`asset-card${selected ? ' selected' : ''}`}
      onPointerDown={(e) => {
        if (selectionMode) return
        startDrag(
          e,
          {
            label: asset.name ?? '',
            ...(isVisual
              ? { image: mediaUrl(asset.path) }
              : { icon: kindIcon(asset.kind) })
          },
          onDragDrop
        )
      }}
      onClick={() => {
        if (selectionMode) onToggleSelect()
      }}
    >
      {selectionMode && (
        <button
          type="button"
          className={`asset-check${selected ? ' on' : ''}`}
          aria-label={selected ? '取消选择' : '选择素材'}
          onClick={(e) => {
            e.stopPropagation()
            onToggleSelect()
          }}
        >
          <Icon name="check" size={12} />
        </button>
      )}

      <div className={`asset-thumb kind-${asset.kind}`}>
        {asset.kind === 'image' && (
          <img src={mediaUrl(asset.path)} alt={asset.name} loading="lazy" />
        )}
        {asset.kind === 'video' && (
          <>
            <img src={mediaUrl(asset.path)} alt={asset.name} loading="lazy" />
            <span className="asset-play-badge">
              <Icon name="play" size={11} />
            </span>
          </>
        )}
        {asset.kind === 'audio' && (
          <div className="asset-wave">
            {waveBars(asset.id).map((height, i) => (
              <i key={i} style={{ height: `${height}%` }} />
            ))}
          </div>
        )}
        {asset.kind === 'file' && (
          <span className="asset-thumb-icon">
            <Icon name="document" size={24} />
          </span>
        )}
      </div>

      <div className="asset-info">
        <span className="asset-name" title={asset.name}>
          {asset.name}
        </span>
        <span className="asset-meta">
          {formatSize(asset.sizeBytes)} · {formatTime(asset.createdAt)}
        </span>
      </div>

      <button
        type="button"
        className="asset-locate"
        aria-label="定位来源"
        onClick={(e) => {
          e.stopPropagation()
          onLocate()
        }}
      >
        <Icon name="target" size={12} />
      </button>
      <button
        type="button"
        className="asset-library-save"
        aria-label="保存到资源库"
        onClick={(e) => {
          e.stopPropagation()
          onSaveLibrary()
        }}
      >
        <Icon name="add" size={12} />
      </button>
      <button
        type="button"
        className="asset-delete"
        aria-label="删除素材"
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
