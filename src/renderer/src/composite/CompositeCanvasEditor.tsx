import { useEffect, useRef, useState } from 'react'
import { createShapeId, Tldraw, type Editor, type TLShapeId } from 'tldraw'
import type { CompositeCapabilitySummary } from '@shared/composite/types'
import type { CompositeManifest } from '@shared/composite/manifest'
import { flowInitialConfig } from '@shared/agent-flow/model-defaults'
import { DEFAULT_PALETTE_CATEGORY_ORDER } from '@shared/palette-menu-order'
import type { PaletteCategoryId } from '@shared/palette-preferences'
import { NodeCardUtil, type NodeCardShape } from '../canvas/NodeCardShape'
import { CarrierArrowUtil } from '../canvas/CarrierArrowUtil'
import { BackdropShapeUtil } from '../canvas/BackdropShape'
import { createEdge, deriveGraph, tryConnect, tryConnectFromInput } from '../canvas/graph'
import { NodeContractPanel } from '../canvas/NodeContractPanel'
import { NodeContextMenu } from '../canvas/NodeContextMenu'
import { DataEdgeLayer } from '../canvas/DataEdgeLayer'
import { NodeCreateMenu } from '../canvas/NodeCreateMenu'
import { CanvasBottomDock } from '../canvas/CanvasMinimap'
import { ConnectionLayer, PendingConnectionLayer } from '../canvas/ConnectionLayer'
import { setConnectionFinishOverride, type ConnectionFinish } from '../canvas/connection-drag'
import { NODE_PORT_OUTSET } from '../canvas/edge-geometry'
import { nodeTextField } from '../canvas/node-pointer-policy'
import { PALETTE_CATEGORY_META, nodesForPaletteCategory } from '../canvas/palette-categories'
import { allNodeTypes, getNodeType, nodeIconColor } from '../nodes/registry'
import { Icon } from '../components/Icon'
import { ModalShell } from '../components/ModalShell'
import { useGatewayStore } from '../stores/gateway'
import { useNodePanelStore } from '../stores/nodePanel'
import { imageGenInitialConfig } from '../stores/imageGenPreference'
import type { ConnectionFrom } from '../stores/connection'
import { toast } from '../stores/toast'
import { topNotice } from '../stores/topNotice'
import { buildCompositeManifestFromEditor } from './editor-manifest'
import {
  CompositePublishPreview,
  type CompositePublishValidationIssue
} from './CompositePublishPreview'
import { CompositeVersionSheet } from './CompositeVersionSheet'
import './composite-editor.css'

const EMPTY_COMPONENTS = {
  Toolbar: null,
  StylePanel: null,
  HelpMenu: null,
  PageMenu: null,
  DebugPanel: null,
  MainMenu: null,
  ZoomMenu: null,
  Minimap: null,
  NavigationPanel: null,
  SharePanel: null,
  ContextMenu: null
} as const

interface Props {
  capability: CompositeCapabilitySummary
  manifest: CompositeManifest
  projectId: string
  /** 已恢复草稿的 revision；null 表示以已发布版本为基准。 */
  draftRevision?: number | null
  onClose: () => void
  onSaved: (manifest: CompositeManifest) => void
}

function versionLabel(version: string): string {
  return version.replace(/\.0\.0$/, '.0')
}

/**
 * 节点流「编辑节点」：与主画布同规格的全屏画布。
 * - 左侧节点面板、底部缩放/小地图坞、双击空白建节点菜单与主画布一致；
 * - 顶栏只显示节点流名称；右下角浮动动作簇：历史版本 / 保存 / 另存为新版本 / 取消；
 * - 取消即退出，不做二次确认（用户裁决 2026-11-11）；
 * - 历史版本从底部弹层查看，可载入旧版本或切换为旧版本；
 * - 编辑期间隐藏窗口标题栏控制钮，退出恢复；
 * - 保存 = 写入草稿（下次编辑自动恢复）；另存为新版本 = 发布不可变版本；
 * - 公开输入/输出随内部图按节点规范自动推导，不提供手动挑选。
 */
