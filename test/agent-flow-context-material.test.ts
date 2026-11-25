import { describe, expect, it } from 'vitest'
import { NodeExecuteCommandSchema } from '../src/shared/agent-flow/commands'

const baseCommand = {
  schemaVersion: 1 as const,
  kind: 'node.execute' as const,
  commandId: 'cmd-1',
  projectId: 'project-1',
  taskId: 'task-1',
  agentNodeId: 'agent-1',
  targetNodeId: 'node-1',
  expectedSemanticRevision: `sha256:${'a'.repeat(64)}`,
  contractVersion: 1,
  inputs: [],
  traceId: 'trace-1',
  spanId: 'span-1'
}

describe('BL-40 / AF-10.4 能力节点上下文补料命令', () => {
  it('缺省不带 contextMaterial，旧命令保持兼容', () => {
    const parsed = NodeExecuteCommandSchema.parse(baseCommand)
    expect(parsed.contextMaterial).toBeUndefined()
  })

  it('接受合法的人工补料（端口 + 精简文本）', () => {
    const parsed = NodeExecuteCommandSchema.parse({
      ...baseCommand,
      contextMaterial: { targetPortId: 'in-text', text: '人工精简后的材料' }
    })
    expect(parsed.contextMaterial).toEqual({ targetPortId: 'in-text', text: '人工精简后的材料' })
  })

  it('拒绝空文本、缺少端口、未知字段与超长文本', () => {
    for (const material of [
      { targetPortId: 'in-text', text: '' },
      { targetPortId: 'in-text', text: '   ' },
      { text: '材料' },
      { targetPortId: 'in-text', text: '材料', extra: true },
      { targetPortId: 'in-text', text: 'x'.repeat(65537) }
    ]) {
      expect(
        NodeExecuteCommandSchema.safeParse({ ...baseCommand, contextMaterial: material }).success
      ).toBe(false)
    }
  })

  it('补料不改变固定输入引用协议：两者可以同时出现', () => {
    const parsed = NodeExecuteCommandSchema.parse({
      ...baseCommand,
      inputs: [
        {
          targetPortId: 'in-json',
          assets: [
            {
              assetId: 'asset-1',
              versionId: 'version-1',
              sourceNodeId: 'upstream-1',
              sourcePortId: 'out-json'
            }
          ]
        }
      ],
      contextMaterial: { targetPortId: 'in-text', text: '补充材料' }
    })
    expect(parsed.inputs).toHaveLength(1)
    expect(parsed.contextMaterial?.targetPortId).toBe('in-text')
  })
})