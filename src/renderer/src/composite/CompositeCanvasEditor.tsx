import { useEffect, useRef, useState } from 'react'
import { createShapeId, Tldraw, type Editor, type TLShapeId } from 'tldraw'
import type { CompositeCapabilitySummary } from '@shared/composite/types'
import type { CompositeManifest } from '@shared/composite/manifest'
import { deriveCompositeBoundary } from '@shared/composite/boundary'
import { NodeCardUtil, type NodeCardShape } from '../canvas/NodeCardShape'
import { CarrierArrowUtil } from '../canvas/CarrierArrowUtil'
import { BackdropShapeUtil } from '../canvas/BackdropShape'
import { createEdge, deriveGraph } from '../canvas/graph'
import { NodeContractPanel } from '../canvas/NodeContractPanel'
import { useNodePanelStore } from '../stores/nodePanel'
import { useGatewayStore } from '../stores/gateway'
import { toast } from '../stores/toast'
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

type ManifestNodePortType = NonNullable<CompositeManifest['graph']['nodes'][number]['ports']>[number]['type']

const NODE_DEFAULTS: Record<string, { title: string; w: number; h: number }> = {
  text: { title: '文本', w: 340, h: 300 },
  'ai-process': { title: 'AI 处理', w: 340, h: 300 },
  'image-gen': { title: '生图', w: 340, h: 300 }
}

interface Props {
  capability: CompositeCapabilitySummary
  manifest: CompositeManifest
  projectId: string
  onClose: () => void
  onSaved: (manifest: CompositeManifest) => void
}

/**
 * 组合内部图的整屏画布编辑模式（P4）。
 * 使用独立 tldraw 编辑器承载内部节点；关闭即销毁，不触碰用户当前画布/项目。
 */
