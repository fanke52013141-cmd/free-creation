// 连线契约覆盖：循环当前项（iteration 非对称规则）与 any 口。
// 对应审计「剩余端口」里风险最高的两组：36 条 iteration 注入边 + 24 条 processing 透传边。
// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { allNodeTypes, getNodeType } from '@renderer/nodes/registry'
import { portPairCompatible } from '@renderer/canvas/graph'

beforeAll(() => {
  registerAllNodeTypes()
})

describe('循环当前项注入与 any 口的契约覆盖', () => {
  it('iteration 只作为输出；45 条注入边的来源、端口与目标输入类型固定', () => {
    const targets = new Set<string>()
    let count = 0
    for (const fromSpec of allNodeTypes()) {
      for (const out of fromSpec.ports.out.filter((port) => port.type === 'iteration')) {
        for (const toSpec of allNodeTypes()) {
          for (const inp of toSpec.ports.in) {
            if (!portPairCompatible(out, inp)) continue
            count += 1
            expect(fromSpec.type).toBe('iterate')
            expect(out.id).toBe('out-item')
            targets.add(`${toSpec.type}.${inp.id}:${inp.type}`)
          }
        }
      }
    }
    // 44 = 可创建节点；契约全集含 2 条历史节点（script / video-audio）为 46。
    expect(count).toBe(44)
    const inputTypes = [...new Set([...targets].map((entry) => entry.split(':')[1]))].sort()
    expect(inputTypes).toEqual(['any', 'audio', 'camera', 'file', 'image', 'json', 'video'])
    // 方向规则：iteration 不可能出现在输入端（历史 bug 就是把参数写反）。
    for (const spec of allNodeTypes()) {
      expect(spec.ports.in.some((port) => port.type === 'iteration')).toBe(false)
    }
  })

  it('any 口唯一：只有数据处理 in-value 接受任意类型（53 条可创建节点透传边）', () => {
    const anyInputs = allNodeTypes().flatMap((spec) =>
      spec.ports.in.filter((port) => port.type === 'any').map((port) => `${spec.type}.${port.id}`)
    )
    expect(anyInputs).toEqual(['processor.in-value'])
    const anyPort = getNodeType('processor')?.ports.in.find((port) => port.type === 'any')
    expect(anyPort).toBeTruthy()
    let pairs = 0
    for (const spec of allNodeTypes()) {
      for (const out of spec.ports.out) {
        if (portPairCompatible(out, anyPort!)) pairs += 1
      }
    }
    // 53 条包含人工任务新增的图片和视频交付端口与去气口的音频端口。
    expect(pairs).toBe(53)
  })
})

