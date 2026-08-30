import { useEffect, useMemo, useRef, useState } from 'react'
import { type Editor, type TLShapeId } from 'tldraw'
import type { MediaAsset, MediaKind } from '@shared/types'
import { mediaUrl } from '../../nodes/registry'
import { filteredAssets, useMediaStore } from '../../stores/media'
import {
  buildMediaAssetIndex,
  mediaSourceOptions,
  type IndexedMediaAsset,
  type MediaRunFilter,
  type MediaTimeFilter
} from '../../assets/media-index'
import type { NodeCardShape } from '../NodeCardShape'
import { toast } from '../../stores/toast'
import { Icon, type IconName } from '../../components/Icon'

const FILTER_TABS: { key: MediaKind | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
  { key: 'audio', label: '音频' },
  { key: 'file', label: '文件' }
]

const KIND_ICON: Record<MediaKind, IconName> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  file: 'document'
}

const RUN_FILTERS: { key: MediaRunFilter; label: string }[] = [
  { key: 'all', label: '全部状态' },
  { key: 'success', label: '成功' },
  { key: 'running', label: '运行中' },
  { key: 'failed', label: '失败' },
  { key: 'skipped', label: '跳过' },
  { key: 'cancelled', label: '已取消' },
  { key: 'unavailable', label: '无运行记录' }
]

const TIME_FILTERS: { key: MediaTimeFilter; label: string }[] = [
  { key: 'all', label: '全部时间' },
  { key: 'today', label: '今天' },
  { key: '7d', label: '最近 7 天' },
  { key: '30d', label: '最近 30 天' }
]

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function AssetCard({
  asset,
  onAdd,
  onDelete,
  onLocate,
  onOpenRun
}: {
  asset: IndexedMediaAsset
  onAdd: () => void
  onDelete: () => void
  onLocate: () => void
  onOpenRun: () => void
}): React.JSX.Element {
  return (
    <div
      className="asset-card"
      title={`${asset.name ?? asset.id} · ${formatSize(asset.sizeBytes)}`}
      onClick={onAdd}
    >
      <div className="asset-thumb">
        {asset.kind === 'image' ? (
          <img src={mediaUrl(asset.path)} alt={asset.name ?? ''} loading="lazy" draggable={false} />
        ) : (
          <span className="asset-thumb-icon">
            <Icon name={KIND_ICON[asset.kind]} size={24} />
          </span>
        )}
      </div>
      <div className="asset-info">
        <span className="asset-name">{asset.name ?? asset.id.slice(0, 8)}</span>
        <span className="asset-meta">
          {formatSize(asset.sizeBytes)} · {formatTime(asset.createdAt)}
        </span>
        {asset.source && (
          <span
            className={`asset-source ${asset.source.runStatus ?? 'unavailable'}`}
            title={`${asset.source.nodeTitle} · ${asset.source.nodeType}${asset.source.modelKey ? ` · ${asset.source.modelKey}` : ''}`}
          >
            <Icon name="target" size={10} />
            {asset.source.nodeTitle}
            {asset.source.isCurrentOutput ? ' · 当前' : ' · 历史'}
          </span>
        )}
      </div>
      {asset.source && (
        <button
          className="asset-locate"
          title="定位到来源节点"
          aria-label="定位到来源节点"
          onClick={(event) => {
            event.stopPropagation()
            onLocate()
          }}
        >
          <Icon name="target" size={12} />
        </button>
      )}
      {asset.source?.runId && (
        <button
          className="asset-run"
          title="查看对应运行记录"
          aria-label="查看对应运行记录"
          onClick={(event) => {
            event.stopPropagation()
            onOpenRun()
          }}
        >
          <Icon name="history" size={12} />
        </button>
      )}
      <button
        className="asset-delete"
        title="删除"
        onClick={(event) => {
          event.stopPropagation()
          onDelete()
        }}
      >
        <Icon name="close" size={13} />
      </button>
    </div>
  )
}

