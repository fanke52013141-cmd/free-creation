import { describe, expect, it } from 'vitest'
import {
  buildMcpToolsList,
  MCP_CORE_OPERATION_IDS,
  MCP_META_TOOL_NAMES,
  MCP_SERVER_INSTRUCTIONS,
  parseOpsCallArgs,
  resolveMcpProfile,
  runOpsSchema,
  runOpsSearch
} from '../src/local-agent/mcp-profile'
import { ACCESS_OPERATIONS } from '../src/shared/agent-access/registry'

describe('MCP progressive disclosure (core vs full profile)', () => {
  it('defaults to core profile and supports explicit --profile full / env override', () => {
    expect(resolveMcpProfile(['mcp', 'serve'], {})).toBe('core')
    expect(resolveMcpProfile(['mcp', 'serve', '--profile', 'full'], {})).toBe('full')
    expect(resolveMcpProfile(['mcp', 'serve', '--profile=full'], {})).toBe('full')
    expect(resolveMcpProfile(['mcp', 'serve'], { CANVAS_MCP_PROFILE: 'full' })).toBe('full')
  })

  it('shrinks tools/list payload by >90% in core profile while keeping <=28 tools', () => {
    const core = buildMcpToolsList('core')
    const full = buildMcpToolsList('full')
    expect(full.length).toBe(Object.keys(ACCESS_OPERATIONS).length)
    expect(core.length).toBeLessThanOrEqual(28)
    expect(core.every((tool) => tool.outputSchema === undefined)).toBe(true)

    const coreBytes = Buffer.byteLength(JSON.stringify(core), 'utf8')
    const fullBytes = Buffer.byteLength(JSON.stringify(full), 'utf8')
    expect(coreBytes).toBeLessThan(fullBytes * 0.1)

    // Every declared core operation ID must exist in ACCESS_OPERATIONS with no duplicates (prevents phantom tools)
    expect(new Set(MCP_CORE_OPERATION_IDS).size).toBe(MCP_CORE_OPERATION_IDS.length)
    for (const opId of MCP_CORE_OPERATION_IDS) {
      expect(Object.hasOwn(ACCESS_OPERATIONS, opId), `missing opId in registry: ${opId}`).toBe(true)
    }
    expect(core.length).toBe(MCP_CORE_OPERATION_IDS.length + 3)

    // Core profile directly exposes scheme-A graph patch preview ops, composite execute, and meta-tools
    const names = new Set(core.map((t) => t.name))
    expect(names.has('graph_patch_propose')).toBe(true)
    expect(names.has('graph_patch_confirm')).toBe(true)
    expect(names.has('graph_patch_discard')).toBe(true)
    expect(names.has('composite_execute')).toBe(true)
    expect(names.has('composite_execute_wait')).toBe(true)
    expect(names.has(MCP_META_TOOL_NAMES.search)).toBe(true)
    expect(names.has(MCP_META_TOOL_NAMES.schema)).toBe(true)
    expect(names.has(MCP_META_TOOL_NAMES.call)).toBe(true)
    expect(names.has('flowAgent_build_propose')).toBe(false)
    expect(MCP_SERVER_INSTRUCTIONS).toContain('graph_patch_propose')
    expect(MCP_SERVER_INSTRUCTIONS).toContain('idempotencyKey')
    expect(MCP_SERVER_INSTRUCTIONS).toContain('in-images')
    expect(MCP_SERVER_INSTRUCTIONS).toContain('composite_execute')
  })

  it('discovers and validates extended operations via canvas_ops_search / schema / call', () => {
    const found = runOpsSearch({ group: 'library', limit: 10 })
    expect(found.ok).toBe(true)
    if (found.ok) {
      expect(found.data.matched).toBeGreaterThan(0)
      expect(found.data.operations.every((op) => op.operationId.startsWith('library'))).toBe(true)
    }

    const schema = runOpsSchema({ operationId: 'skill.list' })
    expect(schema.ok).toBe(true)
    if (schema.ok) {
      expect(schema.data.operationId).toBe('skill.list')
      expect(schema.data.inputSchema).toBeTruthy()
    }

    const missing = runOpsSchema({ operationId: 'nonexistent.op' })
    expect(missing.ok).toBe(false)

    const call = parseOpsCallArgs({
      operationId: 'skill.list',
      input: { offset: 0, limit: 10 },
      requestId: 'req-1'
    })
    expect(call.ok).toBe(true)
    if (call.ok) {
      expect(call.operationId).toBe('skill.list')
      expect(call.args).toMatchObject({ input: { offset: 0, limit: 10 }, requestId: 'req-1' })
    }
  })
})
