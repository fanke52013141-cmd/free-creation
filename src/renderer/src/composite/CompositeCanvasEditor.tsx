import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createShapeId, Tldraw, type Editor, type TLShapeId } from 'tldraw'
import type { CompositeCapabilitySummary } from '@shared/composite/types'
import type { CompositeManifest } from '@shared/composite/manifest'
import { flowInitialConfig } from '@shared/agent-flow/model-defaults'
import { DEFAULT_PALETTE_CATEGORY_ORDER } from '@shared/palette-menu-order'
import type { PaletteCategoryId } from '@shared/palette-preferences'
import { NodeCardUtil, type NodeCardShape } from '../canvas/NodeCardShape'
import { CarrierArrowUtil } from '../canvas/CarrierArrowUtil'
import { BackdropShapeUtil } from '../canvas/BackdropShape'
import { createEdge, deriveGraph } from '../canvas/graph'
import { NodeContractPanel } from '../canvas/NodeContractPanel'
import { DataEdgeLayer } from '../canvas/DataEdgeLayer'
import { NodeCreateMenu } from '../canvas/NodeCreateMenu'
import { CanvasBottomDock } from '../canvas/CanvasMinimap'
import { PALETTE_CATEGORY_META, nodesForPaletteCategory } from '../canvas/palette-categories'
import { allNodeTypes, getNodeType, nodeIconColor } from '../nodes/registry'
import { Icon } from '../components/Icon'
import { useGatewayStore } from '../stores/gateway'
import { toast } from '../stores/toast'
import { buildCompositeManifestFromEditor } from './editor-manifest'
import {
  CompositePublishPreview,
  type CompositePublishValidationIssue
} from './CompositePublishPreview'
import { CompositeCloseConfirm } from './CompositeCloseConfirm'
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
 * - 右下角浮动动作簇：历史版本 / 保存 / 另存为新版本 / 取消；
 * - 历史版本从底部弹层查看，可载入旧版本或切换为旧版本；
 * - 编辑期间隐藏窗口标题栏控制钮，退出恢复；
 * - 保存 = 写入草稿（下次编辑自动恢复）；另存为新版本 = 发布不可变版本。
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
  const [selectedShapeId, setSelectedShapeId] = useState<TLShapeId | null>(null)
  const [busy, setBusy] = useState(false)
  const [staleMappings, setStaleMappings] = useState<string[]>([])
  const [issues, setIssues] = useState<string[]>([])
  const [revision, setRevision] = useState<number | null>(draftRevision)
  const [dirty, setDirty] = useState(false)
  const [closeConfirm, setCloseConfirm] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [showVersions, setShowVersions] = useState(false)
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
    const unsubscribe = editor.store.listen(
      () => {
        const selected = editor.getSelectedShapeIds()[0]
        setSelectedShapeId(
          selected && editor.getShape(selected)?.type === 'node-card' ? selected : null
        )
      },
      { scope: 'session' }
    )
    // 初始化完成后才监听用户改动，避免把恢复快照本身记为未保存修改。
    const unsubscribeDirty = editor.store.listen(() => setDirty(true), {
      scope: 'document',
      source: 'user'
    })
    return () => {
      unsubscribe()
      unsubscribeDirty()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在编辑器首次挂载时铺一次初始快照
  }, [editor])

  // 与主画布 createNodeAt 同规格：注册表默认尺寸/标题/初始配置（含模型绑定）。
  const addNode = (nodeType: string, screenX: number, screenY: number): void => {
    if (!editor) return
    const spec = getNodeType(nodeType)
    if (!spec) return
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
          : {})
      }
    })
    editor.select(id)
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
    staleMappings: string[]
  } => {
    if (!editor)
      return {
        manifest: { ...base, version },
        issues: [],
        staleMappings: []
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
    setStaleMappings(result.staleMappings)
    setIssues(nextIssues)
    return {
      manifest: { ...result.manifest, version },
      issues: nextIssues,
      staleMappings: result.staleMappings
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
      toast('已保存，下次编辑会自动恢复')
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
      if (built.staleMappings.length > 0) throw new Error('公开端口映射已失效，请先重新绑定或移除')
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
      toast(`已另存为「${next.name}」v${versionLabel(next.version)}`)
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

  // 取消 = 退出编辑；有未保存修改时先确认（保存并关闭 / 放弃 / 继续）。
  const requestClose = (): void => {
    if (dirty) setCloseConfirm(true)
    else onClose()
  }

  const saveAndClose = async (): Promise<void> => {
    const saved = await saveDraft()
    if (saved) {
      setCloseConfirm(false)
      onClose()
    }
  }

  // 双击空白画布打开与主画布相同的节点创建菜单；点在节点上时交给节点自身处理。
  const handleStageDoubleClick = (event: React.MouseEvent): void => {
    if (!editor || busy) return
    const page = editor.screenToPage({ x: event.clientX, y: event.clientY })
    if (editor.getShapeAtPoint(page)) return
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
  return createPortal(
    <div
      className="composite-canvas-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="composite-canvas-title"
    >
      <span hidden>{capability.id}</span>
      <header className="composite-canvas-topbar">
        <div className="composite-canvas-heading">
          <span className="composite-canvas-mark">
            <Icon name="layers" size={15} />
          </span>
          <span>节点流</span>
          <h2 id="composite-canvas-title" title={manifest.name}>
            {base.name}
          </h2>
          <span className="composite-canvas-version">
            当前 v{versionLabel(capability.latestVersion ?? manifest.version)}
          </span>
        </div>
      </header>
      <div className="composite-canvas-workspace">
        <div className="composite-canvas-stage" onDoubleClick={handleStageDoubleClick}>
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
              onPick={(choice) => {
                addNode(choice.type, menu.x, menu.y)
                setMenu(null)
              }}
              onTemplate={() => setMenu(null)}
              onUpload={() => setMenu(null)}
              onGallery={() => setMenu(null)}
              onClose={() => setMenu(null)}
            />
          )}
        </div>
        {editor && selectedShapeId && (
          <NodeContractPanel
            editor={editor}
            projectId={projectId}
            providers={providers}
            localShapeId={selectedShapeId}
            onClose={() => {
              editor.selectNone()
              setSelectedShapeId(null)
            }}
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
      {(staleMappings.length > 0 || issues.length > 0) && (
        <div className="composite-canvas-diagnostics" role="status">
          {staleMappings.map((item) => (
            <span key={item} className="composite-canvas-warning">
              {item}
            </span>
          ))}
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
      {closeConfirm && (
        <CompositeCloseConfirm
          capabilityName={manifest.name}
          busy={busy}
          onSaveAndClose={() => void saveAndClose()}
          onDiscard={() => {
            setCloseConfirm(false)
            onClose()
          }}
          onContinue={() => setCloseConfirm(false)}
        />
      )}
    </div>,
    document.body
  )
}
