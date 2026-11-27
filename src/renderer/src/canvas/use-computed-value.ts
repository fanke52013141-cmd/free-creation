import { useMemo } from 'react'
import { computed, useValue } from 'tldraw'

/**
 * 带自定义等价比较的 tldraw 派生订阅。
 *
 * tldraw 4.5 的 `useValue(name, fn, deps)` 默认用 `Object.is` 判等；
 * 当计算结果是新对象/新数组/新 Set 但业务语义未变时，通过 `computed(..., { isEqual })`
 * 阻止 `lastChangedEpoch` 推进，可做到 0 次 React 重渲染。
 */
export function useComputedValue<T>(
  name: string,
  compute: () => T,
  isEqual: (prev: T, next: T) => boolean,
  deps: readonly unknown[]
): T {
  // 与 tldraw `useValue(name, fn, deps)` 保持一致，依赖数组由调用方显式传入。
  // eslint-disable-next-line react-hooks/use-memo, react-hooks/exhaustive-deps
  const signal = useMemo(() => computed(name, compute, { isEqual }), deps)
  return useValue(signal)
}
