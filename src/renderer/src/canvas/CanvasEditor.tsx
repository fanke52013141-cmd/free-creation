import { Tldraw, createShapeId, type Editor, type TLShapeId } from 'tldraw'
import 'tldraw/tldraw.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectMeta, MediaAsset, NodeTypeId } from '@shared/types'
import { Tooltip } from '../components/Tooltip'
import { NodeCardUtil, type NodeCardProps } from './NodeCardShape'
import { repairTldrawSnapshot } from './tldrawSnapshotRepair'
import { NodeCreateMenu } from './NodeCreateMenu'
import { NodeContextMenu } from './NodeContextMenu'
import { ConnectionLayer } from './ConnectionLayer'
import { CanvasBottomDock } from './CanvasMinimap'
import { MultiSelectToolbar } from './MultiSelectToolbar'
import { CanvasSidePanel, type SidePanelTab } from './CanvasSidePanel'
import { ChatSidePanel } from './ChatSidePanel'
import { NodeContractPanel } from './NodeContractPanel'
import { DirectorStudioPanel } from './DirectorStudioPanel'
import { useNodePanelStore } from '../stores/nodePanel'
import { SearchPalette } from './SearchPalette'
import { GroupOutlineLayer } from './GroupOutlineLayer'
import { DataEdgeLayer } from './DataEdgeLayer'
import { useDockMagnify } from './useDockMagnify'
import {
  setConnectionFinishHandler,
  teardownConnectionDrag,
  type ConnectionFinish
} from './connection-drag'
import { deriveGraph, tryConnect, createEdge } from './graph'
import type { AiProcessConfig } from '../engine/executors/aiProcess'
import { markUndoPoint } from './history'
import { getNodeType, allNodeTypes, needsNodeSizeMigration } from '../nodes/registry'
import {
  registerBaseNodeTypes,
  registerScriptNodeType,
  registerExtendedNodeTypes
} from '../nodes/specs'
import { toast } from '../stores/toast'
import type { ConnectionFrom } from '../stores/connection'
import { useGatewayStore } from '../stores/gateway'
import { useEngineStore } from '../engine/store'
import { runWorkflow, runWorkflowForNodes } from '../engine/executor'
import { useMediaStore } from '../stores/media'
import { useEditorStore } from '../stores/editor'
import { Icon } from '../components/Icon'
import { useEdgeSelectionStore } from '../stores/edgeSelection'

registerBaseNodeTypes()
registerScriptNodeType()
registerExtendedNodeTypes()

// ── 一次性旧快照迁移（纯同步，返回迁移数量；由 handleMount 决定是否 toast）──
// 这些函数从 handleMount 抽出以提高可读性，便于单独理解每段迁移的职责与边界。
// 关键约束：迁移必须保持原有执行顺序，且不在迁移期间改变保存时机——
// handleMount 仍按原顺序调用它们，store.listen 注册位置不变。

/** 把兼具「资产 + 生成」旧职责的 image 节点拆分：有生成配置或无媒体的迁移为 image-gen。 */
function migrateLegacyImageGenNodes(editor: Editor): number {
  const updates = editor
    .getCurrentPageShapes()
    .filter((shape): shape is typeof shape & { type: 'node-card' } => shape.type === 'node-card')
    .flatMap((shape) => {
      if (shape.props.nodeType !== 'image') return []
      let hasPromptConfig = false
      try {
        const value = JSON.parse(shape.props.text) as { prompt?: unknown }
        hasPromptConfig = typeof value.prompt === 'string'
      } catch {
        // 空或普通资产文字不代表生图配置。
      }
      if (!hasPromptConfig && shape.props.mediaPath) return []
      return [
        {
          id: shape.id,
          type: 'node-card' as const,
          props: {
            nodeType: 'image-gen',
            title: shape.props.title === '图片' ? '生图' : shape.props.title
          }
        }
      ]
    })
  if (updates.length > 0) editor.updateShapes(updates)
  return updates.length
}

