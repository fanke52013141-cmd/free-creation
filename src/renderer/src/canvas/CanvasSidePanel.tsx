// 画布右侧抽屉面板：资产中心 / 工作流 / 历史记录（LibTV 侧栏入口落地）
// 资产中心：项目级媒体库——导入/搜索/筛选/缩略图预览/点击拖到画布/删除
// 工作流模板：保存选中节点组合为可复用模板，一键套用整段创作链路
import { useEffect, useRef, useState } from 'react'
import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import type { MediaAsset, MediaKind } from '@shared/types'
import { mediaUrl } from '../nodes/registry'
import { filteredAssets, useMediaStore } from '../stores/media'
import {
  extractTemplateFromSelection,
  useWorkflowStore,
  type WorkflowTemplate
} from '../stores/workflow'
import { createEdge } from './graph'
import { markUndoPoint } from './history'
import { getNodeType } from '../nodes/registry'
import { toast } from '../stores/toast'

export type SidePanelTab = 'assets' | 'workflow' | 'history'

interface CanvasSidePanelProps {
  tab: SidePanelTab | null
  projectId: string
  editor: Editor | null
  onClose: () => void
  onImport: () => void
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

// 内置推荐模板（点击直接生成节点组合）
const BUILTIN_TEMPLATES: {
  name: string
  icon: string
  desc: string
  nodes: { type: string; dx: number; dy: number }[]
  edges: { from: number; to: number }[]
}[] = [
  {
    name: '文本→图片生成',
    icon: '📝',
    desc: '文本节点驱动图片生成',
    nodes: [
      { type: 'text', dx: -160, dy: 0 },
      { type: 'image', dx: 120, dy: 0 }
    ],
    edges: [{ from: 0, to: 1 }]
  },
  {
    name: '脚本→分镜→图片',
    icon: '🎬',
    desc: '脚本拆解为分镜，逐镜生成图片',
    nodes: [
      { type: 'script', dx: -240, dy: 0 },
      { type: 'storyboard', dx: 40, dy: 0 },
      { type: 'image', dx: 320, dy: 0 }
    ],
    edges: [
      { from: 0, to: 1 },
      { from: 1, to: 2 }
    ]
  },
  {
    name: '图片→视频→合成',
    icon: '🎞',
    desc: '多路图片生成视频后合成',
    nodes: [
      { type: 'image', dx: -260, dy: -60 },
      { type: 'image', dx: -260, dy: 80 },
      { type: 'video', dx: 20, dy: -60 },
      { type: 'video', dx: 20, dy: 80 },
      { type: 'compose', dx: 300, dy: 10 }
    ],
    edges: [
      { from: 0, to: 2 },
      { from: 1, to: 3 },
      { from: 2, to: 4 },
      { from: 3, to: 4 }
    ]
  }
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
      {assets.length > 0 && <div className="assets-footer">共 {assets.length} 个素材</div>}
    </div>
  )
}

