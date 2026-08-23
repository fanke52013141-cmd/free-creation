import { Tldraw, useEditor, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import { useEffect, useState, type CSSProperties } from 'react'
import { useAppData, store } from '../store'
import { ChatNodeUtil } from '../shapes/ChatNode'
import { TextAssetUtil } from '../shapes/TextAsset'
import { OneShotNodeUtil } from '../shapes/OneShotNode'
import { SplitNodeUtil } from '../shapes/SplitNode'
import { MergeNodeUtil } from '../shapes/MergeNode'
import { ImageAssetUtil } from '../shapes/ImageAsset'
import { ImageGenNodeUtil } from '../shapes/ImageGenNode'
import { VideoGenNodeUtil } from '../shapes/VideoGenNode'
import { NODE_REGISTRY, NODE_DRAG_MIME, CATEGORY_LABEL, type NodeMeta } from '../shapes/nodeRegistry'
import { inspectDataGraph } from '../shapes/graph'
import { loadCanvasSnapshot, saveCanvasSnapshot } from '../services/gateway'
import { CanvasProjectProvider } from './CanvasProjectContext'

interface Props {
  projectId: string
  onBack: () => void
}

const customShapeUtils = [ChatNodeUtil, TextAssetUtil, OneShotNodeUtil, SplitNodeUtil, MergeNodeUtil, ImageAssetUtil, ImageGenNodeUtil, VideoGenNodeUtil]

export function CanvasView({ projectId, onBack }: Props) {
  const data = useAppData()
  const project = data.projects.find((p) => p.id === projectId)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [snapshotState, setSnapshotState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  if (!project) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-neutral-400 gap-2">
        <span>项目不存在</span>
        <button onClick={onBack} className="text-blue-500 underline text-sm">
          ← 返回
        </button>
      </div>
    )
  }

  return (
    <div className="canvas-workspace">
      <div className="canvas-column">
        <div className="canvas-topbar">
          <button
            onClick={onBack}
            className="canvas-back"
          >
            <span>←</span> 项目
          </button>
          <span className="canvas-divider" />
          <div className="canvas-project-heading"><span>{project.name}</span>{project.description && <small>{project.description}</small>}</div>
          <span className="canvas-mode-badge">创作画布</span>
          <button
            onClick={() => {
              if (!editor) return
              const report = inspectDataGraph(editor.getCurrentPageShapes())
              const headline = `节点 ${report.nodeCount} 个，数据依赖 ${report.edgeCount} 条`
              alert(report.issues.length ? `${headline}\n\n${report.issues.map((issue) => `【${issue.level === 'error' ? '错误' : '提示'}】${issue.message}`).join('\n')}` : `${headline}\n\n图依赖检查通过。`)
            }}
            disabled={!editor}
            className="canvas-toolbar-button ml-auto"
          >
            图检查
          </button>
          <button
            onClick={async () => {
              if (!editor) return
              setSnapshotState('saving')
              try {
                await saveCanvasSnapshot(project.id, editor.getCurrentPageShapes())
                setSnapshotState('saved')
              } catch {
                setSnapshotState('error')
              }
            }}
            disabled={!editor || snapshotState === 'saving'}
            className="canvas-toolbar-button"
          >
            {snapshotState === 'saving' ? '保存中…' : snapshotState === 'saved' ? '已保存' : snapshotState === 'error' ? '保存失败' : '保存本地快照'}
          </button>
          <button
            onClick={() => {
              if (!editor) return
              const shapes = editor.getCurrentPageShapes().filter((shape) => NODE_REGISTRY.some((meta) => meta.type === shape.type))
              editor.updateShapes(shapes.map((shape) => ({ id: shape.id, type: shape.type, props: { w: 360, h: 360 } })) as never)
            }}
            disabled={!editor}
            className="canvas-toolbar-button"
          >
            统一尺寸
          </button>
          <button
            onClick={() => {
              if (confirm(`复制项目「${project.name}」？新项目为独立空画布。`)) {
                const copy = store.copyProject(project.id)
                if (copy) alert(`已复制为「${copy.name}」`)
              }
            }}
            className="canvas-toolbar-button canvas-toolbar-subtle"
          >
            复制项目
          </button>
        </div>

        {/* tldraw 无限画布；每个项目独立 persistenceKey → 独立持久化 */}
        <div className="canvas-stage">
          <CanvasProjectProvider projectId={projectId}><Tldraw
            persistenceKey={`canvas_${projectId}`}
            shapeUtils={customShapeUtils}
            onMount={(mountedEditor) => {
              setEditor(mountedEditor)
              // The product owns the workspace theme; canvas chrome should not
              // inherit a browser/system light preference.
              mountedEditor.user.updateUserPreferences({ colorScheme: 'dark' })
              void loadCanvasSnapshot(projectId).then((shapes) => {
                if (!shapes?.length || mountedEditor.getCurrentPageShapes().length) return
                mountedEditor.createShapes(shapes as never)
              }).catch(() => undefined)
            }}
            components={{
              // 隐藏 tldraw 默认上下文工具栏（避免与自定义节点交互冲突）
              Toolbar: null,
            }}
          >
            <CanvasDropZone />
          </Tldraw></CanvasProjectProvider>
          <CreatorDock editor={editor} />
        </div>
      </div>
    </div>
  )
}

