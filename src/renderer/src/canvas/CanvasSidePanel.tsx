// 画布右侧抽屉面板：资产中心 / 工作流 / 历史记录（LibTV 侧栏入口落地）
// 资产中心：项目级媒体库——导入/搜索/筛选/缩略图预览/点击拖到画布/删除
// 工作流模板：保存选中节点组合为可复用模板，一键套用整段创作链路
/* eslint-disable react-refresh/only-export-components -- 导出内置模板数据供契约回归测试复用，避免重复维护同一组端口连线。 */
import { useEffect, useRef, useState } from 'react'
import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import type { MediaAsset, MediaKind } from '@shared/types'
import { getNodeType, mediaUrl, portCompatible } from '../nodes/registry'
import { filteredAssets, useMediaStore } from '../stores/media'
import {
  extractTemplateFromSelection,
  useWorkflowStore,
  type WorkflowTemplate
} from '../stores/workflow'
import { createEdge } from './graph'
import { markUndoPoint } from './history'
import { toast } from '../stores/toast'
import { useHistorySnapshots, type HistorySnapshot } from '../stores/history-snapshots'
import { Icon, type IconName } from '../components/Icon'

export type SidePanelTab = 'assets' | 'workflow' | 'history'

interface CanvasSidePanelProps {
  tab: SidePanelTab | null
  projectId: string
  editor: Editor | null
  onClose: () => void
  onImport: () => void
  onAddToCanvas: (asset: MediaAsset) => void
}

const TAB_META: Record<SidePanelTab, { title: string; icon: IconName }> = {
  assets: { title: '资产中心', icon: 'assets' },
  workflow: { title: '工作流', icon: 'workflow' },
  history: { title: '历史记录', icon: 'history' }
}

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

