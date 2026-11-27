import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildExternalAgentBrief } from '../src/renderer/src/lib/external-agent-brief'
import { GENERATED_NODE_CONTRACTS } from '../src/shared/agent-access/generated/node-contracts.generated'
import { nodeContract } from '../src/shared/agent-access/node-contracts'

describe('external-agent-brief copy button & guide generation', () => {
  it('generates a complete onboarding brief covering all active node contracts and MCP core workflow', () => {
    const brief = buildExternalAgentBrief([{ id: 'proj-abc', name: '演示项目' }])
    expect(brief).toContain('mcp serve')
    expect(brief).toContain('idempotencyKey')
    expect(brief).toContain('graph_patch_propose')
    expect(brief).toContain('graph_patch_confirm')
    expect(brief).toContain('composite_execute')
    expect(brief).not.toContain('composite_run')
    expect(brief).toContain('"portId": "in-images"')
    expect(brief).not.toContain('"portId": "in-first-frame"')
    expect(brief).toContain('agent-exports')
    expect(brief).toContain('view: "latest"')
    expect(brief).toContain('canvas_ops_search')
    expect(brief).toContain('canvas_ops_schema')
    expect(brief).toContain('canvas_ops_call')
    expect(brief).toContain('演示项目')
    expect(brief).toContain('proj-abc')
    for (const contract of GENERATED_NODE_CONTRACTS) {
      expect(brief).toContain(`\`${contract.typeId}\``)
    }
    // 核心高频节点的 nodeContract 必须附带 configGuide 供外部 Agent 自省
    for (const keyType of ['image-gen', 'video', 'processor', 'code', 'image-crop', 'image-split']) {
      const c = nodeContract(keyType)
      expect(c?.configGuide?.summary).toBeTruthy()
      expect(c?.configGuide?.example).toBeTruthy()
    }
  })

  it('places the Agent 对接 copy button directly to the left of 重载 on ProjectListPage', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/pages/ProjectListPage.tsx'),
      'utf8'
    )
    const guideIndex = source.indexOf('project-home-agent-guide')
    const reloadIndex = source.indexOf('project-home-dev-reload')
    const createIndex = source.indexOf('project-home-button-primary')
    expect(guideIndex).toBeGreaterThan(-1)
    expect(reloadIndex).toBeGreaterThan(-1)
    expect(guideIndex).toBeLessThan(reloadIndex)
    expect(reloadIndex).toBeLessThan(createIndex)
  })
})
