import { Tldraw, createShapeId, type Editor, type TLShapeId } from 'tldraw'
import 'tldraw/tldraw.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectMeta, MediaAsset, NodeTypeId } from '@shared/types'
import { NodeCardUtil, type NodeCardProps } from './NodeCardShape'
import { NodeCreateMenu } from './NodeCreateMenu'
import { NodeContextMenu } from './NodeContextMenu'
import { ConnectionLayer } from './ConnectionLayer'
import { CanvasBottomDock } from './CanvasMinimap'
import { MultiSelectToolbar } from './MultiSelectToolbar'
import { CanvasSidePanel, type SidePanelTab } from './CanvasSidePanel'
import { ChatSidePanel } from './ChatSidePanel'
import { NodeContractPanel } from './NodeContractPanel'
import { useNodePanelStore } from '../stores/nodePanel'
import { SearchPalette } from './SearchPalette'
import { GroupOutlineLayer } from './GroupOutlineLayer'
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
import { runWorkflow } from '../engine/executor'
import { useMediaStore } from '../stores/media'
import { useEditorStore } from '../stores/editor'
import { Icon } from '../components/Icon'

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
}

interface CreateMenuState {
  kind: 'create'
  x: number
  y: number
}

interface NodeMenuState {
  kind: 'node'
  x: number
  y: number
  ids: TLShapeId[]
}

type MenuState = CreateMenuState | NodeMenuState

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
  // 节点右上角 info 图标显式打开的面板目标（选中不触发；对话节点→聊天，其余→契约窗）
  const nodePanelKind = useNodePanelStore((s) => s.kind)
  const nodePanelShapeId = useNodePanelStore((s) => s.shapeId)
  // 画布配色：dark（深色）/ light（米黄色）
  const [canvasTheme, setCanvasTheme] = useState<'dark' | 'light'>('dark')
  // 左侧节点面板拖拽状态
  const [nodeDrag, setNodeDrag] = useState<{ type: NodeTypeId; x: number; y: number } | null>(null)

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
    video: '视频',
    audio: '音频',
    chat: '对话',
    script: '脚本',
    processor: '处理',
    json: '数据',
    code: '代码',
    storyboard: '分镜'
  }

  const handleNodePick = (type: NodeTypeId): void => {
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
      setMenu({ kind: 'create', x: e.clientX, y: e.clientY })
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
      // 正在编辑文本（节点内文本/标题、顶栏项目名、各类输入框）时不拦截 Ctrl+D / Ctrl+Shift+F，
      // 避免把"复制选中节点 / 适配画布"等画布操作误注入到用户的输入上下文
      const active = document.activeElement
      const typing =
        !!editor.getEditingShape() ||
        (active instanceof HTMLElement &&
          (active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            active.isContentEditable))
      if (typing) return
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
          text: JSON.stringify(cfg),
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
    setMenu({ kind: 'create', x: r.screenPt.x, y: r.screenPt.y })
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
      onPasteCapture={(e) => void handlePaste(e)}
    >
      <Tldraw
        onMount={handleMount}
        shapeUtils={[NodeCardUtil]}
        cameraOptions={{
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
      {/* 左侧节点面板：悬浮图标条，点击创建或拖拽到画布 */}
      <div className="node-palette">
        <div className="palette-node-scroll">
          <div className="palette-section palette-node-section">
            {nodeTypes.map((t) => (
              <button
                key={t.type}
                className="palette-item palette-node-item"
                title={t.label}
                onClick={() => handleNodePick(t.type)}
                onPointerDown={(e) => startNodeDrag(e, t.type)}
              >
                <span className="palette-icon" style={{ color: t.color }}>
                  <Icon name={t.icon} size={20} />
                </span>
                <span className="palette-label">{paletteLabels[t.type] ?? t.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="palette-utility">
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
              <span className="palette-icon">
                <Icon name="upload" size={20} />
              </span>
            </button>
            <button className="palette-item" title="资产管理" onClick={() => setPanelTab('assets')}>
              <span className="palette-icon">
                <Icon name="assets" size={20} />
              </span>
            </button>
            <button
              className="palette-item"
              title="工作流面板"
              onClick={() => setPanelTab('workflow')}
            >
              <span className="palette-icon">
                <Icon name="workflow" size={20} />
              </span>
            </button>
            <button
              className="palette-item"
              title="历史记录"
              onClick={() => setPanelTab('history')}
            >
              <span className="palette-icon">
                <Icon name="history" size={20} />
              </span>
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
            <span className="palette-icon">
              <Icon name="theme" size={20} />
            </span>
          </button>
        </div>
      </div>
      <CanvasBottomDock editor={editorInstance} />
      {/* 多选浮动工具栏：选中 2+ 节点时显示对齐与打组 */}
      {editorInstance && <MultiSelectToolbar editor={editorInstance} />}
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
      {!panelTab && editorInstance && nodePanelKind === 'contract' && nodePanelShapeId && (
        <NodeContractPanel
          editor={editorInstance}
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
          onTemplate={() => {
            createStoryboardTemplate(menu.x, menu.y)
            setMenu(null)
          }}
          onClose={closeMenu}
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
