import { useState } from 'react'
import type { NodeBodyProps } from '../nodes/registry'
import { readCompositeInstanceManifest } from '@shared/composite/outputs'
import { readNodeRunRecord } from '../engine/runRecord'

/** composite.run.get 返回的运行台账（main 侧 CompositeRunRecord 的渲染层最小投影）。 */
interface CompositeRunDetail {
  run: {
    id: string
    status: string
    parentRunId: string | null
    failurePhase: string | null
    failureNodeId: string | null
    failurePortId: string | null
    errorMessage: string | null
  }
  steps: Array<{
    stepKey: string
    nodeType: string
    status: string
    reason: string | null
  }>
}

const STEP_STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  completed: '完成',
  failed: '失败',
  skipped: '跳过',
  cancelled: '取消'
}

export function CompositeBody({ shape }: NodeBodyProps): React.JSX.Element {
  const manifest = readCompositeInstanceManifest(shape)
  const nodeRun = readNodeRunRecord(shape.meta?.nodeRun)
  const [detail, setDetail] = useState<CompositeRunDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [showSteps, setShowSteps] = useState(false)

  const loadRun = async (runId: string): Promise<void> => {
    setLoading(true)
    try {
      const res = await window.api.composite.runGet(runId)
      if (res.ok && res.data) setDetail(res.data as CompositeRunDetail)
    } finally {
      setLoading(false)
    }
  }

  if (!manifest) {
    return (
      <div className="composite-body">
        <p className="composite-body-empty">节点流版本缺失，请从节点流面板重新插入</p>
      </div>
    )
  }

  const failed = nodeRun?.status === 'failed'
  const failureNodeId = nodeRun?.error?.failureNodeId
  const failurePortId = nodeRun?.error?.failurePortId

  return (
    <div className="composite-body">
      <div className="composite-body-head">
        <span className="composite-body-name">{manifest.name}</span>
        <span className="composite-body-version">v{manifest.version}</span>
      </div>
      {manifest.description ? <p className="composite-body-desc">{manifest.description}</p> : null}
      <p className="composite-body-meta">
        {manifest.inputs.length} 个输入 · {manifest.outputs.length} 个输出 ·{' '}
        {manifest.graph.nodes.length} 个内部节点
      </p>
      {failed ? (
        <div className="composite-body-failure" role="alert">
          <span className="composite-body-failure-title">
            运行失败{nodeRun?.error?.phase ? `（${nodeRun.error.phase} 阶段）` : ''}
          </span>
          {failureNodeId ? (
            <span className="composite-body-failure-loc">
              失败节点：{failureNodeId}
              {failurePortId ? ` · 端口 ${failurePortId}` : ''}
            </span>
          ) : null}
          {nodeRun?.error?.reason ? (
            <span className="composite-body-failure-reason">{nodeRun.error.reason}</span>
          ) : null}
        </div>
      ) : null}
      {nodeRun?.runId ? (
        <button
          type="button"
          className="composite-body-steps-toggle"
          onClick={() => {
            const next = !showSteps
            setShowSteps(next)
            if (next && !detail) void loadRun(nodeRun.runId)
          }}
        >
          {showSteps ? '收起运行步骤' : '查看运行步骤'}
        </button>
      ) : null}
      {showSteps ? (
        <div className="composite-body-steps">
          {loading ? <p className="composite-body-meta">加载运行台账…</p> : null}
          {detail ? (
            <>
              {detail.run.parentRunId ? (
                <button
                  type="button"
                  className="composite-body-steps-parent"
                  onClick={() => void loadRun(detail.run.parentRunId as string)}
                >
                  ↑ 上层运行 {detail.run.parentRunId.slice(0, 8)}
                </button>
              ) : null}
              {detail.run.failureNodeId ? (
                <p className="composite-body-failure-loc">
                  台账定位：{detail.run.failureNodeId}
                  {detail.run.failurePortId ? ` · 端口 ${detail.run.failurePortId}` : ''}
                  {detail.run.failurePhase ? `（${detail.run.failurePhase}）` : ''}
                </p>
              ) : null}
              <ul className="composite-body-step-list">
                {detail.steps.map((step) => (
                  <li
                    key={step.stepKey}
                    className={`composite-body-step composite-body-step-${step.status}`}
                  >
                    <span className="composite-body-step-name">
                      {step.stepKey}
                      {step.nodeType ? `（${step.nodeType}）` : ''}
                    </span>
                    <span className="composite-body-step-status">
                      {STEP_STATUS_LABEL[step.status] ?? step.status}
                    </span>
                    {step.reason ? (
                      <span className="composite-body-step-reason">{step.reason}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}