import { useEffect, useState } from 'react'
import type { FlowAgentView } from '@shared/agent-flow/desktop-tasks'
import type { NodeCardShape } from './NodeCardShape'
import { ensureCanvasSaved } from './flow-asset-actions'
import { NodePrimaryButton } from './NodePresentation'
import { useAppStore } from '../stores/app'
import { newTraceId, newSpanId } from '@shared/observability'
import { reportCanvasFailure } from './canvas-diagnostics'

/** Feedback is a main task fact, never inferred from a card's editable result text. */
export function FlowReviewFeedback({ shape }: { shape: NodeCardShape }): React.JSX.Element | null {
  const projectId = useAppStore((state) => state.currentProject?.id)
  const [feedback, setFeedback] = useState<FlowAgentView['reviewFeedback']>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (
      !projectId ||
      !window.api.inspectFlowAgent ||
      !['agent', 'text', 'json'].includes(shape.props.nodeType)
    )
      return
    let disposed = false
    const inspect = async (): Promise<void> => {
      try {
        const reply = await window.api.inspectFlowAgent({ projectId, nodeId: shape.id })
        if (!disposed && reply.ok) setFeedback(reply.data?.reviewFeedback)
      } catch {
        /* Explicit submission owns user-visible errors. */
      }
    }
    void inspect()
    const timer = setInterval(() => void inspect(), 750)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [projectId, shape.id, shape.props.nodeType])
  if (!feedback || feedback.state === 'passed') return null
  const manual = ['text', 'json'].includes(shape.props.nodeType) && feedback.state === 'manual-wait'
  const submit = async (): Promise<void> => {
    if (!projectId || busy) return
    setBusy(true)
    setError('')
    try {
      await ensureCanvasSaved()
      const saved = await window.api.openProject(projectId)
      if (!saved.ok || !saved.data) throw new Error('FLOW_SAVE_FAILED')
      const result = await window.api.submitFlowAsset({
        projectId,
        nodeId: shape.id,
        portId: shape.props.nodeType === 'json' ? 'out-json' : 'out-text',
        submissionId: crypto.randomUUID(),
        expectedGraphVersion: saved.data.meta.graphVersion,
        traceId: newTraceId(),
        spanId: newSpanId()
      })
      if (!result.ok) throw new Error('FLOW_SUBMISSION_FAILED')
      setError('新版本已提交，请在主 Agent 明确继续复审。')
    } catch {
      setError('新版本未确认，请检查内容和保存状态。')
      reportCanvasFailure(projectId, 'review-rework-submit')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flow-review-feedback">
      <p className="agent-flow-pending">审核反馈 · 返工 {feedback.round}</p>
      <pre className="agent-flow-output">{feedback.feedback}</pre>
      {manual && (
        <NodePrimaryButton disabled={busy} onClick={() => void submit()}>
          提交返工新版本
        </NodePrimaryButton>
      )}
      {error && (
        <p className="agent-flow-pending" role="status">
          {error}
        </p>
      )}
    </div>
  )
}
