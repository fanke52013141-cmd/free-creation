// @vitest-environment jsdom
// 所有可创建节点的发布门禁：新增节点若缺 executor、投影、契约或误用 legacy 类型，
// 必须在合并前失败，而不是留到画布运行时猜测。
import { beforeAll, describe, expect, it } from 'vitest'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { activeNodeTypes, getNodeType } from '@renderer/nodes/registry'
import {
  ACTIVE_NODE_TYPE_IDS,
  LEGACY_NODE_TYPE_IDS,
  type ActiveNodeTypeId,
  type LegacyNodeTypeId
} from '@shared/types'

beforeAll(registerAllNodeTypes)

const legacy: readonly LegacyNodeTypeId[] = LEGACY_NODE_TYPE_IDS

describe('节点合规门禁', () => {
  it('所有可创建节点都是 ActiveNodeTypeId，历史节点不进入创建入口', () => {
    const active = activeNodeTypes()
    expect(active.length).toBeGreaterThan(0)
    expect(new Set(active.map((spec) => spec.type))).toEqual(new Set(ACTIVE_NODE_TYPE_IDS))
    for (const spec of active) expect(legacy).not.toContain(spec.type as LegacyNodeTypeId)
    for (const type of legacy) expect(active.some((spec) => spec.type === type)).toBe(false)
  })

  it('每个可创建节点都有可执行协议与完整端口投影', () => {
    for (const spec of activeNodeTypes()) {
      expect(spec.type as ActiveNodeTypeId).toBeTruthy()
      expect(spec.executor, `${spec.type} 缺少 executor`).toBeTypeOf('function')
      if (spec.ports.out.length > 0) {
        expect(spec.projectOutputs, `${spec.type} 缺少 projectOutputs`).toBeTypeOf('function')
      }
      expect(spec.contractVersion).toBeGreaterThanOrEqual(1)
      expect(spec.description.trim()).not.toBe('')
      expect(spec.category, `${spec.type} 缺少创建菜单分类`).toBeTruthy()
    }
  })

  it('历史节点的兼容状态必须显式而非悄然可创建', () => {
    expect(getNodeType('script')?.creatable).toBe(false)
    expect(getNodeType('group')).toBeUndefined()
    expect(getNodeType('compose')).toBeUndefined()
  })
})
