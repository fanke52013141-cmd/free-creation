import { useEffect, useState } from 'react'
import type { NodeSettingsProps } from '../registry'
import type { TLShapeId } from 'tldraw'
import type { NodeCardShape } from '../../canvas/NodeCardShape'
import type {
  FlowAgentCollaborationView,
  FlowAgentCollaboration
} from '@shared/agent-flow/desktop-tasks'
import type { FlowAssetSummary } from '@shared/agent-flow/assets'
import { AppSelect } from '../../components/AppSelect'
import { ensureCanvasSaved } from '../../canvas/flow-asset-actions'
import { markUndoPoint } from '../../canvas/history'

export function AgentCollaborationPanel({
  shape,
  editor,
  projectId
}: NodeSettingsProps): React.JSX.Element {
  const [view, setView] = useState<FlowAgentCollaborationView | null>(null)
  const [text, setText] = useState('')
  const [goal, setGoal] = useState(shape.props.text)
  const [output, setOutput] = useState('')
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [versions, setVersions] = useState<FlowAssetSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState('')
  useEffect(() => {
    let disposed = false
    void (async () => {
      const result = await window.api.flowAgentCollaboration({ projectId, nodeId: shape.id })
      if (disposed) return
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setView(result.data)
      const unique = new Map(
        result.data?.inputs.map((ref) => [
          JSON.stringify([ref.sourceNodeId, ref.sourcePortId]),
          ref
        ])
      )
      const summaries = await Promise.all(
        [...unique.values()].map((ref) =>
          window.api.listFlowAssets({
            projectId,
            nodeId: ref.sourceNodeId,
            portId: ref.sourcePortId
          })
        )
      )
      if (!disposed) setVersions(summaries.flatMap((reply) => (reply.ok ? reply.data : [])))
    })().catch(() => {
      if (!disposed) setError('协作记录读取失败，请重新打开本节点。')
    })
    return () => {
      disposed = true
    }
  }, [projectId, shape.id])
  const ready = !busy && view?.task.state === 'waiting' && view.task.waitKind === 'human'
  const canRevise =
    ready || (!busy && view?.task.state === 'blocked' && view.task.code === 'HUMAN_REJECTED')
  const action = async (
    kind: FlowAgentCollaboration['action'],
    accepted?: boolean
  ): Promise<void> => {
    if (!view) return
    setBusy(true)
    setError('')
    try {
      if (kind === 'revise') {
        markUndoPoint(editor, '采用 Agent 新要求')
        editor.updateShape({ id: shape.id, type: 'node-card', props: { text: goal } })
      }
      await ensureCanvasSaved()
      const result = await window.api.cooperateFlowAgent({
        projectId,
        nodeId: shape.id,
        taskId: view.task.taskId,
        waitRevision: view.task.waitRevision,
        revision: view.revision,
        eventId: crypto.randomUUID(),
        action: kind,
        text: kind === 'revise' ? goal : text,
        ...(kind === 'submit'
          ? {
              accepted,
              selectedOutputs: output
                ? view.candidates.filter((ref) => ref.versionId === output)
                : []
            }
          : {}),
        ...(kind === 'revise'
          ? {
              selectedInputs: versions
                .filter((version) => Object.values(inputs).includes(version.ref.versionId))
                .map((version) => version.ref)
            }
          : {})
      })
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setView(result.data)
      const current = editor.getShape(shape.id)
      window.dispatchEvent(new CustomEvent('canvas-agent-task-updated', { detail: { projectId, nodeId: shape.id, task: result.data.task } }))
      editor.updateShape({
        id: shape.id,
        type: 'node-card',
        meta: { ...current?.meta, agentTask: JSON.stringify(result.data.task) }
      })
      await ensureCanvasSaved()
      if (kind !== 'revise') setText('')
    } catch {
      setError('操作未确认，请重新打开协作记录核对，勿重复执行。')
    } finally {
      setBusy(false)
    }
  }
  const uniqueInputs = [
    ...new Map(
      view?.inputs.map((ref) => [JSON.stringify([ref.sourceNodeId, ref.sourcePortId]), ref])
    ).values()
  ]
  return (
    <section className="agent-flow-settings agent-collaboration" aria-label="Agent 节点协作">
      <p>讨论和保存意见不会执行节点。采用新要求后，请回卡片明确启动新修订。</p>
      {!view ? (
        <p>暂无任务。请先启动人机协作 Agent。</p>
      ) : (
        <>
          <p>当前目标：{view.goal}</p>
          <p role="status">
            {view.task.prepared
              ? '新修订已准备，等待启动'
              : view.task.state === 'waiting'
                ? '等待人工提交'
                : '当前任务不在人工等待阶段'}
          </p>
          {view.messages.map((message) => (
            <div className="contract-section" key={message.eventId}>
              <p>
                {message.kind === 'submit'
                  ? '人工意见'
                  : message.kind === 'revise'
                    ? '新要求'
                    : '讨论'}
                ：{message.text}
              </p>
              {message.reply && <p>Agent：{message.reply}</p>}
            </div>
          ))}
          <label>
            讨论或反馈
            <textarea
              aria-label="讨论或反馈"
              maxLength={4096}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <button disabled={busy || !text.trim()} onClick={() => void action('note')}>
            保存讨论
          </button>
          <button disabled={!ready || !text.trim()} onClick={() => void action('discuss')}>
            与 Agent 讨论
          </button>
          <label>
            选择交付版本
            <AppSelect
              aria-label="选择交付版本"
              value={output}
              onChange={(event) => setOutput(event.target.value)}
            >
              <option value="">由 Agent 检查真实回执</option>
              {[...new Map(view.candidates.map((ref) => [ref.versionId, ref])).values()].map(
                (ref, index) => (
                  <option key={ref.versionId} value={ref.versionId}>
                    候选 {index + 1} ·{' '}
                    {editor.getShape<NodeCardShape>(ref.sourceNodeId as TLShapeId)?.props.title ??
                      '处理结果'}
                  </option>
                )
              )}
            </AppSelect>
          </label>
          <button
            disabled={!output || busy}
            onClick={() => {
              void window.api
                .readFlowAsset({ projectId, versionId: output })
                .then((reply) => {
                  if (reply.ok)
                    setPreview(
                      reply.data.value.kind === 'json'
                        ? JSON.stringify(reply.data.value.data, null, 2)
                        : reply.data.value.text
                    )
                  else setError(reply.error.message)
                })
                .catch(() => setError('资产读取未确认，请重试。'))
            }}
          >
            查看所选版本
          </button>
          {preview && <pre>{preview}</pre>}
          <button disabled={!ready} onClick={() => void action('submit', true)}>
            提交意见与选择
          </button>
          <button disabled={!ready} onClick={() => void action('submit', false)}>
            提交拒绝意见
          </button>
          <p>提交后，回本节点“确认并继续”。拒绝意见会阻断原任务，保留回执。</p>
          <label>
            新目标
            <textarea
              aria-label="新目标"
              maxLength={4096}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
            />
          </label>
          {uniqueInputs.map((ref) => {
            const key = JSON.stringify([ref.sourceNodeId, ref.sourcePortId])
            return (
              <label key={key}>
                材料版本 ·{' '}
                {editor.getShape<NodeCardShape>(ref.sourceNodeId as TLShapeId)?.props.title ??
                  '输入材料'}
                <AppSelect
                  aria-label={`材料版本 ${ref.sourceNodeId}`}
                  value={inputs[key] ?? ''}
                  onChange={(event) => setInputs({ ...inputs, [key]: event.target.value })}
                >
                  <option value="">采用当前已保存材料</option>
                  {versions
                    .filter(
                      (version) =>
                        version.ref.sourceNodeId === ref.sourceNodeId &&
                        version.ref.sourcePortId === ref.sourcePortId
                    )
                    .map((version) => (
                      <option key={version.ref.versionId} value={version.ref.versionId}>
                        版本 {version.ordinal}
                      </option>
                    ))}
                </AppSelect>
              </label>
            )
          })}
          <button disabled={!canRevise || !goal.trim()} onClick={() => void action('revise')}>
            采用为新要求
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
