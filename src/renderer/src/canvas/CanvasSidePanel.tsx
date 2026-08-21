// 画布右侧抽屉面板：资产中心 / 工作流 / 历史记录（LibTV 侧栏入口落地）
// 资产中心：项目级媒体库——导入/搜索/筛选/缩略图预览/点击拖到画布/删除
import { useEffect, useRef } from 'react'
import type { MediaAsset, MediaKind } from '@shared/types'
import { mediaUrl } from '../nodes/registry'
import { filteredAssets, useMediaStore } from '../stores/media'

export type SidePanelTab = 'assets' | 'workflow' | 'history'

interface CanvasSidePanelProps {
  tab: SidePanelTab | null
  projectId: string
  onClose: () => void
  /** 把文件导入到画布视角中心（由 CanvasEditor 提供） */
  onImport: () => void
  /** 点击资产 → 添加到画布视角中心 */
  onAddToCanvas: (asset: MediaAsset) => void
}

const TAB_META: Record<SidePanelTab, { title: string; icon: string }> = {
  assets: { title: '资产中心', icon: '📦' },
  workflow: { title: '工作流', icon: '⛓' },
  history: { title: '历史记录', icon: '🕘' }
}

const FILTER_TABS: { key: MediaKind | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
  { key: 'audio', label: '音频' },
  { key: 'file', label: '文件' }
]

const KIND_ICON: Record<MediaKind, string> = {
  image: '🖼️',
  video: '🎥',
  audio: '🎵',
  file: '📄'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ── 资产卡片 ──
function AssetCard({
  asset,
  onAdd,
  onDelete
}: {
  asset: MediaAsset
  onAdd: () => void
  onDelete: () => void
}): React.JSX.Element {
  const hoverRef = useRef<HTMLDivElement>(null)

  return (
    <div
      className="asset-card"
      ref={hoverRef}
      title={`${asset.name ?? asset.id} · ${formatSize(asset.sizeBytes)}`}
      onClick={onAdd}
    >
      <div className="asset-thumb">
        {asset.kind === 'image' ? (
          <img src={mediaUrl(asset.path)} alt={asset.name ?? ''} loading="lazy" draggable={false} />
        ) : (
          <span className="asset-thumb-icon">{KIND_ICON[asset.kind]}</span>
        )}
      </div>
      <div className="asset-info">
        <span className="asset-name">{asset.name ?? asset.id.slice(0, 8)}</span>
        <span className="asset-meta">{formatSize(asset.sizeBytes)}</span>
      </div>
      <button
        className="asset-delete"
        title="删除"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
      >
        ✕
      </button>
    </div>
  )
}

// ── 资产中心面板 ──
function AssetsPanel({
  projectId,
  onImport,
  onAddToCanvas
}: {
  projectId: string
  onImport: () => void
  onAddToCanvas: (asset: MediaAsset) => void
}): React.JSX.Element {
  const assets = useMediaStore((s) => s.assets)
  const filter = useMediaStore((s) => s.filter)
  const keyword = useMediaStore((s) => s.keyword)
  const load = useMediaStore((s) => s.load)
  const remove = useMediaStore((s) => s.remove)
  const setFilter = useMediaStore((s) => s.setFilter)
  const setKeyword = useMediaStore((s) => s.setKeyword)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void load(projectId)
  }, [projectId, load])

  const visible = filteredAssets({ assets, filter, keyword })

  return (
    <div className="side-panel-body assets-panel" ref={scrollRef}>
      <div className="assets-toolbar">
        <button className="side-panel-primary" onClick={onImport}>
          📂 导入素材
        </button>
        <input
          className="assets-search"
          placeholder="搜索素材…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
        />
      </div>
      <div className="assets-filters">
        {FILTER_TABS.map((t) => (
          <button
            key={t.key}
            className={`asset-filter-tab ${filter === t.key ? 'active' : ''}`}
            onClick={() => setFilter(t.key)}
          >
            {t.label}
          </button>
        ))}
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
            />
          ))}
        </div>
      )}
      {assets.length > 0 && (
        <div className="assets-footer">共 {assets.length} 个素材</div>
      )}
    </div>
  )
}

export function CanvasSidePanel({
  tab,
  projectId,
  onClose,
  onImport,
  onAddToCanvas
}: CanvasSidePanelProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!tab) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [tab, onClose])

  if (!tab) return <></>
  const meta = TAB_META[tab]

  return (
    <div className="side-panel" ref={ref}>
      <div className="side-panel-head">
        <span className="side-panel-icon">{meta.icon}</span>
        <strong className="side-panel-title">{meta.title}</strong>
        <button className="side-panel-close" title="关闭" onClick={onClose}>
          ✕
        </button>
      </div>
      {tab === 'assets' && (
        <AssetsPanel
          projectId={projectId}
          onImport={onImport}
          onAddToCanvas={onAddToCanvas}
        />
      )}
      {tab === 'workflow' && (
        <div className="side-panel-body">
          <p className="side-panel-desc">
            工作流用于把常用的节点组合保存为可复用模板，一键套用整段创作链路。
          </p>
          <div className="side-panel-empty">工作流模板功能即将开放。</div>
        </div>
      )}
      {tab === 'history' && (
        <div className="side-panel-body">
          <p className="side-panel-desc">
            这里记录画布的自动保存版本，可随时回溯到任意历史版本。
          </p>
          <div className="side-panel-empty">暂无历史版本，画布会自动保存每次变更。</div>
        </div>
      )}
    </div>
  )
}
