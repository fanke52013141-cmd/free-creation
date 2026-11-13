import { describe, expect, it } from 'vitest'
import { projectStateMachineOutputs } from '../src/shared/agent-flow/agent-outputs'
import { DETERMINISTIC_PROJECTIONS } from '../src/shared/engine/deterministic-projections'
import {
  parseStateMachineInstance,
  parseStateMachinePending,
  stateMachineFlowState
} from '../src/shared/engine/executors/agentFlow'
import type { NodeShape } from '../src/shared/engine/executor-types'

const INSTANCE = {
  schemaVersion: 1,
  taskId: 'state-machine:shape:sm',
  stateNodeId: 'shape:sm',
  revision: 3,
  state: 'working',
  history: []
}

function shape(meta: Record<string, unknown>): NodeShape {
  return { props: { text: '', config: '' }, meta } as unknown as NodeShape
}

describe('C3：状态机输出投影与解析', () => {
  it('DETERMINISTIC_PROJECTIONS 注册 state-machine（output.get 不再 UNSUPPORTED_CONTRACT）', () => {
    expect(Object.hasOwn(DETERMINISTIC_PROJECTIONS, 'state-machine')).toBe(true)
  })

  it('持久化实例投影为 out-state（flow.state@1 严格字段）', () => {
    // 执行器写 nodeResult 前经 stateMachineFlowState 收敛为严格契约（剥离 history）。
    const outputs = projectStateMachineOutputs(
      shape({ nodeResult: JSON.stringify(stateMachineFlowState(INSTANCE as never)) })
    )
    expect(outputs['out-state']).toEqual({
      kind: 'json',
      data: {
        schemaVersion: 1,
        taskId: 'state-machine:shape:sm',
        stateNodeId: 'shape:sm',
        revision: 3,
        state: 'working'
      }
    })
  })

  it('无实例/损坏结果不投影（不伪造状态）', () => {
    expect(projectStateMachineOutputs(shape({}))).toEqual({})
    expect(projectStateMachineOutputs(shape({ nodeResult: 'bad-json' }))).toEqual({})
    expect(projectStateMachineOutputs(shape({ nodeResult: JSON.stringify({ state: 'x' }) }))).toEqual({})
  })

  it('实例与待处理事件解析口径', () => {
    expect(parseStateMachineInstance(JSON.stringify(INSTANCE))?.revision).toBe(3)
    expect(parseStateMachineInstance('bad')).toBeNull()
    const pending = { eventId: 'e1', event: 'flow.completed', expectedRevision: 3 }
    expect(parseStateMachinePending(JSON.stringify(pending))).toEqual(pending)
    expect(parseStateMachinePending(JSON.stringify({ event: 'x' }))).toBeNull()
  })
})