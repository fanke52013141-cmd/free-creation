// F4/F5 动作路由的机器校验（不是"看起来像"的映射）。
//
// 背景：F4/F5 剩余动作在 GUI 里就是"某类节点执行"的入口（见 action-coverage 的 gui 字段），
// 因此外部等价路径是 node.execute + output.get。这个结论必须可机器复核，否则就是拍脑袋：
// 1) 带 nodeType 的动作，其类型必须是当前 Active 节点；
// 2) 该类型必须能通过 node.type.get 查到契约（证明节点真实存在且可创建）；
// 3) 映射到 node.execute 的类型，逐节点矩阵里的 N5（执行）不能是 planned/not-applicable；
// 4) 付费族必须保留"从未实测"的诚实说明，禁止有人把它标成已验收；
// 5) excluded 的预览/维护动作必须写明理由（不能空着排除）。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { nodeContract } from '../src/shared/agent-access/node-contracts'
import { nodeActionMatrix } from '../src/shared/agent-access/node-actions'
import { ACTIVE_NODE_TYPE_IDS } from '../src/shared/types'

interface ActionEntry {
  label?: string
  gui?: string
  phase: string
  external?: string[]
  note?: string
  nodeType?: string
}

const coverage = JSON.parse(
  readFileSync(resolve(__dirname, '../docs/local-agent-access/action-coverage.json'), 'utf8')
) as { actions: Record<string, ActionEntry> }

const entries = Object.entries(coverage.actions)
const withNodeType = entries.filter(([, entry]) => typeof entry.nodeType === 'string')
const executeMapped = entries.filter(([, entry]) => (entry.external ?? []).includes('node.execute'))

/** GUI 入口确认为"某类节点执行"的动作集合（本测试的核心断言对象）。 */
const NODE_EXECUTION_ACTIONS = [
  'ipc.media.imageCrop',
  'ipc.media.imageSplit',
  'ipc.media.videoFrame',
  'ipc.media.videoClip',
  'ipc.media.soundAdjust',
  'ipc.media.timelineCompose',
  // 生成类通道在 IPC 契约中归属 gateway 族（db91832d 修正 keys 嵌套缩进后，
  // 审计按 ipc.gateway.* 解析；旧 ipc.keys.* 为缩进异常时期的误判命名）。
  'ipc.gateway.imageGenerate',
  'ipc.gateway.imageEdit',
  'ipc.gateway.videoSubmit',
  'ipc.gateway.speechGenerate',
  'ipc.gateway.voiceDesign',
  'ipc.gateway.audioGenerate',
  'ipc.media.indexttsSynthesize'
]

/** 需要本机 CUDA 环境、从未实测的动作：已按"代码层接通"映射，但 note 必须声明未实测。 */
const ENVIRONMENT_GATED_ACTIONS = ['ipc.media.videoConvertDepth', 'ipc.media.videoConvertClay']