export function CompositeCanvasEditor({
  capability,
  manifest,
  projectId,
  onClose,
  onSaved
}: Props): React.JSX.Element {
  const [editor, setEditor] = useState<Editor | null>(null)
  const [selectedShapeId, setSelectedShapeId] = useState<TLShapeId | null>(null)
  const [busy, setBusy] = useState(false)
  const [warning, setWarning] = useState('')
  const initialized = useRef(false)
  const providers = useGatewayStore((state) => state.providers)

  useEffect(() => {
    if (!editor || initialized.current) return
    initialized.current = true
    const shapeByNode = new Map<string, TLShapeId>()
    for (const node of manifest.graph.nodes) {
      const id = createShapeId()
      shapeByNode.set(node.id, id)
      editor.createShape<NodeCardShape>({
        id,
        type: 'node-card',
        x: node.dx,
        y: node.dy,
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
        createEdge(editor, { shapeId: from, portId: edge.from.portId }, { shapeId: to, portId: edge.to.portId }, false)
      }
    }
    editor.zoomToFit({ animation: { duration: 0 } })
    const unsubscribe = editor.store.listen(() => {
      const selected = editor.getSelectedShapeIds()[0]
      if (!selected) return
      if (editor.getShape(selected)?.type !== 'node-card') return
      setSelectedShapeId(selected as TLShapeId)
      useNodePanelStore.getState().open('contract', selected as TLShapeId)
    })
    return unsubscribe
  }, [editor, manifest])

  const addNode = (nodeType: string): void => {
    if (!editor) return
    const defaults = NODE_DEFAULTS[nodeType] ?? { title: nodeType, w: 340, h: 300 }
    const bounds = editor.getViewportPageBounds()
    const id = createShapeId()
    editor.createShape<NodeCardShape>({
      id,
      type: 'node-card',
      x: bounds.center.x - defaults.w / 2,
      y: bounds.center.y - defaults.h / 2,
      props: { nodeType: nodeType as NodeCardShape['props']['nodeType'], title: defaults.title, w: defaults.w, h: defaults.h }
    })
    editor.select(id)
  }

  const buildManifest = (): CompositeManifest => {
    if (!editor) return manifest
    const graph = deriveGraph(editor)
    const internalId = new Map<string, string>()
    graph.nodes.forEach((node, index) => internalId.set(node.id, `n${index + 1}`))
    const inputs = manifest.inputs.length
      ? manifest.inputs
          .map((input) => ({
            ...input,
            targets: input.targets
              .map((target) => ({ ...target, nodeId: internalId.get(target.nodeId) ?? target.nodeId }))
              .filter((target) => internalId.has(target.nodeId))
          }))
          .filter((input) => input.targets.length > 0)
      : []
    const outputs = manifest.outputs
      .map((output) => ({ ...output, source: { ...output.source, nodeId: internalId.get(output.source.nodeId) ?? output.source.nodeId } }))
      .filter((output) => internalId.has(output.source.nodeId))
    const rebuilt: CompositeManifest = {
      ...manifest,
      graph: {
        nodes: graph.nodes.map((node) => ({
          id: internalId.get(node.id)!,
          nodeType: node.type,
          contractVersion: node.contractVersion,
          title: node.title,
          dx: node.x,
          dy: node.y,
          w: node.w,
          h: node.h,
          ...(node.content.kind === 'text' ? { text: node.content.text } : {}),
          ...(typeof node.params?.config === 'string' ? { config: node.params.config } : {}),
          ...(node.content.kind === 'media' ? { mediaRefs: [{ mediaId: node.content.mediaId, mediaPath: String(node.params?.mediaPath ?? ''), mime: String(node.params?.mediaMime ?? '') }] } : {}),
          ports: node.ports.map((port) => ({
            id: port.id,
            name: port.name,
            dir: port.dir,
            type: port.type as ManifestNodePortType,
            required: port.required,
            cardinality: port.cardinality,
            ...(port.schema ? { schemaRef: { id: port.schema.id, version: port.schema.version } } : {})
          }))
        })),
        edges: graph.edges
          .filter((edge) => internalId.has(edge.from.nodeId) && internalId.has(edge.to.nodeId))
          .map((edge) => ({
            from: { nodeId: internalId.get(edge.from.nodeId)!, portId: edge.from.portId },
            to: { nodeId: internalId.get(edge.to.nodeId)!, portId: edge.to.portId }
          }))
      },
      inputs,
      outputs
    }
    const derived = deriveCompositeBoundary(rebuilt)
    if (rebuilt.inputs.length === 0 && derived.inputs.length > 0) setWarning('检测到旧组合没有公开输入，发布时会按内部图重新推导')
    return { ...rebuilt, inputs: derived.inputs, outputs: derived.outputs }
  }

  const save = async (): Promise<void> => {
    if (!editor) return
    setBusy(true)
    try {
      const next = buildManifest()
      const validated = await window.api.composite.validate({ manifest: next })
      if (!validated.ok) throw new Error(validated.error.message)
      if (!validated.data.ok) {
        throw new Error(validated.data.issues.map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`).join('；'))
      }
      const draft = await window.api.composite.draftSave({ manifest: next })
      if (!draft.ok) throw new Error(draft.error.message)
      const published = await window.api.composite.publish({ manifest: next })
      if (!published.ok) throw new Error(published.error.message)
      toast(`已保存并发布「${next.name}」v${next.version.replace(/\.0$/, '.0')}`)
      onSaved(next)
      onClose()
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="composite-canvas-overlay">
      <span hidden>{capability.id}</span>
      <header className="composite-canvas-topbar">
        <button type="button" className="btn-ghost small" onClick={onClose} disabled={busy}>
          返回
        </button>
        <strong>{manifest.name}</strong>
        <span className="composite-version-pill">v{manifest.version.replace(/\.0\.0$/, '.0')} · 草稿</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn-ghost small" disabled={busy} onClick={() => addNode('text')}>+ 文本</button>
        <button type="button" className="btn-ghost small" disabled={busy} onClick={() => addNode('ai-process')}>+ AI 处理</button>
        <button type="button" className="btn-ghost small" disabled={busy} onClick={() => addNode('image-gen')}>+ 生图</button>
        <button type="button" className="library-form-primary" disabled={busy} onClick={() => void save()}>
          {busy ? '保存中…' : '保存并发布'}
        </button>
      </header>
      <div className="composite-canvas-stage">
        <Tldraw
          shapeUtils={[NodeCardUtil, CarrierArrowUtil, BackdropShapeUtil]}
          components={EMPTY_COMPONENTS as never}
          onMount={(instance) => setEditor(instance)}
        />
      </div>
      {editor && selectedShapeId && (
        <NodeContractPanel
          editor={editor}
          projectId={projectId}
          providers={providers}
          onClose={() => {
            useNodePanelStore.getState().close()
            setSelectedShapeId(null)
          }}
        />
      )}
      {warning && <div className="composite-canvas-warning">{warning}</div>}
    </div>
  )
}
