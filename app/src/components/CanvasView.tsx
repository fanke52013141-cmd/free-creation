import { Tldraw, useEditor } from 'tldraw'
import 'tldraw/tldraw.css'
import { useEffect } from 'react'
import { useAppData, store } from '../store'
import { ChatNodeUtil } from '../shapes/ChatNode'
import { TextAssetUtil } from '../shapes/TextAsset'
import { NODE_REGISTRY, NODE_DRAG_MIME, CATEGORY_LABEL, type NodeMeta } from '../shapes/nodeRegistry'

interface Props {
  projectId: string
  onBack: () => void
}

const customShapeUtils = [ChatNodeUtil, TextAssetUtil]

export function CanvasView({ projectId, onBack }: Props) {
  const data = useAppData()
  const project = data.projects.find((p) => p.id === projectId)

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
    <div className="flex-1 flex min-h-0">
      {/* 左侧节点面板：竖排图标 + tooltip + 拖拽 */}
      <NodePanel />

      {/* 中间：顶栏 + 画布 */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 顶栏 */}
        <div className="h-12 border-b border-neutral-200 bg-white flex items-center px-4 gap-3 shrink-0 z-20">
          <button
            onClick={onBack}
            className="text-sm text-neutral-500 hover:text-neutral-800 transition-colors"
          >
            ← 返回
          </button>
          <span className="w-px h-4 bg-neutral-200" />
          <span className="font-medium text-neutral-800">{project.name}</span>
          <span className="ml-2 text-xs text-neutral-400">{project.description}</span>
          <button
            onClick={() => {
              if (confirm(`复制项目「${project.name}」？新项目为独立空画布。`)) {
                const copy = store.copyProject(project.id)
                if (copy) alert(`已复制为「${copy.name}」`)
              }
            }}
            className="ml-auto text-xs text-neutral-400 hover:text-neutral-600 px-2 py-1 rounded hover:bg-neutral-100"
          >
            复制项目
          </button>
        </div>

        {/* tldraw 无限画布；每个项目独立 persistenceKey → 独立持久化 */}
        <div className="flex-1 relative min-h-0">
          <Tldraw
            persistenceKey={`canvas_${projectId}`}
            shapeUtils={customShapeUtils}
            components={{
              // 隐藏 tldraw 默认上下文工具栏（避免与自定义节点交互冲突）
              Toolbar: null,
            }}
          >
            <CanvasDropZone />
          </Tldraw>
        </div>
      </div>
    </div>
  )
}

// ===== 左侧节点面板：竖排图标 + 分类 + tooltip + 拖拽 =====
function NodePanel() {
  // 按分类分组
  const categories = ['generate', 'asset', 'process', 'tool'] as const

  return (
    <aside className="w-16 h-full bg-white border-r border-neutral-200 flex flex-col shrink-0 z-30">
      <div className="h-12 flex items-center justify-center border-b border-neutral-200 shrink-0">
        <span className="text-base" title="节点">◉</span>
      </div>
      <div className="flex-1 overflow-y-auto py-2 no-scrollbar">
        {categories.map((cat, idx) => {
          const nodes = NODE_REGISTRY.filter((n) => n.category === cat)
          return (
            <div key={cat} className={idx > 0 ? 'mt-3 pt-3 border-t border-neutral-100' : ''}>
              <div className="text-[9px] text-neutral-400 text-center mb-1 select-none">
                {CATEGORY_LABEL[cat]}
              </div>
              <div className="flex flex-col items-center gap-1 px-1.5">
                {nodes.map((node) => (
                  <NodeIcon key={node.type} node={node} />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}

// ===== 单个节点图标（含 tooltip + 拖拽）=====
function NodeIcon({ node }: { node: NodeMeta }) {
  const editor = useEditor()

  // 点击：已实现的在视口中心创建
  const handleClick = () => {
    if (!node.implemented) return
    const center = editor.getViewportPageBounds().center
    editor.createShape({
      type: node.type as any,
      x: center.x - node.w / 2,
      y: center.y - node.h / 2,
      props: { w: node.w, h: node.h } as any,
    })
  }

  return (
    <div className="relative group flex items-center justify-center">
      <button
        draggable={node.implemented}
        onDragStart={(e) => {
          // 拖拽时带上节点 type
          e.dataTransfer.setData(NODE_DRAG_MIME, node.type)
          e.dataTransfer.effectAllowed = 'copy'
        }}
        onClick={handleClick}
        disabled={!node.implemented}
        className={`w-11 h-11 flex items-center justify-center rounded-lg text-lg transition-all ${
          node.implemented
            ? 'hover:scale-110 cursor-grab active:cursor-grabbing'
            : 'opacity-35 cursor-not-allowed'
        }`}
        style={
          node.implemented
            ? { backgroundColor: `${node.color}15`, color: node.color }
            : undefined
        }
        title={node.implemented ? `${node.name}（点击或拖到画布）` : `${node.name}（开发中）`}
      >
        {node.icon}
      </button>

      {/* hover tooltip：详细节点信息（右侧弹出）*/}
      <div
        className="pointer-events-none absolute left-full ml-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50"
        style={{ minWidth: 220 }}
      >
        <div
          className="bg-neutral-900 text-white rounded-lg shadow-xl px-3 py-2.5 text-xs"
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
              <span className="text-neutral-300 font-mono">{node.inputs}</span>
            </div>
            <div className="flex gap-1.5">
              <span className="text-neutral-500 shrink-0">输出</span>
              <span className="text-neutral-300 font-mono">{node.outputs}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
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
        x: pagePoint.x - meta.w / 2,
        y: pagePoint.y - meta.h / 2,
        props: { w: meta.w, h: meta.h } as any,
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