/** 退役旧「分组节点」（成员迁移为 tldraw 原生 group）与「合成节点」（直接移除）。返回迁移的分组数。 */
function migrateRetiredNodes(editor: Editor): number {
  const retiredNodes: TLShapeId[] = []
  let migratedGroups = 0
  for (const current of editor.getCurrentPageShapes()) {
    if (current.type !== 'node-card') continue
    if (current.props.nodeType === 'compose') {
      retiredNodes.push(current.id)
      continue
    }
    if (current.props.nodeType !== 'group') continue
    try {
      const parsed = JSON.parse(current.props.text) as { memberIds?: unknown }
      const memberIds = Array.isArray(parsed.memberIds)
        ? parsed.memberIds.filter(
            (id): id is TLShapeId =>
              typeof id === 'string' && editor.getShape(id as TLShapeId)?.type === 'node-card'
          )
        : []
      if (memberIds.length >= 2) {
        editor.groupShapes(memberIds)
        migratedGroups += 1
      }
    } catch {
      // 损坏的旧分组不阻断项目打开；旧分组卡片仍会被移除。
    }
    retiredNodes.push(current.id)
  }
  if (retiredNodes.length > 0) editor.deleteShapes(retiredNodes)
  return migratedGroups
}

/** 把旧版本默认尺寸或明显异常的超大节点修正为当前标准尺寸。返回修正数量。 */
function migrateLegacyNodeSizes(editor: Editor): number {
  const updates = editor
    .getCurrentPageShapes()
    .filter((shape): shape is typeof shape & { type: 'node-card' } => shape.type === 'node-card')
    .flatMap((shape) => {
      const spec = getNodeType(shape.props.nodeType)
      if (!spec || !needsNodeSizeMigration(shape.props.nodeType, shape.props.w, shape.props.h)) {
        return []
      }
      return [
        {
          id: shape.id,
          type: 'node-card' as const,
          props: { w: spec.defaultSize.w, h: spec.defaultSize.h }
        }
      ]
    })
  if (updates.length > 0) editor.updateShapes(updates)
  return updates.length
}

interface CanvasEditorProps {
  project: ProjectMeta
  initialSnapshot: unknown
  onThemeChange?: (theme: 'dark' | 'light') => void
}

interface CreateMenuState {
  kind: 'create'
  x: number
  y: number
  source?: ConnectionFrom
}

interface NodeMenuState {
  kind: 'node'
  x: number
  y: number
  ids: TLShapeId[]
}

type MenuState = CreateMenuState | NodeMenuState

/**
 * 画布只承载工作流实体，不是通用白板。tldraw 内置的 draw / text / geo 等形状既无法
 * 参与端口契约，又会干扰节点布局；原生 group 仍保留为“分组状态”。
 */
function isWorkflowCanvasShape(shape: { type: string; meta?: Record<string, unknown> }): boolean {
  if (shape.type === 'node-card' || shape.type === 'group') return true
  return (
    shape.type === 'arrow' &&
    typeof shape.meta?.fromPort === 'string' &&
    typeof shape.meta?.toPort === 'string'
  )
}

/** 清理历史快照中遗留的自由笔迹、白板文本等非工作流形状。 */
function removeUnsupportedCanvasShapes(editor: Editor): number {
  const ids = editor
    .getCurrentPageShapes()
    .filter((shape) => shape.type !== 'image' && !isWorkflowCanvasShape(shape))
    .map((shape) => shape.id)
  if (ids.length > 0) editor.deleteShapes(ids)
  return ids.length
}

