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
  const specialist = (() => {
    try {
      return JSON.parse(shape.props.config).role === 'specialist'
    } catch {
      return false
    }
  })()
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
  const act = async (): Promise<void> => {
    if (!projectId) return
    setError('')
    if (!specialist && !running && task?.state !== 'waiting' && task?.state !== 'blocked') {
      useNodePanelStore.getState().open('contract', shape.id, 'settings')
      return
    }
    if (running || task?.state === 'blocked') {
      await stop()
      return
    }
    setPending(true)
    try {
      await ensureCanvasSaved()
      // Resume selection is a control fact from main, not a canvas config rewrite.
      if (task) {
        editor.updateShape({
          id: shape.id,
          type: 'node-card',
          meta: { ...shape.meta, agentTask: JSON.stringify(task) }
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
              ready: task.prepared ? '新修订待启动' : '准备中',
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
      {Object.values(outputs).map((value, index) => (
        <pre className="agent-flow-output" key={index}>
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
      <NodePrimaryButton allowWhileBusy disabled={!projectId} onClick={() => void act()}>
        {running
          ? '停止任务'
          : task?.state === 'waiting'
            ? task.waitKind === 'human'
              ? '确认并继续'
              : '核对并继续'
            : task?.state === 'blocked'
              ? '停止任务'
              : specialist
                ? '启动任务'
                : '配置专业 Agent'}
      </NodePrimaryButton>
      {task?.state === 'waiting' && !running && (
        <NodePrimaryButton onClick={() => void stop()}>停止任务</NodePrimaryButton>
      )}
      <NodePrimaryButton
        onClick={() => useNodePanelStore.getState().open('contract', shape.id, 'collaboration')}
      >
        查看协作
      </NodePrimaryButton>
    </>
  )
}
