// @vitest-environment jsdom
// outputSource 双表同步门禁（2026-11-20 规范审查 A-⚠6 的防复发守卫）。
//
// 背景：main 侧 output.get 的 DETERMINISTIC_OUTPUT_SOURCES（run-ops.ts）与 renderer
// 注册表的 outputSource 声明（specs）是同一契约的两次记载，此前 image/audio/
// video-asset 标注相反、file 两边都缺。本测试把"两表必须同口径"固化为门禁：
// 1. main 表每个条目必须与 GUI 注册表的有效 outputSource（未声明时缺省 'run'）一致；
// 2. main 表每个条目必须有共享投影函数（output.get 不得 UNSUPPORTED_CONTRACT）；
// 3. 全部 Active 节点类型要么双表齐备，要么显式登记豁免（chat 走 chat.read/messages）。
import { describe, expect, it } from 'vitest'
import { DETERMINISTIC_PROJECTIONS } from '@shared/engine/deterministic-projections'
import { DETERMINISTIC_OUTPUT_SOURCES } from '@shared/agent-access/run-ops'
import { ACTIVE_NODE_TYPE_IDS } from '@shared/types'
import { getNodeType } from '@renderer/nodes/registry'
import { registerAllNodeTypes } from './helpers/registerNodes'

registerAllNodeTypes()

/** output.get 有意不支持、走专用读取路径的类型（必须逐个写明理由）。 */
const OUTPUT_GET_EXEMPT = new Set<string>([
  // chat 的输出是会话投影，外部走 chat.read / chat.messages（含分页与脱敏边界）。
  'chat',
  // voice-design 的产物经媒体回执与 voice.profile@1 咬合流转；且它不在
  // flowTargetContract 的可调度目标里，output.get 的 fail-closed 是现行口径。
  // 把它加进 DETERMINISTIC_PROJECTIONS 会连带放宽 asset-store 的生产者门
  // （asset-store 以投影表成员判定类型支持），2026-11-20 复核后撤回，留豁免登记。
  'voice-design'
])

describe('outputSource 双表同步门禁', () => {
  it('main 表每个条目与 GUI 注册表的 outputSource 同口径', () => {
    const mismatches: string[] = []
    for (const [type, source] of Object.entries(DETERMINISTIC_OUTPUT_SOURCES)) {
      const spec = getNodeType(type)
      if (!spec) {
        mismatches.push(`${type}: main 表登记了未注册类型`)
        continue
      }
      // director 的 manual-publish 是 main 侧 output.get 的元数据口径（发布授权后投影），
      // GUI 未声明 outputSource（缺省 run），属已登记的例外。
      const effective = spec.outputSource ?? 'run'
      if (source !== effective && !(type === 'director' && source === 'manual-publish'))
        mismatches.push(`${type}: main=${source} gui=${effective}`)
    }
    expect(mismatches).toEqual([])
  })

  it('main 表每个条目都有共享投影函数', () => {
    const missing: string[] = []
    for (const type of Object.keys(DETERMINISTIC_OUTPUT_SOURCES))
      if (!DETERMINISTIC_PROJECTIONS[type as keyof typeof DETERMINISTIC_PROJECTIONS])
        missing.push(type)
    expect(missing).toEqual([])
  })

  it('全部 Active 类型要么双表齐备，要么显式豁免', () => {
    const gaps: string[] = []
    for (const type of ACTIVE_NODE_TYPE_IDS) {
      if (OUTPUT_GET_EXEMPT.has(type)) continue
      if (!DETERMINISTIC_OUTPUT_SOURCES[type]) gaps.push(`${type}: 缺 outputSource 登记`)
      else if (!DETERMINISTIC_PROJECTIONS[type as keyof typeof DETERMINISTIC_PROJECTIONS])
        gaps.push(`${type}: 缺共享投影`)
    }
    expect(gaps).toEqual([])
  })

  it('document 语义只允许投影不读运行记录的节点（registry 规则的机器化）', () => {
    // registry.tsx：只有 projectOutputs 完全不读 meta.nodeResult/nodeExtra 的节点才能声明 document。
    // 这里对 document 类型抽查投影函数源码，防止未来把读 nodeResult 的类型误标 document。
    const violations: string[] = []
    for (const [type, source] of Object.entries(DETERMINISTIC_OUTPUT_SOURCES)) {
      if (source !== 'document') continue
      const fn = DETERMINISTIC_PROJECTIONS[type as keyof typeof DETERMINISTIC_PROJECTIONS]
      const fnSource = fn ? fn.toString() : ''
      if (fnSource.includes('nodeResult') || fnSource.includes('nodeExtra'))
        violations.push(`${type}: 声明 document 但投影读取运行记录`)
    }
    expect(violations).toEqual([])
  })
})
