import type { CompositeExecutionPolicy } from './manifest'

/**
 * BL-08 / NF-10.2：节点流预算缺省值的**唯一来源**。
 *
 * 发布校验（validate.ts）与运行守卫（runtime.ts checkCompositeRunBudget）必须读同一组值；
 * 此前两处缺省不一致（发布 5 层/500 节点 vs 运行 8 层/200 节点），导致「能发布、必然跑不了」。
 * 取运行期既有值，存量实例运行行为不变；发布校验相应收紧节点上限、放宽深度上限。
 */
export const COMPOSITE_BUDGET_DEFAULTS = Object.freeze({
  maxDepth: 8,
  maxExpandedNodes: 200,
  maxExpandedEdges: 1500
})

export interface CompositeBudget {
  maxDepth: number
  maxExpandedNodes: number
  maxExpandedEdges: number
}

/** 按 manifest.executionPolicy 解析生效预算；未声明项取统一缺省。 */
export function resolveCompositeBudget(
  policy: Pick<CompositeExecutionPolicy, 'maxDepth' | 'maxExpandedNodes' | 'maxExpandedEdges'> | undefined
): CompositeBudget {
  return {
    maxDepth: policy?.maxDepth ?? COMPOSITE_BUDGET_DEFAULTS.maxDepth,
    maxExpandedNodes: policy?.maxExpandedNodes ?? COMPOSITE_BUDGET_DEFAULTS.maxExpandedNodes,
    maxExpandedEdges: policy?.maxExpandedEdges ?? COMPOSITE_BUDGET_DEFAULTS.maxExpandedEdges
  }
}
