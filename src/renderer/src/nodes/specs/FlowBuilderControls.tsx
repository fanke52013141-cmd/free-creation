import { useEffect, useState } from 'react'
import { useEditor, type TLShapeId } from 'tldraw'
import type { NodeBodyProps } from '../registry'
import type { BuildPreview } from '@shared/agent-flow/builder'
import { useAppStore } from '../../stores/app'
import { NodeIdentity, NodePrimaryButton } from '../../canvas/NodePresentation'
import { ensureCanvasSaved } from '../../canvas/flow-asset-actions'
import { commitFlowBuild } from '../../canvas/flow-build-actions'
import { setFlowBuildPreview } from '../../canvas/flow-build-preview-store'
import { runNodeManually } from '../../engine/executor'

const capabilityLabel: Record<string, string> = {
  'text-template@1': '文本模板',
  'image-gen@3': '生图',
  'image-edit@2': '图片编辑',
  'video@7': '视频生成',
  'speech@4': '语音合成',
  'tts@4': '音色克隆'
}

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
            if (!disposed && reply.ok) {
              setPreview(reply.data)
              setFlowBuildPreview(projectId, shape.id, reply.data)
            }
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
      if (action === 'commit' && preview) {
        const result = await commitFlowBuild(editor, preview)
        setPreview(result)
        setFlowBuildPreview(projectId, shape.id, result)
      } else if (action === 'propose') {
        const run = await runNodeManually(editor, projectId, [], shape.id)
        if (run.status === 'failed') throw new Error(run.reason ?? '建图提案失败')
        const reply = await window.api.buildFlowAgent({
          projectId,
          nodeId: shape.id,
          action: 'inspect'
        })
        if (!reply.ok) throw new Error(reply.error.message)
        setPreview(reply.data)
        setFlowBuildPreview(projectId, shape.id, reply.data)
        if (reply.data?.state === 'preview') {
          const bounds = [
            ...reply.data.nodes.map((node) => ({ x: node.x, y: node.y, w: 340, h: 260 })),
            editor.getShapePageBounds(shape.id as TLShapeId)
          ].filter((item): item is { x: number; y: number; w: number; h: number } => !!item)
          if (bounds.length) {
            const x = Math.min(...bounds.map((item) => item.x)),
              y = Math.min(...bounds.map((item) => item.y)),
              maxX = Math.max(...bounds.map((item) => item.x + item.w)),
              maxY = Math.max(...bounds.map((item) => item.y + item.h))
            editor.zoomToBounds({ x, y, w: maxX - x, h: maxY - y }, { inset: 80 })
          }
        }
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
        setFlowBuildPreview(projectId, shape.id, reply.data)
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
          封闭能力目录：文本、生图、改图、视频、语音合成、音色克隆；支持顺序流程、2–4 路并行和有界审核返工。
          预览只提出图变更，提交后由主 Agent 启动。
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
              {' · '}
              {preview.plan.topology === 'parallel-fork'
                ? `${preview.plan.steps.length} 路并行分支`
                : '顺序流程'}
            </p>
            {preview.plan.steps.map((step, i) => (
              <div key={i}>
                <p className="agent-flow-pending">
                  {i + 1}. {step.title} · {capabilityLabel[step.capability] ?? '流程步骤'} ·{' '}
                  {step.mode === 'collaborative' ? '人工确认' : '自主处理'}
                </p>
                <pre className="agent-flow-output" data-node-selectable-text="true">
                  {step.goal}
                  {step.template ? `\n模板：${step.template}` : ''}
                  {step.instruction ? `\n指令：${step.instruction}` : ''}
                  {step.review
                    ? `\n审核标准：${step.review.criteria}\n拒绝策略：${step.review.rejectPolicy === 'rework' ? `最多返工 ${step.review.maxReworks} 次` : '停止流程'}`
                    : ''}
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
