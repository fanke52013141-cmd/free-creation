import { Tldraw, createShapeId, type Editor, type TLShapeId } from 'tldraw'
import 'tldraw/tldraw.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectMeta, MediaAsset, NodeTypeId } from '@shared/types'
import { NodeCardUtil, type NodeCardProps } from './NodeCardShape'
import { NodeCreateMenu } from './NodeCreateMenu'
import { ConnectionLayer } from './ConnectionLayer'
import { CanvasBottomDock } from './CanvasMinimap'
import { MultiSelectToolbar } from './MultiSelectToolbar'
import { NodeActionsDock } from './NodeActionsDock'
import { CanvasSidePanel, type SidePanelTab } from './CanvasSidePanel'
import { ChatSidePanel } from './ChatSidePanel'
import { SearchPalette } from './SearchPalette'
import {
  setConnectionFinishHandler,
  teardownConnectionDrag,
  type ConnectionFinish
} from './connection-drag'
import { deriveGraph, tryConnect } from './graph'
import { markUndoPoint } from './history'
import { getNodeType, allNodeTypes } from '../nodes/registry'
import {
  registerBaseNodeTypes,
  registerScriptNodeType,
  registerExtendedNodeTypes
} from '../nodes/specs'
import { toast } from '../stores/toast'
import type { ConnectionFrom } from '../stores/connection'
import { useGatewayStore } from '../stores/gateway'
import { useEngineStore } from '../engine/store'
import { runWorkflow } from '../engine/executor'
import { useMediaStore } from '../stores/media'
import { useEditorStore } from '../stores/editor'

registerBaseNodeTypes()
registerScriptNodeType()
registerExtendedNodeTypes()

interface CanvasEditorProps {
  project: ProjectMeta
  initialSnapshot: unknown
}

interface MenuState {
  x: number
  y: number
}

