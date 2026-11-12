// 循环节点 Body（原迭代节点 Body）
//
// 界面上必须先能看出「有没有列表、有没有循环体」：这两项缺一即整节点跳过，
// 只给配置下拉而不给连线状态，用户就只能靠猜。
import { useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import type { NodeBodyProps } from '../../registry'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { AppSelect } from '../../../components/AppSelect'
import { NumberStepper } from '../../../components/NumberStepper'
import { NodePrimaryButton } from '../../../canvas/NodePresentation'
import { runNodeManually } from '../../../engine/executor'
import { guiWorkflowInputOptions } from '../../../stores/workflowInput'
import { useAppStore } from '../../../stores/app'
import { useGatewayStore } from '../../../stores/gateway'
import {
  parseIterate,
  parseIterateResult,
  type IterateConfig,
  type IterateItemResult,
  type IterateProgress
} from '../../../engine/executors/iterate'

const ITERATE_FAILURE_OPTIONS: Array<{ value: IterateConfig['onFailure']; label: string }> = [
  { value: 'skip', label: '失败项跳过' },
  { value: 'fail', label: '一出错就中止' },
  { value: 'retry', label: '重试后仍失败则跳过' }
]

const ITERATE_RUN_MODE_OPTIONS: Array<{ value: IterateConfig['runMode']; label: string }> = [
  { value: 'all', label: '全部运行' },
  { value: 'resume', label: '续跑未完成' },
  { value: 'failed', label: '只重跑失败' },
  { value: 'changed', label: '修改项与失败项' }
]

function enforceConfig(c: IterateConfig): IterateConfig {
  return {
    onFailure: c.onFailure,
    // 上限必须与执行器 parseIterate 的 0..10 钳制一致：配置手误放大成海量付费重试（R-21）。
    maxRetries: Math.min(10, Math.max(0, c.maxRetries)),
    limit: c.limit < 0 ? 0 : c.limit,
    runMode: c.runMode,
    // W2：与执行器 parseIterate 的 1..4 钳制一致；renderer 未启用并行循环项时
    // 执行器会自动降级为顺序执行（见 IterateConfig.concurrency 注释）。
    concurrency: Math.min(4, Math.max(1, Math.round(c.concurrency) || 1))
  }
}

/**
 * W5：计算循环体节点集合（与 renderer executor 的 expandIterationBody 同口径）：
 * 从 out-item 的目标沿真实连线扩展；out-items 的目标是循环结束后的汇总消费者，
 * 不属于循环体。
 */

function summaryFromResults(results: (IterateItemResult | null)[] | undefined): string {
  if (!results) return ''
  const done = results.filter((r) => r?.status === 'done').length
  const reused = results.filter((r) => r?.status === 'reused').length
  const failed = results.filter((r) => r?.status === 'failed').length
  const skipped = results.filter((r) => r?.status === 'skipped').length
  // 统计产物数量：累加每项 outputs 中的节点端口数
  let productCount = 0
  for (const r of results) {
    if (r?.outputs) {
      for (const ports of Object.values(r.outputs)) {
        productCount += Object.keys(ports).length
      }
    }
  }
  const productSuffix = productCount > 0 ? ` · 产物 ${productCount}` : ''
  const reusedSuffix = reused > 0 ? ` · 复用 ${reused}` : ''
  return `共 ${results.length} 项 · 成功 ${done} · 失败 ${failed} · 跳过 ${skipped}${reusedSuffix}${productSuffix}`
}

function progressLabel(progress: IterateProgress): string {
  const mode =
    progress.mode === 'changed'
      ? '修改项与失败项'
      : progress.mode === 'resume'
        ? '续跑'
        : progress.mode === 'failed'
          ? '重跑失败'
          : '全部运行'
  return `${mode} · ${progress.completed}/${progress.total} · 成功 ${progress.done} · 失败 ${progress.failed}`
}

export function IterateBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  // 循环节点内容可能超出卡片高度：滚轮落在节点上时在节点内滚动，而非缩放/平移画布。
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const data = parseIterate(readNodeConfig(shape))
  // 运行结果从 meta.nodeResult 读取（配置/结果分离）。
  const result = parseIterateResult(
    typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  )
  const updateConfig = (next: IterateConfig): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      // 配置写入只序列化配置字段，不再带上历史运行结果（结果在 meta）
      props: { config: JSON.stringify(enforceConfig(next)) }
    })
  }
  const project = useAppStore((s) => s.currentProject)
  const providers = useGatewayStore((s) => s.providers)
  const [busy, setBusy] = useState(false)
  const run = async (): Promise<void> => {
    if (!project || busy) return
    setBusy(true)
    try {
      await runNodeManually(
        editor,
        project.id,
        providers,
        shape.id,
        undefined,
        undefined,
        undefined,
        guiWorkflowInputOptions
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="iterate-body" ref={scrollRef}>
      <div className="iterate-config">
        <div className="ai-row ai-row-num">
          <label title="只处理列表前 N 项，0 表示不限">
            <span className="ai-row-label">上限</span>
            <NumberStepper
              ariaLabel="上限"
              min={0}
              max={100000}
              step={1}
              value={String(data.limit)}
              onChange={(next) => {
                const value = Number(next)
                if (Number.isFinite(value)) updateConfig({ ...data, limit: value })
              }}
            />
          </label>
        </div>
        <label className="ai-row">
          <span
            className="ai-row-label"
            title="续跑与只重跑失败都按上一次运行记录判定，首次运行没有记录可复用"
          >
            运行
          </span>
          <AppSelect
            className="gen-select"
            value={data.runMode}
            onPointerDown={(e) => stopEventPropagation(e)}
            onChange={(e) =>
              updateConfig({ ...data, runMode: e.target.value as IterateConfig['runMode'] })
            }
          >
            {ITERATE_RUN_MODE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </AppSelect>
        </label>
        <label className="ai-row">
          <span className="ai-row-label" title="决定某一项失败时是否继续处理后面的项">
            失败时
          </span>
          <AppSelect
            className="gen-select"
            value={data.onFailure}
            onPointerDown={(e) => stopEventPropagation(e)}
            onChange={(e) =>
              updateConfig({ ...data, onFailure: e.target.value as IterateConfig['onFailure'] })
            }
          >
            {ITERATE_FAILURE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </AppSelect>
        </label>
        {data.onFailure === 'retry' && (
          <label className="ai-row">
            <span className="ai-row-label" title="单项失败后额外执行几次，用尽仍失败才跳过">
              重试
            </span>
            <NumberStepper
              ariaLabel="重试"
              min={0}
              max={10}
              step={1}
              value={String(data.maxRetries)}
              onChange={(next) => {
                const value = Number(next)
                if (Number.isFinite(value)) updateConfig({ ...data, maxRetries: value })
              }}
            />
          </label>
        )}
        <label className="ai-row">
          <span
            className="ai-row-label"
            title="同时处理的列表项数量（1–4）。循环体节点在各项之间复用，画布上会自动按顺序执行；宿主支持并行循环项后此配置生效"
          >
            并行
          </span>
          <NumberStepper
            ariaLabel="并行"
            min={1}
            max={4}
            step={1}
            value={String(data.concurrency)}
            onChange={(next) => {
              const value = Number(next)
              if (Number.isFinite(value)) updateConfig({ ...data, concurrency: value })
            }}
          />
        </label>
      </div>
      {result?.progress && (
        <div className="iterate-progress-wrap" role="status">
          <div className="iterate-progress-bar">
            <div
              className="iterate-progress-fill"
              style={{
                width: `${
                  result.progress.total > 0
                    ? (result.progress.completed / result.progress.total) * 100
                    : 0
                }%`
              }}
            />
          </div>
          <span className="iterate-progress-text">{progressLabel(result.progress)}</span>
        </div>
      )}
      {result && (
        <p className="iterate-summary" role="status">
          {shape.props.exec === 'running' ? '正在按顺序处理…' : summaryFromResults(result.items)}
        </p>
      )}
      <NodePrimaryButton disabled={busy} onClick={() => void run()}>
        {busy ? '运行中…' : '运行循环'}
      </NodePrimaryButton>
    </div>
  )
}
