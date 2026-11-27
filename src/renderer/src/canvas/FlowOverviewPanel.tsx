import { runNodeManually } from '../engine/executor'
import { useGatewayStore } from '../stores/gateway'
import { publishFlowGraphFromCanvas, restoreFlowGraph } from './flow-build-actions'
import { ensureCanvasSaved } from './flow-asset-actions'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import type { FlowRunOverview } from '@shared/agent-flow/run-overview'
import { Icon, type IconName } from '../components/Icon'
import { useNodePanelStore } from '../stores/nodePanel'
import { useConfirmStore } from '../stores/confirm'
import { toast } from '../stores/toast'
import {
  deriveFlowSteps,
  deriveNow,
  eventLabel,
  eventTone,
  flowProgress,
  STATE_META,
  type FlowStep
} from './flow-overview-model'
import './flow-overview.css'

interface FlowOverviewPanelProps {
  editor: Editor | null
  projectId: string
  onClose: () => void
}

interface CoordinatorRef {
  nodeId: string
  title: string
}

const KIND_ICON: Record<string, IconName> = {
  agent: 'agent',
  review: 'ai-review',
  'human-task': 'edit',
  capability: 'play',
  'state-machine': 'state-machine'
}

const KIND_COLOR: Record<string, string> = {
  agent: '#59D4CD',
  review: '#00AEBD',
  'human-task': '#E0A458',
  capability: '#C97152',
  'state-machine': '#49D2EA'
}

/** 从画布节点里发现主控 Agent（role=coordinator），作为总览的根。 */
function discoverCoordinators(editor: Editor | null): CoordinatorRef[] {
  if (!editor) return []
  const found: CoordinatorRef[] = []
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'node-card') continue
    const props = shape.props as { nodeType?: string; title?: string; config?: string }
    if (props.nodeType !== 'agent') continue
    try {
      const config = JSON.parse(props.config ?? '{}') as { role?: string }
      if (config.role === 'coordinator') {
        found.push({ nodeId: shape.id, title: props.title || '主 Agent' })
      }
    } catch {
      /* 配置损坏的节点跳过，不阻断总览。 */
    }
  }
  return found
}

