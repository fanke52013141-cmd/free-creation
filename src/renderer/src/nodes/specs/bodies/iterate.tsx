// 循环节点 Body（原迭代节点 Body）
import { stopEventPropagation, useEditor, useValue } from 'tldraw'
import type { NodeBodyProps } from '../../registry'
import {
  parseIterate,
  parseIterateResult,
  type IterateConfig,
  type IterateItemResult
} from '../../../engine/executors/iterate'

const ITERATE_FAILURE_OPTIONS: Array<{ value: IterateConfig['onFailure']; label: string }> = [
  { value: 'skip', label: '跳过失败项' },
  { value: 'fail', label: '全部中止' },
  { value: 'retry', label: '重试' }
]

function enforceConfig(c: IterateConfig): IterateConfig {
  return {
    itemVar: c.itemVar || 'item',
    onFailure: c.onFailure,
    maxRetries: c.maxRetries < 0 ? 0 : c.maxRetries,
    concurrency: c.concurrency < 1 ? 1 : c.concurrency,
    limit: c.limit < 0 ? 0 : c.limit
  }
}

function summaryFromResults(results: (IterateItemResult | null)[] | undefined): string {
  if (!results) return ''
  const done = results.filter((r) => r?.status === 'done').length
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
  return `共 ${results.length} 项 · 成功 ${done} · 失败 ${failed} · 跳过 ${skipped}${productSuffix}`
}

/** 从 shape.props.text 中解析执行器上报的中间进度（运行中 _progress 字段）。 */
function parseIterateProgress(text: string): { done: number; total: number } | null {
  if (!text) return null
  try {
    const v = JSON.parse(text) as { _progress?: unknown }
    if (v && typeof v._progress === 'object' && v._progress !== null) {
      const p = v._progress as { done?: unknown; total?: unknown }
      if (typeof p.done === 'number' && typeof p.total === 'number' && p.total > 0) {
        return { done: p.done, total: p.total }
      }
    }
  } catch {
    // 忽略
  }
  return null
}

export function IterateBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const data = parseIterate(shape.props.text)
  const result = parseIterateResult(shape.props.text)
  const updateConfig = (next: IterateConfig): void => {
    // 保留已有运行结果（items），避免调整并发/限数/失败策略等参数时清空历史批量结果（A4）
    const prev = parseIterateResult(shape.props.text)
    const payload: Record<string, unknown> = { ...enforceConfig(next) }
    if (prev) (payload as { items?: IterateItemResult[] }).items = prev.items
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { text: JSON.stringify(payload) }
    })
  }
  // 下游循环体数量：通过当前节点的输出边推算（NodeContractPanel 之外简单估算）
  const downstreamCount = useValue(
    'iterate downstream',
    () => {
      let count = 0
      for (const binding of editor.getBindingsFromShape(shape.id, 'arrow')) {
        // 凡是本节点引出的箭头都视为下游循环体的一部分
        if (binding.props.terminal === 'start') count += 1
      }
      return count
    },
    [editor, shape.id]
  )

  return (
    <div className="iterate-body">
      <div className="iterate-config">
        <label className="ai-row">
          <span className="ai-row-label">变量名</span>
          <input
            value={data.itemVar}
            onPointerDown={(e) => stopEventPropagation(e)}
            onChange={(e) => updateConfig({ ...data, itemVar: e.target.value || 'item' })}
          />
        </label>
        <div className="ai-row ai-row-num">
          <label>
            <span className="ai-row-label">并发</span>
            <input
              type="number"
              min="1"
              value={data.concurrency}
              onPointerDown={(e) => stopEventPropagation(e)}
              onChange={(e) => updateConfig({ ...data, concurrency: Number(e.target.value) || 1 })}
            />
          </label>
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
          <span className="ai-row-label">失败</span>
          <select
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
          </select>
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
        <span>下游循环体节点：{downstreamCount} 个</span>
        {(() => {
          // 运行中：显示进度条 + 百分比
          const progress = parseIterateProgress(shape.props.text)
          const isRunning = shape.props.exec === 'running'
          if (isRunning && progress) {
            const pct = Math.round((progress.done / progress.total) * 100)
            return (
              <div className="iterate-progress-wrap">
                <div className="iterate-progress-bar">
                  <div className="iterate-progress-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="iterate-progress-text">
                  运行中 {progress.done}/{progress.total} · {pct}%
                </span>
              </div>
            )
          }
          // 已完成：显示汇总
          return (
            <span className={result ? 'iterate-hint has-result' : 'iterate-hint'}>
              {result ? summaryFromResults(result.items) : '（尚未运行）'}
            </span>
          )
        })()}
      </div>
    </div>
  )
}
