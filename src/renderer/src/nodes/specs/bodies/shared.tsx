// 节点 Body 共享工具（路线图 R6：拆分超大 bodies.tsx）
//
// 从原 bodies.tsx 提出的、被多个节点 Body 复用的工具函数/组件。拆分后由各节点
// Body 文件从本模块 import。行为与原 bodies.tsx 完全等价。
// 本文件同时导出工具函数（非组件）与少量 UI 组件（ModelSelect/NoModelHint），
// 是共享模块而非单一组件文件，故豁免 React Fast Refresh 的组件-only 规则。
/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef } from 'react'
import { stopEventPropagation } from 'tldraw'
import { modelsByModality } from '../../../stores/gateway'

// shape.props.text 里的 JSON 解析：失败时返回 fallback（兼容旧纯文本数据，ScriptBody 同款约定）
export function parseJsonProp<T>(text: string, validate: (v: unknown) => T | null, fallback: T): T {
  if (!text) return fallback
  try {
    const v = JSON.parse(text) as unknown
    const r = validate(v)
    if (r !== null) return r
  } catch {
    // 非结构化内容按 fallback 处理
  }
  return fallback
}

// 节点内模型选择下拉（按模态过滤全部供应商的模型）
export function ModelSelect({
  value,
  options,
  onChange
}: {
  value: string
  options: ReturnType<typeof modelsByModality>
  onChange: (key: string) => void
}): React.JSX.Element {
  return (
    <select
      className="gen-select"
      value={value}
      onPointerDown={(e) => stopEventPropagation(e)}
      onChange={(e) => onChange(e.target.value)}
    >
      {!options.some((o) => o.key === value) && <option value="">选择模型…</option>}
      {options.map((o) => (
        <option key={o.key} value={o.key}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

// 未配置任何对应模态模型时的占位引导
export function NoModelHint({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  return (
    <div className="gen-empty">
      <span>尚未配置可用模型</span>
      <button
        className="btn-ghost small"
        onPointerDown={(e) => stopEventPropagation(e)}
        onClick={(e) => {
          e.stopPropagation()
          onOpen()
        }}
      >
        打开模型设置
      </button>
    </div>
  )
}

// 点击 vs 拖拽判定：拖动卡片时元素随指针移动，pointerup 仍会触发 click，
// 位移超过阈值视为拖拽，不触发预览
export function useClickGuard(): {
  onPointerDown: (e: React.PointerEvent) => void
  onClick: (e: React.MouseEvent, open: () => void) => void
} {
  const downRef = useRef<{ x: number; y: number } | null>(null)
  return {
    onPointerDown: (e) => {
      downRef.current = { x: e.clientX, y: e.clientY }
    },
    onClick: (e, open) => {
      const d = downRef.current
      downRef.current = null
      if (!d) return
      if (Math.abs(e.clientX - d.x) > 4 || Math.abs(e.clientY - d.y) > 4) return
      e.stopPropagation()
      open()
    }
  }
}

// 卡片内可滚动区域：内容可滚时截断 wheel 冒泡，避免滚动手势被画布抢走（缩放/平移）。
// 必须用原生监听：tldraw 的 wheel 监听在容器上，React 合成事件的 stopPropagation 到不了它
export function useWheelScroll(ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      const canScroll =
        e.deltaY > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0
      if (canScroll) e.stopPropagation()
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
    }
  }, [ref])
}

// 变量值类型（被处理/代码/脚本节点共享）：决定变量映射的类型约束。
export type VariableValueType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any'

// 变量类型下拉选项（处理/代码/脚本节点共用）。
export const VARIABLE_TYPES: { value: VariableValueType; label: string }[] = [
  { value: 'any', label: '任意' },
  { value: 'string', label: '文本' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '布尔' },
  { value: 'object', label: '对象' },
  { value: 'array', label: '数组' }
]
