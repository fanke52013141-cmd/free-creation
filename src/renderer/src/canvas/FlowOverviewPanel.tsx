import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import type { FlowRunOverview } from '@shared/agent-flow/run-overview'
import { Icon, type IconName } from '../components/Icon'
import { useNodePanelStore } from '../stores/nodePanel'
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

function StepCard({
  step,
  onLocate
}: {
  step: FlowStep
  onLocate: (nodeId: string) => void
}): React.JSX.Element {
  const meta = STATE_META[step.state]
  const color = KIND_COLOR[step.kind] ?? '#59D4CD'
  const attention = step.needsYou
  return (
    <div className={`fo-step ${attention ? 'is-attention' : ''} is-${step.state}`}>
      <div className="fo-step-spine" style={{ borderColor: meta.color, color: meta.color }}>
        <span className="fo-step-glyph">{meta.glyph}</span>
      </div>
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
          <span className="fo-chip fo-role" style={{ color, borderColor: `${color}55` }}>
            {step.roleLabel}
          </span>
          <span className="fo-spacer" />
          {attention && <span className="fo-chip fo-needs-you">需要你</span>}
          <span className="fo-state" style={{ color: meta.color, borderColor: `${meta.color}55`, background: `${meta.color}14` }}>
            <span className={`fo-state-glyph ${step.state === 'running' ? 'is-pulse' : ''}`}>{meta.glyph}</span>
            {meta.label}
          </span>
        </div>
        {step.review && step.kind === 'review' && (
          <div className={`fo-rework ${step.state === 'rejected' ? 'is-fail' : ''}`}>
            <span className="fo-rework-label">
              {step.state === 'rejected' ? '返工闭环进行中' : '审核门禁'} · 轮次 {step.review.round}/{step.review.maxReworks}
            </span>
            {step.review.feedback && <span className="fo-rework-reason">{step.review.feedback}</span>}
          </div>
        )}
        {step.state === 'gated' && step.gatedBy && (
          <div className="fo-gated-note">🔒 被「{step.gatedBy}」拦截，审核通过后放行</div>
        )}
        {step.detail && step.kind !== 'review' && step.state !== 'gated' && (
          <div className="fo-step-detail">{step.detail}</div>
        )}
      </button>
    </div>
  )
}

export function FlowOverviewPanel({ editor, projectId, onClose }: FlowOverviewPanelProps): React.JSX.Element {
  const [coordinators, setCoordinators] = useState<CoordinatorRef[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [overview, setOverview] = useState<FlowRunOverview | null>(null)
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
      useNodePanelStore.getState().open('contract', createShapeId(nodeId) as TLShapeId, 'collaboration')
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
        setSelected(active)
      }
      let delay = 3000
      if (active && !document.hidden) {
        try {
          const reply = await window.api.flowRunOverview({ projectId, nodeId: active })
          if (disposed) return
          if (reply.ok) {
            setOverview(reply.data.overview)
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
  const progress = useMemo(() => flowProgress(steps), [steps])
  const events = useMemo(() => (overview ? [...overview.events].reverse().slice(0, 8) : []), [overview])

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
  if (!coordinators.length || !overview) {
    return (
      <div className="flow-overview fo-empty">
        <Icon name="agent" size={30} />
        <p>画布上还没有可总览的主 Agent。</p>
        <span>创建一个 Agent 节点并设为主控，运行后这里会实时呈现流程进度、审核门禁与待你处理的事项。</span>
      </div>
    )
  }

  return (
    <div className="flow-overview">
      <header className="fo-header">
        {coordinators.length > 1 && (
          <div className="fo-header-top">
            <select
              className="fo-flow-select"
              value={selected ?? ''}
              onChange={(event) => setSelected(event.target.value)}
              aria-label="选择流程"
            >
              {coordinators.map((ref) => (
                <option key={ref.nodeId} value={ref.nodeId}>
                  {ref.title}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="fo-header-main">
          <div className="fo-header-title">
            <h1>{overview.graph?.name || coordinators.find((ref) => ref.nodeId === selected)?.title || '流程'}</h1>
            <p>{overview.goal || '多 Agent 协同流程'}</p>
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

      {now && (
        <div className={`fo-now is-${now.tone}`}>
          <div className="fo-now-icon">
            <Icon name={now.tone === 'human' ? 'edit' : now.tone === 'review' ? 'ai-review' : 'agent'} size={13} />
            {now.tone === 'human' && <span className="fo-now-ping" />}
          </div>
          <div className="fo-now-text">
            <div className="fo-now-title-row">
              <span className="fo-now-tag">{now.tone === 'human' ? 'NOW / 需要你' : '当前'}</span>
              <span className="fo-now-title">{now.title}</span>
            </div>
            <p className="fo-now-detail">{now.detail}</p>
          </div>
          {now.action && now.nodeId && (
            <button
              type="button"
              className="fo-now-cta"
              onClick={() => (now.action === 'collaborate' ? collaborate(now.nodeId!) : locate(now.nodeId!))}
            >
              {now.action === 'collaborate' ? '去处理' : '定位'}
              <Icon name="target" size={12} />
            </button>
          )}
        </div>
      )}

      <div className="fo-body">
        <section className="fo-section">
          <div className="fo-section-head">
            <span className="fo-section-title">
              <Icon name="state-machine" size={13} /> 流执行图谱
            </span>
            <span className="fo-section-meta">
              {overview.executionMode === 'graph' ? '声明式图' : '顺序编排'} · {steps.length} 节点
            </span>
          </div>
          <div className="fo-map">
            <div className="fo-map-spine" />
            {steps.map((step, index) => (
              <div key={step.nodeId} className="fo-map-item">
                <StepCard step={step} onLocate={locate} />
                {step.kind === 'review' && index < steps.length - 1 && (
                  <div className={`fo-gate ${step.state === 'review-passed' ? 'is-open' : ''}`}>
                    <Icon name="ai-review" size={11} />
                    <span>审核放行门禁 · {step.state === 'review-passed' ? '已放行' : '拦截中'}</span>
                    <span className="fo-gate-line" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="fo-legend">
          {(['completed', 'running', 'waiting-human', 'rejected', 'idle'] as const).map((state) => (
            <span key={state} className="fo-legend-item">
              <span style={{ color: STATE_META[state].color }}>{STATE_META[state].glyph}</span>
              {STATE_META[state].label}
            </span>
          ))}
        </section>

        <section className="fo-section">
          <div className="fo-section-head">
            <span className="fo-section-title">
              <Icon name="history" size={13} /> 事件时间线
            </span>
            <span className="fo-section-meta">最新优先</span>
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
                        {tone === 'human' ? '人工' : tone === 'review' ? '审核' : 'Agent'}
                      </span>
                      <span className="fo-event-label">{eventLabel(event.event)}</span>
                      <span className="fo-spacer" />
                      <span className="fo-event-rev">r{event.revision}</span>
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
          修订 {overview.revision} · 阶段 {overview.phase}
        </div>
      </footer>
    </div>
  )
}