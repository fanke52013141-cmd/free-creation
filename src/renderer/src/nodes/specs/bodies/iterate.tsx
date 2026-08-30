// 循环节点 Body（原迭代节点 Body）
import { stopEventPropagation, useEditor, useValue } from 'tldraw'
import type { NodeBodyProps } from '../../registry'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { AppSelect } from '../../../components/AppSelect'
import { deriveGraph } from '../../../canvas/graph'
import {
  parseIterate,
  parseIterateResult,
  type IterateConfig,
  type IterateItemResult,
  type IterateProgress
} from '../../../engine/executors/iterate'

const ITERATE_FAILURE_OPTIONS: Array<{ value: IterateConfig['onFailure']; label: string }> = [
  { value: 'skip', label: '跳过失败项' },
  { value: 'fail', label: '全部中止' },
  { value: 'retry', label: '重试' }
]

const ITERATE_RUN_MODE_OPTIONS: Array<{ value: IterateConfig['runMode']; label: string }> = [
  { value: 'all', label: '全部运行' },
  { value: 'resume', label: '续跑未完成' },
  { value: 'failed', label: '只重跑失败' }
]

function enforceConfig(c: IterateConfig): IterateConfig {
  return {
    onFailure: c.onFailure,
    maxRetries: c.maxRetries < 0 ? 0 : c.maxRetries,
    limit: c.limit < 0 ? 0 : c.limit,
    runMode: c.runMode
  }
}

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
    progress.mode === 'resume' ? '续跑' : progress.mode === 'failed' ? '重跑失败' : '全部运行'
  return `${mode} · ${progress.completed}/${progress.total} · 成功 ${progress.done} · 失败 ${progress.failed}`
}

export function IterateBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
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
  // 只有 out-item 的目标是循环体入口；out-items 的目标是循环结束后的汇总消费者。
  const downstreamCount = useValue(
    'iterate body entries',
    () => {
      return deriveGraph(editor).edges.filter(
        (edge) => edge.from.nodeId === shape.id && edge.from.portId === 'out-item'
      ).length
    },
    [editor, shape.id]
  )

  return (
    <div className="iterate-body">
      <div className="iterate-config">
        <div className="ai-row ai-row-num">
          <label>
            <span className="ai-row-label">限数</span>
            <input
              type="number"
              min="0"
              value={data.limit}
              onPointerDown={(e) => stopEventPropagation(e)}
              onChange={(e) => updateConfig({ ...data, limit: Number(e.target.value) || 0 })}
            />
          </label>
        </div>
        <label className="ai-row">
          <span className="ai-row-label">范围</span>
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
          <span className="ai-row-label">失败</span>
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
            <span className="ai-row-label">重试</span>
            <input
              type="number"
              min="0"
              value={data.maxRetries}
              onPointerDown={(e) => stopEventPropagation(e)}
              onChange={(e) => updateConfig({ ...data, maxRetries: Number(e.target.value) || 0 })}
            />
          </label>
        )}
      </div>
      <div className="iterate-meta">
        <span>循环体入口：{downstreamCount} 个</span>
        {result?.progress && (
          <div className="iterate-progress-wrap">
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
        <span className={result ? 'iterate-hint has-result' : 'iterate-hint'}>
          {shape.props.exec === 'running'
            ? '正在按顺序处理…'
            : result
              ? summaryFromResults(result.items)
              : '（尚未运行）'}
        </span>
      </div>
    </div>
  )
}
