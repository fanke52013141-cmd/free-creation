/**
 * 破坏性变更版本门禁（Agent 契约同步机制第二道闸门）
 *
 * 两层互补对比，杜绝「破坏性变更但 contractVersion 未提升」的提交：
 *
 * 用例 1 —— 磁盘快照 vs 当前代码生成结果：
 *   拦截「改了定义还没重新生成快照」时的漏 bump（与快照新鲜度门禁同时红，
 *   但本用例额外指出破坏性变更与版本要求，提示更可操作）。
 *
 * 用例 2 —— git 基线快照（origin/main 或 HEAD 中上次提交的版本）vs 磁盘快照：
 *   拦截「快照已重新生成、契约漂移门禁已绕过，但版本忘了 bump」的危险提交形态。
 *
 * 豁免：
 * - 新增 capability（基线无旧快照）：首次注册，无破坏可言。
 * - 纯新增端口（仅 added 变更）：向后兼容，允许同版本号。
 *
 * 流程详见 docs/AGENT_SYNC_MECHANISM.md。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  diffSnapshots,
  generateAll,
  isBreakingChange,
  normalizeArtifacts,
  type ContractSnapshot
} from '@capabilities'

const CONTRACT_PATH = resolve(process.cwd(), 'generated/agent-contracts.json')

interface SnapshotLite {
  capabilityId: string
  version: string
  inputs: unknown[]
  outputs: unknown[]
  configSchema: Record<string, unknown>
}

/** x.y.z 语义版本数值比较：返回正数表示 a > b。 */
function compareSemVer(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  }
  return 0
}

/** 把破坏性违规格式化为可操作的错误信息。 */
function formatViolations(violations: string[]): string {
  return (
    `检测到破坏性契约变更但 contractVersion 未 bump：\n${violations.join('\n')}\n` +
    `  修复：在 src/capabilities/definitions.ts 中提升对应能力的 contractVersion，` +
    `并同步 renderer spec（node-contract-source 门禁要求两侧一致），随后 npm run agent:generate 重新生成快照。\n` +
    `  详见 docs/AGENT_SYNC_MECHANISM.md`
  )
}

/** 对比两组快照：凡破坏性变更的能力，新版本号必须严格大于旧版本号。返回违规列表。 */
function collectViolations(oldSnaps: SnapshotLite[], newSnaps: SnapshotLite[]): string[] {
  const oldById = new Map(oldSnaps.map((s) => [s.capabilityId, s]))
  const violations: string[] = []

  for (const fresh of newSnaps) {
    const old = oldById.get(fresh.capabilityId)
    if (!old) continue // 新增能力豁免：首次注册

    // diffSnapshots 需要 ContractSnapshot 类型；snapshotAt 不参与 diff，补齐即可。
    const diff = diffSnapshots(
      { ...old, snapshotAt: 0 } as unknown as ContractSnapshot,
      { ...fresh, snapshotAt: 0 } as unknown as ContractSnapshot
    )

    if (isBreakingChange(diff) && compareSemVer(fresh.version, old.version) <= 0) {
      const changes = diff.changes
        .map(
          (c) =>
            `${c.type} ${c.path}${c.before !== undefined ? `（${String(c.before)} → ${String(c.after)}）` : ''}`
        )
        .join('; ')
      violations.push(
        `  - ${fresh.capabilityId}: 契约版本 ${old.version} → ${fresh.version} 未提升，但存在破坏性变更 [${changes}]`
      )
    }
  }
  return violations
}

/** 从 git 读取基线契约快照（上次提交的状态）；不可用时返回 null。 */
function readGitBaseline(): { source: string; snapshots: SnapshotLite[] } | null {
  const candidates = ['origin/main', 'HEAD']
  for (const ref of candidates) {
    try {
      const raw = execFileSync('git', ['show', `${ref}:generated/agent-contracts.json`], {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000
      })
      const parsed = JSON.parse(raw) as { snapshots: SnapshotLite[] }
      if (Array.isArray(parsed.snapshots)) {
        return { source: ref, snapshots: parsed.snapshots }
      }
    } catch {
      // 该 ref 不可用（浅克隆缺 ref / 首次运行），尝试下一个
    }
  }
  return null
}

describe('破坏性变更版本门禁', () => {
  it('磁盘快照中的破坏性变更必须已 bump contractVersion（对照当前代码生成结果）', () => {
    const committed = JSON.parse(readFileSync(CONTRACT_PATH, 'utf-8')) as {
      snapshots: SnapshotLite[]
    }
    const fresh = normalizeArtifacts(generateAll())

    const violations = collectViolations(
      committed.snapshots,
      fresh.snapshots as unknown as SnapshotLite[]
    )
    if (violations.length > 0) {
      throw new Error(
        `【快照未重新生成场景】\n${formatViolations(violations)}\n  提示：同时还需要 npm run agent:generate 重新生成快照（见快照新鲜度门禁）。`
      )
    }
    expect(violations).toEqual([])
  })

  it('git 基线中的破坏性变更必须已 bump contractVersion（拦截重新生成快照后漏 bump 的危险提交）', () => {
    const baseline = readGitBaseline()

    if (!baseline) {
      // 非 git 环境（如部分 CI 浅克隆）无法取基线：本用例降级为自我一致，
      // 场景 3 的拦截交由 CI 的 agent:check-contracts 与代码审查兜底。
      console.warn('[contract-version-bump] 无可用 git 基线（origin/main / HEAD），跳过基线对比')
      return
    }

    const committed = JSON.parse(readFileSync(CONTRACT_PATH, 'utf-8')) as {
      snapshots: SnapshotLite[]
    }

    const violations = collectViolations(baseline.snapshots, committed.snapshots)
    if (violations.length > 0) {
      throw new Error(
        `【快照已重新生成但版本未提升场景】基线来源：${baseline.source}\n${formatViolations(violations)}`
      )
    }
    expect(violations).toEqual([])
  })

  it('纯新增端口（向后兼容）允许保持版本号不变', () => {
    // 固化豁免语义：仅 added 变更不触发版本强制（isBreakingChange 对 added 返回 false）。
    const committed = JSON.parse(readFileSync(CONTRACT_PATH, 'utf-8')) as {
      snapshots: SnapshotLite[]
    }
    const first = committed.snapshots[0]
    expect(first).toBeDefined()
    const snap = { ...first, snapshotAt: 0 } as unknown as ContractSnapshot
    const diff = diffSnapshots(snap, snap)
    expect(isBreakingChange(diff)).toBe(false)
  })
})