// ── 工作流模板面板 ──
function WorkflowPanel({ editor }: { editor: Editor | null }): React.JSX.Element {
  const templates = useWorkflowStore((s) => s.templates)
  const wfLoad = useWorkflowStore((s) => s.load)
  const wfSave = useWorkflowStore((s) => s.save)
  const wfRemove = useWorkflowStore((s) => s.remove)
  const [name, setName] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    wfLoad()
  }, [wfLoad])

  // 保存当前选中节点为模板
  const handleSave = (): void => {
    if (!editor) return
    const selected = editor.getSelectedShapes()
    const nodeShapes = selected.filter((s) => s.type === 'node-card')
    if (nodeShapes.length === 0) {
      toast('请先选中要保存为模板的节点（框选或按住 Shift 多选）')
      return
    }
    const nodeIds = new Set(nodeShapes.map((s) => s.id))
    // 找选中节点之间的连线
    const edges: { fromIdx: number; toIdx: number; fromPort?: string; toPort?: string }[] = []
    for (const shape of editor.getCurrentPageShapes()) {
      if (shape.type !== 'arrow') continue
      const meta = shape.meta as Record<string, unknown>
      const bindings = editor.getBindingsFromShape(shape.id, 'arrow')
      const startB = bindings.find((b) => b.props.terminal === 'start')
      const endB = bindings.find((b) => b.props.terminal === 'end')
      if (!startB || !endB) continue
      if (!nodeIds.has(startB.toId) || !nodeIds.has(endB.toId)) continue
      const fromIdx = nodeShapes.findIndex((n) => n.id === startB.toId)
      const toIdx = nodeShapes.findIndex((n) => n.id === endB.toId)
      if (fromIdx < 0 || toIdx < 0) continue
      edges.push({
        fromIdx,
        toIdx,
        fromPort: typeof meta.fromPort === 'string' ? meta.fromPort : undefined,
        toPort: typeof meta.toPort === 'string' ? meta.toPort : undefined
      })
    }
    const data = extractTemplateFromSelection(nodeShapes as never[], edges)
    wfSave(name || `模板 ${templates.length + 1}`, data)
    setName('')
    toast(`已保存模板（${data.nodes.length} 节点 / ${data.edges.length} 连线）`)
  }

  // 套用模板到画布视角中心
  const handleApply = (tmpl: WorkflowTemplate): void => {
    if (!editor) return
    const center = editor.getViewportPageBounds().center
    const ids: TLShapeId[] = []
    editor.run(() => {
      for (const node of tmpl.nodes) {
        const id = createShapeId()
        ids.push(id)
        editor.createShape({
          id,
          type: 'node-card',
          x: center.x + node.dx,
          y: center.y + node.dy,
          props: {
            nodeType: node.nodeType,
            title: node.title,
            w: node.w,
            h: node.h,
            text: node.text ?? '',
            mediaId: node.mediaId,
            mediaPath: node.mediaPath,
            mediaMime: node.mediaMime
          }
        })
      }
      for (const edge of tmpl.edges) {
        const fromId = ids[edge.fromIdx]
        const toId = ids[edge.toIdx]
        if (!fromId || !toId) continue
        createEdge(
          editor,
          { shapeId: fromId, portId: edge.fromPort ?? '' },
          { shapeId: toId, portId: edge.toPort ?? '' }
        )
      }
    })
    markUndoPoint(editor, 'apply-template')
    toast(`已套用「${tmpl.name}」（${tmpl.nodes.length} 节点）`)
  }

  // 套用内置推荐模板
  const handleApplyBuiltin = (builtin: (typeof BUILTIN_TEMPLATES)[number]): void => {
    if (!editor) return
    const center = editor.getViewportPageBounds().center
    const ids: TLShapeId[] = []
    editor.run(() => {
      for (const node of builtin.nodes) {
        const id = createShapeId()
        ids.push(id)
        const spec = getNodeType(node.type)
        editor.createShape({
          id,
          type: 'node-card',
          x: center.x + node.dx,
          y: center.y + node.dy,
          props: {
            nodeType: node.type,
            title: spec?.label ?? node.type,
            w: spec?.defaultSize.w ?? 260,
            h: spec?.defaultSize.h ?? 160
          }
        })
      }
      for (const edge of builtin.edges) {
        createEdge(
          editor,
          { shapeId: ids[edge.from], portId: '' },
          { shapeId: ids[edge.to], portId: '' }
        )
      }
    })
    markUndoPoint(editor, 'apply-builtin')
    toast(`已创建「${builtin.name}」`)
  }

  return (
    <div className="side-panel-body workflow-panel" ref={scrollRef}>
      {/* 保存当前选中 */}
      <div className="wf-save-bar">
        <input
          className="wf-name-input"
          placeholder="模板名称…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave()
          }}
        />
        <button className="side-panel-primary" onClick={handleSave}>
          💾 保存选中
        </button>
      </div>
      <p className="side-panel-hint">
        在画布上框选节点，然后点击「保存选中」将其保存为可复用模板。
      </p>

      {/* 内置推荐模板 */}
      <div className="wf-section-title">⚡ 推荐模板</div>
      <div className="wf-builtin-list">
        {BUILTIN_TEMPLATES.map((bt) => (
          <button
            key={bt.name}
            className="wf-builtin-card"
            onClick={() => handleApplyBuiltin(bt)}
            title={bt.desc}
          >
            <span className="wf-builtin-icon">{bt.icon}</span>
            <div className="wf-builtin-info">
              <strong>{bt.name}</strong>
              <span>{bt.desc}</span>
            </div>
          </button>
        ))}
      </div>

      {/* 用户保存的模板 */}
      <div className="wf-section-title">📦 我的模板</div>
      {templates.length === 0 ? (
        <div className="side-panel-empty">暂无自定义模板。</div>
      ) : (
        <div className="wf-template-list">
          {templates.map((tmpl) => (
            <div key={tmpl.id} className="wf-template-card">
              <div className="wf-template-info">
                <strong className="wf-template-name">{tmpl.name}</strong>
                <span className="wf-template-meta">
                  {tmpl.nodeCount} 节点 · {tmpl.edges.length} 连线 · {formatTime(tmpl.createdAt)}
                </span>
              </div>
              <div className="wf-template-actions">
                <button
                  className="wf-action-btn apply"
                  title="套用模板"
                  onClick={() => handleApply(tmpl)}
                >
                  ➕ 套用
                </button>
                <button
                  className="wf-action-btn delete"
                  title="删除模板"
                  onClick={() => wfRemove(tmpl.id)}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function CanvasSidePanel({
  tab,
  projectId,
  editor,
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
        <AssetsPanel projectId={projectId} onImport={onImport} onAddToCanvas={onAddToCanvas} />
      )}
      {tab === 'workflow' && <WorkflowPanel editor={editor} />}
      {tab === 'history' && (
        <div className="side-panel-body">
          <p className="side-panel-desc">这里记录画布的自动保存版本，可随时回溯到任意历史版本。</p>
          <div className="side-panel-empty">暂无历史版本，画布会自动保存每次变更。</div>
        </div>
      )}
    </div>
  )
}