export function CompositeCanvasEditor({
  capability,
  manifest,
  projectId,
  draftRevision = null,
  onClose,
  onSaved
}: Props): React.JSX.Element {
  const [editor, setEditor] = useState<Editor | null>(null)
  const [busy, setBusy] = useState(false)
  const [issues, setIssues] = useState<string[]>([])
  const [revision, setRevision] = useState<number | null>(draftRevision)
  const [dirty, setDirty] = useState(false)
  // 空白右键/拉线落空白：创建菜单；source/startPage 记录待连线的源端口。
  const [menu, setMenu] = useState<{
    x: number
    y: number
    source?: ConnectionFrom
    startPage?: { x: number; y: number }
  } | null>(null)
  // 节点右键：与主画布同一份节点操作菜单。
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; ids: TLShapeId[] } | null>(null)
  const [showVersions, setShowVersions] = useState(false)
  // 单击只选中；契约面板由节点 info 按钮显式打开（与主画布 nodePanel store 一致）。
  const panelKind = useNodePanelStore((s) => s.kind)
  const panelShapeId = useNodePanelStore((s) => s.shapeId)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const [activeCategory, setActiveCategory] = useState<{
    id: PaletteCategoryId
    top: number
  } | null>(null)
  const [preview, setPreview] = useState<{
    base: CompositeManifest | null
    next: CompositeManifest
    issues: CompositePublishValidationIssue[]
  } | null>(null)
  // 当前编辑基准：初始为入口传入的 manifest；「查看」旧版本会替换它。
  const [base, setBase] = useState<CompositeManifest>(manifest)
  const internalIdByShape = useRef(new Map<string, string>())
  const initialized = useRef(false)
  const flyoutTimer = useRef<number | null>(null)
  const providers = useGatewayStore((state) => state.providers)
  // 发布目标版本由入口按最新发布自动递增，不提供手填，避免同版本覆盖被拒。
  const version = manifest.version

  // 编辑期间隐藏 Windows 标题栏覆盖按钮（最小化/最大化/关闭），退出恢复。
  useEffect(() => {
    void window.api.setTitleBarOverlay(false)
    return () => {
      void window.api.setTitleBarOverlay(true)
    }
  }, [])

  /** 把一份 manifest 铺进编辑器：清空旧形状、重建节点与连线、固定内部 ID。 */
  const loadManifestIntoEditor = (instance: Editor, m: CompositeManifest): void => {
    instance.deleteShapes(instance.getCurrentPageShapes().map((shape) => shape.id))
    internalIdByShape.current.clear()
    const shapeByNode = new Map<string, TLShapeId>()
    for (const node of m.graph.nodes) {
      const id = createShapeId()
      shapeByNode.set(node.id, id)
      internalIdByShape.current.set(id, node.id)
      instance.createShape<NodeCardShape>({
        id,
        type: 'node-card',
        x: node.dx,
        y: node.dy,
        meta: { compositeNodeId: node.id },
        props: {
          nodeType: node.nodeType as NodeCardShape['props']['nodeType'],
          title: node.title,
          w: node.w,
          h: node.h,
          text: node.text ?? '',
          config: node.config ?? '',
          mediaId: node.mediaRefs?.[0]?.mediaId ?? '',
          mediaPath: node.mediaRefs?.[0]?.mediaPath ?? '',
          mediaMime: node.mediaRefs?.[0]?.mime ?? ''
        }
      })
    }
    for (const edge of m.graph.edges) {
      const from = shapeByNode.get(edge.from.nodeId)
      const to = shapeByNode.get(edge.to.nodeId)
      if (from && to) {
        createEdge(
          instance,
          { shapeId: from, portId: edge.from.portId },
          { shapeId: to, portId: edge.to.portId },
          false
        )
      }
    }
    instance.zoomToFit({ animation: { duration: 0 } })
  }

  useEffect(() => {
    if (!editor || initialized.current) return
    initialized.current = true
    loadManifestIntoEditor(editor, manifest)
    // 初始化完成后才监听用户改动，避免把恢复快照本身记为未保存修改。
    const unsubscribeDirty = editor.store.listen(() => setDirty(true), {
      scope: 'document',
      source: 'user'
    })
    return () => {
      unsubscribeDirty()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在编辑器首次挂载时铺一次初始快照
  }, [editor])

  // 退出编辑时关闭节点面板，避免契约面板状态泄漏回主画布。
  useEffect(() => () => useNodePanelStore.getState().close(), [])

  // 与主画布一致：捕获阶段接管双击——文本节点 inline 编辑、标题改名、媒体/JSON 桥接，
  // 其余一律阻止默认行为（tldraw 双击空白建文本框、双击节点误触发退出等都由此屏蔽）。
  useEffect(() => {
    const el = overlayRef.current
    if (!el) return
    const dispatchNodeDoubleClick = (body: HTMLElement, event: MouseEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      body.dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          cancelable: true,
          detail: 2,
          clientX: event.clientX,
          clientY: event.clientY
        })
      )
    }
    const onNodeDoubleClick = (event: MouseEvent): void => {
      const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
      if (!target) return
      const field = nodeTextField(target)
      const fieldShapeId = field?.closest<HTMLElement>('.node-card-wrap')?.dataset.nodeId
      if (field && fieldShapeId) {
        if (document.activeElement !== field) {
          editor?.cancel()
          field.dataset.nodeInlineEditing = 'true'
          editor?.setEditingShape(fieldShapeId as TLShapeId)
          field.focus()
        }
        return
      }
      const jsonBody = target.closest<HTMLElement>(
        '[data-node-interactive="json-content"], [data-node-interactive="double-click-content"]'
      )
      const jsonControl = target.closest('button, input, textarea, select, [role="combobox"]')
      if (
        jsonBody &&
        (!jsonControl || (jsonControl === jsonBody && jsonBody.dataset.nodePointer === 'surface'))
      ) {
        dispatchNodeDoubleClick(jsonBody, event)
        return
      }
      const websiteBody = target.closest<HTMLElement>(
        '[data-node-interactive="website-empty"], [data-node-interactive="website-link"]'
      )
      if (websiteBody) {
        dispatchNodeDoubleClick(websiteBody, event)
        return
      }
      const mediaBody = target.closest<HTMLElement>('[data-node-interactive="media-preview"]')
      if (mediaBody) {
        const nestedControl = target.closest<HTMLElement>(
          'button, input, textarea, select, a, [contenteditable="true"]'
        )
        if (
          nestedControl &&
          mediaBody.contains(nestedControl) &&
          nestedControl.dataset.nodePointer !== 'surface'
        )
          return
        dispatchNodeDoubleClick(mediaBody, event)
        return
      }
      const nodeTitle = target.closest<HTMLElement>('[data-node-interactive="node-title"]')
      if (nodeTitle && nodeTitle.getAttribute('contenteditable') !== 'true') {
        event.preventDefault()
        event.stopPropagation()
        nodeTitle.dispatchEvent(new CustomEvent('canvas:edit-node-title'))
        return
      }
      const textBody = target.closest<HTMLElement>('[data-node-interactive="text-content"]')
      if (textBody) {
        event.preventDefault()
        event.stopPropagation()
        textBody.dispatchEvent(new CustomEvent('canvas:edit-text-node'))
      }
    }
    const onDblClickCapture = (event: MouseEvent): void => {
      if (!event.isTrusted) return
      onNodeDoubleClick(event)
      event.preventDefault()
      event.stopPropagation()
    }
    el.addEventListener('dblclick', onDblClickCapture, { capture: true })
    // 与主画布一致：禁用 tldraw 绘制类快捷键，避免误建文本/图形。
    const blockedTools = new Set(['a', 'd', 'e', 'g', 'h', 'i', 'k', 'l', 'n', 'r', 't'])
    const onKeyDownCapture = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement
      const typing =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      if (typing || event.ctrlKey || event.metaKey || event.altKey) return
      if (!blockedTools.has(event.key.toLowerCase())) return
      event.preventDefault()
      event.stopPropagation()
      editor?.setCurrentTool('select')
    }
    el.addEventListener('keydown', onKeyDownCapture, { capture: true })
    return () => {
      el.removeEventListener('dblclick', onDblClickCapture, { capture: true })
      el.removeEventListener('keydown', onKeyDownCapture, { capture: true })
    }
  }, [editor])

  // 端口拉线落点：覆盖主画布回调，在本编辑器内完成连接；落空白则弹兼容节点菜单。
  useEffect(() => {
    if (!editor) return
    const finish = (r: ConnectionFinish): void => {
      const pagePt = editor.screenToPage(r.screenPt)
      const target = editor.getShapeAtPoint(pagePt, {
        hitInside: true,
        margin: NODE_PORT_OUTSET + 8,
        filter: (s) => s.type === 'node-card' && s.id !== r.from.shapeId && !s.isLocked
      })
      if (target) {
        const error =
          r.from.direction === 'in'
            ? tryConnectFromInput(editor, r.from, target.id, pagePt)
            : tryConnect(editor, r.from, target.id, pagePt)
        if (error) toast(error)
        else if ((r.from.memberIds?.length ?? 0) > 1)
          toast(`已批量连接 ${r.from.memberIds?.length} 个节点`)
        return
      }
      setMenu({
        x: r.screenPt.x,
        y: r.screenPt.y,
        source: r.from,
        startPage: editor.screenToPage(r.startPt)
      })
    }
    setConnectionFinishOverride(finish)
    return () => setConnectionFinishOverride(null)
  }, [editor])

  // 与主画布 createNodeAt 同规格：注册表默认尺寸/标题/初始配置（含模型绑定）。
  const addNode = (nodeType: string, screenX: number, screenY: number): TLShapeId | null => {
    if (!editor) return null
    const spec = getNodeType(nodeType)
    if (!spec) return null
    const point = editor.screenToPage({ x: screenX, y: screenY })
    const id = createShapeId()
    const internalId = `n-${crypto.randomUUID().slice(0, 8)}`
    internalIdByShape.current.set(id, internalId)
    editor.createShape<NodeCardShape>({
      id,
      type: 'node-card',
      x: point.x - spec.defaultSize.w / 2,
      y: point.y - spec.defaultSize.h / 2,
      meta: { compositeNodeId: internalId },
      props: {
        nodeType: spec.type as NodeCardShape['props']['nodeType'],
        title: spec.label,
        w: spec.defaultSize.w,
        h: spec.defaultSize.h,
        ...(spec.initialConfig
          ? {
              config: flowInitialConfig(
                spec.type,
                spec.initialConfig,
                useGatewayStore.getState().modelBindings
              )
            }
          : {}),
        // 生图节点沿用上次选择的供应商/模型（与主画布一致）。
        ...(spec.type === 'image-gen'
          ? { config: imageGenInitialConfig(useGatewayStore.getState().providers) ?? '' }
          : {})
      }
    })
    editor.select(id)
    return id
  }

  /** 左侧面板点选节点：落在当前视口中心。 */
  const addNodeAtCenter = (nodeType: string): void => {
    if (!editor) return
    const center = editor.pageToScreen(editor.getViewportPageBounds().center)
    addNode(nodeType, center.x, center.y)
  }

  const buildManifest = (): {
    manifest: CompositeManifest
    issues: string[]
  } => {
    if (!editor)
      return {
        manifest: { ...base, version },
        issues: []
      }
    const graph = deriveGraph(editor)
    const result = buildCompositeManifestFromEditor({
      manifest: base,
      nodes: graph.nodes,
      edges: graph.edges,
      internalIdByShapeId: internalIdByShape.current,
      nextInternalId: () => `n-${crypto.randomUUID().slice(0, 8)}`
    })
    // 把本次分配的稳定 ID 写回会话映射，后续保存不会再次重排。
    graph.nodes.forEach((node, index) => {
      const assigned = result.manifest.graph.nodes[index]?.id
      if (assigned) internalIdByShape.current.set(node.id, assigned)
    })
    const nextIssues = result.issues.map((item) => `${item.path}: ${item.message}`)
    setIssues(nextIssues)
    return {
      manifest: { ...result.manifest, version },
      issues: nextIssues
    }
  }

  // 保存：写入草稿，不产生新版本；下次「编辑 / 编辑节点」自动恢复。
  const saveDraft = async (): Promise<CompositeManifest | null> => {
    if (!editor) return null
    setBusy(true)
    try {
      const built = buildManifest()
      // 草稿允许未接完的图，但结构必须可解析；可运行的完整校验留给另存为新版本。
      const saved = await window.api.composite.draftSave({
        manifest: built.manifest,
        expectedRevision: revision ?? 0
      })
      if (!saved.ok) throw new Error(saved.error.message)
      setRevision(saved.data.revision)
      setDirty(false)
      topNotice('已保存，下次编辑会自动恢复')
      return built.manifest
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setIssues((current) => [...current, message])
      toast(message)
      return null
    } finally {
      setBusy(false)
    }
  }

  // 另存为新版本：完整校验 + 发布预览，确认后发布不可变新版本。
  const publish = async (): Promise<void> => {
    if (!editor) return
    setBusy(true)
    setIssues([])
    try {
      const built = buildManifest()
      const next = built.manifest
      if (built.issues.length > 0) throw new Error('内部图存在结构问题，请先修复')
      const latest = capability.latestVersion
      if (latest && Number.parseInt(next.version, 10) <= Number.parseInt(latest, 10))
        throw new Error(`新版本必须高于当前最新发布 v${versionLabel(latest)}`)
      const validated = await window.api.composite.validate({ manifest: next })
      const validationIssues: CompositePublishValidationIssue[] = validated.ok
        ? validated.data.issues
        : [
            {
              code: 'VALIDATE_FAILED',
              path: 'composite.validate',
              message: validated.error.message
            }
          ]
      // 发布预览（W2-B）：基准取最新发布快照，差异复用实例升级同一预检函数。
      let baseManifest: CompositeManifest | null = null
      if (latest) {
        const result = await window.api.composite.versionGet({
          capabilityId: capability.id,
          version: latest
        })
        if (result.ok && result.data) baseManifest = result.data.manifest
      }
      setPreview({ base: baseManifest, next, issues: validationIssues })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setIssues((current) => (current.length > 0 ? current : [message]))
      toast(message)
    } finally {
      setBusy(false)
    }
  }

  const confirmPublish = async (): Promise<void> => {
    if (!preview) return
    setBusy(true)
    try {
      const next = preview.next
      const saved = await window.api.composite.draftSave({
        manifest: next,
        expectedRevision: revision ?? 0
      })
      if (!saved.ok) throw new Error(saved.error.message)
      setRevision(saved.data.revision)
      const published = await window.api.composite.publish({
        manifest: next,
        expectedRevision: saved.data.revision
      })
      if (!published.ok) throw new Error(published.error.message)
      setDirty(false)
      setPreview(null)
      topNotice(`已另存为「${next.name}」v${versionLabel(next.version)}`)
      onSaved(next)
      onClose()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      // 发布失败保留草稿并回到编辑器展示问题。
      setPreview(null)
      setIssues((current) => (current.length > 0 ? current : [message]))
      toast(message)
    } finally {
      setBusy(false)
    }
  }

  // 取消 = 立即退出编辑，不做二次确认（用户裁决 2026-11-11）。
  const requestClose = (): void => {
    onClose()
  }

  // 与主画布一致：右键空白弹创建菜单，右键节点弹节点操作菜单。
  const handleContextMenu = (event: React.MouseEvent): void => {
    const target = event.target as HTMLElement
    if (
      target.closest('.node-palette') ||
      target.closest('.canvas-dock') ||
      target.closest('.node-contract-panel') ||
      target.closest('.nf-action-bar')
    )
      return
    if (!target.closest('.tl-canvas')) return
    event.preventDefault()
    // portal 事件会沿 React 树冒泡到主画布 wrapper 的 onContextMenu，
    // 不阻断会在主画布同时弹出一份创建菜单。
    event.stopPropagation()
    if (!editor || busy) return
    const hit = editor.getShapeAtPoint(editor.screenToPage({ x: event.clientX, y: event.clientY }), {
      hitInside: true,
      margin: 4,
      filter: (shape) => shape.type === 'node-card'
    })
    if (hit?.type === 'node-card') {
      const selected = editor
        .getSelectedShapeIds()
        .filter((id) => editor.getShape(id)?.type === 'node-card')
      const ids = selected.includes(hit.id) ? selected : [hit.id]
      if (!selected.includes(hit.id)) editor.select(hit.id)
      setNodeMenu({ x: event.clientX, y: event.clientY, ids })
      return
    }
    setMenu({ x: event.clientX, y: event.clientY })
  }

  // 左侧面板：与主画布同一份分类/节点数据与样式（鱼眼 Dock + 右侧展开列表）。
  const paletteCategories = DEFAULT_PALETTE_CATEGORY_ORDER.filter(
    (category) => nodesForPaletteCategory(allNodeTypes(), category).length > 0
  )
  const openCategory = (category: PaletteCategoryId, target: HTMLElement): void => {
    if (flyoutTimer.current !== null) {
      window.clearTimeout(flyoutTimer.current)
      flyoutTimer.current = null
    }
    setActiveCategory({ id: category, top: target.getBoundingClientRect().top })
  }
  const scheduleFlyoutClose = (): void => {
    if (flyoutTimer.current !== null) window.clearTimeout(flyoutTimer.current)
    flyoutTimer.current = window.setTimeout(() => setActiveCategory(null), 180)
  }
  const keepFlyout = (): void => {
    if (flyoutTimer.current !== null) {
      window.clearTimeout(flyoutTimer.current)
      flyoutTimer.current = null
    }
  }
  const flyoutNodes = activeCategory
    ? nodesForPaletteCategory(allNodeTypes(), activeCategory.id)
    : []

  // 侧栏祖先会形成层叠上下文，fixed overlay 若留在原处会被主顶栏盖住头部按钮；
  // 挂到 body 保证全屏编辑始终位于最上层。
  // 2026-11-21 弹窗统一：壳换 ModalShell（取消=立即退出，不做遮罩/Esc 关闭防误退，
  // 与「取消」按钮同一行为；右上 X 为新增，行为与取消一致）。
  return (
    <ModalShell
      size="xl"
      title={base.name}
      bodyClassName="modal-shell-body--flush"
      onClose={requestClose}
      closeOnEscape={false}
      closeOnOverlay={false}
    >
      <div className="composite-canvas-overlay" ref={overlayRef} onContextMenu={handleContextMenu}>
        <span hidden>{capability.id}</span>
        <div className="composite-canvas-workspace">
        <div className="composite-canvas-stage">
          <Tldraw
            shapeUtils={[NodeCardUtil, CarrierArrowUtil, BackdropShapeUtil]}
            components={EMPTY_COMPONENTS as never}
            onMount={(instance) => {
              // 与主画布一致的深色主题；背景点阵由 composite-editor.css 统一去除。
              instance.user.updateUserPreferences({ colorScheme: 'dark' })
              instance.setCurrentTool('select')
              setEditor(instance)
            }}
          />
          {editor && <DataEdgeLayer editor={editor} interactive={false} />}
          <ConnectionLayer />

          {/* 左侧节点面板：与主画布同一套 Dock 分类 + 展开列表。 */}
          <div className="node-palette" onMouseLeave={scheduleFlyoutClose}>
            <div className="palette-node-scroll">
              <div className="palette-section palette-category-section">
                {paletteCategories.map((category) => {
                  const meta = PALETTE_CATEGORY_META[category]
                  const active = activeCategory?.id === category
                  return (
                    <button
                      key={category}
                      type="button"
                      className={`palette-item palette-category-item${active ? ' is-active' : ''}`}
                      aria-label={`展开${meta.label}节点`}
                      aria-expanded={active}
                      onPointerEnter={(event) => openCategory(category, event.currentTarget)}
                      onFocus={(event) => openCategory(category, event.currentTarget)}
                      onClick={(event) => openCategory(category, event.currentTarget)}
                    >
                      <span className="palette-icon" style={{ color: nodeIconColor(meta.color) }}>
                        <Icon name={meta.icon} size={20} strokeWidth={2} />
                      </span>
                      <span className="palette-label">{meta.shortLabel}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
          {activeCategory && (
            <div
              className="palette-node-flyout"
              style={{ left: 150, top: activeCategory.top }}
              onMouseEnter={keepFlyout}
              onMouseLeave={scheduleFlyoutClose}
            >
              <div className="palette-node-flyout-list scrollbar-hidden">
                {flyoutNodes.map((spec) => (
                  <button
                    key={spec.type}
                    type="button"
                    className="palette-item palette-node-item"
                    aria-label={`添加${spec.label}节点`}
                    onClick={() => {
                      addNodeAtCenter(spec.type)
                      setActiveCategory(null)
                    }}
                  >
                    <span className="palette-icon" style={{ color: nodeIconColor(spec.color) }}>
                      <Icon name={spec.icon} size={18} strokeWidth={2} />
                    </span>
                    <span className="palette-label">{spec.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 左下角：与主画布同一份小地图 + 缩放控制坞。 */}
          <CanvasBottomDock editor={editor} />

          {menu && (
            <NodeCreateMenu
              x={menu.x}
              y={menu.y}
              minimal
              source={menu.source ?? null}
              onPick={(choice) => {
                const source = menu.source
                const id = addNode(choice.type, menu.x, menu.y)
                setMenu(null)
                // 拉线到空白建节点：与主画布一致，建节点后自动接上源端口。
                if (source && id && editor) {
                  const error =
                    source.direction === 'in'
                      ? tryConnectFromInput(editor, source, id)
                      : tryConnect(editor, source, id)
                  if (error) toast(`未连线：${error}`)
                }
              }}
              onTemplate={() => setMenu(null)}
              onUpload={() => setMenu(null)}
              onGallery={() => setMenu(null)}
              onClose={() => setMenu(null)}
            />
          )}
          {editor && menu?.source && menu.startPage && (
            <PendingConnectionLayer
              editor={editor}
              startPage={menu.startPage}
              endPt={{ x: menu.x, y: menu.y }}
              from={menu.source}
            />
          )}
        </div>
        {editor && panelKind === 'contract' && panelShapeId && editor.getShape(panelShapeId) && (
          <NodeContractPanel
            editor={editor}
            projectId={projectId}
            providers={providers}
            onClose={() => useNodePanelStore.getState().close()}
          />
        )}
        {editor && nodeMenu && (
          <NodeContextMenu
            editor={editor}
            ids={nodeMenu.ids}
            x={nodeMenu.x}
            y={nodeMenu.y}
            onClose={() => setNodeMenu(null)}
          />
        )}
        {/* 动作簇与历史弹层挂在 workspace 层：右侧节点面板开合会改变 stage 宽度，
            若锚定 stage，按钮会在 pointerdown→pointerup 之间位移导致点击落空。 */}
        <div className="nf-action-bar" role="group" aria-label="节点流编辑动作">
          <button
            type="button"
            className="nf-btn ghost"
            disabled={busy}
            title="查看历史版本，可载入或切换为旧版本"
            onClick={() => setShowVersions(true)}
          >
            <Icon name="history" size={14} /> 历史版本
          </button>
          <button
            type="button"
            className="nf-btn ghost"
            disabled={busy || !editor}
            title="暂存当前内容，下次编辑自动恢复；不产生新版本"
            onClick={() => void saveDraft()}
          >
            <Icon name="check" size={14} /> 保存
          </button>
          <button
            type="button"
            className="nf-btn primary"
            disabled={busy || !editor}
            title={`以当前内容发布不可变的新版本 v${versionLabel(version)}`}
            onClick={() => void publish()}
          >
            <Icon name="spark" size={14} />
            {busy ? '处理中…' : '另存为新版本'}
          </button>
          <button
            type="button"
            className="nf-btn ghost"
            disabled={busy}
            title="退出编辑，返回画布"
            onClick={requestClose}
          >
            取消
          </button>
        </div>
        {showVersions && (
          <CompositeVersionSheet
            capability={capability}
            dirty={dirty}
            onClose={() => setShowVersions(false)}
            onLoadVersion={(loaded) => {
              if (!editor) return
              const nextBase: CompositeManifest = { ...loaded, version }
              setBase(nextBase)
              loadManifestIntoEditor(editor, nextBase)
              setDirty(true)
            }}
            onSwitched={() => {
              onSaved(base)
              onClose()
            }}
          />
        )}
      </div>
      {issues.length > 0 && (
        <div className="composite-canvas-diagnostics" role="status">
          {issues.map((item) => (
            <span key={item} className="composite-canvas-warning">
              {item}
            </span>
          ))}
        </div>
      )}
      {preview && (
        <CompositePublishPreview
          capabilityName={manifest.name}
          baseManifest={preview.base}
          nextManifest={preview.next}
          validationIssues={preview.issues}
          busy={busy}
          onCancel={() => setPreview(null)}
          onConfirm={() => void confirmPublish()}
        />
      )}
      </div>
    </ModalShell>
  )
}
