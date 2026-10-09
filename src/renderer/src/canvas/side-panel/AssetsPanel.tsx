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
import { useConfirmStore } from '../../stores/confirm'
import { Icon, type IconName } from '../../components/Icon'
import { AppSelect } from '../../components/AppSelect'
import { LibraryResourcePicker } from '../../library/LibraryResourcePicker'

import type { ArtifactRecipe } from '@shared/artifact-recipe'

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

// 计数压缩规则：小于 1000 显示精确值；1000–9999 一位小数（1.2k）；≥10000 取整 k（10k），
// 保证筛选 chips 在窄面板下宽度可控
function formatCount(count: number): string {
  if (count < 1000) return String(count)
  if (count < 10000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.round(count / 1000)}k`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

// 纯装饰：由素材 ID 确定性地生成一排波形条高度，同一素材每次渲染一致
function waveBars(id: string, count = 21): number[] {
  let seed = 0
  for (let index = 0; index < id.length; index++) seed = (seed * 31 + id.charCodeAt(index)) >>> 0
  const bars: number[] = []
  for (let index = 0; index < count; index++) {
    seed = (seed * 1103515245 + 12345) >>> 0
    bars.push(24 + ((seed >>> 8) % 66))
  }
  return bars
}

function AssetCard({
  asset,
  projectId,
  onAdd,
  onDelete,
  onLocate,
  onOpenRun,
  onSaveToLibrary,
  savingToLibrary,
  selectMode,
  selected,
  onToggleSelect
}: {
  asset: IndexedMediaAsset
  projectId: string
  onAdd: () => void
  onDelete: () => void
  onLocate: () => void
  onOpenRun: () => void
  onSaveToLibrary: () => void
  savingToLibrary: boolean
  selectMode: boolean
  selected: boolean
  onToggleSelect: () => void
}): React.JSX.Element {
  const [imageFailed, setImageFailed] = useState(false)
  const [recipe, setRecipe] = useState<ArtifactRecipe | null>(null)
  const [recipeOpen, setRecipeOpen] = useState(false)
  const [recipeMessage, setRecipeMessage] = useState('读取中…')
  const name =
    asset.name ??
    `${asset.kind === 'image' ? '图片' : asset.kind === 'video' ? '视频' : asset.kind === 'audio' ? '音频' : '文件'}素材-${asset.id.slice(0, 6)}`
  const handleCardActivate = (): void => {
    if (selectMode) onToggleSelect()
    else onAdd()
  }
  return (
    <div
      className={`asset-card${recipeOpen ? ' recipe-open' : ''}${selected ? ' selected' : ''}`}
      role="button"
      tabIndex={0}
      title={`${name} · ${formatSize(asset.sizeBytes)}`}
      aria-label={selectMode ? `${selected ? '取消选择' : '选择'} ${name}` : `添加 ${name} 到画布`}
      aria-pressed={selectMode ? selected : undefined}
      onClick={handleCardActivate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          handleCardActivate()
        }
      }}
    >
      <div className={`asset-thumb kind-${asset.kind}`}>
        {selectMode && (
          <span className={`asset-check${selected ? ' on' : ''}`} aria-hidden="true">
            <Icon name="check" size={12} />
          </span>
        )}
        {asset.kind === 'image' && !imageFailed ? (
          <img
            src={mediaUrl(asset.path)}
            alt={name}
            loading="lazy"
            draggable={false}
            onError={() => setImageFailed(true)}
          />
        ) : asset.kind === 'audio' && !imageFailed ? (
          <span className="asset-wave" aria-hidden="true">
            {waveBars(asset.id).map((height, index) => (
              <i key={index} style={{ height: `${height}%` }} />
            ))}
          </span>
        ) : (
          <span className={`asset-thumb-icon${imageFailed ? ' failed' : ''}`}>
            <Icon name={KIND_ICON[asset.kind]} size={28} />
            {imageFailed && <small>图片不可读取</small>}
          </span>
        )}
      </div>
      <div className="asset-info">
        <div className="asset-info-head">
          <span className="asset-name">{name}</span>
          <button
            type="button"
            className="asset-recipe-chip"
            aria-expanded={recipeOpen}
            title="查看此素材的生成来源（提示词与参数）"
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              if (recipeOpen) {
                setRecipeOpen(false)
                return
              }
              setRecipeOpen(true)
              setRecipe(null)
              setRecipeMessage('读取中…')
              void window.api
                .getArtifactRecipe({ projectId, mediaId: asset.id })
                .then((result) => {
                  if (result.ok) {
                    setRecipe(result.data)
                    setRecipeMessage(result.data ? '' : '历史记录不完整：此素材没有独立生成来源记录')
                  } else setRecipeMessage('生成来源读取失败，请重试')
                })
                .catch(() => setRecipeMessage('生成来源读取失败，请重试'))
            }}
          >
            <Icon name="history" size={11} />
            生成来源
          </button>
        </div>
        {recipeOpen && (
          <div
            className="asset-recipe"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {recipeMessage && <p>{recipeMessage}</p>}
            {recipe && (
              <>
                <p>
                  {recipe.nodeType} · 契约 v{recipe.contractVersion} ·{' '}
                  {recipe.modelKey ?? '未记录模型'} · {formatTime(recipe.createdAt)}
                </p>
                <p>
                  运行：{recipe.runId} · 输入媒体：{recipe.inputMediaIds.length} 项
                  {recipe.missingInputMediaIds?.length
                    ? ` · ${recipe.missingInputMediaIds.length} 项来源媒体未随项目导入`
                    : ''}
                </p>
                <label>
                  提交提示词或朗读正文
                  <textarea readOnly value={recipe.fullPrompt} />
                </label>
                <label>
                  运行参数
                  <textarea readOnly value={recipe.paramsJson} />
                </label>
                <small>记录用于追溯，不会自动重新生成；本地处理无提示词时仅记录处理参数。</small>
              </>
            )}
          </div>
        )}
        <span className="asset-meta">
          {formatSize(asset.sizeBytes)} · {formatTime(asset.createdAt)}
        </span>
        {asset.source && (
          <span
            className={`asset-source ${asset.source.runStatus ?? 'unavailable'}`}
            title={`${asset.source.nodeTitle} · ${asset.source.nodeType}${asset.source.modelKey ? ` · ${asset.source.modelKey}` : ''}${asset.source.voiceId ? ` · ${asset.source.voiceId}` : ''}`}
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
        className="asset-library-save"
        title="保存到资源库"
        aria-label={`保存素材 ${name} 到资源库`}
        disabled={savingToLibrary}
        onClick={(event) => {
          event.stopPropagation()
          onSaveToLibrary()
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Icon name="assets" size={12} />
      </button>
      <button
        className="asset-delete"
        title="删除"
        aria-label={`删除素材 ${asset.name ?? asset.id}`}
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
  onOpenRun,
  selectionMode
}: {
  projectId: string
  editor: Editor | null
  onImport: () => void
  onAddToCanvas: (asset: MediaAsset) => void
  onOpenRun: (nodeId: string, runId: string) => void
  selectionMode: boolean
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
  const [libraryMode, setLibraryMode] = useState(false)
  const [savingMediaId, setSavingMediaId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)

  // 退出多选模式时清空选择（渲染期同步调整，避免 effect 双渲染）
  const [lastSelectionMode, setLastSelectionMode] = useState(selectionMode)
  if (lastSelectionMode !== selectionMode) {
    setLastSelectionMode(selectionMode)
    if (!selectionMode) setSelectedIds(new Set())
  }

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
  const kindCounts = useMemo(() => {
    const counts: Record<MediaKind | 'all', number> = {
      all: indexedAssets.length,
      image: 0,
      video: 0,
      audio: 0,
      file: 0
    }
    for (const asset of indexedAssets) counts[asset.kind]++
    return counts
  }, [indexedAssets])
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
  const handleDelete = async (asset: IndexedMediaAsset): Promise<void> => {
    const name = asset.name ?? asset.id
    if (
      !(await useConfirmStore.getState().confirm({
        title: `删除素材「${name}」`,
        message: '删除后素材文件将从项目中移除，不可恢复。',
        confirmText: '删除',
        danger: true
      }))
    )
      return
    await remove(projectId, asset.id)
  }
  const handleSaveToLibrary = async (asset: IndexedMediaAsset): Promise<void> => {
    setSavingMediaId(asset.id)
    try {
      const result = await window.api.captureLibraryMedia({
        projectId,
        mediaId: asset.id,
        title: asset.name ?? `${asset.kind}素材-${asset.id.slice(0, 6)}`
      })
      if (!result.ok) return toast(`保存失败：${result.error.message}`)
      toast(`已将「${result.data.selectedTitle}」保存到资源库`)
    } catch (error) {
      toast(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSavingMediaId(null)
    }
  }
  const handleBatchExport = async (ids: Iterable<string>): Promise<void> => {
    const idList = [...ids]
    if (idList.length === 0) return toast('当前筛选没有可导出的素材')
    const res = await window.api.batchExportMedia(projectId, idList)
    if (!res.ok) return toast(`导出失败：${res.error.message}`)
    if (res.data.exported === 0 && res.data.targetDir === '') return
    toast(
      res.data.failed > 0
        ? `已导出 ${res.data.exported} 个素材（${res.data.failed} 个失败）`
        : `已导出 ${res.data.exported} 个素材到目标目录`
    )
  }
  const toggleSelected = (id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div
      className={`side-panel-body assets-panel${selectionMode ? ' assets-panel-selection-mode' : ''}`}
      ref={scrollRef}
    >
      <div className="assets-source-switch">
        <button className={!libraryMode ? 'active' : ''} onClick={() => setLibraryMode(false)}>
          项目素材
        </button>
        <button className={libraryMode ? 'active' : ''} onClick={() => setLibraryMode(true)}>
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
              placeholder="搜索素材、来源或模型…"
              aria-label="搜索素材"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            />
          </label>
          <div className="assets-toolbar">
            <button className="side-panel-primary" onClick={onImport}>
              <Icon name="upload" size={15} /> 导入素材
            </button>
            <button
              className="side-panel-secondary assets-toolbar-btn"
              onClick={() => {
                if (!editor || !editor.getSelectedShapeIds().length)
                  return toast('先选择要使用的产物')
                editor.zoomToSelection({ animation: { duration: 220 } })
              }}
            >
              <Icon name="target" size={14} /> 定位选用结果
            </button>
            <button
              className="side-panel-secondary assets-toolbar-btn"
              title="将当前筛选结果导出到指定目录；同名文件不会被覆盖"
              disabled={visible.length === 0}
              onClick={() => void handleBatchExport(visible.map((asset) => asset.id))}
            >
              <Icon name="download" size={14} /> 导出筛选
            </button>
          </div>
          {selectionMode && (
            <div className="assets-batch-bar">
              <span className="assets-batch-count">
                已选 {formatCount(selectedIds.size)} / {formatCount(visible.length)} 个素材
              </span>
              <button
                className="assets-batch-btn"
                disabled={selectedIds.size === 0}
                onClick={() => void handleBatchExport(selectedIds)}
              >
                <Icon name="download" size={13} /> 导出所选
              </button>
              {selectedIds.size > 0 && (
                <button
                  className="assets-batch-btn ghost"
                  onClick={() => setSelectedIds(new Set())}
                >
                  清除
                </button>
              )}
            </div>
          )}
          <div className="assets-filters">
            {FILTER_TABS.map((item) => (
              <button
                key={item.key}
                className={`asset-filter-tab ${filter === item.key ? 'active' : ''}`}
                onClick={() => setFilter(item.key)}
              >
                {item.label}
                {kindCounts[item.key] > 0 && (
                  <em className="asset-filter-count">{formatCount(kindCounts[item.key])}</em>
                )}
              </button>
            ))}
          </div>
          <div className="assets-advanced-filters" aria-label="资产高级筛选">
            <AppSelect
              className="asset-filter-select"
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
            </AppSelect>
            <AppSelect
              className="asset-filter-select"
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
            </AppSelect>
            <AppSelect
              className="asset-filter-select"
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
            </AppSelect>
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
                  projectId={projectId}
                  key={asset.id}
                  asset={asset}
                  selectMode={selectionMode}
                  selected={selectedIds.has(asset.id)}
                  onToggleSelect={() => toggleSelected(asset.id)}
                  onAdd={() => onAddToCanvas(asset)}
                  onDelete={() => void handleDelete(asset)}
                  onLocate={() => locateSource(asset)}
                  onOpenRun={() => {
                    if (asset.source?.runId) onOpenRun(asset.source.nodeId, asset.source.runId)
                  }}
                  onSaveToLibrary={() => void handleSaveToLibrary(asset)}
                  savingToLibrary={savingMediaId === asset.id}
                />
              ))}
            </div>
          )}
          {assets.length > 0 && (
            <div className="assets-footer">
              显示 {visible.length} / {assets.length} 个素材
            </div>
          )}
        </>
      )}
    </div>
  )
}
