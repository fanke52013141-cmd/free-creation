import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createShapeId, useValue, type Editor, type TLShapeId } from 'tldraw'
import type { FlowRunOverview } from '@shared/agent-flow/run-overview'
import { Icon } from '../components/Icon'
import { Tooltip } from '../components/Tooltip'
import { useNodePanelStore } from '../stores/nodePanel'
import { useFlowFocusStore } from '../stores/flowFocus'
import { useGatewayStore } from '../stores/gateway'
import { toast } from '../stores/toast'
import { runNodeManually } from '../engine/executor'
import { ensureCanvasSaved } from './flow-asset-actions'
import { deriveFlowSteps, deriveNow, STATE_META, type FlowStepState } from './flow-overview-model'
import { deriveGraph } from './graph'
import { nodePageIndex } from './node-page-index'
import type { NodeCardShape } from './NodeCardShape'
import './flow-stage-rail.css'

export interface RailStageItem {
  nodeId: string
  title: string
  roleTag: '人工' | '人机' | 'AI' | '审核'
  state: FlowStepState
  needsYou: boolean
}

interface FlowStageRailProps {
  editor: Editor
  projectId: string
}

function discoverFlowMeta(editor: Editor): {
  coordinators: Array<{ nodeId: string; title: string; members: Set<string> }>
  controlledNodeIds: Set<string>
  stageNodes: NodeCardShape[]
} {
  const coordinators: Array<{ nodeId: string; title: string; members: Set<string> }> = []
  const controlledNodeIds = new Set<string>()
  const stageNodes: NodeCardShape[] = []

  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'node-card') continue
    const card = shape as NodeCardShape
    const nt = card.props.nodeType
    if (nt === 'agent') {
      try {
        const cfg = JSON.parse(card.props.config || '{}') as {
          role?: string
          allowedNodeIds?: unknown
          stages?: Array<{ nodeId?: string }>
        }
        if (cfg.role === 'coordinator') {
          const members = new Set<string>()
          if (Array.isArray(cfg.allowedNodeIds)) {
            for (const id of cfg.allowedNodeIds) {
              if (typeof id === 'string') members.add(id)
            }
          }
          if (Array.isArray(cfg.stages)) {
            for (const st of cfg.stages) {
              if (typeof st?.nodeId === 'string' && st.nodeId) members.add(st.nodeId)
            }
          }
          for (const member of members) controlledNodeIds.add(member)
          coordinators.push({ nodeId: card.id, title: card.props.title || '主控', members })
          continue
        }
      } catch {
        /* ignore malformed config */
      }
      stageNodes.push(card)
    } else if (nt === 'ai-review') {
      try {
        const cfg = JSON.parse(card.props.config || '{}') as { gatedNodeIds?: unknown }
        if (Array.isArray(cfg.gatedNodeIds)) {
          for (const id of cfg.gatedNodeIds) {
            if (typeof id === 'string') controlledNodeIds.add(id)
          }
        }
      } catch {
        /* ignore */
      }
      stageNodes.push(card)
    } else if (nt === 'human-task') {
      stageNodes.push(card)
    }
  }
  return { coordinators, controlledNodeIds, stageNodes }
}

function roleTagForShape(card: NodeCardShape): RailStageItem['roleTag'] {
  if (card.props.nodeType === 'human-task') return '人工'
  if (card.props.nodeType === 'ai-review') return '审核'
  if (card.props.nodeType === 'agent') {
    try {
      const cfg = JSON.parse(card.props.config || '{}') as { interactionMode?: string }
      if (cfg.interactionMode === 'collaborative') return '人机'
    } catch {
      /* ignore */
    }
  }
  return 'AI'
}

function roleTagForOverviewStep(kind: string, participation: string): RailStageItem['roleTag'] {
  if (kind === 'human-task' || participation === 'human') return '人工'
  if (kind === 'review') return '审核'
  if (participation === 'collaborative') return '人机'
  return 'AI'
}

function toShapeId(nodeId: string): TLShapeId {
  return (nodeId.startsWith('shape:') ? nodeId : createShapeId(nodeId)) as TLShapeId
}

