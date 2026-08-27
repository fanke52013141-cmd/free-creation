// @vitest-environment jsdom
// T5 · runNodeManually 手动运行一致性测试（R0/WP3）
//
// 验证统一手动入口与全局运行共用 executeNodeOnce 完整链路：
// - 全局运行进行中拒绝手动触发（并发保护）
// - 节点不存在直接返回 false
// - 上游输出从 shape 投影预填：手动跑下游与全局跑产出一致的 props 与 exec 状态
// - store 状态机：beginRun/endRun/setStop 正确复位
// - 失败路径：执行器 failed 时写运行错误（store.errors）并返回 false
// - 跳过路径：无输入节点返回 false，exec 回 idle
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { FakeEditor, nodeProps } from './helpers/fakeEditor'
import { runNodeManually, runWorkflow } from '@renderer/engine/executor'
import { useEngineStore } from '@renderer/engine/store'
import { useToastStore } from '@renderer/stores/toast'

/** text(a) --out-text→in-text--> text(b) 的标准两节点图 */
function makeTextChain(ownText: string): FakeEditor {
  const ed = new FakeEditor()
  ed.addNode('shape:a', nodeProps({ nodeType: 'text', title: '上游', text: '上游文本' }))
  ed.addNode('shape:b', nodeProps({ nodeType: 'text', title: '下游', text: ownText }))
  ed.addArrow('shape:e', 'out-text', 'in-text', 'shape:a', 'shape:b')
  return ed
}

beforeAll(() => {
  registerAllNodeTypes()
})

beforeEach(() => {
  useEngineStore.getState().endRun()
  useEngineStore.getState().setStop(null)
  useToastStore.getState().clear()
})

describe('runNodeManually · 并发与边界', () => {
  it('全局运行进行中拒绝手动触发', async () => {
    const ed = makeTextChain('')
    useEngineStore.getState().beginRun(1) // 模拟全局运行占用
    const ok = await runNodeManually(ed.asEditor(), 'p1', 'shape:b')
    expect(ok).toBe(false)
    // 未执行任何节点
    expect(ed.getShape('shape:b')?.props.exec).toBe('idle')
    expect(useToastStore.getState().msg).toBe('全局运行进行中，请等待完成或先停止')
  })

  it('节点不存在返回 false', async () => {
    const ed = new FakeEditor()
    const ok = await runNodeManually(ed.asEditor(), 'p1', 'shape:none')
    expect(ok).toBe(false)
  })
})

describe('runNodeManually · 上游预填与全局一致性', () => {
  it('手动跑下游节点：合并上游文本与全局运行产出一致', async () => {
    const manual = makeTextChain('自有内容')
    const ok = await runNodeManually(manual.asEditor(), 'p1', 'shape:b')
    expect(ok).toBe(true)

    const global = makeTextChain('自有内容')
    await runWorkflow(global.asEditor(), 'p1', [])

    const expected = '上游文本\n\n---\n\n自有内容'
    const manualB = manual.getShape('shape:b')!
    const globalB = global.getShape('shape:b')!
    // 一致性核心断言：同图同初值，手动跑下游 == 全局跑整图的下游产出
    expect(manualB.props.text).toBe(expected)
    expect(globalB.props.text).toBe(expected)
    expect(manualB.props.exec).toBe('success')
    expect(globalB.props.exec).toBe('success')
    // 上游节点未被手动执行触碰
    expect(manual.getShape('shape:a')?.props.exec).toBe('idle')
  })

  it('成功后 store 状态机复位', async () => {
    const ed = makeTextChain('')
    await runNodeManually(ed.asEditor(), 'p1', 'shape:b')
    const s = useEngineStore.getState()
    expect(s.phase).toBe('idle')
    expect(s.stop).toBeNull()
    expect(s.errors).toHaveLength(0)
    expect(s.done).toBe(1)
    expect(s.total).toBe(1)
  })
})

describe('runNodeManually · 失败与跳过', () => {
  it('执行器 failed：写运行错误并返回 false', async () => {
    const ed = new FakeEditor()
    ed.addNode('shape:j', nodeProps({ nodeType: 'json', title: '坏JSON', text: 'not-json' }))
    const ok = await runNodeManually(ed.asEditor(), 'p1', 'shape:j')
    expect(ok).toBe(false)
    expect(ed.getShape('shape:j')?.props.exec).toBe('failed')
    const s = useEngineStore.getState()
    expect(s.errors).toHaveLength(1)
    expect(s.errors[0].reason).toBe('JSON 输入格式无效')
    expect(s.errors[0].nodeId).toBe('shape:j')
    expect(s.errors[0].phase).toBe('execution')
    expect(s.errors[0].nodeType).toBe('json')
    expect(s.phase).toBe('idle')
  })

  it('无输入跳过：返回 false 且 exec 回 idle', async () => {
    const ed = new FakeEditor()
    ed.addNode('shape:t', nodeProps({ nodeType: 'text', title: '空文本', text: '   ' }))
    const ok = await runNodeManually(ed.asEditor(), 'p1', 'shape:t')
    expect(ok).toBe(false)
    expect(ed.getShape('shape:t')?.props.exec).toBe('idle')
    expect(useEngineStore.getState().errors).toHaveLength(0)
    expect(useToastStore.getState().msg).toBe('无文本输入')
  })

  it('未知节点类型：冻结跳过并报错', async () => {
    const ed = new FakeEditor()
    ed.addNode('shape:f', nodeProps({ nodeType: 'future-node', title: '来自未来' }))
    const ok = await runNodeManually(ed.asEditor(), 'p1', 'shape:f')
    expect(ok).toBe(false)
    expect(ed.getShape('shape:f')?.props.exec).toBe('failed')
    const errs = useEngineStore.getState().errors
    expect(errs).toHaveLength(1)
    expect(errs[0].reason).toContain('future-node')
    expect(errs[0].reason).toContain('未注册')
  })
})