export function CanvasEditor({ project, initialSnapshot }: CanvasEditorProps): React.JSX.Element {
  const editorRef = useRef<Editor | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  // 上传提示延迟隐藏定时器：HTML5 dragleave 会因进子元素误触发，用延迟避免闪烁
  const dragHideTimer = useRef<number | null>(null)
  // 快照恢复失败后置位：跳过一切自动保存，避免把空画布写回覆盖原数据
  const restoreFailedRef = useRef(false)
  // 拉线到空白处松手：暂存连线来源，待菜单选定节点类型后自动连线（LibTV 交互）
  const pendingConnectRef = useRef<ConnectionFrom | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dragOver, setDragOver] = useState(false)
  // 在 React 状态中持有 editor，让右下角停靠簇能订阅画布变化（editorRef 变化不会触发重渲染）
  const [editorInstance, setEditorInstance] = useState<Editor | null>(null)
  // 右键侧栏面板：资产 / 工作流 / 历史记录
  const [panelTab, setPanelTab] = useState<SidePanelTab | null>(null)
  // 选中对话节点时弹出右侧聊天面板
  const [chatShapeId, setChatShapeId] = useState<TLShapeId | null>(null)
  // 画布配色：dark（深色）/ light（米黄色）
  const [canvasTheme, setCanvasTheme] = useState<'dark' | 'light'>('dark')
  // 左侧节点面板拖拽状态
  const [nodeDrag, setNodeDrag] = useState<{ type: NodeTypeId; x: number; y: number } | null>(null)
  // 空画布引导：画布无节点时显示新手提示
  const [isEmpty, setIsEmpty] = useState(true)

  // 执行引擎：注册 run 闭包到全局 store，顶部栏通过 store 触发（捕获 editor + projectId + providers）
  const providers = useGatewayStore((s) => s.providers)
  useEffect(() => {
    const run = (): void => {
      const editor = editorRef.current
      if (!editor) return
      void runWorkflow(editor, project.id, providers)
    }
    useEngineStore.getState().register(run)
    return () => {
      // 卸载时清空，避免 stale 闭包残留
      useEngineStore.getState().register(null)
    }
  }, [project.id, providers])

  // 选中对话节点时弹出右侧聊天面板；取消选中或切换其他节点时关闭
  useEffect(() => {
    if (!editorInstance) return
    const check = (): void => {
      const sel = editorInstance.getSelectedShapes()
      if (
        sel.length === 1 &&
        sel[0].type === 'node-card' &&
        (sel[0].props as { nodeType?: string }).nodeType === 'chat'
      ) {
        setChatShapeId(sel[0].id)
      } else {
        setChatShapeId(null)
      }
    }
    check()
    return editorInstance.store.listen(check, { scope: 'session' })
  }, [editorInstance])

  // 空画布检测：有任意 node-card 时隐藏引导提示
  useEffect(() => {
    if (!editorInstance) return
    const check = (): void => {
      setIsEmpty(!editorInstance.getCurrentPageShapes().some((s) => s.type === 'node-card'))
    }
    check()
    return editorInstance.store.listen(check, { scope: 'document' })
  }, [editorInstance])

  // 左侧节点面板：点击在视口中心创建；拖拽到画布在落点创建
  const SIDEBAR_W = 72
  const nodeTypes = allNodeTypes()

  const handleNodePick = (type: NodeTypeId): void => {
    // 点击直接在视口中心创建
    const editor = editorRef.current
    if (!editor) return
    const center = editor.getViewportPageBounds().center
    const screen = editor.pageToScreen(center)
    createNodeAt(type, screen.x, screen.y)
  }

  const startNodeDrag = (e: React.PointerEvent, type: NodeTypeId): void => {
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    let dragged = false

    const onMove = (ev: PointerEvent): void => {
      if (Math.abs(ev.clientX - startX) > 6 || Math.abs(ev.clientY - startY) > 6) {
        dragged = true
      }
      setNodeDrag({ type, x: ev.clientX, y: ev.clientY })
    }
    const onUp = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setNodeDrag(null)
      if (dragged && ev.clientX > SIDEBAR_W) {
        // 拖到画布区域：在落点创建
        createNodeAt(type, ev.clientX, ev.clientY)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // 右键空白画布弹出节点创建菜单
  const handleContextMenu = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement
    if (target.closest('.tl-shape') || target.closest('.tl-overlays') || target.closest('.node-palette') || target.closest('.canvas-dock') || target.closest('.side-panel') || target.closest('.chat-side-panel')) return
    if (!target.closest('.tl-canvas')) return
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  // 保存载荷：快照 + 从 shapes 派生的图数据（nodes/edges，M4 执行引擎的消费源）
  const collectSaveInput = (): {
    id: string
    tldrawSnapshot: unknown
    graph: { nodes: unknown[]; edges: unknown[]; groups: unknown[] }
  } | null => {
    const editor = editorRef.current
    if (!editor) return null
    return {
      id: project.id,
      tldrawSnapshot: editor.store.getStoreSnapshot(),
      graph: deriveGraph(editor)
    }
  }

  const flushSave = (): void => {
    if (restoreFailedRef.current) return
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const input = collectSaveInput()
    if (input) void window.api.saveProject(input)
  }

  useEffect(() => {
    // 关窗时异步 invoke 可能赶不上页面销毁，用同步 IPC 确保落盘
    const onBeforeUnload = (): void => {
      if (restoreFailedRef.current) return
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      const input = collectSaveInput()
      if (input) window.api.saveProjectSync(input)
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      flushSave()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  // 双击空白画布弹节点菜单（LibTV 1.2.1 交互）；捕获阶段拦截，阻止 tldraw 默认建文本
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onDblClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      // 只在 tldraw 画布空白处触发：侧栏/连线开关/菜单等自有 UI（均在 .tl-canvas 外）
      // 双击时不得弹菜单；形状与选中浮层上的双击交给节点自身处理
      if (
        !target.closest('.tl-canvas') ||
        target.closest('.tl-shape') ||
        target.closest('.tl-overlays') ||
        target.closest('.tlui-layout')
      )
        return
      e.preventDefault()
      e.stopPropagation()
      setMenu({ x: e.clientX, y: e.clientY })
    }
    el.addEventListener('dblclick', onDblClick, { capture: true })
    return () => {
      el.removeEventListener('dblclick', onDblClick, { capture: true })
    }
  }, [])

  // 全局快捷键：Ctrl+D 复制选中节点、Ctrl+Shift+F 适配画布
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const editor = editorRef.current
      if (!editor) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        if (e.altKey) return // Shift+Alt+F 整理画布交给小地图
        e.preventDefault()
        editor.zoomToFit({ animation: { duration: 200 } })
        return
      }
      if (mod && (e.key === 'd' || e.key === 'D')) {
        const sel = editor.getSelectedShapeIds().filter((id) => {
          const s = editor.getShape(id)
          return s?.type === 'node-card'
        })
        if (sel.length === 0) return
        e.preventDefault()
        markUndoPoint(editor, 'duplicate-nodes')
        editor.duplicateShapes(sel)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 消费「拉线到空白」的待连线；返回是否成功建线（失败也要打撤销分段点）
  const connectPendingTo = (editor: Editor, targetId: TLShapeId): boolean => {
    const pending = pendingConnectRef.current
    pendingConnectRef.current = null
    if (!pending) return false
    const error = tryConnect(editor, pending, targetId)
    if (error) {
      toast(`未连线：${error}`)
      return false
    }
    return true
  }

  const createNodeAt = (type: NodeTypeId, screenX: number, screenY: number): void => {
    const editor = editorRef.current
    if (!editor) return
    const spec = getNodeType(type)
    if (!spec) return
    const point = editor.screenToPage({ x: screenX, y: screenY })
    const id = createShapeId()
    editor.createShape({
      id,
      type: 'node-card',
      x: point.x - spec.defaultSize.w / 2,
      y: point.y - spec.defaultSize.h / 2,
      props: {
        nodeType: type,
        title: spec.label,
        w: spec.defaultSize.w,
        h: spec.defaultSize.h
      } satisfies Partial<NodeCardProps>
    })
    // 有待连线且成功建线时由 createEdge 统一打点（节点+连线并为一步）；
    // 建线失败（类型不兼容等）或无待连线时，节点创建独立成步
    const connected = connectPendingTo(editor, id)
    if (!connected) markUndoPoint(editor, 'create-node')
  }

  const createMediaNodes = (assets: MediaAsset[], screenX: number, screenY: number): void => {
    const editor = editorRef.current
    if (!editor) return
    let firstId: TLShapeId | null = null
    assets.forEach((asset, i) => {
      // 文本类文件（txt/md/json）：内容直接填进文本节点，可编辑
      const isTextFile = asset.kind === 'file'
      const spec = getNodeType(isTextFile ? 'text' : asset.kind)
      if (!spec) return
      const point = editor.screenToPage({ x: screenX + i * 24, y: screenY + i * 24 })
      const id = createShapeId()
      if (!firstId) firstId = id
      editor.createShape({
        id,
        type: 'node-card',
        x: point.x,
        y: point.y,
        props: {
          nodeType: isTextFile ? 'text' : asset.kind,
          title: asset.name ?? spec.label,
          text: asset.textContent ?? '',
          w: spec.defaultSize.w,
          h: isTextFile ? 200 : spec.defaultSize.h,
          mediaId: asset.id,
          mediaPath: asset.path,
          mediaMime: asset.mime
        } satisfies Partial<NodeCardProps>
      })
    })
    // 建线成功时由 createEdge 打点（导入+连线并为一步）；失败/无待连线时导入独立成步
    const connected = firstId ? connectPendingTo(editor, firstId) : false
    if (!connected) {
      pendingConnectRef.current = null
      markUndoPoint(editor, 'import-media')
    }
  }

  const reportImport = (errors: { path: string; reason: string }[]): void => {
    if (errors.length === 0) return
    const first = errors[0]
    const extra = errors.length > 1 ? ` 等 ${errors.length} 个文件` : ''
    toast(`导入失败：${first.path.split(/[\\/]/).pop()}（${first.reason}）${extra}`)
  }

  const handleUpload = async (screenX: number, screenY: number): Promise<void> => {
    const res = await window.api.pickMedia(project.id)
    if (!res.ok) {
      // 取消/失败都没有新节点，清掉待连线，避免残留到下一次建节点时误连
      pendingConnectRef.current = null
      toast(`上传失败：${res.error.message}`)
      return
    }
    if (res.data.assets.length > 0) {
      createMediaNodes(res.data.assets, screenX, screenY)
    } else {
      // 用户在系统对话框点了取消（返回空 assets）
      pendingConnectRef.current = null
    }
    reportImport(res.data.errors)
  }

  const handleDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    const paths = files.map((f) => window.api.getDroppedFilePath(f))
    const res = await window.api.importMedia({ projectId: project.id, paths })
    if (!res.ok) {
      toast(`导入失败：${res.error.message}`)
      return
    }
    if (res.data.assets.length > 0) createMediaNodes(res.data.assets, e.clientX, e.clientY)
    reportImport(res.data.errors)
  }

  const handleMount = (editor: Editor): void => {
    editorRef.current = editor
    setEditorInstance(editor)
    useEditorStore.getState().setEditor(editor)
    // DEV 调试入口：浏览器 console 可用 window.__tldrawEditor 访问（生产构建自动剔除）
    if (import.meta.env.DEV) {
      ;(window as { __tldrawEditor?: Editor }).__tldrawEditor = editor
    }
    // LibTV 式深色画布（tldraw 默认浅色，与整体 UI 不符）
    editor.user.updateUserPreferences({ colorScheme: 'dark' })
    if (initialSnapshot) {
      try {
        editor.store.loadStoreSnapshot(editor.store.migrateSnapshot(initialSnapshot as never))
      } catch (e) {
        console.error('快照恢复失败', e)
        restoreFailedRef.current = true
        toast('画布数据恢复失败，已暂停自动保存，以防覆盖原有数据', 6000)
        return
      }
    }
    editor.store.listen(
      () => {
        if (restoreFailedRef.current) return
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = setTimeout(flushSave, 800)
      },
      { scope: 'document' }
    )
    // 删除节点时级联清理连线：tldraw 删 shape 时只删其 binding 不删 arrow，会留悬空线。
    // 用 sideEffects 的 afterDelete 钩子同步处理——binding 在 shape 的 beforeDelete 阶段
    // 已被 tldraw 删除，此时遍历箭头找绑定数 < 2 的即为悬空线，随同一次事务删除（可整体撤销）。
    // 异步方案（rAF/microtask）在后台标签页会丢清理时机。
    editor.sideEffects.registerAfterDeleteHandler('shape', (deleted) => {
      if (deleted.type !== 'node-card') return
      const orphaned: TLShapeId[] = []
      for (const shape of editor.getCurrentPageShapes()) {
        if (shape.type !== 'arrow') continue
        if (editor.getBindingsFromShape(shape.id, 'arrow').length < 2) orphaned.push(shape.id)
      }
      if (orphaned.length > 0) editor.deleteShapes(orphaned)
    })
  }

  // 连线松手：命中节点则校验连线；落在空白则暂存来源并弹创建菜单（新节点自动连线）
  const handleConnectionFinish = useCallback((r: ConnectionFinish): void => {
    const editor = editorRef.current
    if (!editor) return
    const pagePt = editor.screenToPage(r.screenPt)
    const target = editor.getShapeAtPoint(pagePt, {
      hitInside: true,
      margin: 6,
      filter: (s) => s.type === 'node-card' && s.id !== r.from.shapeId && !s.isLocked
    })
    if (target) {
      const error = tryConnect(editor, r.from, target.id, pagePt)
      if (error) toast(error)
      return
    }
    pendingConnectRef.current = r.from
    setMenu({ x: r.screenPt.x, y: r.screenPt.y })
  }, [])

  useEffect(() => {
    setConnectionFinishHandler(handleConnectionFinish)
    return () => {
      setConnectionFinishHandler(null)
      teardownConnectionDrag()
    }
  }, [handleConnectionFinish])

  const closeMenu = (): void => {
    pendingConnectRef.current = null
    setMenu(null)
  }

  return (
    <div
      className={`canvas-host canvas-theme-${canvasTheme} ${dragOver ? 'drag-over' : ''}`}
      ref={wrapRef}
      onContextMenu={handleContextMenu}
      onDragEnter={(e) => {
        // 只在拖入真实文件时提示上传；画布内拖动节点/框选等会冒泡 dragover，那些不提示
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        if (dragHideTimer.current) clearTimeout(dragHideTimer.current)
        setDragOver(true)
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => {
        // HTML5 dragleave 在指针移入子元素时也会触发，延迟隐藏避免提示闪烁
        if (dragHideTimer.current) clearTimeout(dragHideTimer.current)
        dragHideTimer.current = window.setTimeout(() => setDragOver(false), 120)
      }}
      onDrop={(e) => void handleDrop(e)}
    >
      <Tldraw
        onMount={handleMount}
        shapeUtils={[NodeCardUtil]}
        components={{
          Toolbar: null,
          StylePanel: null,
          HelpMenu: null,
          PageMenu: null,
          DebugPanel: null,
          MainMenu: null,
          ZoomMenu: null,
          Minimap: null,
          NavigationPanel: null,
          SharePanel: null
        }}
      />
      {/* 左侧节点面板：悬浮图标条，点击创建或拖拽到画布 */}
      <div className="node-palette">
        <div className="palette-section">
          {nodeTypes.map((t) => (
            <button
              key={t.type}
              className="palette-item"
              title={t.label}
              onClick={() => handleNodePick(t.type)}
              onPointerDown={(e) => startNodeDrag(e, t.type)}
            >
              <span className="palette-icon" style={{ color: t.color }}>{t.icon}</span>
            </button>
          ))}
        </div>
        <div className="palette-divider" />
        <div className="palette-section">
          <button
            className="palette-item"
            title="上传本地文件"
            onClick={() => {
              const editor = editorRef.current
              if (!editor) return
              const center = editor.getViewportPageBounds().center
              const screen = editor.pageToScreen(center)
              void handleUpload(screen.x, screen.y)
            }}
          >
            <span className="palette-icon">📂</span>
          </button>
          <button className="palette-item" title="资产管理" onClick={() => setPanelTab('assets')}>
            <span className="palette-icon">📦</span>
          </button>
          <button className="palette-item" title="工作流面板" onClick={() => setPanelTab('workflow')}>
            <span className="palette-icon">⛓</span>
          </button>
          <button className="palette-item" title="历史记录" onClick={() => setPanelTab('history')}>
            <span className="palette-icon">🕘</span>
          </button>
        </div>
        <div className="palette-divider" />
        {/* 画布配色切换 */}
        <button
          className="palette-item"
          title={canvasTheme === 'dark' ? '切换为米黄色' : '切换为深色'}
          onClick={() => {
            const next = canvasTheme === 'dark' ? 'light' : 'dark'
            setCanvasTheme(next)
            editorRef.current?.user.updateUserPreferences({
              colorScheme: next === 'dark' ? 'dark' : 'light'
            })
          }}
        >
          <span className="palette-icon">{canvasTheme === 'dark' ? '☀' : '🌙'}</span>
        </button>
      </div>
      <CanvasBottomDock editor={editorInstance} />
      {/* 多选浮动工具栏：选中 2+ 节点时显示对齐与打组 */}
      {editorInstance && <MultiSelectToolbar editor={editorInstance} />}
      {/* 右侧操作栏：选中节点时常驻显示删除/复制/置顶/置底 */}
      {editorInstance && <NodeActionsDock editor={editorInstance} />}
      {/* 搜索覆盖层（顶栏按钮触发，在 Tldraw 同级渲染） */}
      {editorInstance && <SearchPalette editor={editorInstance} />}
      <CanvasSidePanel
        tab={panelTab}
        projectId={project.id}
        editor={editorInstance}
        onClose={() => setPanelTab(null)}
        onImport={() => {
          const editor = editorRef.current
          if (!editor) return
          const screen = editor.pageToScreen(editor.getViewportPageBounds().center)
          void handleUpload(screen.x, screen.y).then(() => {
            void useMediaStore.getState().refresh(project.id)
          })
        }}
        onAddToCanvas={(asset) => {
          const editor = editorRef.current
          if (!editor) return
          const screen = editor.pageToScreen(editor.getViewportPageBounds().center)
          createMediaNodes([asset], screen.x, screen.y)
        }}
      />
      {/* 对话节点右侧聊天面板 */}
      {chatShapeId && editorInstance && (
        <ChatSidePanel
          editor={editorInstance}
          shapeId={chatShapeId}
          onClose={() => {
            editorInstance.selectNone()
            setChatShapeId(null)
          }}
        />
      )}
      {nodeDrag && (
        <div className="add-drag-ghost" style={{ left: nodeDrag.x + 14, top: nodeDrag.y + 14 }}>
          {getNodeType(nodeDrag.type)?.icon} {getNodeType(nodeDrag.type)?.label}
        </div>
      )}
      {dragOver && <div className="drop-hint">松开鼠标，上传到画布</div>}
      {isEmpty && !menu && !dragOver && (
        <div className="canvas-empty-hint">
          <div className="empty-hint-icon">✛</div>
          <div className="empty-hint-title">开始你的创作</div>
          <div className="empty-hint-desc">
            <span className="empty-hint-kbd">双击</span> 画布空白处创建节点
            <br />
            或从<span className="empty-hint-side">左侧</span>拖拽节点到画布
          </div>
        </div>
      )}
      <ConnectionLayer />
      {menu && (
        <NodeCreateMenu
          x={menu.x}
          y={menu.y}
          onPick={(type) => {
            createNodeAt(type, menu.x, menu.y)
            setMenu(null)
          }}
          onUpload={() => {
            void handleUpload(menu.x, menu.y)
            setMenu(null)
          }}
          onGallery={() => {
            setMenu(null)
            toast('图库功能将在后续版本开放')
          }}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}
