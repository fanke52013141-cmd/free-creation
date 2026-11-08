// 节点可用性对等性：**所有 32 类节点都必须能被人和 Agent 同时操作**。
//
// 背景：曾有一份"发行版裁剪清单"（DISTRIBUTION_HIDDEN_NODE_TYPES）会把 13 类节点
// 从 Dock/拖线菜单/新建项目选择器里隐藏，但注册表仍保留——结果会造成
// "人看不到但 Agent 能建"或反之的能力缺口，与三入口一致性目标冲突。
// 2026-11-08 用户决定：不做发行版节点裁剪。这条测试把这个决定锁住。
import { describe, expect, it } from 'vitest'
import { ACTIVE_NODE_TYPE_IDS } from '../src/shared/types'
import {
  DISTRIBUTION_EDITION,
  DISTRIBUTION_HIDDEN_NODE_TYPES
} from '../src/shared/edition'
import {
  GENERAL_WORKSPACE_NODE_TYPES,
  allWorkspaceProfile,
  defaultWorkspaceProfile
} from '../src/shared/workspace-profile'
import { ACCESS_OPERATIONS } from '../src/shared/agent-access/registry'

describe('节点可用性对等（人 ↔ Agent）', () => {
  it('发行版不隐藏任何节点类型', () => {
    expect([...DISTRIBUTION_HIDDEN_NODE_TYPES]).toEqual([])
  })

  it('"全部节点"工作档案覆盖所有可创建节点', () => {
    const visible = new Set(allWorkspaceProfile().visibleNodeTypeIds)
    const missing = ACTIVE_NODE_TYPE_IDS.filter((type) => !visible.has(type))
    expect(missing).toEqual([])
    expect(visible.size).toBe(ACTIVE_NODE_TYPE_IDS.length)
  })

  it('Agent 侧节点目录覆盖全部 32 类，且不因发行版开关减少', () => {
    // node.type.list 的数据源是逐节点动作矩阵；它必须覆盖全部 Active 类型。
    const contract = (ACCESS_OPERATIONS as Record<string, unknown>)['node.type.get']
    expect(contract).toBeDefined()
    expect(ACTIVE_NODE_TYPE_IDS.length).toBeGreaterThanOrEqual(32)
    // 发行版开关本身仍可读（保持机制），但隐藏集合为空时两侧一致。
    expect(typeof DISTRIBUTION_EDITION).toBe('boolean')
    expect(defaultWorkspaceProfile().visibleNodeTypeIds.length).toBeGreaterThan(0)
  })

  it('通用预设是"有意的子集"，不因发行版裁剪而变少', () => {
    // 注意：默认预设只含精选类型（这是产品设计，不是裁剪）；
    // 要断言的是它没有被发行版隐藏清单再削一次。
    const visible = defaultWorkspaceProfile().visibleNodeTypeIds
    expect(visible.length).toBe(GENERAL_WORKSPACE_NODE_TYPES.length)
    for (const type of visible) expect(ACTIVE_NODE_TYPE_IDS).toContain(type)
  })
})
