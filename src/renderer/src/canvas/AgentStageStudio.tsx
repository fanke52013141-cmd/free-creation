import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { createShapeId, useValue, type Editor, type TLShapeId } from 'tldraw'
import type { FlowAgentCollaboration, FlowAgentCollaborationView } from '@shared/agent-flow/desktop-tasks'
import { admitHumanTaskSubmission } from '@shared/agent-flow/human-task-submission'
import {
  HumanTaskNodeConfigSchema,
  HumanTaskInstanceSchema,
  ReviewDecisionSchema,
  type HumanTaskNodeConfig,
  type HumanTaskInstance,
  type HumanTaskValue
} from '@shared/agent-flow/node-contracts'
import { Icon } from '../components/Icon'
import { AppSelect } from '../components/AppSelect'
import { useNodePanelStore } from '../stores/nodePanel'
import { useConfirmStore } from '../stores/confirm'
import { useGatewayStore } from '../stores/gateway'
import { useMediaStore } from '../stores/media'
import { toast } from '../stores/toast'
import { getNodeType, mediaUrl } from '../nodes/registry'
import { projectNodeOutputs, type NodeValue } from '../nodes/nodeValues'
import { runNodeManually } from '../engine/executor'
import { ensureCanvasSaved } from './flow-asset-actions'
import { deriveGraph } from './graph'
import { markUndoPoint } from './history'
import {
  archiveAndClearDownstreamCanvasNodes,
  collectDownstreamNodeIds,
  readArchivedDeliveries,
  restoreArchivedDelivery
} from './flow-rework-reset'
import type { NodeCardShape } from './NodeCardShape'
import './agent-stage-studio.css'

interface AgentStageStudioProps {
  editor: Editor
  projectId: string
  shapeId: TLShapeId
  onClose: () => void
}

type StageMode = 'human' | 'collab' | 'ai' | 'review'

function detectStageMode(shape: NodeCardShape): StageMode {
  if (shape.props.nodeType === 'human-task') return 'human'
  if (shape.props.nodeType === 'ai-review') return 'review'
  if (shape.props.nodeType === 'agent') {
    try {
      const cfg = JSON.parse(shape.props.config || '{}') as { interactionMode?: string }
      if (cfg.interactionMode === 'collaborative') return 'collab'
    } catch {
      /* ignore */
    }
    return 'ai'
  }
  return 'ai'
}