// 内置推荐模板（点击直接生成节点组合）
export const BUILTIN_TEMPLATES: {
  name: string
  icon: IconName
  desc: string
  nodes: { type: string; title?: string; text?: string; config?: string; dx: number; dy: number }[]
  edges: { from: number; to: number; fromPort: string; toPort: string }[]
}[] = [
  {
    name: '文本→图片生成',
    icon: 'text',
    desc: '文本节点驱动图片生成',
    nodes: [
      { type: 'text', dx: -190, dy: 0 },
      { type: 'image-gen', dx: 190, dy: 0 }
    ],
    edges: [{ from: 0, to: 1, fromPort: 'out-text', toPort: 'in-text' }]
  },
  {
    name: '文本→AI→JSON→分镜',
    icon: 'script',
    desc: '用普通节点组合结构化分镜流程',
    nodes: [
      { type: 'text', dx: -570, dy: 0 },
      { type: 'chat', dx: -190, dy: 0 },
      { type: 'json', dx: 190, dy: 0 },
      { type: 'storyboard', dx: 570, dy: 0 }
    ],
    edges: [
      { from: 0, to: 1, fromPort: 'out-text', toPort: 'in-text' },
      { from: 1, to: 2, fromPort: 'out-markdown', toPort: 'in-text' },
      { from: 2, to: 3, fromPort: 'out-json', toPort: 'in-json' }
    ]
  },
  {
    name: '文本→处理→代码',
    icon: 'processor',
    desc: '把上游变量显式映射后交给代码处理',
    nodes: [
      { type: 'text', dx: -380, dy: 0 },
      { type: 'processor', dx: 0, dy: 0 },
      { type: 'code', dx: 380, dy: 0 }
    ],
    edges: [
      { from: 0, to: 1, fromPort: 'out-text', toPort: 'in-value' },
      { from: 1, to: 2, fromPort: 'out-value', toPort: 'in-text' }
    ]
  },
  {
    name: '角色→场景→分镜',
    icon: 'json',
    desc: '用可校验结构数据组装一条镜头，并交给分镜板继续编辑',
    nodes: [
      {
        type: 'structured',
        title: '角色设定',
        dx: -800,
        dy: 0,
        config: JSON.stringify({ schema: { id: 'character.profile', version: 1 } }),
        text: JSON.stringify({
          id: 'character-1',
          name: '主角',
          description: '雨夜里坚持追寻真相的人',
          appearance: '深色风衣，短发'
        })
      },
      {
        type: 'structured',
        title: '场景设定',
        dx: -400,
        dy: 0,
        config: JSON.stringify({ schema: { id: 'scene.definition', version: 1 } }),
        text: JSON.stringify({
          id: 'scene-1',
          name: '霓虹雨巷',
          description: '{{input[0].name}} 穿行在雨夜的霓虹街头',
          timeOfDay: '夜晚'
        })
      },
      {
        type: 'structured',
        title: '镜头定义',
        dx: 0,
        dy: 0,
        config: JSON.stringify({ schema: { id: 'shot.definition', version: 1 } }),
        text: JSON.stringify({
          id: 'shot-1',
          scene: '{{input[0].description}}',
          dialogue: '',
          sound: '雨声与远处车流',
          camera: '中近景跟拍',
          duration: '5s'
        })
      },
      {
        type: 'structured',
        title: '分镜结构',
        dx: 400,
        dy: 0,
        config: JSON.stringify({ schema: { id: 'storyboard.shots', version: 1 } }),
        text: JSON.stringify({ shots: ['{{input[0]}}'] })
      },
      { type: 'storyboard', title: '分镜板', dx: 800, dy: 0 }
    ],
    edges: [
      { from: 0, to: 1, fromPort: 'out-json', toPort: 'in-context' },
      { from: 1, to: 2, fromPort: 'out-json', toPort: 'in-context' },
      { from: 2, to: 3, fromPort: 'out-json', toPort: 'in-context' },
      { from: 3, to: 4, fromPort: 'out-json', toPort: 'in-json' }
    ]
  },
  {
    name: '分镜→导演台',
    icon: 'director',
    desc: '分镜数据直接交给导演台进行镜头预演与手动发布',
    nodes: [
      {
        type: 'structured',
        title: '分镜结构',
        dx: -400,
        dy: 0,
        config: JSON.stringify({ schema: { id: 'storyboard.shots', version: 1 } }),
        text: JSON.stringify({
          shots: [
            {
              id: 'shot-1',
              scene: '雨夜街头，人物在霓虹灯下回头',
              dialogue: '',
              sound: '细雨与车流',
              duration: '5s'
            }
          ]
        })
      },
      { type: 'storyboard', title: '分镜板', dx: 0, dy: 0 },
      { type: 'director', title: '导演台', dx: 400, dy: 0 }
    ],
    edges: [
      { from: 0, to: 1, fromPort: 'out-json', toPort: 'in-json' },
      { from: 1, to: 2, fromPort: 'out-json', toPort: 'in-storyboard' }
    ]
  },
  {
    name: '提示词包→生图',
    icon: 'image-gen',
    desc: '以 prompt.bundle@1 明确传递提示词和风格约束',
    nodes: [
      {
        type: 'structured',
        title: '提示词包',
        dx: -200,
        dy: 0,
        config: JSON.stringify({ schema: { id: 'prompt.bundle', version: 1 } }),
        text: JSON.stringify({
          prompt: '电影感雨夜街头，人物在霓虹灯下回头',
          style: '35mm 胶片，浅景深，低饱和青橙色调',
          aspectRatio: '16:9'
        })
      },
      { type: 'image-gen', title: '生图', dx: 200, dy: 0 }
    ],
    edges: [{ from: 0, to: 1, fromPort: 'out-json', toPort: 'in-prompt' }]
  },
  {
    name: '分镜→批量生图',
    icon: 'workflow',
    desc: '分镜逐项生成提示词包并串行生图；支持暂停、续跑和只重跑失败项',
    nodes: [
      {
        type: 'structured',
        title: '分镜结构',
        dx: -800,
        dy: 0,
        config: JSON.stringify({ schema: { id: 'storyboard.shots', version: 1 } }),
        text: JSON.stringify({
          shots: [
            {
              id: 'shot-1',
              scene: '雨夜的霓虹街头，主角回头望向远处车灯',
              dialogue: '',
              sound: '细雨与车流',
              camera: '中近景跟拍',
              duration: '5s'
            },
            {
              id: 'shot-2',
              scene: '镜头拉远，主角走入潮湿的巷口',
              dialogue: '',
              sound: '脚步声与雨声',
              camera: '广角远景',
              duration: '5s'
            }
          ]
        })
      },
      {
        type: 'structured',
        title: '镜头列表',
        dx: -400,
        dy: 0,
        config: JSON.stringify({ schema: { id: 'list.items', version: 1 } }),
        text: '{{input[0].shots}}'
      },
      {
        type: 'iterate',
        title: '逐镜生图',
        dx: 0,
        dy: 0,
        config: JSON.stringify({ onFailure: 'skip', maxRetries: 0, limit: 0, runMode: 'resume' })
      },
      {
        type: 'structured',
        title: '镜头提示词',
        dx: 400,
        dy: 0,
        config: JSON.stringify({ schema: { id: 'prompt.bundle', version: 1 } }),
        text: JSON.stringify({
          prompt: '{{input[0].scene}}。镜头：{{input[0].camera}}。时长：{{input[0].duration}}。',
          style: '电影感分镜，35mm 胶片，浅景深，低饱和青橙色调',
          aspectRatio: '16:9'
        })
      },
      { type: 'image-gen', title: '批量生图', dx: 800, dy: 0 }
    ],
    edges: [
      { from: 0, to: 1, fromPort: 'out-json', toPort: 'in-context' },
      { from: 1, to: 2, fromPort: 'out-json', toPort: 'in-list' },
      { from: 2, to: 3, fromPort: 'out-item', toPort: 'in-context' },
      { from: 3, to: 4, fromPort: 'out-json', toPort: 'in-prompt' }
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
          <span className="asset-thumb-icon">
            <Icon name={KIND_ICON[asset.kind]} size={24} />
          </span>
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
        <Icon name="close" size={13} />
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

  const handleBatchExport = async (): Promise<void> => {
    if (assets.length === 0) {
      toast('暂无素材可导出')
      return
    }
    const res = await window.api.batchExportMedia(projectId)
    if (!res.ok) {
      toast(`导出失败：${res.error.message}`)
      return
    }
    if (res.data.exported === 0 && res.data.targetDir === '') return // 用户取消
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
          title="将项目所有素材导出到指定目录"
          disabled={assets.length === 0}
          onClick={() => void handleBatchExport()}
        >
          <Icon name="download" size={15} /> 批量导出
        </button>
        <input
          className="assets-search"
          placeholder="搜索素材…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
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
    let skippedEdges = 0
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
        const fromSpec = getNodeType(tmpl.nodes[edge.fromIdx]?.nodeType ?? '')
        const toSpec = getNodeType(tmpl.nodes[edge.toIdx]?.nodeType ?? '')
        const fromPort = edge.fromPort
          ? fromSpec?.ports.out.find((port) => port.id === edge.fromPort)
          : fromSpec?.ports.out.length === 1
            ? fromSpec.ports.out[0]
            : undefined
        const compatibleTargets = fromPort
          ? (toSpec?.ports.in.filter((port) => portCompatible(port.type, fromPort.type)) ?? [])
          : []
        const toPort = edge.toPort
          ? compatibleTargets.find((port) => port.id === edge.toPort)
          : compatibleTargets.length === 1
            ? compatibleTargets[0]
            : undefined
        if (!fromPort || !toPort) {
          skippedEdges += 1
          continue
        }
        if (
          !createEdge(
            editor,
            { shapeId: fromId, portId: fromPort.id },
            { shapeId: toId, portId: toPort.id }
          )
        )
          skippedEdges += 1
      }
    })
    markUndoPoint(editor, 'apply-template')
    toast(
      skippedEdges > 0
        ? `已套用「${tmpl.name}」，${skippedEdges} 条旧连线因端口不明确未恢复`
        : `已套用「${tmpl.name}」（${tmpl.nodes.length} 节点）`
    )
  }

  // 套用内置推荐模板
  const handleApplyBuiltin = (builtin: (typeof BUILTIN_TEMPLATES)[number]): void => {
    if (!editor) return
    const center = editor.getViewportPageBounds().center
    const ids: TLShapeId[] = []
    let skippedEdges = 0
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
            title: node.title ?? spec?.label ?? node.type,
            w: spec?.defaultSize.w ?? 260,
            h: spec?.defaultSize.h ?? 160,
            text: node.text ?? '',
            config: node.config ?? ''
          }
        })
      }
      for (const edge of builtin.edges) {
        if (
          !createEdge(
            editor,
            { shapeId: ids[edge.from], portId: edge.fromPort },
            { shapeId: ids[edge.to], portId: edge.toPort }
          )
        )
          skippedEdges += 1
      }
    })
    markUndoPoint(editor, 'apply-builtin')
    toast(
      skippedEdges > 0
        ? `已创建「${builtin.name}」，但有 ${skippedEdges} 条连线不符合当前契约`
        : `已创建「${builtin.name}」`
    )
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
            e.stopPropagation()
            if (e.key === 'Enter') handleSave()
          }}
        />
        <button className="side-panel-primary" onClick={handleSave}>
          <Icon name="copy" size={14} /> 保存选中
        </button>
      </div>
      <p className="side-panel-hint">
        在画布上框选节点，然后点击「保存选中」将其保存为可复用模板。
      </p>

      {/* 内置推荐模板 */}
      <div className="wf-section-title">
        <Icon name="spark" size={13} /> 推荐模板
      </div>
      <div className="wf-builtin-list">
        {BUILTIN_TEMPLATES.map((bt) => (
          <button
            key={bt.name}
            className="wf-builtin-card"
            onClick={() => handleApplyBuiltin(bt)}
            title={bt.desc}
          >
            <span className="wf-builtin-icon">
              <Icon name={bt.icon} size={20} />
            </span>
            <div className="wf-builtin-info">
              <strong>{bt.name}</strong>
              <span>{bt.desc}</span>
            </div>
          </button>
        ))}
      </div>

      {/* 用户保存的模板 */}
      <div className="wf-section-title">
        <Icon name="assets" size={13} /> 我的模板
      </div>
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
                  <Icon name="add" size={13} /> 套用
                </button>
                <button
                  className="wf-action-btn delete"
                  title="删除模板"
                  onClick={() => wfRemove(tmpl.id)}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── 历史版本面板 ──
