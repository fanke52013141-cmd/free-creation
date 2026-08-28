// 循环节点 Body（原迭代节点 Body）
import { stopEventPropagation, useEditor, useValue } from 'tldraw'
import type { NodeBodyProps } from '../../registry'
import { readNodeConfig } from '../../../canvas/node-persistence'
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
