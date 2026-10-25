import { useEffect, useState } from 'react'
import { useEditor } from 'tldraw'
import type { NodeBodyProps } from '../registry'
import { NodePrimaryButton } from '../../canvas/NodePresentation'
import { useAppStore } from '../../stores/app'
import { runNodeManually } from '../../engine/executor'
import { ensureCanvasSaved } from '../../canvas/flow-asset-actions'
import type { FlowAgentView } from '@shared/agent-flow/desktop-tasks'
import { projectAgentOutputs } from '@shared/agent-flow/agent-outputs'
import { useNodePanelStore } from '../../stores/nodePanel'
import { useResourceQueue } from '../../engine/resource-queue'
import { flowAgentFailureMessage } from '@shared/agent-flow/failure-messages'
import { getAgentModelBindingStatus } from '@shared/agent-flow/node-contracts'
import { preflightAgentDecisionModels } from '../../engine/agent-model-preflight'

export function AgentTaskControls({ shape }: Pick<NodeBodyProps, 'shape'>): React.JSX.Element {
  const editor = useEditor()
  const projectId = useAppStore((state) => state.currentProject?.id)
  const [task, setTask] = useState<FlowAgentView | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (!projectId || !window.api.inspectFlowAgent) return
    let disposed = false,
      timer: ReturnType<typeof setTimeout>
    const inspect = async (): Promise<void> => {
      try {
        const reply = await window.api.inspectFlowAgent({ projectId, nodeId: shape.id })
        if (!disposed && reply.ok) setTask(reply.data)
      } catch {
        /* The next explicit action reports transport errors. */
      }
      if (!disposed) timer = setTimeout(() => void inspect(), 750)
    }
    const onTaskUpdate = (event: Event): void => {
      const detail = (
        event as CustomEvent<{ projectId: string; nodeId: string; task: FlowAgentView }>
      ).detail
      if (!disposed && detail?.projectId === projectId && detail.nodeId === shape.id)
        setTask(detail.task)
    }
    window.addEventListener('canvas-agent-task-updated', onTaskUpdate)
    void inspect()
    return () => {
      disposed = true
      clearTimeout(timer)
      window.removeEventListener('canvas-agent-task-updated', onTaskUpdate)
    }
  }, [projectId, shape.id])
  const engineBusy = useResourceQueue((state) =>
    state.tasks.some((entry) => entry.key === `${projectId}/${shape.id}`)
  )
  const running =
    task?.state === 'running' ||
    (task?.state === 'ready' && !task.prepared) ||
    pending ||
    engineBusy
  const role = (() => {
    try {
      return JSON.parse(shape.props.config).role as string
    } catch {
      return ''
    }
  })()
  const specialist = role === 'specialist' || role === 'coordinator'
  const stop = async (): Promise<void> => {
    if (!projectId) return
    try {
      const result = await window.api.stopFlowAgent({ projectId, nodeId: shape.id })
      if (result.ok) setTask(result.data)
      else setError(result.error.message)
    } catch {
      setError('停止未确认，请核对任务状态。')
    }
  }
  const act = async (restore = false): Promise<void> => {
    if (!projectId) return
    setError('')
    if (!specialist && !running && task?.state !== 'waiting' && task?.state !== 'blocked') {
      useNodePanelStore.getState().open('contract', shape.id, 'settings')
      return
    }
    if (running) {
      await stop()
      return
    }
    setPending(true)
    try {
      let actionableTask = task
      if (getAgentModelBindingStatus(shape.props.config) === 'missing') {
        if (window.api.inspectFlowAgent) {
          const inspected = await window.api.inspectFlowAgent({ projectId, nodeId: shape.id })
          if (!inspected.ok) {
            setError(inspected.error.message)
            return
          }
          actionableTask = inspected.data
          setTask(inspected.data)
        }
        if (!['waiting', 'blocked'].includes(actionableTask?.state ?? '')) {
          setError('请在节点设置中选择决策模型。')
          return
        }
      }
      const modelPreflightError = await preflightAgentDecisionModels([shape.props.config])
      if (modelPreflightError) {
        setError(modelPreflightError)
        return
      }
      await ensureCanvasSaved()
      // Resume selection is a control fact from main, not a canvas config rewrite.
      // Re-read meta at write time: the awaits above let the publication channel
      // materialize agentAssetVersionId/agentTaskId on this node, and merging a
      // stale render snapshot would roll those facts back.
      if (actionableTask) {
        const current = editor.getShape<NodeBodyProps['shape']>(shape.id)
        editor.updateShape({
          id: shape.id,
          type: 'node-card',
          meta: {
            ...(current?.meta ?? shape.meta),
            agentTask: JSON.stringify({
              ...actionableTask,
              recoveryAction: restore ? 'restore' : undefined
            })
          }
        })
      }
      const result = await runNodeManually(editor, projectId, [], shape.id)
      await ensureCanvasSaved()
      if (result.status === 'failed') setError(result.reason ?? '任务未完成')
    } catch {
      setError('任务操作未确认，请检查保存状态并核对原任务。')
    } finally {
      setPending(false)
    }
  }
  const outputs = projectAgentOutputs(shape)
  return (
    <>
      {task && (
        <p className="agent-flow-pending" role="status">
          {
            {
              ready: task.prepared
                ? task.reviewFeedback
                  ? '返工待明确启动'
                  : '新修订待启动'
                : '准备中',
              running: '处理中',
              waiting: task.waitKind === 'human' ? '等待人工确认' : '等待执行核对',
              blocked: '任务已阻断，请核对或停止',
              completed: '资产已完成',
              failed: '任务失败',
              cancelled: '已停止'
            }[task.state]
          }{' '}
          · {task.decisions} 次决策
        </p>
      )}
      {role === 'coordinator' && task?.phase && (
        <p className="agent-flow-pending">阶段：{task.phase}</p>
      )}
      {task?.children?.map((child) => (
        <p className="agent-flow-pending" key={child.nodeId}>
          {editor.getShape<NodeBodyProps['shape']>(child.nodeId as NodeBodyProps['shape']['id'])
            ?.props.title || '专业 Agent'}{' '}
          ·{' '}
          {child.state === 'completed'
            ? '已完成'
            : child.state === 'waiting'
              ? '等待人工处理'
              : '处理中'}
        </p>
      ))}
      {Object.values(outputs).map((value, index) => (
        <pre className="agent-flow-output" data-node-selectable-text="true" key={index}>
          {value?.kind === 'json'
            ? JSON.stringify(value.data, null, 2)
            : value && 'text' in value
              ? value.text
              : ''}
        </pre>
      ))}
      {error && (
        <p className="agent-flow-pending" role="alert">
          {error}
        </p>
      )}
      {task?.recovery?.reasons.map((reason) => (
        <p className="agent-flow-pending" key={reason}>
          {flowAgentFailureMessage(reason)}
        </p>
      ))}
      <NodePrimaryButton allowWhileBusy disabled={!projectId} onClick={() => void act()}>
        {running
          ? '停止任务'
          : task?.state === 'waiting'
            ? task.waitKind === 'human'
              ? '确认并继续'
              : role === 'specialist' && task.code !== 'FLOW_COMMAND_FACTS_VERIFIED'
                ? '核对执行事实'
                : '明确继续执行'
            : task?.state === 'blocked'
              ? '核对执行事实'
              : specialist
                ? '启动任务'
                : '配置专业 Agent'}
      </NodePrimaryButton>
      {['waiting', 'blocked'].includes(task?.state ?? '') && !running && (
        <NodePrimaryButton onClick={() => void stop()}>停止任务</NodePrimaryButton>
      )}
      {task?.state === 'blocked' && task.recovery?.canRestore && !running && (
        <NodePrimaryButton onClick={() => void act(true)}>补呈现已提交成果</NodePrimaryButton>
      )}
      {role === 'coordinator' && running && (
        <NodePrimaryButton
          allowWhileBusy
          onClick={() => {
            if (projectId)
              void window.api
                .pauseFlowAgent({ projectId, nodeId: shape.id })
                .then((reply) => {
                  if (!reply.ok) setError(reply.error.message)
                })
                .catch(() => setError('暂停未确认，请核对流程状态。'))
          }}
        >
          暂停派发
        </NodePrimaryButton>
      )}
      {role === 'specialist' && (
        <NodePrimaryButton
          onClick={() => useNodePanelStore.getState().open('contract', shape.id, 'collaboration')}
        >
          查看协作
        </NodePrimaryButton>
      )}
    </>
  )
}
