// BL-08 / NF-10.2：节点流发布校验与运行守卫的预算缺省值必须同一来源。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMPOSITE_BUDGET_DEFAULTS, resolveCompositeBudget } from '../src/shared/composite/budget'
import { checkCompositeRunBudget } from '../src/shared/composite/runtime'
import type { CompositeManifest } from '../src/shared/composite/manifest'

const root = join(__dirname, '..')
const read = (file: string): string => readFileSync(join(root, file), 'utf8')

const tiny = (policy?: CompositeManifest['executionPolicy']): CompositeManifest =>
  ({
    schemaVersion: 1,
    capabilityId: 'budget-probe',
    version: '1.0',
    name: 'probe',
    inputs: [],
    outputs: [],
    graph: { nodes: [{ id: 'n1' }], edges: [] },
    ...(policy ? { executionPolicy: policy } : {})
  }) as unknown as CompositeManifest

describe('BL-08 节点流预算单一来源', () => {
  it('缺省值：8 层 / 200 节点 / 1500 连线', () => {
    expect(COMPOSITE_BUDGET_DEFAULTS).toEqual({ maxDepth: 8, maxExpandedNodes: 200, maxExpandedEdges: 1500 })
    expect(resolveCompositeBudget(undefined)).toEqual({ ...COMPOSITE_BUDGET_DEFAULTS })
    expect(resolveCompositeBudget({ maxDepth: 2 }).maxDepth).toBe(2)
  })

  it('运行守卫按统一缺省值判定（边界 = maxExpandedNodes）', () => {
    const limit = COMPOSITE_BUDGET_DEFAULTS.maxExpandedNodes
    expect(checkCompositeRunBudget(tiny(), { chain: [], expandedNodes: limit - 1 }).issue).toBeNull()
    expect(checkCompositeRunBudget(tiny(), { chain: [], expandedNodes: limit }).issue?.code).toBe(
      'EXPANSION_BUDGET_EXCEEDED'
    )
  })

  it('validate.ts 与 runtime.ts 不再写死预算缺省数字，均经 resolveCompositeBudget', () => {
    for (const file of ['src/shared/composite/validate.ts', 'src/shared/composite/runtime.ts']) {
      const source = read(file)
      expect(source).toContain('resolveCompositeBudget(')
      expect(source).not.toMatch(/(maxDepth|maxExpandedNodes|maxExpandedEdges)\s*\?\?\s*\d/)
      expect(source).not.toMatch(/MAX_BUDGET_(NODES|EDGES)/)
    }
  })
})
