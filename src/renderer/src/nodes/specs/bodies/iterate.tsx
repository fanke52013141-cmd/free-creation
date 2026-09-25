// 循环节点 Body（原迭代节点 Body）
//
// 界面上必须先能看出「有没有列表、有没有循环体」：这两项缺一即整节点跳过，
// 只给配置下拉而不给连线状态，用户就只能靠猜。
import { useRef } from 'react'
import { stopEventPropagation, useEditor, useValue } from 'tldraw'
import type { NodeBodyProps } from '../../registry'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { AppSelect } from '../../../components/AppSelect'
import { deriveGraph, readConnectedNodeInputs } from '../../../canvas/graph'
import { useWheelScroll } from './shared'
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
  // 循环节点内容可能超出卡片高度：滚轮落在节点上时在节点内滚动，而非缩放/平移画布。
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useWheelScroll(scrollRef)
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
  // 列表元素数量：执行器要求 in-list 是数组，否则整节点跳过，因此这里必须如实报出来。
  const listCount = useValue<number | null>(
    'iterate list size',
    () => {
      const entry = readConnectedNodeInputs(editor, shape.id).find(
        (item) => item.targetPortId === 'in-list'
      )
      const value = entry?.value
      return value && value.kind === 'json' && Array.isArray(value.data) ? value.data.length : null
    },
    [editor, shape.id]
  )
  const effectiveCount =
    listCount === null ? null : data.limit > 0 ? Math.min(data.limit, listCount) : listCount

  return (
    <div className="iterate-body" ref={scrollRef}>
      <div className="iterate-contract">
        <code className="variable-expr">in-list</code>
        <span>按顺序逐项交给</span>
        <code className="variable-expr">out-item</code>
        <span>循环体，汇总到</span>
        <code className="variable-expr">out-items</code>
      </div>
      <div className="iterate-config">
        <div className="ai-row ai-row-num">
          <label title="只处理列表前 N 项，0 表示不限">
            <span className="ai-row-label">上限</span>
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
        <span className={`iterate-wiring ${listCount === null ? 'warn' : 'ok'}`}>
          列表：{listCount === null ? '未接入或不是数组，运行会跳过' : `${listCount} 项`}
          {effectiveCount !== null && listCount !== null && effectiveCount < listCount
            ? ` · 本次处理 ${effectiveCount} 项`
            : ''}
        </span>
        <span className={`iterate-wiring ${downstreamCount === 0 ? 'warn' : 'ok'}`}>
          {downstreamCount === 0
            ? '循环体：未从「当前项」连线，运行会跳过'
            : `循环体入口：${downstreamCount} 个`}
        </span>
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
        <span className={result ? 'iterate-hint has-result' : 'iterate-hint'} role="status">
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
