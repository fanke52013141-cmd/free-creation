import { useEffect, useState } from 'react'
import { useEditor } from 'tldraw'
import type { NodeBodyProps } from '../registry'
import type { BuildPreview } from '@shared/agent-flow/builder'
import { useAppStore } from '../../stores/app'
import { NodeIdentity, NodePrimaryButton } from '../../canvas/NodePresentation'
import { ensureCanvasSaved } from '../../canvas/flow-asset-actions'
import { commitFlowBuild } from '../../canvas/flow-build-actions'
import { runNodeManually } from '../../engine/executor'

export function FlowBuilderControls({ shape }: Pick<NodeBodyProps, 'shape'>): React.JSX.Element {
  const editor = useEditor(),
    projectId = useAppStore((state) => state.currentProject?.id)
  const [preview, setPreview] = useState<BuildPreview | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    const inspect = (): void => {
      if (projectId)
        void window.api
          .buildFlowAgent({ projectId, nodeId: shape.id, action: 'inspect' })
          .then((reply) => {
            if (!disposed && reply.ok) setPreview(reply.data)
          })
          .catch(() => {})
    }
    const timer = setInterval(inspect, 750)
    inspect()
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [projectId, shape.id])
  const act = async (action: 'propose' | 'commit' | 'discard'): Promise<void> => {
    if (!projectId || busy) return
    setBusy(true)
    setError('')
    try {
      await ensureCanvasSaved()
      if (action === 'commit' && preview) setPreview(await commitFlowBuild(editor, preview))
      else if (action === 'propose') {
        const run = await runNodeManually(editor, projectId, [], shape.id)
        if (run.status === 'failed') throw new Error(run.reason ?? '建图提案失败')
        const reply = await window.api.buildFlowAgent({
          projectId,
          nodeId: shape.id,
          action: 'inspect'
        })
        if (!reply.ok) throw new Error(reply.error.message)
        setPreview(reply.data)
      } else {
        const reply = await window.api.buildFlowAgent({
          projectId,
          nodeId: shape.id,
          action: 'discard',
          requestId: crypto.randomUUID(),
          ...(action === 'discard' && preview ? { buildId: preview.buildId } : {})
        })
        if (!reply.ok) throw new Error(reply.error.message)
        setPreview(reply.data)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '建图未确认，请核对画布')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <NodeIdentity>
        <p className="agent-flow-pending">
          文本模板顺序流程 · 1–4 个步骤。预览只提出图变更，提交后由主 Agent 启动。
        </p>
        {preview && (
          <>
            <p className="agent-flow-pending">
              {preview.state === 'preview'
                ? '拟创建'
                : preview.state === 'committed'
                  ? '图变更已保存'
                  : '预览已取消'}
              ：{preview.plan.title}
            </p>
            {preview.plan.steps.map((step, i) => (
              <div key={i}>
                <p className="agent-flow-pending">
                  {i + 1}. {step.title} · {step.mode === 'collaborative' ? '人工确认' : '自主处理'}
                </p>
                <pre className="agent-flow-output">
                  {step.goal}
                  {'\n'}模板：{step.template}
                </pre>
              </div>
            ))}
            <p className="agent-flow-pending">
              {preview.nodes.length} 个节点 · {preview.edges.length} 条数据边 ·
              控制和状态关系单独保存
            </p>
          </>
        )}
        {error && (
          <p role="alert" className="agent-flow-pending">
            {error}
          </p>
        )}
      </NodeIdentity>
      {preview?.state === 'preview' ? (
        <>
          <NodePrimaryButton disabled={busy} onClick={() => void act('commit')}>
            {busy ? '处理中' : '提交图变更'}
          </NodePrimaryButton>
          <NodePrimaryButton disabled={busy} onClick={() => void act('discard')}>
            取消预览
          </NodePrimaryButton>
        </>
      ) : (
        <NodePrimaryButton disabled={busy || !projectId} onClick={() => void act('propose')}>
          {busy ? '生成预览中' : '生成建图预览'}
        </NodePrimaryButton>
      )}
    </>
  )
}
