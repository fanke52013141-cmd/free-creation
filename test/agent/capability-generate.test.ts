/**
 * 自动生成层测试
 *
 * 验证从 Capability Registry 自动生成 MCP Schema、CLI 规格、能力矩阵
 * 和契约快照的正确性。这是「一套定义，多个入口」原则的核心保障。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  defineCapability,
  clearRegistry,
  listCapabilities,
  generateMcpToolSchema,
  generateCliSpec,
  generateMatrixEntry,
  generateSnapshot,
  generateAll,
  diffSnapshots,
  isBreakingChange
} from '@capabilities'
import type { Capability, ContractSnapshot } from '@capabilities/types'

// ── 测试用能力 ─────────────────────────────────────────────

function makeCap(overrides: Partial<Capability> = {}): Capability {
  return {
    id: 'image.crop',
    version: '2.0.0',
    contractVersion: 2,
    nodeType: 'image-crop' as any,
    title: '图片裁剪',
    description: '按照固定比例或自由区域裁剪图片',
    category: 'image',
    inputs: [
      {
        id: 'image',
        name: '图片',
        type: 'image',
        required: true,
        cardinality: 'one',
        description: '待裁剪图片'
      }
    ],
    outputs: [
      {
        id: 'result',
        name: '结果',
        type: 'image',
        required: true,
        cardinality: 'one',
        description: '裁剪后图片'
      }
    ],
    configSchema: {
      mode: {
        type: 'enum',
        required: true,
        enumValues: ['fixed-ratio', 'free'],
        description: '裁剪模式',
        defaultValue: 'fixed-ratio'
      },
      ratio: {
        type: 'enum',
        required: false,
        enumValues: ['1:1', '16:9', '9:16', '4:3', '3:4'],
        description: '固定比例'
      },
      iterations: {
        type: 'number',
        required: false,
        minimum: 1,
        maximum: 10,
        defaultValue: 3
      }
    },
    commands: { execute: 'image.crop.execute', preview: 'image.crop.preview' },
    runtime: { headless: true, preview: true, batch: false, executionMode: 'auto' },
    expose: { desktop: true, cli: true, mcp: true },
    ...overrides
  }
}

describe('自动生成层', () => {
  beforeEach(() => {
    clearRegistry()
  })

  // ── MCP Schema 生成 ───────────────────────────────────────

  describe('generateMcpToolSchema()', () => {
    it('应该生成正确的工具名称和描述', () => {
      const cap = makeCap()
      const schema = generateMcpToolSchema(cap)
      expect(schema.name).toBe('node.image-crop')
      expect(schema.description).toContain('图片裁剪')
      expect(schema.description).toContain('按照固定比例')
    })

    it('应该将 configSchema 映射为 JSON Schema properties', () => {
      const schema = generateMcpToolSchema(makeCap())
      const props = schema.inputSchema.properties
      expect(props.mode).toBeDefined()
      expect(props.ratio).toBeDefined()
      expect(props.iterations).toBeDefined()
    })

    it('应该正确映射 enum 类型', () => {
      const schema = generateMcpToolSchema(makeCap())
      const mode = schema.inputSchema.properties.mode as Record<string, unknown>
      expect(mode.enum).toEqual(['fixed-ratio', 'free'])
    })

    it('应该正确映射 defaultValue', () => {
      const schema = generateMcpToolSchema(makeCap())
      const mode = schema.inputSchema.properties.mode as Record<string, unknown>
      expect(mode.default).toBe('fixed-ratio')
    })

    it('应该正确映射 minimum/maximum', () => {
      const schema = generateMcpToolSchema(makeCap())
      const iter = schema.inputSchema.properties.iterations as Record<string, unknown>
      expect(iter.minimum).toBe(1)
      expect(iter.maximum).toBe(10)
    })

    it('应该正确提取 required 列表', () => {
      const schema = generateMcpToolSchema(makeCap())
      expect(schema.inputSchema.required).toContain('mode')
      expect(schema.inputSchema.required).not.toContain('ratio')
    })

    it('无必填字段时 required 应为空', () => {
      const cap = makeCap({
        configSchema: {
          optional: { type: 'string', required: false }
        }
      })
      const schema = generateMcpToolSchema(cap)
      expect(schema.inputSchema.required).toEqual([])
    })
  })

  // ── CLI 规格生成 ──────────────────────────────────────────

  describe('generateCliSpec()', () => {
    it('应该生成正确的命令名和描述', () => {
      const spec = generateCliSpec(makeCap())
      expect(spec.command).toBe('image-crop')
      expect(spec.description).toContain('图片裁剪')
    })

    it('应该将 configSchema 映射为 options', () => {
      const spec = generateCliSpec(makeCap())
      expect(spec.options).toHaveLength(3)

      const modeOpt = spec.options.find((o) => o.name === '--mode')
      expect(modeOpt).toBeDefined()
      expect(modeOpt!.required).toBe(true)
      expect(modeOpt!.type).toBe('enum')

      const ratioOpt = spec.options.find((o) => o.name === '--ratio')
      expect(ratioOpt).toBeDefined()
      expect(ratioOpt!.required).toBe(false)
    })

    it('应该正确映射 defaultValue', () => {
      const spec = generateCliSpec(makeCap())
      const iterOpt = spec.options.find((o) => o.name === '--iterations')
      expect(iterOpt!.defaultValue).toBe(3)
    })
  })

  // ── 能力矩阵条目生成 ─────────────────────────────────────

  describe('generateMatrixEntry()', () => {
    it('应该包含正确的矩阵字段', () => {
      const entry = generateMatrixEntry(makeCap())
      expect(entry.capability).toBe('image.crop')
      expect(entry.node).toBe('图片裁剪')
      expect(entry.nodeType).toBe('image-crop')
      expect(entry.version).toBe('2.0.0')
      expect(entry.contractVersion).toBe(2)
      expect(entry.cli).toBe(true)
      expect(entry.mcp).toBe(true)
      expect(entry.inputs).toBe(1)
      expect(entry.outputs).toBe(1)
      expect(entry.headless).toBe(true)
    })

    it('应该正确反映暴露标志', () => {
      const entry = generateMatrixEntry(
        makeCap({ expose: { desktop: false, cli: false, mcp: true } })
      )
      expect(entry.cli).toBe(false)
      expect(entry.mcp).toBe(true)
    })
  })

  // ── 快照生成 ──────────────────────────────────────────────

  describe('generateSnapshot()', () => {
    it('应该生成包含完整契约信息的快照', () => {
      const cap = makeCap()
      const snap = generateSnapshot(cap)
      expect(snap.capabilityId).toBe('image.crop')
      expect(snap.version).toBe('2.0.0')
      expect(snap.inputs).toEqual(cap.inputs)
      expect(snap.outputs).toEqual(cap.outputs)
      expect(snap.configSchema).toEqual(cap.configSchema)
      expect(snap.snapshotAt).toBeGreaterThan(0)
    })
  })

  // ── 批量生成 ──────────────────────────────────────────────

  describe('generateAll()', () => {
    it('应该为所有已注册能力生成全部产物', () => {
      defineCapability(makeCap({ id: 'a.one', nodeType: 'a-one' as any }))
      defineCapability(makeCap({ id: 'b.two', nodeType: 'b-two' as any }))

      const artifacts = generateAll()
      expect(artifacts.mcpTools.some((tool) => tool.name === 'create_node')).toBe(true)
      expect(artifacts.cliCommands.some((command) => command.command === 'node')).toBe(true)
      expect(artifacts.nodeConfigSchemas).toHaveLength(2)
      expect(artifacts.capabilityMatrix).toHaveLength(2)
      expect(artifacts.snapshots).toHaveLength(2)
      expect(artifacts.generatedAt).toBeGreaterThan(0)
    })

    it('空注册表仍保留真实入口，但不生成节点配置 schema', () => {
      const artifacts = generateAll()
      expect(artifacts.mcpTools.length).toBeGreaterThan(0)
      expect(artifacts.cliCommands.length).toBeGreaterThan(0)
      expect(artifacts.nodeConfigSchemas).toEqual([])
    })
  })

  // ── 契约差异检测 ─────────────────────────────────────────

  describe('diffSnapshots()', () => {
    function makeSnap(overrides: Partial<ContractSnapshot> = {}): ContractSnapshot {
      return {
        capabilityId: 'image.crop',
        version: '1.0.0',
        inputs: [
          {
            id: 'image',
            name: '图片',
            type: 'image',
            required: true,
            cardinality: 'one',
            description: ''
          }
        ],
        outputs: [
          {
            id: 'result',
            name: '结果',
            type: 'image',
            required: true,
            cardinality: 'one',
            description: ''
          }
        ],
        configSchema: {
          mode: { type: 'enum', required: true, enumValues: ['a', 'b'] }
        },
        snapshotAt: Date.now(),
        ...overrides
      }
    }

    it('相同契约应无差异', () => {
      const snap = makeSnap()
      const diff = diffSnapshots(snap, snap)
      expect(diff.changes).toHaveLength(0)
    })

    it('新增输入端口应检测为 added', () => {
      const old = makeSnap()
      const newSnap = makeSnap({
        version: '1.1.0',
        inputs: [
          ...old.inputs,
          {
            id: 'mask',
            name: '遮罩',
            type: 'image',
            required: false,
            cardinality: 'one',
            description: ''
          }
        ]
      })
      const diff = diffSnapshots(old, newSnap)
      const added = diff.changes.find((c) => c.type === 'added' && c.path === 'inputs.mask')
      expect(added).toBeDefined()
    })

    it('删除输出端口应检测为 removed', () => {
      const old = makeSnap({
        outputs: [
          {
            id: 'result',
            name: '结果',
            type: 'image',
            required: true,
            cardinality: 'one',
            description: ''
          },
          {
            id: 'thumbnail',
            name: '缩略图',
            type: 'image',
            required: false,
            cardinality: 'one',
            description: ''
          }
        ]
      })
      const newSnap = makeSnap()
      const diff = diffSnapshots(old, newSnap)
      const removed = diff.changes.find(
        (c) => c.type === 'removed' && c.path === 'outputs.thumbnail'
      )
      expect(removed).toBeDefined()
    })

    it('端口类型变化应检测为 modified', () => {
      const old = makeSnap()
      const newSnap = makeSnap({
        inputs: [
          {
            id: 'image',
            name: '图片',
            type: 'text',
            required: true,
            cardinality: 'one',
            description: ''
          }
        ]
      })
      const diff = diffSnapshots(old, newSnap)
      const modified = diff.changes.find(
        (c) => c.type === 'modified' && c.path === 'inputs.image.type'
      )
      expect(modified).toBeDefined()
      expect(modified!.before).toBe('image')
      expect(modified!.after).toBe('text')
    })

    it('新增配置字段应检测为 added', () => {
      const old = makeSnap()
      const newSnap = makeSnap({
        version: '1.1.0',
        configSchema: {
          ...old.configSchema,
          background: { type: 'color', required: false }
        }
      })
      const diff = diffSnapshots(old, newSnap)
      const added = diff.changes.find((c) => c.type === 'added' && c.path === 'config.background')
      expect(added).toBeDefined()
    })

    it('删除配置字段应检测为 removed', () => {
      const old = makeSnap({
        configSchema: {
          mode: { type: 'enum', required: true, enumValues: ['a', 'b'] },
          legacy: { type: 'string', required: false }
        }
      })
      const newSnap = makeSnap()
      const diff = diffSnapshots(old, newSnap)
      const removed = diff.changes.find((c) => c.type === 'removed' && c.path === 'config.legacy')
      expect(removed).toBeDefined()
    })
  })

  // ── 破坏性变更判定 ───────────────────────────────────────

  describe('isBreakingChange()', () => {
    function makeDiff(
      changes: Array<{ type: 'added' | 'removed' | 'modified'; path: string; after?: unknown }>
    ) {
      return {
        capabilityId: 'test',
        changes: changes.map((c) => ({ ...c, before: undefined }))
      }
    }

    it('删除端口是破坏性变更', () => {
      const diff = makeDiff([{ type: 'removed', path: 'inputs.image' }])
      expect(isBreakingChange(diff as any)).toBe(true)
    })

    it('删除配置字段是破坏性变更', () => {
      const diff = makeDiff([{ type: 'removed', path: 'config.legacy' }])
      expect(isBreakingChange(diff as any)).toBe(true)
    })

    it('端口类型变化是破坏性变更', () => {
      const diff = makeDiff([{ type: 'modified', path: 'inputs.image.type', after: 'text' }])
      expect(isBreakingChange(diff as any)).toBe(true)
    })

    it('必填从 false 变 true 是破坏性变更', () => {
      const diff = makeDiff([{ type: 'modified', path: 'inputs.mask.required', after: true }])
      expect(isBreakingChange(diff as any)).toBe(true)
    })

    it('必填从 true 变 false 不是破坏性变更', () => {
      const diff = makeDiff([{ type: 'modified', path: 'inputs.image.required', after: false }])
      expect(isBreakingChange(diff as any)).toBe(false)
    })

    it('新增端口不是破坏性变更', () => {
      const diff = makeDiff([{ type: 'added', path: 'inputs.mask' }])
      expect(isBreakingChange(diff as any)).toBe(false)
    })

    it('新增配置字段不是破坏性变更', () => {
      const diff = makeDiff([{ type: 'added', path: 'config.background' }])
      expect(isBreakingChange(diff as any)).toBe(false)
    })

    it('无变化不是破坏性变更', () => {
      const diff = makeDiff([])
      expect(isBreakingChange(diff as any)).toBe(false)
    })
  })
})

// ── 一致性验证 ─────────────────────────────────────────────

describe('生成一致性', () => {
  beforeEach(() => {
    clearRegistry()
  })

  it('真实工具表固定，节点配置 schema 与注册能力数一致', () => {
    defineCapability(makeCap({ id: 'a.one', nodeType: 'a-one' as any }))
    defineCapability(makeCap({ id: 'b.two', nodeType: 'b-two' as any }))
    defineCapability(makeCap({ id: 'c.three', nodeType: 'c-three' as any }))

    const artifacts = generateAll()
    const capCount = listCapabilities().length
    expect(artifacts.mcpTools.some((tool) => tool.name === 'create_node')).toBe(true)
    expect(artifacts.cliCommands.some((command) => command.command === 'node')).toBe(true)
    expect(artifacts.nodeConfigSchemas.length).toBe(capCount)
    expect(artifacts.capabilityMatrix.length).toBe(capCount)
    expect(artifacts.snapshots.length).toBe(capCount)
  })
})