function CreatorDock({ editor }: { editor: Editor | null }) {
  const [expanded, setExpanded] = useState(false)
  const categories = ['generate', 'asset', 'tool'] as const
  return (
    <div className={`creator-dock ${expanded ? 'is-expanded' : ''}`}>
      <button className="creator-dock-trigger" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span className="creator-dock-plus">+</span><span>添加节点</span><span className="creator-dock-chevron">⌃</span>
      </button>
      {expanded && <div className="creator-dock-menu">
        {categories.map((category) => {
          const nodes = NODE_REGISTRY.filter((node) => node.category === category && node.implemented)
          return <section key={category} className="creator-dock-section"><p>{CATEGORY_LABEL[category]}</p><div>{nodes.map((node) => <NodeIcon key={node.type} node={node} editor={editor} onCreated={() => setExpanded(false)} />)}</div></section>
        })}
      </div>}
    </div>
  )
}

// ===== 单个节点图标（含 tooltip + 拖拽）=====
function NodeIcon({ node, editor, onCreated }: { node: NodeMeta; editor: Editor | null; onCreated?: () => void }) {
  const formatPorts = (ports: NodeMeta['inputs']) => ports.length
    ? ports.map((port) => `${port.name}: ${port.kinds.join(' | ')}${port.optional ? '?' : ''}`).join('; ')
    : '—'

  // 点击：已实现的在视口中心创建
  const handleClick = () => {
    if (!node.implemented || !editor) return
    const position = getNextNodePosition(editor, node)
    editor.createShape({
      type: node.type as any,
      x: position.x,
      y: position.y,
      props: node.defaultSize as any,
    })
    onCreated?.()
  }

  return (
    <div className="relative group creator-node-item">
      <button
        draggable={node.implemented && Boolean(editor)}
        onDragStart={(e) => {
          // 拖拽时带上节点 type
          e.dataTransfer.setData(NODE_DRAG_MIME, node.type)
          e.dataTransfer.effectAllowed = 'copy'
        }}
        onClick={handleClick}
        disabled={!node.implemented || !editor}
        className={`creator-node-button ${
          node.implemented
            ? 'hover:scale-110 cursor-grab active:cursor-grabbing'
            : 'opacity-35 cursor-not-allowed'
        }`}
        style={node.implemented ? { '--node-color': node.color } as CSSProperties : undefined}
        title={node.implemented ? `${node.name}（点击或拖到画布）` : `${node.name}（开发中）`}
      >
        <span className="creator-node-symbol">{node.icon}</span><span>{node.name}</span>
      </button>

      {/* hover tooltip：详细节点信息（右侧弹出）*/}
      <div
        className="creator-node-tooltip pointer-events-none absolute bottom-full mb-3 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50"
        style={{ minWidth: 220 }}
      >
        <div
          className="creator-tooltip-card"
          style={{ borderLeft: `3px solid ${node.color}` }}
        >
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-base">{node.icon}</span>
            <span className="font-semibold text-sm">{node.name}</span>
            {!node.implemented && (
              <span className="ml-auto text-[10px] px-1.5 py-0.5 bg-neutral-700 rounded">
                开发中
              </span>
            )}
          </div>
          <p className="text-neutral-300 leading-relaxed mb-2">{node.desc}</p>
          <div className="space-y-1 pt-1.5 border-t border-neutral-700 text-[11px]">
            <div className="flex gap-1.5">
              <span className="text-neutral-500 shrink-0">输入</span>
              <span className="text-neutral-300 font-mono">{formatPorts(node.inputs)}</span>
            </div>
            <div className="flex gap-1.5">
              <span className="text-neutral-500 shrink-0">输出</span>
              <span className="text-neutral-300 font-mono">{formatPorts(node.outputs)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Place click-created nodes in a compact, non-overlapping working grid. */
function getNextNodePosition(editor: Editor, node: NodeMeta) {
  const center = editor.getViewportPageBounds().center
  const placedCount = editor.getCurrentPageShapes().filter((shape) => NODE_REGISTRY.some((meta) => meta.type === shape.type)).length
  const offsets = [
    { x: -400, y: 0 }, { x: 0, y: 0 }, { x: 400, y: 0 },
    { x: -400, y: 400 }, { x: 0, y: 400 }, { x: 400, y: 400 },
  ]
  const wave = Math.floor(placedCount / offsets.length)
  const offset = offsets[placedCount % offsets.length]
  return {
    x: center.x - node.defaultSize.w / 2 + offset.x,
    y: center.y - node.defaultSize.h / 2 + offset.y + wave * 800,
  }
}

// ===== 画布拖放区：用 document 级监听接收从节点面板拖来的 drop =====
// 注意：不能用 pointerEvents:none 的 overlay（会吞掉 drag 事件），
// 改为在 document 上注册 dragover/drop，最可靠。
function CanvasDropZone() {
  const editor = useEditor()

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes(NODE_DRAG_MIME)) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }
    }
    const onDrop = (e: DragEvent) => {
      const type = e.dataTransfer?.getData(NODE_DRAG_MIME)
      if (!type) return
      const meta = NODE_REGISTRY.find((n) => n.type === type)
      if (!meta || !meta.implemented) return
      e.preventDefault()
      // 把屏幕坐标转成画布坐标
      const pagePoint = editor.screenToPage({ x: e.clientX, y: e.clientY })
      editor.createShape({
        type: meta.type as any,
        x: pagePoint.x - meta.defaultSize.w / 2,
        y: pagePoint.y - meta.defaultSize.h / 2,
        props: meta.defaultSize as any,
      })
    }
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('drop', onDrop)
    }
  }, [editor])

  return null
}
