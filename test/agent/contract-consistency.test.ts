/**
 * 契约一致性与防漏机制测试
 *
 * 这是 Agent 接入方案的 CI 防漏检查核心。
 * 验证：
 * 1. 同一能力定义在 MCP、CLI 和矩阵中的描述保持一致
 * 2. 所有标记 mcp: true 的能力都能生成有效 Schema
 * 3. 所有标记 cli: true 的能力都能生成有效 CLI 规格
 * 4. 契约快照保存与差异检测工作流
 * 5. 生成结果的幂等性（确定性）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type {
  Capability,
  ContractSnapshot,
  McpToolSchema,
  CliCommandSpec,
  CapabilityMatrixEntry
} from '@capabilities/types'

// ── 辅助：获取最新注册的能力 ───────────────────────────────

async function getCaps(): Promise<{
  caps: Capability[]
  generateAll: typeof import('@capabilities').generateAll
  generateMcpToolSchema: typeof import('@capabilities').generateMcpToolSchema
  generateCliSpec: typeof import('@capabilities').generateCliSpec
  generateMatrixEntry: typeof import('@capabilities').generateMatrixEntry
  generateSnapshot: typeof import('@capabilities').generateSnapshot
  diffSnapshots: typeof import('@capabilities').diffSnapshots
  isBreakingChange: typeof import('@capabilities').isBreakingChange
}> {
  vi.resetModules()
  const mod = await import('@capabilities')
  return {
    caps: mod.listCapabilities(),
    ...mod
  }
}

describe('契约一致性检查', () => {
  let caps: Capability[]
  let generateAll: Awaited<ReturnType<typeof getCaps>>['generateAll']
  let generateMcpToolSchema: Awaited<ReturnType<typeof getCaps>>['generateMcpToolSchema']
  let generateCliSpec: Awaited<ReturnType<typeof getCaps>>['generateCliSpec']
  let generateMatrixEntry: Awaited<ReturnType<typeof getCaps>>['generateMatrixEntry']

  beforeEach(async () => {
    const env = await getCaps()
    caps = env.caps
    generateAll = env.generateAll
    generateMcpToolSchema = env.generateMcpToolSchema
    generateCliSpec = env.generateCliSpec
    generateMatrixEntry = env.generateMatrixEntry
  })

  // ── 1. 三入口一致性 ──────────────────────────────────────

  describe('三入口一致性', () => {
    it('MCP 工具名与 CLI 命令名应基于同一 nodeType', () => {
      for (const cap of caps) {
        const mcp = generateMcpToolSchema(cap)
        const cli = generateCliSpec(cap)

        // MCP 工具名是 node.<nodeType>，CLI 命令名是 <nodeType>
        expect(mcp.name).toBe(`node.${cap.nodeType}`)
        expect(cli.command).toBe(cap.nodeType)
      }
    })

    it('MCP 和 CLI 的 configSchema 字段集应一致', () => {
      for (const cap of caps) {
        const mcp = generateMcpToolSchema(cap)
        const cli = generateCliSpec(cap)

        const mcpKeys = new Set(Object.keys(mcp.inputSchema.properties))
        const cliKeys = new Set(cli.options.map((o) => o.name.replace('--', '')))

        // 两者应包含相同的字段
        const configKeys = new Set(Object.keys(cap.configSchema))
        expect(mcpKeys).toEqual(configKeys)
        expect(cliKeys).toEqual(configKeys)
      }
    })

    it('矩阵条目应反映能力的真实暴露标志', () => {
      for (const cap of caps) {
        const entry = generateMatrixEntry(cap)
        expect(entry.cli).toBe(cap.expose.cli)
        expect(entry.mcp).toBe(cap.expose.mcp)
      }
    })

    it('矩阵条目应反映真实的输入/输出端口数', () => {
      for (const cap of caps) {
        const entry = generateMatrixEntry(cap)
        expect(entry.inputs).toBe(cap.inputs.length)
        expect(entry.outputs).toBe(cap.outputs.length)
      }
    })

    it('矩阵条目应反映真实的契约版本', () => {
      for (const cap of caps) {
        const entry = generateMatrixEntry(cap)
        expect(entry.contractVersion).toBe(cap.contractVersion)
        expect(entry.version).toBe(cap.version)
      }
    })
  })

  // ── 2. MCP Schema 完整性 ─────────────────────────────────

  describe('MCP Schema 完整性', () => {
    it('每个暴露给 MCP 的能力都应生成有效 Schema', () => {
      const mcpCaps = caps.filter((c) => c.expose.mcp)
      expect(mcpCaps.length).toBeGreaterThan(0)

      for (const cap of mcpCaps) {
        const schema = generateMcpToolSchema(cap)
        expect(schema.name).toBeTruthy()
        expect(schema.description).toBeTruthy()
        expect(schema.inputSchema.type).toBe('object')
        expect(schema.inputSchema.properties).toBeDefined()
      }
    })

    it('MCP Schema 的 required 列表应与 configSchema 中 required: true 的字段一致', () => {
      for (const cap of caps) {
        const schema = generateMcpToolSchema(cap)
        const expectedRequired = Object.entries(cap.configSchema)
          .filter(([, field]) => field.required)
          .map(([key]) => key)
        expect(schema.inputSchema.required).toEqual(expectedRequired)
      }
    })

    it('enum 类型字段应在 MCP Schema 中包含 enum 约束', () => {
      for (const cap of caps) {
        const schema = generateMcpToolSchema(cap)
        for (const [key, field] of Object.entries(cap.configSchema)) {
          if (field.type === 'enum' && field.enumValues) {
            const prop = schema.inputSchema.properties[key] as Record<string, unknown>
            expect(prop.enum).toEqual(field.enumValues)
          }
        }
      }
    })

    it('MCP Schema 的 description 应来自能力定义', () => {
      for (const cap of caps) {
        const schema = generateMcpToolSchema(cap)
        expect(schema.description).toContain(cap.title)
      }
    })
  })

  // ── 3. CLI 规格完整性 ────────────────────────────────────

  describe('CLI 规格完整性', () => {
    it('每个暴露给 CLI 的能力都应生成有效 CLI 规格', () => {
      const cliCaps = caps.filter((c) => c.expose.cli)
      expect(cliCaps.length).toBeGreaterThan(0)

      for (const cap of cliCaps) {
        const spec = generateCliSpec(cap)
        expect(spec.command).toBeTruthy()
        expect(spec.description).toBeTruthy()
        expect(Array.isArray(spec.options)).toBe(true)
      }
    })

    it('CLI 规格的每个 option 应有 name、type、required', () => {
      for (const cap of caps) {
        const spec = generateCliSpec(cap)
        for (const opt of spec.options) {
          expect(opt.name).toMatch(/^--/)
          expect(opt.type).toBeTruthy()
          expect(typeof opt.required).toBe('boolean')
        }
      }
    })
  })

  // ── 4. 生成幂等性 ────────────────────────────────────────

  describe('生成幂等性', () => {
    it('两次调用 generateAll 应产生相同的结构化结果（忽略时间戳）', () => {
      const a1 = generateAll()
      const a2 = generateAll()

      // 比较 MCP tools
      expect(a2.mcpTools.length).toBe(a1.mcpTools.length)
      for (let i = 0; i < a1.mcpTools.length; i++) {
        expect(a2.mcpTools[i].name).toBe(a1.mcpTools[i].name)
        expect(a2.mcpTools[i].inputSchema.properties).toEqual(a1.mcpTools[i].inputSchema.properties)
        expect(a2.mcpTools[i].inputSchema.required).toEqual(a1.mcpTools[i].inputSchema.required)
      }

      // 比较 CLI commands
      expect(a2.cliCommands.length).toBe(a1.cliCommands.length)
      for (let i = 0; i < a1.cliCommands.length; i++) {
        expect(a2.cliCommands[i].command).toBe(a1.cliCommands[i].command)
        expect(a2.cliCommands[i].options).toEqual(a1.cliCommands[i].options)
      }

      // 比较矩阵
      expect(a2.capabilityMatrix).toEqual(a1.capabilityMatrix)
    })
  })

  // ── 5. 全量矩阵验证 ──────────────────────────────────────

  describe('能力矩阵', () => {
    it('矩阵条目数应与能力数一致', () => {
      const artifacts = generateAll()
      expect(artifacts.capabilityMatrix.length).toBe(caps.length)
    })

    it('每个能力的 id 和 nodeType 应出现在矩阵中', () => {
      const artifacts = generateAll()
      const capIds = new Set(caps.map((c) => c.id))
      const matrixIds = new Set(artifacts.capabilityMatrix.map((m) => m.capability))
      expect(matrixIds).toEqual(capIds)
    })
  })
})

// ── 契约快照工作流测试 ─────────────────────────────────────

describe('契约快照工作流', () => {
  let generateSnapshot: Awaited<ReturnType<typeof getCaps>>['generateSnapshot']
  let diffSnapshots: Awaited<ReturnType<typeof getCaps>>['diffSnapshots']
  let isBreakingChange: Awaited<ReturnType<typeof getCaps>>['isBreakingChange']
  let caps: Capability[]

  beforeEach(async () => {
    const env = await getCaps()
    caps = env.caps
    generateSnapshot = env.generateSnapshot
    diffSnapshots = env.diffSnapshots
    isBreakingChange = env.isBreakingChange
  })

  it('应为所有能力生成快照', () => {
    for (const cap of caps) {
      const snap = generateSnapshot(cap)
      expect(snap.capabilityId).toBe(cap.id)
      expect(snap.version).toBe(cap.version)
    }
  })

  it('快照间无差异时 diff 应为空', () => {
    for (const cap of caps) {
      const snap = generateSnapshot(cap)
      const diff = diffSnapshots(snap, snap)
      expect(diff.changes).toHaveLength(0)
      expect(isBreakingChange(diff)).toBe(false)
    }
  })

  it('模拟新增配置字段的 diff 不应判定为破坏性变更', () => {
    const cap = caps[0]
    const oldSnap = generateSnapshot(cap)

    // 模拟新增可选字段
    const newCap: Capability = {
      ...cap,
      version: bumpPatch(cap.version),
      configSchema: {
        ...cap.configSchema,
        _newOptionalField: { type: 'string', required: false }
      }
    }
    const newSnap = generateSnapshot(newCap)
    const diff = diffSnapshots(oldSnap, newSnap)

    const added = diff.changes.find((c) => c.type === 'added')
    expect(added).toBeDefined()
    expect(isBreakingChange(diff)).toBe(false)
  })

  it('模拟删除输出端口的 diff 应判定为破坏性变更', () => {
    const cap = caps.find((c) => c.outputs.length > 0)!
    const oldSnap = generateSnapshot(cap)

    const newCap: Capability = {
      ...cap,
      outputs: cap.outputs.slice(0, -1) // 删除最后一个输出
    }
    const newSnap = generateSnapshot(newCap)
    const diff = diffSnapshots(oldSnap, newSnap)

    const removed = diff.changes.find((c) => c.type === 'removed')
    expect(removed).toBeDefined()
    expect(isBreakingChange(diff)).toBe(true)
  })

  it('模拟修改端口类型的 diff 应判定为破坏性变更', () => {
    const cap = caps.find((c) => c.inputs.length > 0)!
    const oldSnap = generateSnapshot(cap)

    const newInputs = [...cap.inputs]
    newInputs[0] = { ...newInputs[0], type: 'video' as any } // 改变类型
    const newCap: Capability = { ...cap, inputs: newInputs }
    const newSnap = generateSnapshot(newCap)
    const diff = diffSnapshots(oldSnap, newSnap)

    expect(isBreakingChange(diff)).toBe(true)
  })
})

// ── 辅助函数 ───────────────────────────────────────────────

function bumpPatch(version: string): string {
  const parts = version.split('.').map(Number)
  parts[2]++
  return parts.join('.')
}
