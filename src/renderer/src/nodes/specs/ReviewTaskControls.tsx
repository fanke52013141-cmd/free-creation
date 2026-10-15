import { useState } from 'react'
import { useEditor } from 'tldraw'
import type { NodeBodyProps } from '../registry'
import { ReviewDecisionSchema, ReviewNodeConfigSchema } from '@shared/agent-flow/node-contracts'
import { NodeIdentity, NodePrimaryButton } from '../../canvas/NodePresentation'
import { useAppStore } from '../../stores/app'
import { ensureCanvasSaved } from '../../canvas/flow-asset-actions'
import { runNodeManually } from '../../engine/executor'

export function ReviewTaskControls({ shape }: Pick<NodeBodyProps, 'shape'>): React.JSX.Element {
  const editor = useEditor(),
    projectId = useAppStore((s) => s.currentProject?.id)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const decision = (() => {
    try {
      return ReviewDecisionSchema.parse(JSON.parse(String(shape.meta?.nodeResult ?? '')))
    } catch {
      return null
    }
  })()
  const sampled = (() => {
    try {
      return (
        ReviewNodeConfigSchema.parse(JSON.parse(shape.props.config)).reviewMode === 'sampled-video'
      )
    } catch {
      return false
    }
  })()
  const reviewMode = (() => {
    try {
      return ReviewNodeConfigSchema.parse(JSON.parse(shape.props.config)).reviewMode ?? 'text-json'
    } catch {
      return 'text-json'
    }
  })()
  const run = async (): Promise<void> => {
    if (!projectId || busy) return
    setBusy(true)
    setError('')
    try {
      await ensureCanvasSaved()
      const result = await runNodeManually(editor, projectId, [], shape.id)
      await ensureCanvasSaved()
      if (result.status === 'failed') setError(result.reason ?? '审核失败')
    } catch {
      setError('审核未确认，请核对原运行和保存状态')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <NodeIdentity>
        {decision && (
          <>
            <p className="agent-flow-summary">
              审核：{decision.passed ? '是' : '否'} · 第 {decision.reviewRevision + 1} 轮
            </p>
            <pre className="agent-flow-output">{decision.feedback}</pre>
            {decision.videoEvidence && (
              <p className="agent-flow-pending">
                抽样位置：
                {decision.videoEvidence.frames
                  .map((frame) => `${(frame.timeMs / 1000).toFixed(2)}s`)
                  .join('、')}
              </p>
            )}
            {decision.imageEvidence && (
              <p className="agent-flow-pending">
                已核对完整图片字节：{decision.imageEvidence.byteLength} 字节
              </p>
            )}
            {decision.audioEvidence && (
              <p className="agent-flow-pending">
                已审核完整音频：{(decision.audioEvidence.durationMs / 1000).toFixed(2)} 秒 · 16 kHz 单声道
              </p>
            )}
            {decision.audioVideoEvidence && (
              <p className="agent-flow-pending">
                全帧时间线：{decision.audioVideoEvidence.videoFrameCount} 帧 · 音轨偏移{' '}
                {decision.audioVideoEvidence.audioOffsetMs} ms · 结尾差{' '}
                {decision.audioVideoEvidence.audioEndDeltaMs} ms；仅四张画面用于视觉判断
              </p>
            )}
            {!decision.passed && (
              <p className="agent-flow-pending">
                请在负责修订的节点按反馈提交新版本，再明确运行复审。
              </p>
            )}
          </>
        )}
        <p className="agent-flow-pending">
          {sampled
            ? '仅审核四张抽样画面，不含声音、完整时序或未展示的画面；可人工替换视频复审，或由已配置的主 Agent 在预算内安排专业 Agent 返工。'
            : reviewMode === 'image'
              ? '审核整张固定图片的完整字节；自动审核与返工须由主 Agent 明确配置控制范围。'
              : reviewMode === 'audio'
                ? '审核完整音轨；审核模型须经过音频输入探测。'
                : reviewMode === 'audio-video'
                  ? '完整音轨和全帧时间戳摘要参与审核，画面使用四张抽样锚点；不能把样本当作逐帧视觉证明。'
                  : '完整文本 / JSON 审核；自动审核与返工须由主 Agent 明确配置控制范围。'}
        </p>
        {error && (
          <p role="alert" className="agent-flow-pending">
            {error}
          </p>
        )}
      </NodeIdentity>
      <NodePrimaryButton disabled={busy || !projectId} onClick={() => void run()}>
        {busy ? '审核中' : decision ? '提交版本复审' : '审核当前版本'}
      </NodePrimaryButton>
    </>
  )
}