function directUpstreamIds(editor: Editor, nodeId: string): Set<string> {
  const graph = deriveGraph(editor)
  const upstream = new Set<string>()
  for (const edge of graph.edges) {
    if (edge.to.nodeId === nodeId) upstream.add(edge.from.nodeId)
  }
  return upstream
}

export function FlowStageRail({ editor, projectId }: FlowStageRailProps): React.JSX.Element | null {
  const hasFlowNodes = useValue(
    'flow-stage-rail-presence',
    () => {
      const counts = nodePageIndex(editor).counts
      if (counts.controlFlowNodes > 0) return true
      for (const shape of editor.getCurrentPageShapes()) {
        if (shape.type === 'node-card' && (shape as NodeCardShape).props.nodeType === 'human-task') {
          return true
        }
      }
      return false
    },
    [editor]
  )

  const resetFocus = useFlowFocusStore((s) => s.reset)
  useEffect(() => {
    if (!hasFlowNodes) resetFocus()
    return () => resetFocus()
  }, [hasFlowNodes, resetFocus])

  if (!hasFlowNodes) return null
  return <FlowStageRailContent editor={editor} projectId={projectId} />
}

function FlowStageRailContent({ editor, projectId }: FlowStageRailProps): React.JSX.Element | null {
  const [overview, setOverview] = useState<FlowRunOverview | null>(null)
  const [busy, setBusy] = useState(false)
  const coordRef = useRef<string | null>(null)

  const focusedNodeId = useFlowFocusStore((s) => s.focusedNodeId)
  const spotlightEnabled = useFlowFocusStore((s) => s.spotlightEnabled)
  const showControlRelations = useFlowFocusStore((s) => s.showControlRelations)
  const setFocusedNode = useFlowFocusStore((s) => s.setFocusedNode)
  const setFlowContext = useFlowFocusStore((s) => s.setFlowContext)
  const toggleSpotlight = useFlowFocusStore((s) => s.toggleSpotlight)
  const toggleControlRelations = useFlowFocusStore((s) => s.toggleControlRelations)

  const canvasMeta = useValue('flow-stage-rail-meta', () => discoverFlowMeta(editor), [editor])
  const track = useRef<HTMLDivElement>(null)
  const [chosenFlow, setChosenFlow] = useState('')
  const coordinator = canvasMeta.coordinators.find(item => item.nodeId === chosenFlow) ?? canvasMeta.coordinators[0]
  const coordinatorId = coordinator?.nodeId ?? null

  // 轮询主控 Agent 实时运行投影（与 FlowOverviewPanel 同一权威来源）
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    coordRef.current = coordinatorId

    const tick = async (): Promise<void> => {
      if (disposed) return
      let delay = 3000
      if (coordinatorId && !document.hidden && window.api?.flowRunOverview) {
        try {
          const reply = await window.api.flowRunOverview({ projectId, nodeId: coordinatorId })
          if (disposed || coordRef.current !== coordinatorId) return
          if (reply.ok) {
            setOverview(reply.data.overview)
            const st = reply.data.overview?.state
            if (st && ['running', 'waiting', 'ready'].includes(st)) delay = 850
          }
        } catch {
          /* 保持上一帧 */
        }
      }
      if (!disposed) timer = setTimeout(() => void tick(), delay)
    }

    void tick()
    const onUpdated = (): void => {
      if (timer) clearTimeout(timer)
      void tick()
    }
    window.addEventListener('canvas-agent-task-updated', onUpdated)
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      window.removeEventListener('canvas-agent-task-updated', onUpdated)
    }
  }, [projectId, coordinatorId])

  const activeOverview = coordinatorId && overview?.nodeId === coordinatorId ? overview : null

  const steps = useMemo<RailStageItem[]>(() => {
    if (activeOverview) {
      const derived = deriveFlowSteps(activeOverview)
      if (derived.length > 0) {
        return derived.map((step) => ({
          nodeId: step.nodeId,
          title: step.title,
          roleTag: roleTagForOverviewStep(step.kind, step.participation),
          state: step.state,
          needsYou: step.needsYou
        }))
      }
    }
    // 未运行时列出阶段索引，画布坐标不表示执行顺序。
    const sorted = coordinator?.members.size
      ? canvasMeta.stageNodes.filter(node => coordinator.members.has(node.id))
      : canvasMeta.stageNodes
    return sorted.map((card) => ({
      nodeId: card.id,
      title: card.props.title || '未命名',
      roleTag: roleTagForShape(card),
      state:
        card.props.exec === 'success'
          ? 'completed'
          : card.props.exec === 'running'
            ? 'running'
            : card.props.exec === 'error'
              ? 'failed'
              : 'idle',
      needsYou: false
    }))
  }, [activeOverview, canvasMeta.stageNodes, coordinator])

  const now = useMemo(
    () => (activeOverview ? deriveNow(activeOverview, deriveFlowSteps(activeOverview)) : null),
    [activeOverview]
  )

  const attentionNodeId = useMemo(() => {
    const waiting = steps.find((s) => s.needsYou)
    if (waiting) return waiting.nodeId
    if (now?.tone === 'human' && now.nodeId) return now.nodeId
    return null
  }, [steps, now])

  // 同步受控集合与当前待处理卡点到全局 flowFocus store
  useEffect(() => {
    setFlowContext({
      attentionNodeId,
      controlledNodeIds: canvasMeta.controlledNodeIds
    })
  }, [attentionNodeId, canvasMeta.controlledNodeIds, setFlowContext])

  // 当出现明确待人工处理卡点且当前未手动选中其他节点时，自动聚光到卡点
  useEffect(() => {
    if (attentionNodeId && !focusedNodeId) {
      setFocusedNode(attentionNodeId, directUpstreamIds(editor, attentionNodeId))
    }
  }, [attentionNodeId, focusedNodeId, editor, setFocusedNode])

  const focusStage = useCallback(
    (nodeId: string) => {
      if (focusedNodeId === nodeId) {
        setFocusedNode(null)
        return
      }
      const shapeId = toShapeId(nodeId)
      const exists = editor.getShape(shapeId)
      setFocusedNode(nodeId, directUpstreamIds(editor, nodeId))
      if (exists) {
        const bounds = editor.getShapePageBounds(shapeId)
        if (bounds) editor.centerOnPoint(bounds.center, { animation: { duration: 220 } })
      }
    },
    [editor, focusedNodeId, setFocusedNode]
  )

  const openStudio = useCallback((nodeId: string) => {
    useNodePanelStore.getState().open('stage-studio', toShapeId(nodeId), 'collaboration')
  }, [])

  const runPrimaryAction = useCallback(async () => {
    if (attentionNodeId) {
      openStudio(attentionNodeId)
      return
    }
    if (!coordinatorId) {
      const target = focusedNodeId ?? steps[0]?.nodeId
      if (target) openStudio(target)
      return
    }
    if (busy) return
    setBusy(true)
    try {
      if (activeOverview?.state === 'running') {
        const reply = await window.api.pauseFlowAgent({ projectId, nodeId: coordinatorId })
        if (!reply.ok) toast(reply.error.message)
        else toast(activeOverview.paused ? '已恢复' : '已暂停')
        return
      }
      await ensureCanvasSaved()
      const shapeId = toShapeId(coordinatorId)
      const result = await runNodeManually(
        editor,
        projectId,
        useGatewayStore.getState().providers,
        shapeId
      )
      if (result.status === 'failed') toast(result.reason ?? '启动失败')
    } catch {
      toast('操作未确认，请检查流程状态')
    } finally {
      setBusy(false)
      window.dispatchEvent(new Event('canvas-agent-task-updated'))
    }
  }, [attentionNodeId, busy, coordinatorId, editor, focusedNodeId, openStudio, activeOverview, projectId, steps])

  if (!steps.length && !coordinatorId) return null

  const activeStageId = focusedNodeId ?? attentionNodeId ?? steps[0]?.nodeId ?? null
  const primaryLabel = attentionNodeId
    ? '进入工作台 →'
    : activeOverview?.state === 'running'
      ? activeOverview.paused
        ? '恢复'
        : '暂停'
      : activeOverview?.state === 'waiting'
        ? '继续流程'
        : coordinatorId
          ? '启动流程'
          : '打开工作台'

  return (
    <div className="flow-stage-rail" role="region" aria-label="流程阶段轨">
      {canvasMeta.coordinators.length > 1 && (
        <select aria-label="当前流程" value={coordinatorId ?? ''} onChange={event => {
          setFocusedNode(null)
          setChosenFlow(event.target.value)
        }}>
          {canvasMeta.coordinators.map(item => <option key={item.nodeId} value={item.nodeId}>{item.title}</option>)}
        </select>
      )}
      <div className="flow-stage-rail-track" ref={track}>
        {steps.map((step) => {
          const isSelected = step.nodeId === focusedNodeId
          const toneClass =
            step.needsYou
              ? 'is-attention'
              : step.state === 'completed' || step.state === 'review-passed'
                ? 'is-done'
                : step.state === 'rejected' || step.state === 'failed' || step.state === 'blocked'
                  ? 'is-danger'
                  : step.state === 'running' || step.state === 'review-pending'
                    ? 'is-running'
                    : ''
          return (
            <div className="flow-stage-rail-item" key={step.nodeId}>
              <button
                type="button"
                className={`flow-stage-pill ${toneClass}${isSelected ? ' is-selected' : ''}`}
                onClick={() => focusStage(step.nodeId)}
                onDoubleClick={() => openStudio(step.nodeId)}
                title={`${step.title}（单击聚光，双击进入工作台）`}
              >
                {activeOverview?.graph?.edges.some(edge => edge.to === step.nodeId &&
                  activeOverview.graph!.edges.some(peer => peer.from === edge.from && peer.to !== edge.to && peer.kind === 'data') && edge.kind === 'data') && <span>分支</span>}
                <span className="flow-stage-name">{step.title}</span>
                <span className="flow-stage-role">{step.roleTag}</span>
                <span className={`flow-stage-glyph${step.needsYou || step.state === 'running' ? ' is-pulse' : ''}`}>
                  {STATE_META[step.state].label}
                </span>
              </button>

            </div>
          )
        })}
      </div>

      <div className="flow-stage-rail-actions">
        {steps.length > 1 && <>
          <button type="button" className="flow-rail-icon-btn" aria-label="向前查看阶段" onClick={() => track.current?.scrollBy({ left: -track.current.clientWidth * 0.8 })}>‹</button>
          <span>{steps.length} 个环节</span>
          <button type="button" className="flow-rail-icon-btn" aria-label="向后查看阶段" onClick={() => track.current?.scrollBy({ left: track.current.clientWidth * 0.8 })}>›</button>
        </>}
        {activeStageId && !attentionNodeId && (
          <Tooltip label="进入当前环节工作台">
            <button
              type="button"
              className="flow-rail-icon-btn"
              aria-label="进入环节工作台"
              onClick={() => openStudio(activeStageId)}
            >
              <Icon name="fullscreen" size={13} />
            </button>
          </Tooltip>
        )}
        <Tooltip label={spotlightEnabled ? '关闭聚光' : '聚光当前步'}>
          <button
            type="button"
            className={`flow-rail-icon-btn${spotlightEnabled && focusedNodeId ? ' is-active' : ''}`}
            aria-label="切换聚光当前步"
            aria-pressed={spotlightEnabled}
            onClick={() => {
              if (!spotlightEnabled && !focusedNodeId && activeStageId) {
                setFocusedNode(activeStageId, directUpstreamIds(editor, activeStageId))
              }
              toggleSpotlight()
            }}
          >
            <Icon name="target" size={13} />
          </button>
        </Tooltip>
        <Tooltip label={showControlRelations ? '隐藏编排虚线' : '显示编排虚线'}>
          <button
            type="button"
            className={`flow-rail-icon-btn${showControlRelations ? ' is-active' : ''}`}
            aria-label="切换编排虚线"
            aria-pressed={showControlRelations}
            onClick={toggleControlRelations}
          >
            <Icon name="state-machine" size={13} />
          </button>
        </Tooltip>
        <button
          type="button"
          className="flow-rail-cta"
          disabled={busy}
          onClick={() => void runPrimaryAction()}
        >
          {primaryLabel}
        </button>
      </div>
    </div>
  )
}
