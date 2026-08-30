import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const panelSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/canvas/NodeContractPanel.tsx'),
  'utf8'
)

describe('节点详情面板', () => {
  it('对话节点不再被排除，所有有 Spec 的节点都可查看真实输入输出', () => {
    expect(panelSource).not.toContain("shape.props.nodeType === 'chat'")
    expect(panelSource).toContain('const ports = getNodePorts(spec, shape)')
  })
})