function ProgressRing({ percent }: { percent: number }): React.JSX.Element {
  return (
    <div className="fo-ring" role="img" aria-label={`完成 ${percent}%`}>
      <svg viewBox="0 0 36 36" className="fo-ring-svg">
        <path
          className="fo-ring-bg"
          strokeWidth="3.2"
          fill="none"
          d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
        />
        <path
          className="fo-ring-value"
          strokeWidth="3.2"
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${percent}, 100`}
          d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
        />
      </svg>
      <span className="fo-ring-text">{percent}%</span>
    </div>
  )
}

const BOARD_LANES = ['人工', 'AI', '人机协作'] as const

function boardLane(step: FlowStep): number {
  if (step.kind === 'human-task' || step.participation === 'human') return 0
  return step.participation === 'collaborative' ? 2 : 1
}

function StepCard({
  step,
  onLocate,
  onRework
}: {
  step: FlowStep
  onLocate: (nodeId: string) => void
  onRework?: () => void
}): React.JSX.Element {
  const meta = STATE_META[step.state]
  const color = KIND_COLOR[step.kind] ?? '#59D4CD'
  const attention = step.needsYou
  return (
    <div className={`fo-step ${attention ? 'is-attention' : ''} is-${step.state}`}>
      <button
        type="button"
        className="fo-step-card"
        onClick={() => onLocate(step.nodeId)}
        title={`在画布中定位 ${step.title}`}
      >
        <div className="fo-step-head">
          <span className="fo-step-kind" style={{ color, borderColor: `${color}66`, background: `${color}1f` }}>
            <Icon name={KIND_ICON[step.kind] ?? 'agent'} size={12} />
          </span>
          <span className="fo-step-title">{step.title}</span>
          <span className="fo-board-role">{BOARD_LANES[boardLane(step)]}</span>
          {step.humanRole && <span className="fo-board-owner">{step.humanRole.name}</span>}
          <span className="fo-state" style={{ color: meta.color, borderColor: `${meta.color}55`, background: `${meta.color}14` }}>
            <span className={`fo-state-glyph ${step.state === 'running' ? 'is-pulse' : ''}`}>{meta.glyph}</span>
            {meta.label}
          </span>
        </div>
        {step.review && step.kind === 'review' && (
          <div className={`fo-rework ${step.state === 'rejected' ? 'is-fail' : ''}`}>
            <span className="fo-rework-label">
              {step.state === 'rejected' ? '返工中' : '审核门禁'} · 轮次 {step.review.round}/{step.review.maxReworks}
            </span>
            {step.review.feedback && <span className="fo-rework-reason">{step.review.feedback}</span>}
          </div>
        )}
        {step.state === 'gated' && step.gatedBy && (
          <div className="fo-gated-note">🔒 被「{step.gatedBy}」拦截</div>
        )}
        {step.detail && step.kind !== 'review' && step.state !== 'gated' && (
          <div className="fo-step-detail">{step.detail}</div>
        )}
      </button>
      {onRework && (
        <button
          type="button"
          className="fo-btn fo-step-action"
          aria-label={`从「${step.title}」返工`}
          onClick={onRework}
        >
          从这里返工
        </button>
      )}
    </div>
  )
}

export function FlowOverviewPanel({ editor, projectId, onClose }: FlowOverviewPanelProps): React.JSX.Element {
  const [coordinators, setCoordinators] = useState<CoordinatorRef[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [overview, setOverview] = useState<FlowRunOverview | null>(null)
  const [canvasVersion, setCanvasVersion] = useState<FlowRunOverview['canvasVersion']>()
  const [continuing, setContinuing] = useState(false)
  const [materialDraft, setMaterialDraft] = useState({ key: '', text: '' })
  const [loaded, setLoaded] = useState(false)
  const selectedRef = useRef<string | null>(null)
  useEffect(() => {
    selectedRef.current = selected
  }, [selected])

  const locate = useCallback(
    (nodeId: string) => {
      if (!editor) return
      const shapeId = createShapeId(nodeId)
      if (!editor.getShape(shapeId)) return
      editor.select(shapeId)
      const bounds = editor.getShapePageBounds(shapeId)
      if (bounds) editor.centerOnPoint(bounds.center, { animation: { duration: 220 } })
    },
    [editor]
  )

  const collaborate = useCallback(
    (nodeId: string) => {
      onClose()
      const id = (nodeId.startsWith('shape:') ? nodeId : createShapeId(nodeId)) as TLShapeId
      useNodePanelStore.getState().open('stage-studio', id, 'collaboration')
    },
    [onClose]
  )

  // 发现主控 + 自适应轮询总览（有运行 750ms，空闲 3s；页面隐藏时暂停）。
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async (): Promise<void> => {
      if (disposed) return
      const refs = discoverCoordinators(editor)
      setCoordinators(refs)
      let active = selectedRef.current
      if (!active || !refs.some((ref) => ref.nodeId === active)) {
        active = refs[0]?.nodeId ?? null
        selectedRef.current = active
        setSelected(active)
      }
      let delay = 3000
      if (active && !document.hidden) {
        try {
          const reply = await window.api.flowRunOverview({ projectId, nodeId: active })
          if (disposed || selectedRef.current !== active) return
          if (reply.ok) {
            setOverview(reply.data.overview)
            setCanvasVersion(reply.data.canvasVersion ?? reply.data.overview?.canvasVersion)
            const state = reply.data.overview?.state
            if (state && ['running', 'waiting', 'ready'].includes(state)) delay = 750
          }
        } catch {
          /* 读取失败保持上一帧，不打断用户。 */
        }
      }
      setLoaded(true)
      if (!disposed) timer = setTimeout(() => void tick(), delay)
    }
    void tick()
    const onTaskUpdated = (): void => {
      if (timer) clearTimeout(timer)
      void tick()
    }
    window.addEventListener('canvas-agent-task-updated', onTaskUpdated)
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      window.removeEventListener('canvas-agent-task-updated', onTaskUpdated)
    }
  }, [editor, projectId])

  const steps = useMemo(() => (overview ? deriveFlowSteps(overview) : []), [overview])
  const now = useMemo(() => (overview ? deriveNow(overview, steps) : null), [overview, steps])
  const bodyRef = useRef<HTMLDivElement>(null)
  const currentStepRef = useRef<HTMLDivElement>(null)
  const positionedFlow = useRef<string | null>(null)
  const [offscreenStep, setOffscreenStep] = useState<{ nodeId: string; element: HTMLElement } | null>(null)
  const currentNodeId = steps.some((step) => step.nodeId === now?.nodeId) ? now?.nodeId : undefined

  useEffect(() => {
    const body = bodyRef.current
    const current = currentStepRef.current
    if (!body || !current || !selected || !currentNodeId) return
    const observer = new IntersectionObserver(([entry]) => {
      setOffscreenStep(entry.isIntersecting ? null : { nodeId: currentNodeId, element: current })
    }, { root: body })
    observer.observe(current)
    if (positionedFlow.current !== selected) {
      positionedFlow.current = selected
      const viewport = body.getBoundingClientRect()
      const item = current.getBoundingClientRect()
      if (item.top < viewport.top || item.bottom > viewport.bottom) {
        body.scrollTop += item.top - viewport.top - 48
      }
    }
    return () => observer.disconnect()
  }, [selected, currentNodeId])
  const materialWait = overview?.contextMaterialWait
  const materialKey = materialWait
    ? JSON.stringify([overview.taskId, materialWait.waitRevision, materialWait.stageKey])
    : ''
  const materialText = materialKey && materialDraft.key === materialKey ? materialDraft.text : ''
  const materialBytes = new TextEncoder().encode(JSON.stringify(materialText)).byteLength
  const materialTooLarge = Boolean(materialWait?.limitBytes && materialBytes > materialWait.limitBytes)
  const progress = useMemo(() => flowProgress(steps), [steps])
  const events = useMemo(() => (overview ? [...overview.events].reverse().slice(0, 8) : []), [overview])

  const rework = async (step: FlowStep): Promise<void> => {
    if (!selected) return
    const input = { projectId, nodeId: selected, stageKey: step.nodeId }
    try {
      const preview = await window.api.flowAgentStageReworkPreview(input)
      if (!preview.ok || !preview.data?.canRework) {
        toast(`无法返工：${preview.ok ? preview.data?.blockedReason ?? '流程不支持返工' : preview.error.message}`)
        return
      }
      const impact = preview.data
      const titles = impact.willRerunStages.map(({ nodeId }) =>
        steps.find((item) => item.nodeId === nodeId)?.title ?? nodeId
      )
      const confirmed = await useConfirmStore.getState().confirm({
        title: `从「${step.title}」返工？`,
        message: `重新执行：${titles.join('、')}。
${impact.staleDeliveries.length} 份交付移入历史，保留 ${impact.keptDeliveries} 份交付。`,
        confirmText: '确认返工',
        cancelText: '取消',
        danger: true
      })
      if (!confirmed) return
      const result = await window.api.flowAgentStageRework(input)
      if (!result.ok) {
        toast(`返工失败：${result.error.message}`)
        return
      }
      window.dispatchEvent(new Event('canvas-agent-task-updated'))
      toast('返工已准备，继续流程后将重新执行受影响步骤')
    } catch {
      toast('暂时无法返工')
    }
  }

  const restoreDefinition = async (): Promise<void> => {
    if (!editor || !canvasVersion || continuing) return
    const { buildId } = canvasVersion
    const confirmed = await useConfirmStore.getState().confirm({
      title: '恢复原流程定义？',
      message: '将还原此流程的节点定义和输入连线。你可以在画布中撤销这次恢复。',
      confirmText: '恢复原定义',
      cancelText: '取消',
      danger: true
    })
    if (!confirmed) return
    setContinuing(true)
    try {
      await restoreFlowGraph(editor, projectId, buildId)
      toast('已恢复原流程定义')
    } catch (error) {
      toast(error instanceof Error ? error.message : '流程定义恢复失败')
    } finally {
      setContinuing(false)
    }
  }

  const publishDefinition = async (): Promise<void> => {
    if (!editor || !canvasVersion || continuing) return
    const { buildId } = canvasVersion
    const confirmed = await useConfirmStore.getState().confirm({
      title: '发布画布定义为新版本？',
      message: '发布会校验当前节点和连线，并将这个版本用于下一次运行。',
      confirmText: '发布新版本',
      cancelText: '取消'
    })
    if (!confirmed) return
    setContinuing(true)
    try {
      const published = await publishFlowGraphFromCanvas(editor, projectId, buildId)
      toast(`已发布 v${published.sourceGraph?.version ?? 1}`)
    } catch (error) {
      toast(error instanceof Error ? error.message : '流程定义发布失败')
    } finally {
      setContinuing(false)
    }
  }

  const continueFlow = async (): Promise<void> => {
    if (!editor || !selected || continuing || overview?.state !== 'waiting') return
    if (materialKey && (!materialText.trim() || materialTooLarge)) return
    const nodeId = selected as TLShapeId
    const expectedTaskId = overview.taskId
    setContinuing(true)
    try {
      await ensureCanvasSaved()
      const current = await window.api.inspectFlowAgent({ projectId, nodeId })
      if (!current.ok || current.data?.state !== 'waiting' ||
          current.data.taskId !== expectedTaskId || selectedRef.current !== nodeId ||
          (materialWait && (current.data.code !== 'FLOW_CONTEXT_OVER_BUDGET' ||
            current.data.waitRevision !== materialWait.waitRevision)) ||
          !editor.getShape(nodeId)) {
        toast('流程状态已变化，请查看最新进度')
        return
      }
      editor.updateShape({
        id: nodeId,
        type: 'node-card',
        meta: { agentTask: JSON.stringify(current.data) }
      })
      const result = await runNodeManually(
        editor, projectId, useGatewayStore.getState().providers, nodeId,
        undefined, undefined, undefined, undefined,
        materialKey ? {
          taskId: current.data.taskId, waitRevision: current.data.waitRevision, text: materialText
        } : undefined
      )
      if (result.status === 'failed') toast(result.reason ?? '继续流程失败')
    } catch {
      toast('继续流程失败，请查看运行状态')
    } finally {
      setContinuing(false)
      window.dispatchEvent(new Event('canvas-agent-task-updated'))
    }
  }

  const pause = useCallback(async () => {
    if (!selected) return
    const reply = await window.api.pauseFlowAgent({ projectId, nodeId: selected })
    if (!reply.ok) toast(`暂停失败：${reply.error.message}`)
    else toast(overview?.paused ? '已恢复派发' : '已暂停派发')
  }, [selected, projectId, overview?.paused])

  const overall = overview
    ? overview.state === 'completed'
      ? { label: '已完成', color: '#34d399' }
      : overview.state === 'failed' || overview.state === 'blocked'
        ? { label: '已阻断', color: '#ff6b6b' }
        : overview.paused
          ? { label: '已暂停', color: '#E0A458' }
          : { label: '执行中', color: '#fbbf24' }
    : { label: '未运行', color: '#6b7280' }

  if (!loaded) {
    return <div className="flow-overview fo-empty">正在读取流程总览…</div>
  }
  const flowSelector = (
    coordinators.length > 1 && (
      <div className="fo-header-top">
        <select
          className="fo-flow-select"
          value={selected ?? ''}
          onChange={(event) => {
            selectedRef.current = event.target.value
            setSelected(event.target.value)
            setOverview(null)
            setCanvasVersion(undefined)
            window.dispatchEvent(new Event('canvas-agent-task-updated'))
          }}
          aria-label="选择流程"
        >
          {coordinators.map((ref) => (
            <option key={ref.nodeId} value={ref.nodeId}>
              {ref.title}
            </option>
          ))}
        </select>
      </div>
    )
  )
  const versionNotice = (
    canvasVersion?.diverged && (
      <div className="fo-gated-note">
        <span role="status">画布已修改，当前定义与落画布时的版本存在差异</span>
        <button type="button" className="fo-btn" disabled={continuing} onClick={() => void restoreDefinition()}>
          恢复原定义
        </button>
        <button type="button" className="fo-btn" disabled={continuing} onClick={() => void publishDefinition()}>
          发布新版本
        </button>
      </div>
    )
  )
  if (coordinators.length && !overview) {
    return (
      <div className="flow-overview">
        <header className="fo-header">
          {flowSelector}
          {versionNotice}
          <p>流程尚未运行</p>
        </header>
      </div>
    )
  }
  if (!coordinators.length || !overview) {
    return (
      <div className="flow-overview fo-empty">
        <Icon name="agent" size={30} />
        <p>画布上还没有主控 Agent。</p>
        <span>将 Agent 节点设为主控并运行，即可在此跟踪进度与待办。</span>
      </div>
    )
  }

  const currentAction = now && (
    <div className={`fo-now is-${now.tone}`}>
      <div className="fo-now-text">
        {!currentNodeId && <div className="fo-now-title">{now.title}</div>}
        {now.detail && now.detail !== steps.find((step) => step.nodeId === currentNodeId)?.detail && (
          <p className="fo-now-detail">{now.detail}</p>
        )}
        {materialKey && (
          <textarea
            aria-label="替代上下文材料"
            className="fo-context-material"
            placeholder="请输入精简后的材料"
            maxLength={4096}
            value={materialText}
            disabled={continuing}
            onChange={(event) => setMaterialDraft({ key: materialKey, text: event.target.value })}
          />
        )}
        {materialTooLarge && (
          <p className="fo-now-detail" role="status">
            材料为 {materialBytes} 字节，当前上限为 {materialWait?.limitBytes} 字节。
          </p>
        )}
      </div>
      <div className="fo-now-actions">
        {overview.state === 'waiting' && !overview.paused && (
          <button type="button" className="fo-now-cta" disabled={continuing || materialTooLarge || Boolean(materialKey && !materialText.trim())} onClick={() => void continueFlow()}>
            {continuing ? '正在继续' : materialKey ? '提交材料并继续' : '继续流程'}
          </button>
        )}
        {now.action && now.nodeId && (
          <button
            type="button"
            className={`fo-now-cta ${overview.state === 'waiting' && !overview.paused ? 'fo-now-cta-secondary' : ''}`}
            onClick={() => (now.action === 'collaborate' ? collaborate(now.nodeId!) : locate(now.nodeId!))}
          >
            {now.action === 'collaborate' ? '去处理' : '定位'}
          </button>
        )}
      </div>
    </div>
  )

  return (
    <div className="flow-overview">
      <header className="fo-header">
        {flowSelector}
        {overview.sourceGraph && (
          <div className="fo-chip">本次运行来源 v{overview.sourceGraph.version} · {overview.sourceGraph.definitionId}</div>
        )}
        {versionNotice}
        <div className="fo-header-main">
          <div className="fo-header-title">
            <h1>{overview.graph?.name || coordinators.find((ref) => ref.nodeId === selected)?.title || '流程'}</h1>
            <p>{overview.goal || '多 Agent 协同流程'}</p>
            {overview.children.map((child) => child.compositeWait && (
              <p key={child.taskId}>等待人工提交 · {child.goal} / {child.compositeWait.stepKey}</p>
            ))}
          </div>
          <div className="fo-progress">
            <ProgressRing percent={progress.percent} />
            <div className="fo-progress-meta">
              <span className="fo-progress-count">
                {progress.done}/{progress.total} 节点
              </span>
              <span className="fo-overall" style={{ color: overall.color }}>
                <span className={`fo-dot ${overview.state === 'running' ? 'is-pulse' : ''}`} style={{ background: overall.color }} />
                {overall.label}
              </span>
            </div>
          </div>
        </div>
      </header>

      {!currentNodeId && currentAction}
      {offscreenStep && offscreenStep.nodeId === currentNodeId && (
        <div className="fo-current-shortcut">
          <span>{now?.title}</span>
          <button type="button" className="fo-btn" onClick={() => offscreenStep.element.scrollIntoView({ block: 'start' })}>
            回到当前步骤
          </button>
        </div>
      )}

      <div className="fo-body" ref={bodyRef}>
        <section className="fo-section">
          <div className="fo-section-head">
            <span className="fo-section-title">
              <Icon name="state-machine" size={13} /> 流程步骤
            </span>
            <span className="fo-section-meta">{steps.length} 节点</span>
          </div>
          <div className="fo-board">
              {steps.map((step, index) => (
                <div
                  key={step.nodeId}
                  className="fo-board-column"
                  ref={step.nodeId === currentNodeId ? currentStepRef : undefined}
                >
                  <h2
                    className={`fo-board-heading ${step.nodeId === currentNodeId ? 'fo-now-title' : ''}`}
                    aria-current={step.nodeId === currentNodeId ? 'step' : undefined}
                  >
                    <span>{String(index + 1).padStart(2, '0')}</span> {step.title}
                  </h2>
                  <div className="fo-board-task">
                    <StepCard
                      step={step}
                      onLocate={locate}
                      onRework={overview.executionMode === 'graph' &&
                        ['waiting', 'blocked', 'completed'].includes(overview.state) &&
                        ['completed', 'review-passed'].includes(step.state)
                        ? () => void rework(step)
                        : undefined}
                    />
                    {step.nodeId === currentNodeId && currentAction}
                    {step.kind === 'review' && index < steps.length - 1 && (
                      <div className={`fo-gate ${step.state === 'review-passed' ? 'is-open' : ''}`}>
                        <Icon name="ai-review" size={11} />
                        <span>{step.state === 'review-passed' ? '已放行' : '待放行'}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </section>

        <section className="fo-section">
          <div className="fo-section-head">
            <span className="fo-section-title">
              <Icon name="history" size={13} /> 事件时间线
            </span>
          </div>
          <div className="fo-timeline">
            {events.length === 0 && <div className="fo-timeline-empty">暂无协调事件</div>}
            {events.map((event) => {
              const tone = eventTone(event.event, event.source)
              return (
                <div key={event.eventId} className={`fo-event is-${tone}`}>
                  <span className="fo-event-dot" />
                  <div className="fo-event-body">
                    <div className="fo-event-head">
                      <span className="fo-chip fo-event-source">
                        {event.actorSource === 'system' ? '系统'
                          : event.actorSource === 'agent:external' ? '外部 Agent'
                          : event.actorSource?.startsWith('agent:external:')
                            ? `外部 Agent · ${event.actorSource.slice('agent:external:'.length)}`
                          : event.actorSource?.startsWith('user:')
                            ? overview.graph?.roles?.find((role) => `user:${role.roleId}` === event.actorSource)?.name
                              ?? (event.actorSource === 'user:owner' ? '我' : event.actorSource.slice(5))
                            : tone === 'review' ? '审核' : 'Agent'}
                      </span>
                      <span className="fo-event-label">{eventLabel(event.event)}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      </div>

      <footer className="fo-footer">
        <div className="fo-footer-actions">
          <button type="button" className="fo-btn" onClick={() => void pause()}>
            <Icon name={overview.paused ? 'play' : 'pause'} size={12} />
            {overview.paused ? '恢复派发' : '暂停派发'}
          </button>
          <button type="button" className="fo-btn" onClick={() => selected && locate(selected)}>
            <Icon name="target" size={12} /> 定位主控
          </button>
        </div>
        <div className="fo-footer-meta">
          <span className="fo-dot is-live" />
          实时同步
        </div>
      </footer>
    </div>
  )
}