describe('F4/F5 动作路由', () => {
  it('GUI 入口为"节点执行"的动作全部已映射', () => {
    for (const id of NODE_EXECUTION_ACTIONS) {
      const entry = coverage.actions[id]
      expect(entry, `缺少动作 ${id}`).toBeDefined()
      expect(entry.phase, `${id} 仍未映射`).toBe('external')
      expect(typeof entry.nodeType, `${id} 缺少 nodeType 映射`).toBe('string')
    }
  })

  it('依赖本机 CUDA 的两项"代码层接通"但必须声明未实测', () => {
    for (const id of ENVIRONMENT_GATED_ACTIONS) {
      const entry = coverage.actions[id]
      expect(entry.phase, `${id} 应已按代码层接通映射`).toBe('external')
      expect(entry.nodeType).toBeDefined()
      expect(entry.external ?? []).toContain('node.execute')
      // 关键：环境依赖项不得宣称已验收
      expect(/从未实测|环境缺失/.test(entry.note ?? ''), `${id} 缺少未实测声明`).toBe(true)
    }
    // 除 F3 的 result-select 外不应再有 F4/F5 遗留
    const remaining = entries
      .filter(([, entry]) => entry.phase === 'F4' || entry.phase === 'F5')
      .map(([id]) => id)
    expect(remaining).toEqual([])
  })

  it('每个带 nodeType 的映射都指向真实存在、可创建、且有契约的节点类型', () => {
    expect(withNodeType.length).toBeGreaterThanOrEqual(NODE_EXECUTION_ACTIONS.length)
    for (const [id, entry] of withNodeType) {
      const typeId = entry.nodeType as string
      expect(ACTIVE_NODE_TYPE_IDS as readonly string[], `${id} 映射到非 Active 类型 ${typeId}`).toContain(
        typeId
      )
      const contract = nodeContract(typeId)
      expect(contract, `${id} 映射的 ${typeId} 没有契约快照`).not.toBeNull()
      expect(contract!.creatable, `${id} 映射的 ${typeId} 不可创建`).toBe(true)
    }
  })

  it('映射到 node.execute 的类型必须"要么执行已验收，要么明确声明未实测"', () => {
    const matrix = new Map(nodeActionMatrix().map((entry) => [entry.typeId, entry]))
    for (const [id, entry] of executeMapped) {
      const typeId = entry.nodeType
      // 允许"执行经子图/工作流达成"的动作不带 nodeType（例如 workflow.run-all）。
      if (typeof typeId !== 'string') continue
      const row = matrix.get(typeId)
      expect(row, `${id}: 矩阵里没有 ${typeId}`).toBeDefined()
      const n5 = row!.actions.N5
      // 两条都不可接受：
      // ① 执行未验收却把 note 写成"已可用"（谎报）；
      // ② 执行已验收却仍被写成 planned（漏升级）。
      // 允许的是：执行已验收（desktop/contract-tested），或执行未验收但 note 明确声明了未实测。
      const accepted = ['desktop-tested', 'contract-tested']
      const honestPlanned = n5.status === 'planned' && /未实测|从未实测|自测|未验收/.test(entry.note ?? '')
      expect(
        accepted.includes(n5.status) || honestPlanned,
        `${id}: ${typeId} 的 N5 是 ${n5.status}，且 note 未声明未实测，不能声称可执行`
      ).toBe(true)
      expect(n5.evidence.length).toBeGreaterThan(3)
    }
  })

  it('付费族的映射必须保留"从未实测"的诚实说明', () => {
    const PAID_TYPES = ['image-gen', 'image-edit', 'video', 'speech', 'tts', 'voice-design']
    const paidEntries = withNodeType.filter(([, entry]) => PAID_TYPES.includes(entry.nodeType as string))
    expect(paidEntries.length).toBeGreaterThan(0)
    for (const [id, entry] of paidEntries) {
      const note = entry.note ?? ''
      expect(
        /未实测|从未实测|自测|未验收/.test(note),
        `${id}（${entry.nodeType}）缺少"未实测"说明，不允许把付费族写成已验收`
      ).toBe(true)
    }
  })

  it('被排除的预览/维护动作必须写明理由', () => {
    const mediaExcluded = entries.filter(
      ([id, entry]) =>
        entry.phase === 'excluded' && /^ipc\.(media|keys|gateway)\./.test(id)
    )
    expect(mediaExcluded.length).toBeGreaterThanOrEqual(5)
    for (const [id, entry] of mediaExcluded) {
      const note = entry.note ?? ''
      expect(note.length, `${id} 排除但没有理由`).toBeGreaterThan(8)
      expect(entry.external ?? []).toEqual([])
    }
  })

  it('任务控制动作映射到任务族，且不声称取消即成功', () => {
    for (const id of [
      'ipc.gateway.videoTask',
      'ipc.gateway.videoCancel',
      'ipc.media.videoConvertCancel',
      'ipc.media.cancelTransforms'
    ]) {
      const entry = coverage.actions[id]
      expect(entry.phase).toBe('external')
      const mapped = entry.external ?? []
      expect(mapped.some((op) => op === 'run.get' || op === 'run.wait' || op === 'run.cancel')).toBe(
        true
      )
      expect(/取消请求与确认分离|终态由 run\.get/.test(entry.note ?? '')).toBe(true)
    }
  })
})
