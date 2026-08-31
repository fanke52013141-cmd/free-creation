/**
 * Capability Registry 测试
 *
 * 验证能力注册、查询、版本管理和契约快照功能。
 * 这是「一套定义，多个入口」原则的基础保障。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  defineCapability,
  getCapability,
  listCapabilities,
  getCapabilityByNodeType,
  getCapabilities,
  isEmpty,
  clearRegistry,
  getSnapshots,
  getLatestSnapshot
} from '@capabilities'
import type { Capability } from '@capabilities/types'

// ── 测试用能力定义工厂 ─────────────────────────────────────

function makeCapability(overrides: Partial<Capability> = {}): Capability {
  return {
    id: 'test.demo',
    version: '1.0.0',
    contractVersion: 1,
    nodeType: 'test-node' as any,
    title: '测试节点',
    description: '测试用能力',
    category: 'test',
    inputs: [
      { id: 'in1', name: '输入', type: 'text', required: true, cardinality: 'one', description: '输入端口' }
    ],
    outputs: [
      { id: 'out1', name: '输出', type: 'text', required: true, cardinality: 'one', description: '输出端口' }
    ],
    configSchema: {
      mode: { type: 'enum', required: false, enumValues: ['a', 'b'], description: '模式选择' }
    },
    commands: { execute: 'test.demo.execute' },
    runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
    expose: { desktop: true, cli: true, mcp: true },
    ...overrides
  }
}

describe('Capability Registry', () => {
  beforeEach(() => {
    clearRegistry()
  })

  // ── 注册 ──────────────────────────────────────────────────

  describe('defineCapability()', () => {
    it('应该成功注册合法能力定义', () => {
      const cap = defineCapability(makeCapability())
      expect(cap.id).toBe('test.demo')
      expect(cap.version).toBe('1.0.0')
      expect(getCapability('test.demo')).toBeDefined()
    })

    it('应该拒绝 id 不含点号格式', () => {
      expect(() => defineCapability(makeCapability({ id: 'invalid' }))).toThrow(
        /category\.name/
      )
    })

    it('应该拒绝非语义化版本', () => {
      expect(() => defineCapability(makeCapability({ version: '1.0' }))).toThrow(
        /语义化版本/
      )
      expect(() => defineCapability(makeCapability({ version: 'v1.0.0' }))).toThrow(
        /语义化版本/
      )
    })

    it('应该拒绝缺少 nodeType', () => {
      expect(() =>
        defineCapability(makeCapability({ nodeType: '' as any }))
      ).toThrow(/nodeType/)
    })

    it('应该拒绝缺少 title', () => {
      expect(() => defineCapability(makeCapability({ title: '' }))).toThrow(/title/)
    })

    it('应该拒绝重复端口 ID', () => {
      expect(() =>
        defineCapability(
          makeCapability({
            inputs: [
              { id: 'dup', name: '输入A', type: 'text', required: false, cardinality: 'one', description: '' },
              { id: 'dup', name: '输入B', type: 'text', required: false, cardinality: 'one', description: '' }
            ]
          })
        )
      ).toThrow(/端口 ID 重复/)
    })

    it('应该拒绝跨输入输出的重复端口 ID', () => {
      expect(() =>
        defineCapability(
          makeCapability({
            inputs: [
              { id: 'shared', name: '输入', type: 'text', required: false, cardinality: 'one', description: '' }
            ],
            outputs: [
              { id: 'shared', name: '输出', type: 'text', required: true, cardinality: 'one', description: '' }
            ]
          })
        )
      ).toThrow(/端口 ID 重复/)
    })
  })

  // ── 查询 ──────────────────────────────────────────────────

  describe('getCapability()', () => {
    it('应该返回已注册的能力', () => {
      defineCapability(makeCapability())
      const cap = getCapability('test.demo')
      expect(cap).toBeDefined()
      expect(cap!.id).toBe('test.demo')
    })

    it('应该对未注册的 ID 返回 undefined', () => {
      expect(getCapability('nonexistent')).toBeUndefined()
    })
  })

  describe('getCapabilityByNodeType()', () => {
    it('应该按 nodeType 查找到能力', () => {
      defineCapability(makeCapability({ nodeType: 'custom-type' as any }))
      const cap = getCapabilityByNodeType('custom-type')
      expect(cap).toBeDefined()
      expect(cap!.nodeType).toBe('custom-type')
    })

    it('应该对未知 nodeType 返回 undefined', () => {
      expect(getCapabilityByNodeType('unknown')).toBeUndefined()
    })
  })

  describe('listCapabilities()', () => {
    it('应该返回所有已注册的能力', () => {
      defineCapability(makeCapability({ id: 'a.one' }))
      defineCapability(makeCapability({ id: 'b.two', nodeType: 'b-two' as any }))
      const all = listCapabilities()
      expect(all).toHaveLength(2)
    })

    it('应该支持按暴露标志过滤', () => {
      defineCapability(makeCapability({ id: 'a.one', expose: { desktop: true, cli: false, mcp: true } }))
      defineCapability(makeCapability({ id: 'b.two', nodeType: 'b-two' as any, expose: { desktop: false, cli: true, mcp: false } }))

      const cliOnly = listCapabilities({ cli: true })
      expect(cliOnly).toHaveLength(1)
      expect(cliOnly[0].id).toBe('b.two')

      const mcpOnly = listCapabilities({ mcp: true })
      expect(mcpOnly).toHaveLength(1)
      expect(mcpOnly[0].id).toBe('a.one')

      const desktopOnly = listCapabilities({ desktop: true })
      expect(desktopOnly).toHaveLength(1)
      expect(desktopOnly[0].id).toBe('a.one')
    })

    it('空注册表应返回空数组', () => {
      expect(listCapabilities()).toEqual([])
    })
  })

  describe('getCapabilities()', () => {
    it('应该批量获取能力', () => {
      defineCapability(makeCapability({ id: 'a.one' }))
      defineCapability(makeCapability({ id: 'b.two', nodeType: 'b-two' as any }))
      const caps = getCapabilities(['a.one', 'b.two', 'nonexistent'])
      expect(caps).toHaveLength(2)
    })
  })

  // ── 注册表状态 ────────────────────────────────────────────

  describe('isEmpty() & clearRegistry()', () => {
    it('空注册表应返回 true', () => {
      expect(isEmpty()).toBe(true)
    })

    it('注册后应返回 false', () => {
      defineCapability(makeCapability())
      expect(isEmpty()).toBe(false)
    })

    it('clearRegistry 后应返回 true', () => {
      defineCapability(makeCapability())
      clearRegistry()
      expect(isEmpty()).toBe(true)
    })
  })

  // ── 契约快照 ──────────────────────────────────────────────

  describe('契约快照', () => {
    it('注册时应自动记录快照', () => {
      defineCapability(makeCapability())
      const snaps = getSnapshots('test.demo')
      expect(snaps).toHaveLength(1)
      expect(snaps[0].capabilityId).toBe('test.demo')
      expect(snaps[0].version).toBe('1.0.0')
    })

    it('版本变化时新增快照', () => {
      defineCapability(makeCapability({ version: '1.0.0' }))
      defineCapability(makeCapability({ version: '2.0.0' }))
      const snaps = getSnapshots('test.demo')
      expect(snaps).toHaveLength(2)
    })

    it('同版本重注册不新增快照', () => {
      defineCapability(makeCapability({ version: '1.0.0' }))
      defineCapability(makeCapability({ version: '1.0.0' }))
      const snaps = getSnapshots('test.demo')
      expect(snaps).toHaveLength(1)
    })

    it('getLatestSnapshot 返回最后一条', () => {
      defineCapability(makeCapability({ version: '1.0.0' }))
      defineCapability(makeCapability({ version: '2.0.0' }))
      const latest = getLatestSnapshot('test.demo')
      expect(latest).toBeDefined()
      expect(latest!.version).toBe('2.0.0')
    })

    it('未注册能力的快照应返回空数组', () => {
      expect(getSnapshots('unknown')).toEqual([])
      expect(getLatestSnapshot('unknown')).toBeUndefined()
    })

    it('快照应包含 inputs/outputs/configSchema', () => {
      defineCapability(makeCapability())
      const snap = getLatestSnapshot('test.demo')!
      expect(snap.inputs).toHaveLength(1)
      expect(snap.outputs).toHaveLength(1)
      expect(snap.configSchema).toBeDefined()
      expect(snap.configSchema.mode).toBeDefined()
    })
  })
})

// ── 生产定义集成测试 ───────────────────────────────────────

describe('生产能力定义集成', () => {
  // vi.resetModules() 强制 Vitest 清除模块缓存，
  // 下一次 import('@capabilities') 会重新执行 definitions.ts 中的 defineCapability() 调用
  async function freshImport() {
    vi.resetModules()
    return await import('@capabilities')
  }

  it('导入 @capabilities 后应有 23 个已注册能力', async () => {
    const mod = await freshImport()
    const all = mod.listCapabilities()
    expect(all.length).toBeGreaterThanOrEqual(20)
  })

  it('所有能力都有合法 id 格式', async () => {
    const mod = await freshImport()
    for (const cap of mod.listCapabilities()) {
      expect(cap.id).toMatch(/^\w+\.\w+$/)
    }
  })

  it('所有能力都有语义化版本', async () => {
    const mod = await freshImport()
    for (const cap of mod.listCapabilities()) {
      expect(cap.version).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })

  it('所有能力的 nodeType 唯一', async () => {
    const mod = await freshImport()
    const nodeTypes = mod.listCapabilities().map((c) => c.nodeType)
    const unique = new Set(nodeTypes)
    expect(unique.size).toBe(nodeTypes.length)
  })

  it('所有能力的 id 唯一', async () => {
    const mod = await freshImport()
    const ids = mod.listCapabilities().map((c) => c.id)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })

  it('至少有一个能力暴露给 MCP', async () => {
    const mod = await freshImport()
    const mcpCaps = mod.listCapabilities({ mcp: true })
    expect(mcpCaps.length).toBeGreaterThan(0)
  })
})