export function AssetsPanel({
  projectId,
  editor,
  onImport,
  onAddToCanvas,
  onOpenRun
}: {
  projectId: string
  editor: Editor | null
  onImport: () => void
  onAddToCanvas: (asset: MediaAsset) => void
  onOpenRun: (nodeId: string, runId: string) => void
}): React.JSX.Element {
  const assets = useMediaStore((state) => state.assets)
  const filter = useMediaStore((state) => state.filter)
  const keyword = useMediaStore((state) => state.keyword)
  const sourceNodeId = useMediaStore((state) => state.sourceNodeId)
  const runStatus = useMediaStore((state) => state.runStatus)
  const timeRange = useMediaStore((state) => state.timeRange)
  const load = useMediaStore((state) => state.load)
  const remove = useMediaStore((state) => state.remove)
  const setFilter = useMediaStore((state) => state.setFilter)
  const setKeyword = useMediaStore((state) => state.setKeyword)
  const setSourceNodeId = useMediaStore((state) => state.setSourceNodeId)
  const setRunStatus = useMediaStore((state) => state.setRunStatus)
  const setTimeRange = useMediaStore((state) => state.setTimeRange)
  const [shapeRevision, setShapeRevision] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void load(projectId)
  }, [projectId, load])
  useEffect(() => {
    if (!editor) return
    return editor.store.listen(() => setShapeRevision((revision) => revision + 1), {
      scope: 'document'
    })
  }, [editor])

  const indexedAssets = useMemo(() => {
    void shapeRevision
    const shapes = editor
      ? editor
          .getCurrentPageShapes()
          .filter((shape): shape is NodeCardShape => shape.type === 'node-card')
      : []
    return buildMediaAssetIndex(assets, shapes)
  }, [assets, editor, shapeRevision])
  const sourceOptions = useMemo(() => mediaSourceOptions(indexedAssets), [indexedAssets])
  const visible = filteredAssets({
    assets: indexedAssets,
    filter,
    keyword,
    sourceNodeId,
    runStatus,
    timeRange
  })

  const locateSource = (asset: IndexedMediaAsset): void => {
    const source = asset.source
    if (!editor || !source) return toast('此素材没有可定位的来源节点')
    const shape = editor.getShape(source.nodeId as TLShapeId)
    if (!shape || shape.type !== 'node-card') return toast('来源节点已删除或不可用')
    editor.setSelectedShapes([shape.id])
    editor.zoomToSelection({ animation: { duration: 220 } })
    toast(`已定位到「${source.nodeTitle}」`)
  }
  const handleBatchExport = async (): Promise<void> => {
    if (visible.length === 0) return toast('当前筛选没有可导出的素材')
    const res = await window.api.batchExportMedia(
      projectId,
      visible.map((asset) => asset.id)
    )
    if (!res.ok) return toast(`导出失败：${res.error.message}`)
    if (res.data.exported === 0 && res.data.targetDir === '') return
    toast(
      res.data.failed > 0
        ? `已导出 ${res.data.exported} 个素材（${res.data.failed} 个失败）`
        : `已导出 ${res.data.exported} 个素材到目标目录`
    )
  }

  return (
    <div className="side-panel-body assets-panel" ref={scrollRef}>
      <div className="assets-toolbar">
        <button className="side-panel-primary" onClick={onImport}>
          <Icon name="upload" size={15} /> 导入素材
        </button>
        <button
          className="side-panel-secondary"
          title="将当前筛选结果导出到指定目录；同名文件不会被覆盖"
          disabled={visible.length === 0}
          onClick={() => void handleBatchExport()}
        >
          <Icon name="download" size={15} /> 导出筛选
        </button>
        <input
          className="assets-search"
          placeholder="搜索素材、来源或模型…"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        />
      </div>
      <div className="assets-filters">
        {FILTER_TABS.map((item) => (
          <button
            key={item.key}
            className={`asset-filter-tab ${filter === item.key ? 'active' : ''}`}
            onClick={() => setFilter(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="assets-advanced-filters" aria-label="资产高级筛选">
        <select
          value={sourceNodeId}
          title="按来源节点筛选"
          onChange={(event) => setSourceNodeId(event.target.value)}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <option value="all">全部来源</option>
          {sourceOptions.map((source) => (
            <option key={source.nodeId} value={source.nodeId}>
              {source.nodeTitle} · {source.nodeType}
            </option>
          ))}
        </select>
        <select
          value={runStatus}
          title="按最近运行状态筛选"
          onChange={(event) => setRunStatus(event.target.value as MediaRunFilter)}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {RUN_FILTERS.map((status) => (
            <option key={status.key} value={status.key}>
              {status.label}
            </option>
          ))}
        </select>
        <select
          value={timeRange}
          title="按生成时间筛选"
          onChange={(event) => setTimeRange(event.target.value as MediaTimeFilter)}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {TIME_FILTERS.map((range) => (
            <option key={range.key} value={range.key}>
              {range.label}
            </option>
          ))}
        </select>
      </div>
      {visible.length === 0 ? (
        <div className="side-panel-empty">
          {assets.length === 0
            ? '暂无素材，点击「导入素材」或拖拽文件到画布开始创作。'
            : '没有匹配的素材。'}
        </div>
      ) : (
        <div className="assets-grid">
          {visible.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              onAdd={() => onAddToCanvas(asset)}
              onDelete={() => void remove(projectId, asset.id)}
              onLocate={() => locateSource(asset)}
              onOpenRun={() => {
                if (asset.source?.runId) onOpenRun(asset.source.nodeId, asset.source.runId)
              }}
            />
          ))}
        </div>
      )}
      {assets.length > 0 && (
        <div className="assets-footer">
          显示 {visible.length} / {assets.length} 个素材
        </div>
      )}
    </div>
  )
}