export function CanvasEditor({
  project,
  initialSnapshot,
  onThemeChange
}: CanvasEditorProps): React.JSX.Element {
  const editorRef = useRef<Editor | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  // 上传提示延迟隐藏定时器：HTML5 dragleave 会因进子元素误触发，用延迟避免闪烁
  const dragHideTimer = useRef<number | null>(null)
  // 节点已拖入画布时，浏览器随后仍会派发 click；拦住它以避免再在视口中心创建一份。
  const suppressNodePickRef = useRef(false)
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
  // 节点右上角 info 图标显式打开的面板目标（选中不触发；对话节点→聊天，其余→契约窗）
  const nodePanelKind = useNodePanelStore((s) => s.kind)
  const nodePanelShapeId = useNodePanelStore((s) => s.shapeId)
  // 画布配色：dark（深色）/ light（米黄色）
  const [canvasTheme, setCanvasTheme] = useState<'dark' | 'light'>('dark')
  // 左侧节点面板拖拽状态
  const [nodeDrag, setNodeDrag] = useState<{ type: NodeTypeId; x: number; y: number } | null>(null)
  // macOS Dock 风格鱼眼放大：左侧节点面板（纵向）+ 底部工具栏（横向）
  const nodeScrollRef = useRef<HTMLDivElement>(null)
  const paletteUtilityRef = useRef<HTMLDivElement>(null)
  const nodeMagnify = useDockMagnify(nodeScrollRef, {
    direction: 'vertical',
    maxScale: 1.42,
    range: 90
  })
  const utilityMagnify = useDockMagnify(paletteUtilityRef, {
    direction: 'horizontal',
    maxScale: 1.32,
    range: 75
  })

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

  // 左侧节点面板：点击在视口中心创建；拖拽到画布在落点创建
  const SIDEBAR_W = 72
  const nodeTypes = allNodeTypes()
  const paletteLabels: Partial<Record<NodeTypeId, string>> = {
    text: '文本',
    image: '图片',
    'image-gen': '生图',
    'image-crop': '裁剪',
    'image-split': '拆分',
    'image-edit': '修改',
    video: '视频',
    'video-frame': '取帧',
    'video-clip': '截取',
    'video-audio': '提音',
    'vocal-separate': '人声分离',
    audio: '音频',
    speech: '配音',
    tts: '克隆',
    chat: '对话',
    script: '脚本',
    processor: '处理',
    json: '数据',
    code: '代码',
    storyboard: '分镜',
    director: '预演'
  }
  const handleNodePick = (type: NodeTypeId): void => {
    if (suppressNodePickRef.current) {
      suppressNodePickRef.current = false
      return
    }
    // 点击直接在视口中心创建
    const editor = editorRef.current
    if (!editor) return
    const center = editor.getViewportPageBounds().center
    const screen = editor.pageToScreen(center)
    createNodeAt(type, screen.x, screen.y)
  }

  const startNodeDrag = (e: React.PointerEvent, type: NodeTypeId): void => {
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
        suppressNodePickRef.current = true
        window.setTimeout(() => {
          suppressNodePickRef.current = false
        }, 0)
        createNodeAt(type, ev.clientX, ev.clientY)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // 右键空白画布弹出创建菜单；右键节点则显示节点操作。
  const handleContextMenu = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement
    if (
      target.closest('.node-palette') ||
      target.closest('.canvas-dock') ||
      target.closest('.side-panel') ||
      target.closest('.chat-side-panel')
    )
      return
    if (!target.closest('.tl-canvas')) return
    e.preventDefault()
    const editor = editorRef.current
    const hit = editor?.getShapeAtPoint(editor.screenToPage({ x: e.clientX, y: e.clientY }), {
      hitInside: true,
      margin: 4,
      filter: (shape) => shape.type === 'node-card'
    })
    if (hit?.type === 'node-card' && editor) {
      const selected = editor
        .getSelectedShapeIds()
        .filter((id) => editor.getShape(id)?.type === 'node-card')
      const ids = selected.includes(hit.id) ? selected : [hit.id]
      if (!selected.includes(hit.id)) editor.select(hit.id)
      setMenu({ kind: 'node', x: e.clientX, y: e.clientY, ids })
      return
    }
    setMenu({ kind: 'create', x: e.clientX, y: e.clientY })
  }

  // 保存载荷：快照 + 从 shapes 派生的图数据（nodes/edges，M4 执行引擎的消费源）
  // expectedGraphVersion 是画布侧乐观锁：外部（Agent/CLI/MCP）写入会推进版本，
  // 本地保存冲突时返回 REVISION_CONFLICT 而不是静默覆盖外部修改。
  const graphVersionRef = useRef<number>(project.graphVersion)

  const collectSaveInput = (): {
    id: string
    tldrawSnapshot: unknown
    graph: { nodes: unknown[]; edges: unknown[]; groups: unknown[] }
    expectedGraphVersion: number
  } | null => {
    const editor = editorRef.current
    if (!editor) return null
    return {
      id: project.id,
      tldrawSnapshot: editor.store.getStoreSnapshot(),
      graph: deriveGraph(editor),
      expectedGraphVersion: graphVersionRef.current
    }
  }

  // 保存冲突时从磁盘重载最新数据：外部写入的 node-card/arrow 已同步进快照，
  // 这里恢复快照即可让 Agent 的新增内容出现在画布上。
  const reloadFromDisk = async (): Promise<void> => {
    const editor = editorRef.current
    if (!editor) return
    const res = await window.api.openProject(project.id)
    if (!res.ok || !res.data) return
    try {
      const repaired = repairTldrawSnapshot(res.data.tldrawSnapshot)
      editor.store.loadStoreSnapshot(editor.store.migrateSnapshot(repaired as never))
      graphVersionRef.current = res.data.meta.graphVersion
      toast('画布外有新的修改，已重新加载最新内容', 4000)
    } catch (e) {
      console.error('冲突重载失败', e)
      restoreFailedRef.current = true
      toast('外部修改加载失败，已暂停自动保存，以防覆盖原有数据', 6000)
    }
  }

  const flushSave = (): void => {
    if (restoreFailedRef.current) return
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const input = collectSaveInput()
    if (!input) return
    void window.api.saveProject(input).then((res) => {
      if (res.ok && res.data) {
        graphVersionRef.current = res.data.graphVersion
      } else if (!res.ok && res.error.code === 'REVISION_CONFLICT') {
        void reloadFromDisk()
      }
    })
  }

  useEffect(() => {
    // 关窗时异步 invoke 可能赶不上页面销毁，用同步 IPC 确保落盘。
    // 关窗时已无法重载冲突数据，这里不带乐观锁：用户当前视图最后写入胜出。
    const onBeforeUnload = (): void => {
      if (restoreFailedRef.current) return
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      const input = collectSaveInput()
      if (input) window.api.saveProjectSync({ ...input, expectedGraphVersion: undefined })
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      flushSave()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  // 画布禁用 tldraw 的默认“双击插入白板文本”行为：节点正文使用自己的编辑器。
  // 文本正文在捕获阶段被拦下后，转发一个专用事件给 TextBody，避免同时出现一张
  // 独立 text shape（截图中的小文本框）和节点内 textarea。
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onDblClickCapture = (event: MouseEvent): void => {
      const target = event.target as HTMLElement
      const textBody = target.closest<HTMLElement>('[data-node-interactive="text-content"]')
      if (textBody) {
        event.preventDefault()
        event.stopPropagation()
        textBody.dispatchEvent(new CustomEvent('canvas:edit-text-node'))
        return
      }
      // 空白画布不再有双击创建入口，也不能被 tldraw 自动插入独立文本框。
      if (!target.closest('.node-card-wrap')) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    el.addEventListener('dblclick', onDblClickCapture, { capture: true })
    return () => el.removeEventListener('dblclick', onDblClickCapture, { capture: true })
  }, [])

  // 禁用 tldraw 的绘制类快捷键；输入控件和常用组合键不受影响。
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const blockedTools = new Set(['a', 'd', 'e', 'g', 'h', 'i', 'k', 'l', 'n', 'r', 't'])
    const onKeyDownCapture = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement
      const typing =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      if (typing || event.ctrlKey || event.metaKey || event.altKey) return
      if (!blockedTools.has(event.key.toLowerCase())) return
      event.preventDefault()
      event.stopPropagation()
      editorRef.current?.setCurrentTool('select')
    }
    el.addEventListener('keydown', onKeyDownCapture, { capture: true })
    return () => el.removeEventListener('keydown', onKeyDownCapture, { capture: true })
  }, [])

  // 全局快捷键：Ctrl+D 复制选中节点、Delete 删除选中连线、Ctrl+Shift+F 适配画布
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const editor = editorRef.current
      if (!editor) return
      // 正在编辑文本（节点内文本/标题、顶栏项目名、各类输入框）时不拦截 Ctrl+D / Ctrl+Shift+F，
      // 避免把"复制选中节点 / 适配画布"等画布操作误注入到用户的输入上下文
      const active = document.activeElement
      const typing =
        !!editor.getEditingShape() ||
        (active instanceof HTMLElement &&
          (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable))
      if (typing) return
      const mod = e.ctrlKey || e.metaKey
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // 数据连线由专用连接层选中，不能平移但可明确断开。
        const selectedDataEdge = useEdgeSelectionStore.getState().selectedEdgeId
        if (selectedDataEdge && editor.getShape(selectedDataEdge as TLShapeId)?.type === 'arrow') {
          e.preventDefault()
          markUndoPoint(editor, 'delete-connections')
          editor.deleteShapes([selectedDataEdge as TLShapeId])
          useEdgeSelectionStore.getState().clear()
          toast('已断开 1 条连线')
          return
        }
        // 兼容历史上曾被 tldraw 默认工具选中的箭头。
        const arrows = editor
          .getSelectedShapes()
          .filter((shape) => shape.type === 'arrow')
          .map((shape) => shape.id)
        if (arrows.length > 0) {
          e.preventDefault()
          markUndoPoint(editor, 'delete-connections')
          editor.deleteShapes(arrows)
          toast(`已断开 ${arrows.length} 条连线`)
          return
        }
      }
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
  const connectPendingTo = (
    editor: Editor,
    targetId: TLShapeId,
    preferredTargetPortId?: string
  ): boolean => {
    const pending = pendingConnectRef.current
    pendingConnectRef.current = null
    if (!pending) return false
    const error = tryConnect(editor, pending, targetId, undefined, preferredTargetPortId)
    if (error) {
      toast(`未连线：${error}`)
      return false
    }
    return true
  }

  const createNodeAt = (
    type: NodeTypeId,
    screenX: number,
    screenY: number,
    preferredTargetPortId?: string
  ): void => {
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
    const connected = connectPendingTo(editor, id, preferredTargetPortId)
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
          h: spec.defaultSize.h,
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

  // 剧本 → 分镜工作流模板（路线图 R3）
  // 一键搭建「文本 → AI处理 → 分镜板」三条节点并预连线：
  //   文本.out-text → AI处理.in-text（剧本文本喂给 AI）
  //   AI处理.out-json → 分镜板.in-json（AI 产出 storyboard.shots，交给分镜板编辑）
  // AI 处理节点预置 json/storyboard.shots@1 输出模式，用户填入剧本即可一键生成分镜。
  const createStoryboardTemplate = (screenX: number, screenY: number): void => {
    const editor = editorRef.current
    if (!editor) return
    const center = editor.screenToPage({ x: screenX, y: screenY })
    const gap = 400
    const cfg: AiProcessConfig = {
      modelKey: '',
      system:
        '你是一位专业的影视分镜导演。请将剧本文本拆解为分镜 JSON 数组。每个元素必须严格包含 scene（画面描述）、dialogue（台词）、sound（音效）、duration（时长）字段。只输出 JSON 数组，不要添加 Markdown。',
      mode: 'json',
      jsonSchema: { id: 'storyboard.shots', version: 1 },
      temperature: 0.7,
      maxTokens: 4096
    }
    const pick = (type: NodeTypeId): { id: TLShapeId; w: number; h: number } => {
      const spec = getNodeType(type)!
      const id = createShapeId()
      return { id, w: spec.defaultSize.w, h: spec.defaultSize.h }
    }
    const textNode = pick('text')
    const aiNode = pick('ai-process')
    const boardNode = pick('storyboard')

    editor.run(() => {
      editor.createShape({
        id: textNode.id,
        type: 'node-card',
        x: center.x - textNode.w / 2 - gap,
        y: center.y - textNode.h / 2,
        props: {
          nodeType: 'text',
          title: '剧本',
          w: textNode.w,
          h: textNode.h
        } satisfies Partial<NodeCardProps>
      })
      editor.createShape({
        id: aiNode.id,
        type: 'node-card',
        x: center.x - aiNode.w / 2,
        y: center.y - aiNode.h / 2,
        props: {
          nodeType: 'ai-process',
          title: 'AI 拆解',
          config: JSON.stringify(cfg),
          w: aiNode.w,
          h: aiNode.h
        } satisfies Partial<NodeCardProps>
      })
      editor.createShape({
        id: boardNode.id,
        type: 'node-card',
        x: center.x - boardNode.w / 2 + gap,
        y: center.y - boardNode.h / 2,
        props: {
          nodeType: 'storyboard',
          title: '分镜板',
          w: boardNode.w,
          h: boardNode.h
        } satisfies Partial<NodeCardProps>
      })
    })
    // 预连线；createEdge 内部成组并打撤销点，三条节点的创建与连线合并为一步。
    createEdge(
      editor,
      { shapeId: textNode.id, portId: 'out-text' },
      { shapeId: aiNode.id, portId: 'in-text' }
    )
    createEdge(
      editor,
      { shapeId: aiNode.id, portId: 'out-json' },
      { shapeId: boardNode.id, portId: 'in-json' }
    )
    markUndoPoint(editor, 'template-storyboard')
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

  const handlePaste = async (e: React.ClipboardEvent): Promise<void> => {
    const imageFiles = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    if (imageFiles.length === 0) return

    // 阻止 tldraw 把剪贴板图片创建成无法参与工作流的原生 image shape。
    e.preventDefault()
    e.stopPropagation()
    const editor = editorRef.current
    if (!editor) return
    const center = editor.pageToScreen(editor.getViewportPageBounds().center)
    const assets: MediaAsset[] = []
    for (const file of imageFiles) {
      const data = new Uint8Array(await file.arrayBuffer())
      const result = await window.api.importMediaBuffer({
        projectId: project.id,
        mime: file.type || 'image/png',
        name: file.name || '粘贴图片',
        data
      })
      if (result.ok) assets.push(result.data)
      else toast(`粘贴失败：${result.error.message}`)
    }
    if (assets.length > 0) {
      createMediaNodes(assets, center.x, center.y)
      void useMediaStore.getState().refresh(project.id)
    }
  }

  const handleMount = (editor: Editor): void => {
    editorRef.current = editor
    setEditorInstance(editor)
    useEditorStore.getState().setEditor(editor)
    // 不能恢复上一次 tldraw 会话遗留的画笔/文本工具；工作流画布始终从选择工具开始。
    editor.setCurrentTool('select')
    // LibTV 式深色画布（tldraw 默认浅色，与整体 UI 不符）
    editor.user.updateUserPreferences({ colorScheme: 'dark' })
    if (initialSnapshot) {
      try {
        const repairedSnapshot = repairTldrawSnapshot(initialSnapshot)
        editor.store.loadStoreSnapshot(editor.store.migrateSnapshot(repairedSnapshot as never))
      } catch (e) {
        console.error('快照恢复失败', e)
        restoreFailedRef.current = true
        toast('画布数据恢复失败，已暂停自动保存，以防覆盖原有数据', 6000)
        return
      }
    }

    // 旧版“图片”兼具资产和生成两种职责：有生成配置或尚无媒体的迁移为“生图”，
    // 已导入的媒体保留为纯图片资产，避免再出现一个节点两种含义。
    const migratedImageGen = migrateLegacyImageGenNodes(editor)
    if (migratedImageGen > 0) toast(`已将 ${migratedImageGen} 个旧图片生成节点迁移为“生图”`)

    // 退役旧“分组节点”：成员关系迁移为 tldraw 原生 group；旧“合成节点”直接移出画布。
    const migratedGroups = migrateRetiredNodes(editor)
    if (migratedGroups > 0) toast(`已将 ${migratedGroups} 个旧分组迁移为画布分组状态`)

    // 兼容旧版本由 tldraw 默认粘贴产生的原生 image shape：成功落盘后再替换为图片节点。
    const rawImages = editor.getCurrentPageShapes().filter((shape) => shape.type === 'image')
    if (rawImages.length > 0) {
      void (async () => {
        let migrated = 0
        for (const raw of rawImages) {
          const assetId = (raw.props as { assetId?: string }).assetId
          if (!assetId) continue
          const asset = editor.getAsset(assetId as Parameters<typeof editor.getAsset>[0])
          const src = (asset?.props as { src?: unknown } | undefined)?.src
          if (typeof src !== 'string' || !src) continue
          try {
            const response = await fetch(src)
            const blob = await response.blob()
            if (!blob.type.startsWith('image/')) continue
            const result = await window.api.importMediaBuffer({
              projectId: project.id,
              mime: blob.type,
              name: (asset?.props as { name?: string } | undefined)?.name || '粘贴图片',
              data: new Uint8Array(await blob.arrayBuffer())
            })
            if (!result.ok) continue
            const screen = editor.pageToScreen({ x: raw.x, y: raw.y })
            createMediaNodes([result.data], screen.x, screen.y)
            editor.deleteShapes([raw.id])
            migrated += 1
          } catch {
            // 远程或已失效的旧资源保留原状，避免丢失画布内容。
          }
        }
        if (migrated > 0) {
          toast(`已将 ${migrated} 张旧粘贴图片转换为可连线图片节点`)
          void useMediaStore.getState().refresh(project.id)
        }
      })()
    }
    const removedUnsupported = removeUnsupportedCanvasShapes(editor)
    if (removedUnsupported > 0) toast(`已移除 ${removedUnsupported} 个不属于工作流的白板元素`)
    editor.store.listen(
      () => {
        if (restoreFailedRef.current) return
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = setTimeout(flushSave, 800)
      },
      { scope: 'document' }
    )
    // 一次性兼容旧快照：只修正旧版本默认尺寸或明显异常的超大节点。
    const resizedNodes = migrateLegacyNodeSizes(editor)
    if (resizedNodes > 0) toast(`已将 ${resizedNodes} 个旧节点调整为标准尺寸`)

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
    // 即使 tldraw 的隐藏快捷键或外部拖放尝试创建默认图形，也在创建后立刻移除，
    // 形成第二道约束，确保画布只保留可参与真实数据依赖的节点/连线/分组。
    editor.sideEffects.registerAfterCreateHandler('shape', (created) => {
      if (!isWorkflowCanvasShape(created)) editor.deleteShapes([created.id])
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
    setMenu({ kind: 'create', x: r.screenPt.x, y: r.screenPt.y, source: r.from })
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
      onPointerDownCapture={(event) => {
        const target = event.target as HTMLElement
        // 防御性重置：默认工具不应参与本应用的节点画布交互。
        if (
          !target.closest('.node-card-wrap') &&
          editorRef.current?.getCurrentToolId() !== 'select'
        ) {
          editorRef.current?.setCurrentTool('select')
        }
        if (!target.closest('.data-edge-hit')) useEdgeSelectionStore.getState().clear()
      }}
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
      onPasteCapture={(e) => void handlePaste(e)}
    >
      <Tldraw
        onMount={handleMount}
        shapeUtils={[NodeCardUtil]}
        cameraOptions={{
          // 默认滚轮平移画布，按住 Ctrl / Cmd 才缩放，符合画布编辑器的常用语义。
          wheelBehavior: 'pan',
          zoomSpeed: 0.85,
          zoomSteps: [0.1, 0.25, 0.5, 1, 2, 4]
        }}
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
      {editorInstance && <GroupOutlineLayer editor={editorInstance} hostRef={wrapRef} />}
      {editorInstance && <DataEdgeLayer editor={editorInstance} hostRef={wrapRef} />}
      {/* 左侧节点面板：悬浮图标条，点击创建或拖拽到画布 */}
      <div className="node-palette">
        <div
          className="palette-node-scroll"
          ref={nodeScrollRef}
          onPointerMove={nodeMagnify.onPointerMove}
          onPointerLeave={nodeMagnify.onPointerLeave}
        >
          <div className="palette-section palette-node-section">
            {nodeTypes.map((t) => (
              <Tooltip
                key={t.type}
                label={'添加' + t.label + '节点'}
                placement="right"
                anchorSelector=".palette-icon"
              >
                <button
                  className="palette-item palette-node-item"
                  aria-label={'添加' + t.label + '节点'}
                  onClick={() => handleNodePick(t.type)}
                  onPointerDown={(e) => startNodeDrag(e, t.type)}
                >
                  <span className="palette-icon" style={{ color: t.color }}>
                    <Icon name={t.icon} size={20} />
                  </span>
                  <span className="palette-label">{paletteLabels[t.type] ?? t.label}</span>
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
      </div>
      <div
        className="palette-utility"
        ref={paletteUtilityRef}
        onPointerMove={utilityMagnify.onPointerMove}
        onPointerLeave={utilityMagnify.onPointerLeave}
      >
        <div className="palette-divider" />
        <div className="palette-section">
          <Tooltip label="上传本地文件">
            <button
              className="palette-item"
              aria-label="上传本地文件"
              onClick={() => {
                const editor = editorRef.current
                if (!editor) return
                const center = editor.getViewportPageBounds().center
                const screen = editor.pageToScreen(center)
                void handleUpload(screen.x, screen.y)
              }}
            >
              <span className="palette-icon">
                <Icon name="upload" size={20} />
              </span>
              <span className="palette-label">上传</span>
            </button>
          </Tooltip>
          <Tooltip label="打开资产管理">
            <button
              className="palette-item"
              aria-label="打开资产管理"
              onClick={() => setPanelTab('assets')}
            >
              <span className="palette-icon">
                <Icon name="assets" size={20} />
              </span>
              <span className="palette-label">资产</span>
            </button>
          </Tooltip>
          <Tooltip label="打开工作流面板">
            <button
              className="palette-item"
              aria-label="打开工作流面板"
              onClick={() => setPanelTab('workflow')}
            >
              <span className="palette-icon">
                <Icon name="workflow" size={20} />
              </span>
              <span className="palette-label">流程</span>
            </button>
          </Tooltip>
          <Tooltip label="打开历史记录">
            <button
              className="palette-item"
              aria-label="打开历史记录"
              onClick={() => setPanelTab('history')}
            >
              <span className="palette-icon">
                <Icon name="history" size={20} />
              </span>
              <span className="palette-label">历史</span>
            </button>
          </Tooltip>
          <Tooltip label="打开运行中心">
            <button
              className="palette-item"
              aria-label="打开运行中心"
              onClick={() => setPanelTab('runs')}
            >
              <span className="palette-icon">
                <Icon name="play" size={20} />
              </span>
              <span className="palette-label">运行</span>
            </button>
          </Tooltip>
        </div>
        <div className="palette-divider" />
        {/* 画布配色切换 */}
        <Tooltip label={canvasTheme === 'dark' ? '切换为浅色画布' : '切换为深色画布'}>
          <button
            className="palette-item"
            aria-label={canvasTheme === 'dark' ? '切换为浅色画布' : '切换为深色画布'}
            onClick={() => {
              const next = canvasTheme === 'dark' ? 'light' : 'dark'
              setCanvasTheme(next)
              onThemeChange?.(next)
              editorRef.current?.user.updateUserPreferences({
                colorScheme: next === 'dark' ? 'dark' : 'light'
              })
            }}
          >
            <span className="palette-icon">
              <Icon name="theme" size={20} />
            </span>
            <span className="palette-label">主题</span>
          </button>
        </Tooltip>
      </div>
      <CanvasBottomDock editor={editorInstance} />
      {/* 多选浮动工具栏：选中 2+ 节点时显示对齐与打组 */}
      {editorInstance && (
        <MultiSelectToolbar
          editor={editorInstance}
          onRunFlow={(ids) => void runWorkflowForNodes(editorInstance, project.id, providers, ids)}
          onSaveWorkflow={() => setPanelTab('workflow')}
        />
      )}
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
        onOpenRuns={() => setPanelTab('runs')}
      />
      {!panelTab && editorInstance && nodePanelKind === 'contract' && nodePanelShapeId && (
        <NodeContractPanel
          editor={editorInstance}
          projectId={project.id}
          providers={providers}
          onClose={() => useNodePanelStore.getState().close()}
        />
      )}
      {/* 对话节点右侧聊天面板（由节点右上角图标显式打开） */}
      {!panelTab && editorInstance && nodePanelKind === 'chat' && nodePanelShapeId && (
        <ChatSidePanel
          editor={editorInstance}
          shapeId={nodePanelShapeId}
          onClose={() => useNodePanelStore.getState().close()}
        />
      )}
      {!panelTab && editorInstance && nodePanelKind === 'director' && nodePanelShapeId && (
        <DirectorStudioPanel
          editor={editorInstance}
          projectId={project.id}
          shapeId={nodePanelShapeId}
          onClose={() => useNodePanelStore.getState().close()}
        />
      )}
      {nodeDrag && (
        <div className="add-drag-ghost" style={{ left: nodeDrag.x + 14, top: nodeDrag.y + 14 }}>
          {getNodeType(nodeDrag.type) && <Icon name={getNodeType(nodeDrag.type)!.icon} size={16} />}{' '}
          {getNodeType(nodeDrag.type)?.label}
        </div>
      )}
      {dragOver && <div className="drop-hint">松开鼠标，上传到画布</div>}
      <ConnectionLayer />
      {menu?.kind === 'create' && (
        <NodeCreateMenu
          x={menu.x}
          y={menu.y}
          onPick={(choice) => {
            createNodeAt(choice.type, menu.x, menu.y, choice.targetPortId)
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
          onTemplate={() => {
            createStoryboardTemplate(menu.x, menu.y)
            setMenu(null)
          }}
          onClose={closeMenu}
          source={menu.source ?? null}
        />
      )}
      {menu?.kind === 'node' && editorInstance && (
        <NodeContextMenu
          editor={editorInstance}
          ids={menu.ids}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}