function HistoryPanel({
  projectId,
  editor
}: {
  projectId: string
  editor: Editor | null
}): React.JSX.Element {
  const snapshots = useHistorySnapshots((s) => s.snapshots)
  const load = useHistorySnapshots((s) => s.load)
  const add = useHistorySnapshots((s) => s.add)
  const remove = useHistorySnapshots((s) => s.remove)
  const [label, setLabel] = useState('')

  useEffect(() => {
    load(projectId)
  }, [projectId, load])

  // 保存当前画布状态为版本快照
  const handleSave = (): void => {
    if (!editor) return
    const snapshot = editor.store.getStoreSnapshot()
    let nodeCount = 0
    for (const s of editor.getCurrentPageShapes()) {
      if (s.type === 'node-card') nodeCount++
    }
    add(projectId, snapshot, nodeCount, label)
    setLabel('')
    toast(`已保存版本（${nodeCount} 节点）`)
  }

  // 回溯到指定版本：加载快照到编辑器，打撤销分段点
  const handleRestore = (snap: HistorySnapshot): void => {
    if (!editor) return
    try {
      editor.store.loadStoreSnapshot(editor.store.migrateSnapshot(snap.snapshot as never))
      markUndoPoint(editor, 'restore-snapshot')
      toast(`已回溯到「${snap.label}」`)
    } catch (e) {
      console.error('版本恢复失败', e)
      toast('版本恢复失败，数据可能已损坏')
    }
  }

  const handleRemove = (id: string): void => {
    remove(projectId, id)
  }

  return (
    <div className="side-panel-body history-panel">
      <div className="history-toolbar">
        <input
          className="wf-name-input"
          placeholder="版本名称（可选）…"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') handleSave()
          }}
        />
        <button className="side-panel-primary" onClick={handleSave} disabled={!editor}>
          <Icon name="history" size={14} /> 保存版本
        </button>
      </div>
      <p className="side-panel-hint">
        手动保存当前画布为版本快照，随时可回溯。最多保留 {30} 个版本。
      </p>
      {snapshots.length === 0 ? (
        <div className="side-panel-empty">暂无历史版本。点击「保存版本」记录当前画布状态。</div>
      ) : (
        <div className="history-list">
          {snapshots.map((snap) => (
            <div key={snap.id} className="history-card">
              <span className="history-card-icon">
                <Icon name="history" size={16} />
              </span>
              <div className="history-card-info">
                <span className="history-card-label">{snap.label}</span>
                <span className="history-card-meta">
                  {formatTime(snap.timestamp)} · {snap.nodeCount} 节点
                </span>
              </div>
              <div className="history-card-actions">
                <button
                  className="history-action-btn restore"
                  title="回溯到此版本"
                  onClick={() => handleRestore(snap)}
                >
                  ↩ 回溯
                </button>
                <button
                  className="history-action-btn delete"
                  title="删除此版本"
                  onClick={() => handleRemove(snap.id)}
                >
                  <Icon name="close" size={13} />
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
        <span className="side-panel-icon">
          <Icon name={meta.icon} size={17} />
        </span>
        <strong className="side-panel-title">{meta.title}</strong>
        <button className="side-panel-close" title="关闭" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </div>
      {tab === 'assets' && (
        <AssetsPanel projectId={projectId} onImport={onImport} onAddToCanvas={onAddToCanvas} />
      )}
      {tab === 'workflow' && <WorkflowPanel editor={editor} />}
      {tab === 'history' && <HistoryPanel projectId={projectId} editor={editor} />}
    </div>
  )
}