function modeMeta(mode: StageMode): { label: string; tone: string } {
  if (mode === 'human') return { label: '人工', tone: 'is-human' }
  if (mode === 'collab') return { label: '人机协同', tone: 'is-collab' }
  if (mode === 'review') return { label: '审核', tone: 'is-review' }
  return { label: 'AI', tone: 'is-ai' }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function estimateNodeValueBytes(val: NodeValue | undefined): number {
  if (!val) return 0
  if (val.kind === 'text' || val.kind === 'markdown') return new TextEncoder().encode(val.text).byteLength
  if (val.kind === 'json' || val.kind === 'camera') {
    return new TextEncoder().encode(JSON.stringify(val.data)).byteLength
  }
  return 256
}

function parseHumanConfig(shape: NodeCardShape): HumanTaskNodeConfig {
  try {
    const parsed = HumanTaskNodeConfigSchema.safeParse(JSON.parse(shape.props.config || '{}'))
    if (parsed.success) return parsed.data
  } catch {
    /* ignore */
  }
  return { schemaVersion: 1, outputType: 'text', instructions: '' }
}

function parseHumanInstance(shape: NodeCardShape): HumanTaskInstance | null {
  const raw = (shape.meta as Record<string, unknown> | undefined)?.humanTask
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = HumanTaskInstanceSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function findCoordinatorForNode(editor: Editor, nodeId: string): string | null {
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'node-card') continue
    const card = shape as NodeCardShape
    if (card.props.nodeType !== 'agent') continue
    try {
      const cfg = JSON.parse(card.props.config || '{}') as {
        role?: string
        allowedNodeIds?: string[]
        stages?: Array<{ nodeId?: string }>
      }
      if (cfg.role !== 'coordinator') continue
      if (
        cfg.allowedNodeIds?.includes(nodeId) ||
        cfg.stages?.some((stage) => stage.nodeId === nodeId)
      ) {
        return card.id
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

/** 通用多模态产物渲染器：文本 / JSON / 图片 / 视频 / 音频 / 文件统一原生预览。 */
function MultimodalValueView({
  value,
  compact = false
}: {
  value: NodeValue
  compact?: boolean
}): React.JSX.Element {
  const mediaById = useMediaStore((s) => s.assets)
  if (value.kind === 'image') {
    const rel = value.mediaPath || mediaById.find((a) => a.id === value.mediaId)?.path
    return rel ? (
      <img
        className={`ass-media-img${compact ? ' is-compact' : ''}`}
        src={mediaUrl(rel)}
        alt="图片产物"
      />
    ) : (
      <div className="ass-media-placeholder">图片 · {value.mediaId || '未生成'}</div>
    )
  }
  if (value.kind === 'video') {
    const rel = value.mediaPath || mediaById.find((a) => a.id === value.mediaId)?.path
    return rel ? (
      <video
        className={`ass-media-video${compact ? ' is-compact' : ''}`}
        src={mediaUrl(rel)}
        controls
        preload="metadata"
      />
    ) : (
      <div className="ass-media-placeholder">视频 · {value.mediaId || '未生成'}</div>
    )
  }
  if (value.kind === 'audio') {
    const rel = value.mediaPath || mediaById.find((a) => a.id === value.mediaId)?.path
    return rel ? (
      <audio className="ass-media-audio" src={mediaUrl(rel)} controls preload="metadata" />
    ) : (
      <div className="ass-media-placeholder">音频 · {value.mediaId || '未生成'}</div>
    )
  }
  if (value.kind === 'json' || value.kind === 'camera') {
    return (
      <pre className={`ass-code-block${compact ? ' is-compact' : ''}`}>
        {JSON.stringify(value.data, null, 2)}
      </pre>
    )
  }
  if (value.kind === 'text' || value.kind === 'markdown') {
    return <pre className={`ass-text-block${compact ? ' is-compact' : ''}`}>{value.text}</pre>
  }
  return <div className="ass-media-placeholder">{value.mime || value.kind}</div>
}

const studioDrafts = new WeakMap<Editor, Map<string, string>>()

function useStageDraft(editor: Editor, key: string): readonly [string, Dispatch<SetStateAction<string>>] {
  const [value, setValue] = useState(() => studioDrafts.get(editor)?.get(key) ?? '')
  useEffect(() => {
    let drafts = studioDrafts.get(editor)
    if (!drafts) {
      drafts = new Map<string, string>()
      studioDrafts.set(editor, drafts)
    }
    if (value) drafts.set(key, value)
    else drafts.delete(key)
  }, [editor, key, value])
  return [value, setValue] as const
}

export function AgentStageStudio({
  editor,
  projectId,
  shapeId,
  onClose
}: AgentStageStudioProps): React.JSX.Element | null {
  const shape = useValue(
    'stage-studio-shape',
    () => {
      const current = editor.getShape<NodeCardShape>(shapeId)
      return current?.type === 'node-card' ? current : null
    },
    [editor, shapeId]
  )

  const stageList = useValue(
    'stage-studio-siblings',
    () => {
      const nodes: NodeCardShape[] = []
      for (const s of editor.getCurrentPageShapes()) {
        if (s.type !== 'node-card') continue
        const card = s as NodeCardShape
        if (['agent', 'human-task', 'ai-review'].includes(card.props.nodeType)) {
          try {
            if (
              card.props.nodeType === 'agent' &&
              (JSON.parse(card.props.config || '{}') as { role?: string }).role === 'coordinator'
            ) {
              continue
            }
          } catch {
            /* ignore */
          }
          nodes.push(card)
        }
      }
      const owner = findCoordinatorForNode(editor, shapeId)
      return owner ? nodes.filter(node => findCoordinatorForNode(editor, node.id) === owner) : nodes
    },
    [editor, shapeId]
  )

  const upstreamItems = useValue(
    'stage-studio-upstreams',
    () => {
      const graph = deriveGraph(editor)
      const incoming = graph.edges.filter((edge) => edge.to.nodeId === shapeId)
      const seen = new Set<string>()
      const items: Array<{ nodeId: string; title: string; nodeType: string; value?: NodeValue }> = []
      for (const edge of incoming) {
        if (seen.has(edge.from.nodeId)) continue
        seen.add(edge.from.nodeId)
        const src = editor.getShape<NodeCardShape>(edge.from.nodeId as TLShapeId)
        if (!src || src.type !== 'node-card') continue
        const projected = projectNodeOutputs(src)
        const val = projected[edge.from.portId] ?? Object.values(projected)[0]
        items.push({
          nodeId: src.id,
          title: src.props.title || getNodeType(src.props.nodeType)?.label || '节点',
          nodeType: src.props.nodeType,
          value: val
        })
      }
      return items
    },
    [editor, shapeId]
  )

  const canvasPickableNodes = useValue(
    'stage-studio-pickable-nodes',
    () => {
      const list: Array<{ id: string; title: string; value: NodeValue }> = []
      for (const s of editor.getCurrentPageShapes()) {
        if (s.type !== 'node-card' || s.id === shapeId) continue
        const card = s as NodeCardShape
        const projected = projectNodeOutputs(card)
        const first = Object.values(projected).find((v) => v !== undefined)
        if (first) list.push({ id: card.id, title: card.props.title || card.props.nodeType, value: first })
      }
      return list
    },
    [editor, shapeId]
  )

  const [collabView, setCollabView] = useState<FlowAgentCollaborationView | null>(null)
  const [candidatePreviews, setCandidatePreviews] = useState<Record<string, NodeValue>>({})
  const draftKey = JSON.stringify([projectId, shapeId])
  const [selectedCandidateId, setSelectedCandidateId] = useStageDraft(editor, draftKey + '/selectedCandidateId')
  const [chatInput, setChatInput] = useStageDraft(editor, draftKey + '/chatInput')
  const [outputDraft, setOutputDraft] = useStageDraft(editor, draftKey + '/outputDraft')
  const [humanDraft, setHumanDraft] = useStageDraft(editor, draftKey + '/humanDraft')
  const [humanMediaId, setHumanMediaId] = useStageDraft(editor, draftKey + '/humanMediaId')
  const [humanMediaPath, setHumanMediaPath] = useStageDraft(editor, draftKey + '/humanMediaPath')
  const [busy, setBusy] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  // ESC 退出聚焦工作台
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 加载 Agent 协作视图与多模态候选产物预览
  const loadCollab = useCallback(async () => {
    if (!shape || shape.props.nodeType !== 'agent' || !window.api?.flowAgentCollaboration) return
    try {
      const reply = await window.api.flowAgentCollaboration({ projectId, nodeId: shape.id })
      if (!reply.ok || !reply.data) {
        setCollabView(null)
        return
      }
      setCollabView(reply.data)
      if (reply.data.workingDraft !== undefined) {
        setOutputDraft((prev) => (prev ? prev : reply.data!.workingDraft ?? ''))
      }
      const uniqueCandidates = [
        ...new Map(reply.data.candidates.map((ref) => [ref.versionId, ref])).values()
      ]
      const loaded = await Promise.all(
        uniqueCandidates.map(async (ref) => {
          const asset = await window.api.readFlowAsset({ projectId, versionId: ref.versionId })
          return asset.ok ? ([ref.versionId, asset.data.value as unknown as NodeValue] as const) : null
        })
      )
      const map: Record<string, NodeValue> = {}
      for (const entry of loaded) {
        if (entry) map[entry[0]] = entry[1]
      }
      setCandidatePreviews(map)
    } catch {
      /* ignore */
    }
  }, [projectId, shape])

  useEffect(() => {
    let disposed = false
    if (!shape || shape.props.nodeType !== 'agent' || !window.api?.flowAgentCollaboration) return
    void (async () => {
      try {
        const reply = await window.api.flowAgentCollaboration({ projectId, nodeId: shape.id })
        if (disposed) return
        if (!reply.ok || !reply.data) {
          setCollabView(null)
          return
        }
        setCollabView(reply.data)
        if (reply.data.workingDraft !== undefined) {
          setOutputDraft((prev) => (prev ? prev : reply.data!.workingDraft ?? ''))
        }
        const uniqueCandidates = [
          ...new Map(reply.data.candidates.map((ref) => [ref.versionId, ref])).values()
        ]
        const loaded = await Promise.all(
          uniqueCandidates.map(async (ref) => {
            const asset = await window.api.readFlowAsset({ projectId, versionId: ref.versionId })
            return asset.ok
              ? ([ref.versionId, asset.data.value as unknown as NodeValue] as const)
              : null
          })
        )
        if (disposed) return
        const map: Record<string, NodeValue> = {}
        for (const entry of loaded) {
          if (entry) map[entry[0]] = entry[1]
        }
        setCandidatePreviews(map)
      } catch {
        /* ignore */
      }
    })()
    return () => {
      disposed = true
    }
  }, [projectId, shape])

  if (!shape) return null

  const mode = detectStageMode(shape)
  const meta = modeMeta(mode)
  const humanCfg = mode === 'human' ? parseHumanConfig(shape) : null
  const humanInst = mode === 'human' ? parseHumanInstance(shape) : null
  const archived = readArchivedDeliveries(shape)
  const projectedSelf = projectNodeOutputs(shape)
  const firstSelfOutput = Object.values(projectedSelf).find((v) => v !== undefined)

  const reviewDecision = (() => {
    if (mode !== 'review') return null
    try {
      return ReviewDecisionSchema.parse(JSON.parse(String(shape.meta?.nodeResult ?? '')))
    } catch {
      return null
    }
  })()

  const inputBytes = upstreamItems.reduce((sum, item) => sum + estimateNodeValueBytes(item.value), 0)

  const collabReady =
    !busy && collabView?.task.state === 'waiting' && collabView.task.waitKind === 'human'

  // ── 协作动作（讨论 / 采纳提交 / 拒绝） ──
  const runCollabAction = async (
    actionKind: FlowAgentCollaboration['action'],
    accepted?: boolean
  ): Promise<void> => {
    if (!collabView || busy) return
    setBusy(true)
    try {
      await ensureCanvasSaved()
      const textPayload =
        actionKind === 'discuss' || actionKind === 'note'
          ? chatInput.trim()
          : outputDraft.trim()
      const reply = await window.api.cooperateFlowAgent({
        projectId,
        nodeId: shape.id,
        taskId: collabView.task.taskId,
        waitRevision: collabView.task.waitRevision,
        revision: collabView.revision,
        eventId: crypto.randomUUID(),
        action: actionKind,
        text: textPayload,
        ...(actionKind === 'submit'
          ? {
              accepted,
              selectedOutputs: selectedCandidateId
                ? collabView.candidates.filter((c) => c.versionId === selectedCandidateId)
                : []
            }
          : {})
      })
      if (!reply.ok) {
        toast(reply.error.message)
        return
      }
      setCollabView(reply.data)
      if (actionKind === 'discuss' || actionKind === 'note') setChatInput('')
      if (actionKind === 'submit' && accepted) {
        setSelectedCandidateId('')
        setOutputDraft('')
        toast('已确认交付')
      }
      const current = editor.getShape(shape.id)
      editor.updateShape({
        id: shape.id,
        type: 'node-card',
        meta: { ...current?.meta, agentTask: JSON.stringify(reply.data.task) }
      })
      window.dispatchEvent(
        new CustomEvent('canvas-agent-task-updated', {
          detail: { projectId, nodeId: shape.id, task: reply.data.task }
        })
      )
      await ensureCanvasSaved()
      await loadCollab()
    } catch {
      toast('操作未确认，请重试')
    } finally {
      setBusy(false)
    }
  }

  // ── 纯人交付提交 ──
  const submitHumanDelivery = async (): Promise<void> => {
    if (!humanCfg || busy) return
    setBusy(true)
    try {
      let value: HumanTaskValue
      if (humanCfg.outputType === 'image' || humanCfg.outputType === 'video') {
        if (!humanMediaId) {
          toast('请先上传或选择媒体')
          return
        }
        value = { kind: humanCfg.outputType, mediaId: humanMediaId }
      } else if (humanCfg.outputType === 'json') {
        try {
          value = { kind: 'json', data: JSON.parse(humanDraft) }
        } catch {
          toast('JSON 格式无效')
          return
        }
      } else {
        if (!humanDraft.trim()) {
          toast('请先填写交付内容')
          return
        }
        value = { kind: 'text', text: humanDraft }
      }
      const current = editor.getShape<NodeCardShape>(shape.id)
      if (!current) return
      const submitted = admitHumanTaskSubmission(current, {
        submissionId: crypto.randomUUID(),
        expectedRevision: humanInst?.revision ?? 1,
        value
      })
      if (!submitted.ok) {
        toast('本轮已有待处理提交，请继续流程')
        return
      }
      if (!submitted.replay) {
        markUndoPoint(editor, shape.id)
        editor.updateShape({
          id: shape.id,
          type: 'node-card',
          meta: { humanTaskPending: JSON.stringify(submitted.pending) }
        })
      }
      await ensureCanvasSaved()
      window.dispatchEvent(new Event('canvas-agent-task-updated'))
      setHumanDraft('')
      setHumanMediaId('')
      setHumanMediaPath('')
      toast('已提交交付')
    } finally {
      setBusy(false)
    }
  }

  const pickHumanMedia = async (): Promise<void> => {
    if (!humanCfg) return
    const targetKind = humanCfg.outputType === 'video' ? 'video' : 'image'
    const imported = await window.api.pickMedia(projectId)
    if (!imported.ok) return
    const asset = imported.data.assets.find((a) => a.kind === targetKind)
    if (!asset) {
      toast(`请选择${targetKind === 'video' ? '视频' : '图片'}文件`)
      return
    }
    setHumanMediaId(asset.id)
    setHumanMediaPath(asset.path)
  }

  const pickFromCanvasNode = (nodeId: string): void => {
    const found = canvasPickableNodes.find((n) => n.id === nodeId)
    if (!found) return
    const val = found.value
    if (val.kind === 'text' || val.kind === 'markdown') {
      setHumanDraft(val.text)
      toast(`已载入「${found.title}」`)
    } else if (val.kind === 'json' || val.kind === 'camera') {
      setHumanDraft(JSON.stringify(val.data, null, 2))
      toast(`已载入「${found.title}」`)
    } else if (val.kind === 'image' || val.kind === 'video') {
      if (val.mediaId) setHumanMediaId(val.mediaId)
      if (val.mediaPath) setHumanMediaPath(val.mediaPath)
      toast(`已引用「${found.title}」`)
    }
  }

  // ── 通用单步运行（AI 执行 / 审核） ──
  const runThisStage = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await ensureCanvasSaved()
      const result = await runNodeManually(
        editor,
        projectId,
        useGatewayStore.getState().providers,
        shape.id
      )
      await ensureCanvasSaved()
      if (result.status === 'failed') toast(result.reason ?? '执行失败')
      else toast('本步执行完成')
      window.dispatchEvent(new Event('canvas-agent-task-updated'))
    } catch {
      toast('执行未确认')
    } finally {
      setBusy(false)
    }
  }

  // ── 上游撤销 / 从此步重做（先弹影响清单 → 当前态清空受影响下游 → 旧产物软归档历史） ──
  const handleUpstreamRework = async (): Promise<void> => {
    if (busy) return
    const graph = deriveGraph(editor)
    const downstreamIds = collectDownstreamNodeIds(
      graph.edges.map((e) => ({ from: e.from.nodeId, to: e.to.nodeId })),
      shape.id
    )
    const downstreamNames = downstreamIds.map((id) => {
      const s = editor.getShape<NodeCardShape>(id as TLShapeId)
      return s?.props.title || id
    })
    const coordinatorId = findCoordinatorForNode(editor, shape.id)
    let serverLines: string[] = []

    if (coordinatorId) {
      try {
        const preview = await window.api.flowAgentStageReworkPreview({
          projectId,
          nodeId: coordinatorId,
          stageKey: shape.id
        })
        if (!preview.ok || !preview.data?.canRework) {
          toast(preview.ok ? '当前阶段无法返工' : preview.error.message)
          return
        }
        serverLines = [
            `受影响阶段：${preview.data.willRerunStages.length} 个`,
            `${preview.data.staleDeliveries.length} 份旧交付将移入历史，保留上游 ${preview.data.keptDeliveries} 份`
        ]
      } catch {
        toast('返工影响尚未确认')
        return
      }
    }

    const impactLines = [
      downstreamNames.length > 0
        ? `将清空下游 ${downstreamNames.length} 个受依赖节点：${downstreamNames.join('、')}`
        : '没有下游节点需要清理。',
      ...serverLines,
      '旧产物自动归档至各节点「历史」，不物理删除；无关分支不受影响。'
    ]

    const confirmed = await useConfirmStore.getState().confirm({
      title: `从「${shape.props.title || '当前环节'}」重做？`,
      message: impactLines.join('\n'),
      confirmText: '确认重做',
      cancelText: '取消',
      danger: true
    })
    if (!confirmed) return

    setBusy(true)
    try {
      if (coordinatorId) {
        const reply = await window.api.flowAgentStageRework({
          projectId,
          nodeId: coordinatorId,
          stageKey: shape.id
        })
        if (!reply.ok) {
          toast(reply.error.message)
          return
        }
      }
      const { clearedIds, archivedCount } = archiveAndClearDownstreamCanvasNodes(editor, shape.id)
      await ensureCanvasSaved()
      window.dispatchEvent(new Event('canvas-agent-task-updated'))
      toast(
        clearedIds.length > 0
          ? `已清空 ${clearedIds.length} 个下游节点，${archivedCount} 份旧产物已归档历史`
          : '本步没有需要清理的下游节点'
      )
    } catch {
      toast('返工结果尚未确认，请核对流程状态')
    } finally {
      setBusy(false)
    }
  }

  const copyText = (text: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => toast('已复制'),
      () => toast('复制失败')
    )
  }

  const adoptCandidate = (versionId: string, val?: NodeValue): void => {
    setSelectedCandidateId(versionId)
    if (val) {
      if (val.kind === 'json' || val.kind === 'camera') {
        setOutputDraft(JSON.stringify(val.data, null, 2))
      } else if (val.kind === 'text' || val.kind === 'markdown') {
        setOutputDraft(val.text)
      }
    }
    toast('已采纳到左下角输出')
  }

  const switchStage = (targetId: string): void => {
    const id = (targetId.startsWith('shape:') ? targetId : createShapeId(targetId)) as TLShapeId
    useNodePanelStore.getState().open('stage-studio', id, 'collaboration')
  }

  const outputTypeBadge =
    mode === 'human' && humanCfg
      ? humanCfg.outputType.toUpperCase()
      : mode === 'review'
        ? '决策'
        : firstSelfOutput
          ? firstSelfOutput.kind.toUpperCase()
          : '交付物'



  return (
    <div className="ass-overlay" role="dialog" aria-modal="true" aria-label="环节聚焦工作台">
      {/* 44px 极简顶栏 */}
      <header className="ass-topbar">
        <div className="ass-topbar-left">
          <button type="button" className="ass-ghost-btn" onClick={onClose}>
            <Icon name="fullscreen-exit" size={13} />
            <span>返回画布</span>
          </button>
          <span className="ass-divider" />
          <span className={`ass-dot ${meta.tone}`} />

          <h1 className="ass-stage-title">{shape.props.title || '环节工作台'}</h1>
          <span className={`ass-mode-chip ${meta.tone}`}>{meta.label}</span>
        </div>

        {/* 居中紧凑阶段切换 */}
        {stageList.length > 1 && (
          <nav className="ass-stage-switcher" aria-label="切换环节">
            {stageList.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`ass-switch-pill${item.id === shape.id ? ' is-current' : ''}`}
                onClick={() => switchStage(item.id)}
              >
                <span>{item.props.title || '环节'}</span>
              </button>
            ))}
          </nav>
        )}

        <div className="ass-topbar-right">
          {archived.length > 0 && (
            <button
              type="button"
              className={`ass-ghost-btn${showHistory ? ' is-active' : ''}`}
              onClick={() => setShowHistory((v) => !v)}
            >
              <Icon name="history" size={12} />
              <span>历史 {archived.length}</span>
            </button>
          )}
          <button
            type="button"
            className="ass-ghost-btn"
            onClick={() => useNodePanelStore.getState().open('contract', shape.id, 'settings')}
            title="高级设置"
          >
            <Icon name="settings" size={12} />
          </button>
          <button
            type="button"
            className="ass-ghost-btn"
            disabled={busy}
            onClick={() => void handleUpstreamRework()}
          >
            <Icon name="reset" size={12} />
            <span>从此步重做</span>
          </button>
        </div>
      </header>

      {/* 历史归档抽屉条（仅用户点击「历史 N」时展开） */}
      {showHistory && archived.length > 0 && (
        <div className="ass-history-bar">
          <span className="ass-history-label">历史归档（上游重做时自动保留）</span>
          <div className="ass-history-list">
            {archived.map((snap, idx) => (
              <div className="ass-history-item" key={snap.archiveId}>
                <span>
                  归档 #{archived.length - idx} ·{' '}
                  {new Date(snap.archivedAt).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                  })}
                </span>
                <button
                  type="button"
                  className="ass-chip-btn"
                  onClick={() => {
                    if (restoreArchivedDelivery(editor, shape.id, snap.archiveId)) {
                      toast('已恢复该历史交付')
                      setShowHistory(false)
                    }
                  }}
                >
                  恢复
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 两栏主体：左 320px（上输入 / 下输出） + 右 ~72% 主工作台 */}
      <div className="ass-body">
        {/* 左栏：契约 I/O 栏 */}
        <aside className="ass-io-rail">
          {/* 左上：输入 */}
          <section className="ass-io-half ass-io-inputs">
            <div className="ass-io-head">
              <span className="ass-io-title">
                <span className="ass-head-dot is-cyan" />
                输入 · 上游节点
              </span>
              <span className="ass-budget-text">
                约 {formatBytes(inputBytes)}
              </span>
            </div>
            <div className="ass-io-scroll">
              {upstreamItems.length === 0 ? (
                <div className="ass-empty-slot">无上游输入</div>
              ) : (
                upstreamItems.map((item) => (
                  <div className="ass-io-card" key={item.nodeId}>
                    <div className="ass-io-card-head">
                      <span className="ass-io-card-name">{item.title}</span>
                      <span className="ass-type-chip">
                        {item.value ? item.value.kind.toUpperCase() : item.nodeType}
                      </span>
                    </div>
                    {item.value && <MultimodalValueView value={item.value} compact />}
                  </div>
                ))
              )}
            </div>
          </section>

          {/* 左下：输出 */}
          <section className="ass-io-half ass-io-outputs">
            <div className="ass-io-head">
              <span className="ass-io-title">
                <span className="ass-head-dot is-amber" />
                输出 · {outputTypeBadge}
              </span>
            </div>

            <div className="ass-io-scroll">
              {mode === 'human' && humanCfg ? (
                humanCfg.outputType === 'image' || humanCfg.outputType === 'video' ? (
                  humanMediaPath ? (
                    humanCfg.outputType === 'video' ? (
                      <video className="ass-media-video" src={mediaUrl(humanMediaPath)} controls />
                    ) : (
                      <img className="ass-media-img" src={mediaUrl(humanMediaPath)} alt="待交付媒体" />
                    )
                  ) : (
                    <div className="ass-empty-slot">待上传{humanCfg.outputType === 'video' ? '视频' : '图片'}</div>
                  )
                ) : (
                  <textarea
                    className="ass-output-editor"
                    value={humanDraft}
                    placeholder={humanCfg.outputType === 'json' ? '{ }' : '输入交付内容'}
                    onChange={(e) => setHumanDraft(e.target.value)}
                  />
                )
              ) : mode === 'collab' ? (
                selectedCandidateId && candidatePreviews[selectedCandidateId] ? (
                  <MultimodalValueView value={candidatePreviews[selectedCandidateId]} />
                ) : (
                  <textarea
                    className="ass-output-editor"
                    value={outputDraft}
                    placeholder="从右侧对话采纳或直接编辑交付物"
                    onChange={(e) => setOutputDraft(e.target.value)}
                  />
                )
              ) : mode === 'review' ? (
                reviewDecision ? (
                  <div className={`ass-verdict-card ${reviewDecision.passed ? 'is-pass' : 'is-fail'}`}>
                    <div className="ass-verdict-head">
                      <span>{reviewDecision.passed ? '✓ 通过放行' : '↩ 驳回返工'}</span>
                      <span>第 {reviewDecision.reviewRevision + 1} 轮</span>
                    </div>
                    <p className="ass-verdict-text">{reviewDecision.feedback}</p>
                  </div>
                ) : (
                  <div className="ass-empty-slot">待审核裁决</div>
                )
              ) : firstSelfOutput ? (
                <MultimodalValueView value={firstSelfOutput} />
              ) : (
                <div className="ass-empty-slot">待执行产出</div>
              )}
            </div>

            {/* 左下角固定主操作 */}
            <div className="ass-io-footer">
              {mode === 'human' && (
                <button
                  type="button"
                  className="ass-primary-cta is-cyan"
                  disabled={busy}
                  onClick={() => void submitHumanDelivery()}
                >
                  确认交付 →
                </button>
              )}
              {mode === 'collab' && (
                <button
                  type="button"
                  className="ass-primary-cta is-cyan"
                  disabled={collabView ? !collabReady : busy}
                  onClick={() => void (collabView ? runCollabAction('submit', true) : runThisStage())}
                >
                  {collabView ? '确认交付 →' : '启动本步对话'}
                </button>
              )}
              {mode === 'ai' && (
                <button
                  type="button"
                  className="ass-primary-cta is-cyan"
                  disabled={busy}
                  onClick={() => void runThisStage()}
                >
                  {busy ? '执行中…' : '运行本步'}
                </button>
              )}
              {mode === 'review' && (
                <button
                  type="button"
                  className="ass-primary-cta is-cyan"
                  disabled={busy}
                  onClick={() => void runThisStage()}
                >
                  {busy ? '审核中…' : reviewDecision ? '复审当前版本' : '执行审核'}
                </button>
              )}
            </div>
          </section>
        </aside>

        {/* 右栏：72% 超大主工作台（4 形态自适应，零冗余文案） */}
        <section className="ass-workspace">
          {mode === 'human' && humanCfg && (
            <div className="ass-ws-scroll ass-ws-human">
              <div className="ass-ws-toolbar">
                <AppSelect
                  aria-label="交付类型"
                  value={humanCfg.outputType}
                  onChange={(e) => {
                    markUndoPoint(editor, shape.id)
                    editor.updateShape({
                      id: shape.id,
                      type: 'node-card',
                      props: {
                        config: JSON.stringify({ ...humanCfg, outputType: e.target.value })
                      }
                    })
                  }}
                >
                  <option value="text">文本</option>
                  <option value="json">JSON</option>
                  <option value="image">图片</option>
                  <option value="video">视频</option>
                </AppSelect>

                {(humanCfg.outputType === 'image' || humanCfg.outputType === 'video') && (
                  <button type="button" className="ass-ghost-btn" onClick={() => void pickHumanMedia()}>
                    <Icon name="upload" size={13} />
                    <span>上传本地{humanCfg.outputType === 'video' ? '视频' : '图片'}</span>
                  </button>
                )}

                {canvasPickableNodes.length > 0 && (
                  <AppSelect
                    aria-label="从画布节点拾取"
                    value=""
                    onChange={(e) => {
                      if (e.target.value) pickFromCanvasNode(e.target.value)
                    }}
                  >
                    <option value="">从画布拾取已有节点…</option>
                    {canvasPickableNodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.title} ({n.value.kind})
                      </option>
                    ))}
                  </AppSelect>
                )}
              </div>

              {humanCfg.outputType === 'image' || humanCfg.outputType === 'video' ? (
                <div className="ass-dropzone" onClick={() => void pickHumanMedia()}>
                  {humanMediaPath ? (
                    humanCfg.outputType === 'video' ? (
                      <video className="ass-stage-media" src={mediaUrl(humanMediaPath)} controls />
                    ) : (
                      <img className="ass-stage-media" src={mediaUrl(humanMediaPath)} alt="已选媒体" />
                    )
                  ) : (
                    <div className="ass-dropzone-empty">
                      <Icon name="upload" size={28} />
                      <span>点击上传{humanCfg.outputType === 'video' ? '视频' : '图片'}</span>
                    </div>
                  )}
                </div>
              ) : (
                <textarea
                  className="ass-ws-editor"
                  value={humanDraft}
                  placeholder={humanCfg.outputType === 'json' ? '输入或粘贴 JSON…' : '输入或粘贴内容…'}
                  onChange={(e) => setHumanDraft(e.target.value)}
                />
              )}
            </div>
          )}

          {mode === 'collab' && (
            <div className="ass-ws-chat">
              <div className="ass-chat-stream">
                {!collabView ? (
                  <div className="ass-chat-empty">等待启动本步对话</div>
                ) : (
                  <>
                    {collabView.workingDraft !== undefined && (
                      <div className="ass-artifact-card">
                        <div className="ass-artifact-head">
                          <span className="ass-artifact-title">当前工作稿</span>
                          <div className="ass-artifact-actions">
                            <button
                              type="button"
                              className="ass-chip-btn"
                              onClick={() => copyText(collabView.workingDraft ?? '')}
                            >
                              复制
                            </button>
                            <button
                              type="button"
                              className="ass-chip-btn is-adopt"
                              onClick={() => {
                                setSelectedCandidateId('')
                                setOutputDraft(collabView.workingDraft ?? '')
                                toast('已采纳到输出')
                              }}
                            >
                              ↗ 采纳到输出
                            </button>
                          </div>
                        </div>
                        <pre className="ass-code-block">{collabView.workingDraft}</pre>
                      </div>
                    )}

                    {Object.entries(candidatePreviews).map(([versionId, val], idx) => (
                      <div className="ass-artifact-card" key={versionId}>
                        <div className="ass-artifact-head">
                          <span className="ass-artifact-title">
                            候选 #{idx + 1} · {val.kind.toUpperCase()}
                          </span>
                          <div className="ass-artifact-actions">
                            {(val.kind === 'text' || val.kind === 'json') && (
                              <button
                                type="button"
                                className="ass-chip-btn"
                                onClick={() =>
                                  copyText(
                                    val.kind === 'json' ? JSON.stringify(val.data, null, 2) : val.text
                                  )
                                }
                              >
                                复制
                              </button>
                            )}
                            <button
                              type="button"
                              className={`ass-chip-btn is-adopt${selectedCandidateId === versionId ? ' is-picked' : ''}`}
                              onClick={() => adoptCandidate(versionId, val)}
                            >
                              {selectedCandidateId === versionId ? '✓ 已采纳' : '↗ 采纳到输出'}
                            </button>
                          </div>
                        </div>
                        <div className="ass-artifact-body">
                          <MultimodalValueView value={val} />
                        </div>
                      </div>
                    ))}

                    {collabView.messages.map((msg) => (
                      <div className="ass-chat-turn" key={msg.eventId}>
                        {msg.text && (
                          <div className="ass-bubble is-user">
                            <div className="ass-bubble-text">{msg.text}</div>
                          </div>
                        )}
                        {msg.reply && (
                          <div className="ass-bubble is-ai">
                            <div className="ass-bubble-head">
                              <span>AI</span>
                              <div className="ass-artifact-actions">
                                <button
                                  type="button"
                                  className="ass-chip-btn"
                                  onClick={() => copyText(msg.reply ?? '')}
                                >
                                  复制
                                </button>
                                <button
                                  type="button"
                                  className="ass-chip-btn is-adopt"
                                  onClick={() => {
                                    setSelectedCandidateId('')
                                    setOutputDraft(msg.reply ?? '')
                                    toast('已采纳到输出')
                                  }}
                                >
                                  ↗ 采纳到输出
                                </button>
                              </div>
                            </div>
                            <div className="ass-bubble-text">{msg.reply}</div>
                          </div>
                        )}
                      </div>
                    ))}
                  </>
                )}
              </div>

              <div className="ass-chat-composer">
                <input
                  className="ass-chat-input"
                  value={chatInput}
                  placeholder="输入指令与 AI 共创…"
                  disabled={busy || !collabView}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && chatInput.trim()) {
                      e.preventDefault()
                      void runCollabAction(collabReady ? 'discuss' : 'note')
                    }
                  }}
                />
                <button
                  type="button"
                  className="ass-send-btn"
                  disabled={busy || !collabView || !chatInput.trim()}
                  onClick={() => void runCollabAction(collabReady ? 'discuss' : 'note')}
                >
                  发送
                </button>
              </div>
            </div>
          )}

          {mode === 'ai' && (
            <div className="ass-ws-scroll ass-ws-ai">
              <div className="ass-prompt-bar">
                <span className="ass-section-label">提示词 / 指令</span>
                <textarea
                  className="ass-prompt-input"
                  rows={3}
                  value={shape.props.text}
                  placeholder="描述本步处理要求…"
                  onChange={(e) =>
                    editor.updateShape({
                      id: shape.id,
                      type: 'node-card',
                      props: { text: e.target.value }
                    })
                  }
                />
              </div>
              <div className="ass-ai-stage-output">
                <span className="ass-section-label">产出预览</span>
                {firstSelfOutput ? (
                  <div className="ass-artifact-card">
                    <div className="ass-artifact-body">
                      <MultimodalValueView value={firstSelfOutput} />
                    </div>
                  </div>
                ) : (
                  <div className="ass-empty-slot">尚未执行</div>
                )}
              </div>
            </div>
          )}

          {mode === 'review' && (
            <div className="ass-ws-scroll ass-ws-review">
              <div className="ass-prompt-bar">
                <span className="ass-section-label">审核标准</span>
                <textarea
                  className="ass-prompt-input"
                  rows={2}
                  value={shape.props.text}
                  placeholder="输入通过条件…"
                  onChange={(e) =>
                    editor.updateShape({
                      id: shape.id,
                      type: 'node-card',
                      props: { text: e.target.value }
                    })
                  }
                />
              </div>

              <div className="ass-review-grid">
                {upstreamItems.map((item) => (
                  <div className="ass-artifact-card" key={item.nodeId}>
                    <div className="ass-artifact-head">
                      <span className="ass-artifact-title">{item.title}</span>
                      <span className="ass-type-chip">
                        {item.value ? item.value.kind.toUpperCase() : item.nodeType}
                      </span>
                    </div>
                    <div className="ass-artifact-body">
                      {item.value ? (
                        <MultimodalValueView value={item.value} />
                      ) : (
                        <div className="ass-empty-slot">暂无产物</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
