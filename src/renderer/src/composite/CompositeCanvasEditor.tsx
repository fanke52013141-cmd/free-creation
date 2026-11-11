import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createShapeId, Tldraw, type Editor, type TLShapeId } from 'tldraw'
import type { CompositeCapabilitySummary } from '@shared/composite/types'
import type { CompositeManifest } from '@shared/composite/manifest'
import { NodeCardUtil, type NodeCardShape } from '../canvas/NodeCardShape'
import { CarrierArrowUtil } from '../canvas/CarrierArrowUtil'
import { BackdropShapeUtil } from '../canvas/BackdropShape'
import { createEdge, deriveGraph } from '../canvas/graph'
import { NodeContractPanel } from '../canvas/NodeContractPanel'
import { DataEdgeLayer } from '../canvas/DataEdgeLayer'
import { Icon } from '../components/Icon'
import { useGatewayStore } from '../stores/gateway'
import { toast } from '../stores/toast'
import { buildCompositeManifestFromEditor } from './editor-manifest'
import { CompositePublishPreview, type CompositePublishValidationIssue } from './CompositePublishPreview'
import { CompositeCloseConfirm } from './CompositeCloseConfirm'
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

const NODE_DEFAULTS: Record<string, { title: string; w: number; h: number }> = {
  text: { title: '文本', w: 340, h: 300 },
  'ai-process': { title: 'AI 处理', w: 340, h: 300 },
  'image-gen': { title: '生图', w: 340, h: 300 }
}

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
 * 节点流内部图的整屏画布编辑模式（W1）。
 * - 独立 tldraw 编辑器承载内部节点，关闭即销毁，不触碰用户当前画布/项目；
 * - 内部节点 ID 在创建时固定，保存不再按数组下标重排；
 * - 已确认公开端口原样保留，失效映射只提示不静默删除；
 * - 草稿保存与发布新版本分开，发布失败保留草稿。
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
  const [status, setStatus] = useState('')
  const [staleMappings, setStaleMappings] = useState<string[]>([])
  const [issues, setIssues] = useState<string[]>([])
  const [version, setVersion] = useState(manifest.version)
  const [revision, setRevision] = useState<number | null>(draftRevision)
  const [dirty, setDirty] = useState(false)
  const [closeConfirm, setCloseConfirm] = useState(false)
  const [preview, setPreview] = useState<{
    base: CompositeManifest | null
    next: CompositeManifest
    issues: CompositePublishValidationIssue[]
  } | null>(null)
  const internalIdByShape = useRef(new Map<string, string>())
  const initialized = useRef(false)
  const providers = useGatewayStore((state) => state.providers)

  useEffect(() => {
    if (!editor || initialized.current) return
    initialized.current = true
    const shapeByNode = new Map<string, TLShapeId>()
    for (const node of manifest.graph.nodes) {
      const id = createShapeId()
      shapeByNode.set(node.id, id)
      internalIdByShape.current.set(id, node.id)
      editor.createShape<NodeCardShape>({
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
    for (const edge of manifest.graph.edges) {
      const from = shapeByNode.get(edge.from.nodeId)
      const to = shapeByNode.get(edge.to.nodeId)
      if (from && to) {
        createEdge(
          editor,
          { shapeId: from, portId: edge.from.portId },
          { shapeId: to, portId: edge.to.portId },
          false
        )
      }
    }
    editor.zoomToFit({ animation: { duration: 0 } })
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
  }, [editor, manifest])

  const addNode = (nodeType: string): void => {
    if (!editor) return
    const defaults = NODE_DEFAULTS[nodeType] ?? { title: nodeType, w: 340, h: 300 }
    const bounds = editor.getViewportPageBounds()
    const id = createShapeId()
    const internalId = `n-${crypto.randomUUID().slice(0, 8)}`
    internalIdByShape.current.set(id, internalId)
    editor.createShape<NodeCardShape>({
      id,
      type: 'node-card',
      x: bounds.center.x - defaults.w / 2,
      y: bounds.center.y - defaults.h / 2,
      meta: { compositeNodeId: internalId },
      props: {
        nodeType: nodeType as NodeCardShape['props']['nodeType'],
        title: defaults.title,
        w: defaults.w,
        h: defaults.h
      }
    })
    editor.select(id)
  }

  const buildManifest = (): {
    manifest: CompositeManifest
    issues: string[]
    staleMappings: string[]
  } => {
    if (!editor)
      return {
        manifest: { ...manifest, version },
        issues: [],
        staleMappings: []
      }
    const graph = deriveGraph(editor)
    const result = buildCompositeManifestFromEditor({
      manifest,
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

  const saveDraft = async (): Promise<CompositeManifest | null> => {
    if (!editor) return null
    setBusy(true)
    setStatus('')
    try {
      const built = buildManifest()
      // 草稿允许未接完的图，但结构必须可解析；可运行的完整校验留给发布。
      const saved = await window.api.composite.draftSave({
        manifest: built.manifest,
        expectedRevision: revision ?? 0
      })
      if (!saved.ok) throw new Error(saved.error.message)
      setRevision(saved.data.revision)
      setDirty(false)
      setStatus(`草稿已保存 · 修订 ${saved.data.revision}`)
      toast(`草稿已保存（修订 ${saved.data.revision}）`)
      return built.manifest
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setStatus('')
      setIssues((current) => [...current, message])
      toast(message)
      return null
    } finally {
      setBusy(false)
    }
  }

  const publish = async (): Promise<void> => {
    if (!editor) return
    setBusy(true)
    setStatus('')
    setIssues([])
    try {
      const built = buildManifest()
      const next = built.manifest
      if (built.issues.length > 0) throw new Error('内部图存在结构问题，请先修复')
      if (built.staleMappings.length > 0)
        throw new Error('公开端口映射已失效，请先重新绑定或移除')
      const latest = capability.latestVersion
      if (latest && Number.parseInt(next.version, 10) <= Number.parseInt(latest, 10))
        throw new Error(`新版本必须高于当前最新发布 v${versionLabel(latest)}`)
      const validated = await window.api.composite.validate({ manifest: next })
      const validationIssues: CompositePublishValidationIssue[] = validated.ok
        ? validated.data.issues
        : [{ code: 'VALIDATE_FAILED', path: 'composite.validate', message: validated.error.message }]
      // 发布预览（W2-B）：基准取最新发布快照，差异复用实例升级同一预检函数。
      let base: CompositeManifest | null = null
      if (latest) {
        const result = await window.api.composite.versionGet({
          capabilityId: capability.id,
          version: latest
        })
        if (result.ok && result.data) base = result.data.manifest
      }
      setPreview({ base, next, issues: validationIssues })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setStatus('')
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
      toast(`已发布「${next.name}」v${versionLabel(next.version)}`)
      onSaved(next)
      onClose()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      // 发布失败保留草稿并回到编辑器展示问题。
      setPreview(null)
      setStatus('')
      setIssues((current) => (current.length > 0 ? current : [message]))
      toast(message)
    } finally {
      setBusy(false)
    }
  }

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
          <span>节点流</span>
          <h2 id="composite-canvas-title" title={manifest.name}>
            {manifest.name}
          </h2>
          <span className="composite-canvas-version">
            基准 v{versionLabel(manifest.version)}
          </span>
          <label className="composite-canvas-version-input">
            <span>发布版本</span>
            <input
              aria-label="发布版本"
              value={version}
              disabled={busy}
              onChange={(event) => {
                setVersion(event.target.value)
                setDirty(true)
              }}
            />
          </label>
          <span className="composite-canvas-revision">
            {revision === null ? '未保存草稿' : `草稿修订 ${revision}`}
          </span>
        </div>
        <div className="composite-canvas-actions">
          <button
            type="button"
            className="btn-ghost small"
            disabled={busy || !editor}
            onClick={() => void saveDraft()}
          >
            保存草稿
          </button>
          <button
            type="button"
            className="library-form-primary"
            disabled={busy || !editor}
            onClick={() => void publish()}
          >
            {busy ? '处理中…' : '发布新版本'}
          </button>
          <button
            type="button"
            className="composite-canvas-close"
            onClick={requestClose}
            disabled={busy}
            aria-label="关闭节点流编辑"
            title="关闭节点流编辑"
          >
            <Icon name="close" size={18} />
          </button>
        </div>
      </header>
      <div className="composite-canvas-workspace">
        <div className="composite-canvas-stage">
          <Tldraw
            shapeUtils={[NodeCardUtil, CarrierArrowUtil, BackdropShapeUtil]}
            components={EMPTY_COMPONENTS as never}
            onMount={(instance) => setEditor(instance)}
          />
          {editor && <DataEdgeLayer editor={editor} interactive={false} />}
          <div className="composite-canvas-tools" role="group" aria-label="添加节点">
            {Object.entries(NODE_DEFAULTS).map(([type, { title }]) => (
              <button
                key={type}
                type="button"
                className="btn-ghost small"
                disabled={busy || !editor}
                onClick={() => addNode(type)}
              >
                + {title}
              </button>
            ))}
          </div>
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
      </div>
      {(staleMappings.length > 0 || issues.length > 0 || status) && (
        <div className="composite-canvas-diagnostics" role="status">
          {status && <span className="composite-canvas-status">{status}</span>}
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
