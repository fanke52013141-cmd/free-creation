// T2 · 运行错误构造测试（R0/WP1）
//
// 覆盖 engine/store 的 addError：诊断字段齐全（nodeId/portId/contractVersion/runId）、
// runId 由模块级 setRunId 关联（区分每次全局运行）、上报通道缺失时静默不抛。
import { describe, it, expect, beforeEach } from 'vitest'
import { useEngineStore, setRunId } from '@renderer/engine/store'

beforeEach(() => {
  setRunId(undefined)
  useEngineStore.setState({ errors: [], phase: 'idle' })
})

describe('addError · 字段构造', () => {
  it('各阶段错误产出完整字段（input/execution/output/topology）', () => {
    const phases = ['input', 'execution', 'output', 'topology'] as const
    for (const phase of phases) {
      useEngineStore.getState().addError('生图', `阶段${phase}失败`, {
        nodeId: 'shape:1',
        portId: 'in-text',
        phase,
        nodeType: 'image-gen',
        contractVersion: 1,
        runId: 'run-1'
      })
    }
    const { errors } = useEngineStore.getState()
    expect(errors).toHaveLength(4)
    for (const e of errors) {
      expect(e.nodeId).toBe('shape:1')
      expect(e.portId).toBe('in-text')
      expect(e.nodeType).toBe('image-gen')
      expect(e.contractVersion).toBe(1)
      expect(e.runId).toBe('run-1')
      expect(e.timestamp).toBeGreaterThan(0)
    }
    expect(errors.map((e) => e.phase)).toEqual(phases)
  })

  it('未显式传 runId 时使用 setRunId 设置的当前运行 ID', () => {
    setRunId('run-current')
    useEngineStore.getState().addError('工作流', '工作流存在循环连线，无法执行', {
      phase: 'topology'
    })
    const e = useEngineStore.getState().errors[0]
    expect(e.runId).toBe('run-current')
    expect(e.phase).toBe('topology')
    // 拓扑错误无节点上下文：nodeId/portId 为 undefined 而非空字符串
    expect(e.nodeId).toBeUndefined()
  })

  it('runId 结束后（setRunId(undefined)）新错误不带旧运行 ID', () => {
    setRunId('run-old')
    setRunId(undefined)
    useEngineStore.getState().addError('x', 'y')
    expect(useEngineStore.getState().errors[0].runId).toBeUndefined()
  })

  it('多条错误按序累积（错误面板列表顺序）', () => {
    useEngineStore.getState().addError('a', 'reason-a')
    useEngineStore.getState().addError('b', 'reason-b')
    const { errors } = useEngineStore.getState()
    expect(errors.map((e) => e.label)).toEqual(['a', 'b'])
  })
})

describe('addError · 上报通道容错', () => {
  it('window.api 不存在（测试环境）时不抛错，错误仍进 store', () => {
    expect(() => useEngineStore.getState().addError('n', 'r')).not.toThrow()
    expect(useEngineStore.getState().errors).toHaveLength(1)
  })
})
