// @vitest-environment jsdom
// 所有可创建节点的发布门禁：新增节点若缺 executor、投影、契约或误用 legacy 类型，
// 必须在合并前失败，而不是留到画布运行时猜测。
import { beforeAll, describe, expect, it } from 'vitest'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { activeNodeTypes, getNodeType } from '@renderer/nodes/registry'
import { LIBRARY_NODE_ADAPTERS } from '@shared/library/blueprint'
import {
  ACTIVE_NODE_TYPE_IDS,
  INTERNAL_NODE_TYPE_IDS,
  LEGACY_NODE_TYPE_IDS,
  type ActiveNodeTypeId,
  type LegacyNodeTypeId
} from '@shared/types'

beforeAll(registerAllNodeTypes)

const legacy: readonly LegacyNodeTypeId[] = LEGACY_NODE_TYPE_IDS

describe('节点合规门禁', () => {
  it('资源蓝图的内容适配器必须匹配真实节点契约版本', () => {
    for (const [type, adapter] of Object.entries(LIBRARY_NODE_ADAPTERS)) {
      const spec = activeNodeTypes().find((node) => node.type === type)
      expect(spec, `${type} 必须是可创建节点`).toBeDefined()
      expect(spec?.contractVersion, `${type} 的资源适配器必须随契约一起更新`).toBe(adapter.contractVersion)
    }
  })
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
      // 一句话定位（≤40 字），细节只留 NodeContractPanel：防止描述退化成长段落。
      expect(
        spec.description.length,
        `${spec.type} 描述过长（${spec.description.length} 字）：${spec.description}`
      ).toBeLessThanOrEqual(40)
      expect(spec.category, `${spec.type} 缺少创建菜单分类`).toBeTruthy()
    }
  })

  it('顺序迭代节点在界面上称为循环，并明确逐项执行方式', () => {
    const iterate = getNodeType('iterate')
    expect(iterate?.label).toBe('循环')
    expect(iterate?.ports.in.find((port) => port.id === 'in-list')?.description).toContain('按顺序')
  })

  it('历史节点的兼容状态必须显式而非悄然可创建', () => {
    // 先显式点名已知退役节点：防止共享清单被静默清空后，下面的遍历断言空转。
    expect(getNodeType('script')?.creatable).toBe(false)
    expect(getNodeType('video-audio')?.creatable).toBe(false)
    expect(getNodeType('vocal-separate')?.creatable).toBe(false)
    expect(getNodeType('group')).toBeUndefined()
    expect(getNodeType('compose')).toBeUndefined()

    // 注册表全集遍历：可创建集合（=新建菜单集合）之外的每个注册节点都必须
    // 显式 creatable=false 且登记在 LEGACY 清单；LEGACY 清单成员要么已不注册、
    // 要么 creatable=false。以后新增退役节点只改共享清单与 spec，这里自动覆盖。
    const creatableTypes = new Set(activeNodeTypes().map((spec) => spec.type))
    const registeredTypes = [
      ...ACTIVE_NODE_TYPE_IDS,
      ...INTERNAL_NODE_TYPE_IDS,
      ...LEGACY_NODE_TYPE_IDS
    ]
    for (const type of registeredTypes) {
      const spec = getNodeType(type)
      if (!spec) continue // 已退役到不再注册的类型（如 group/compose）
      if (creatableTypes.has(spec.type)) {
        expect(spec.creatable, `${spec.type} 在可创建集合中却 creatable=false`).not.toBe(false)
      } else {
        expect(spec.creatable, `${spec.type} 不在可创建集合却未显式 creatable=false`).toBe(false)
        expect(
          legacy as readonly string[],
          `${spec.type} 不可创建却未登记进 LEGACY_NODE_TYPE_IDS`
        ).toContain(spec.type)
      }
    }
    for (const type of legacy) {
      const spec = getNodeType(type)
      if (!spec) continue
      expect(spec.creatable, `LEGACY 节点 ${type} 却可创建`).toBe(false)
    }
  })
})
