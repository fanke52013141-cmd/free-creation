/**
 * 契约快照新鲜度门禁（Agent 契约同步机制核心闸门）
 *
 * 验证 generated/agent-contracts.json 始终等于当前代码的生成结果。
 * 任何触及节点能力（端口/Schema/configSchema/MCP 工具）的改动，必须在同一提交内
 * 重新生成契约快照（npm run agent:generate），否则本测试失败并阻断合并——
 * 防止 Agent/CLI/MCP 三入口拿到过期契约。
 *
 * 归一化逻辑与 src/capabilities/generate-entry.ts 共用 normalizeArtifacts()。
 * 流程详见 docs/AGENT_SYNC_MECHANISM.md。
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { generateAll, normalizeArtifacts } from '@capabilities'

const CONTRACT_PATH = resolve(process.cwd(), 'generated/agent-contracts.json')

function readCommittedRaw(): string {
  return readFileSync(CONTRACT_PATH, 'utf-8')
}

describe('契约快照新鲜度门禁', () => {
  it('generated/agent-contracts.json 存在且可解析', () => {
    const raw = readCommittedRaw()
    expect(
      () => JSON.parse(raw),
      '契约快照缺失或损坏：请运行 npm run agent:generate 重新生成并提交'
    ).not.toThrow()
  })

  it('提交的契约快照等于当前代码的生成结果', () => {
    const committed = readCommittedRaw()
    const fresh = `${JSON.stringify(normalizeArtifacts(generateAll()), null, 2)}\n`

    if (committed !== fresh) {
      // 定位首个差异，给出可操作的修复指令（而不是一大坨 JSON diff）
      let diffIndex = 0
      const len = Math.min(committed.length, fresh.length)
      while (diffIndex < len && committed[diffIndex] === fresh[diffIndex]) diffIndex++
      const line = committed.slice(0, diffIndex).split('\n').length
      const detail =
        diffIndex >= len && committed.length !== fresh.length
          ? `内容长度不一致（提交 ${committed.length} 字符 vs 生成 ${fresh.length} 字符）`
          : `首个差异在第 ${line} 行附近：提交 "${committed.slice(Math.max(0, diffIndex - 30), diffIndex + 30).replace(/\n/g, '\\n')}" vs 生成 "${fresh.slice(Math.max(0, diffIndex - 30), diffIndex + 30).replace(/\n/g, '\\n')}"`

      throw new Error(
        `契约漂移：generated/agent-contracts.json 与当前代码的生成结果不一致。\n` +
          `  ${detail}\n` +
          `  修复：运行 npm run agent:generate 重新生成，并把 generated/agent-contracts.json 加入本次提交。\n` +
          `  详见 docs/AGENT_SYNC_MECHANISM.md`
      )
    }
    expect(committed).toBe(fresh)
  })

  it('提交的契约快照无审计时间戳残留（保证确定性）', () => {
    const parsed = JSON.parse(readCommittedRaw()) as {
      generatedAt?: unknown
      snapshots: Array<{ capabilityId: string; snapshotAt?: unknown }>
    }
    expect(parsed.generatedAt, 'generatedAt 应在归一化时剔除').toBeUndefined()
    for (const snap of parsed.snapshots) {
      expect(snap.snapshotAt, `${snap.capabilityId}.snapshotAt 应在归一化时剔除`).toBeUndefined()
    }
  })
})
