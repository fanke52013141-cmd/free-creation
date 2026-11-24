import { describe, expect, it } from 'vitest'
import { ACCESS_OPERATIONS } from '../src/shared/agent-access/registry'
import {
  DEFAULT_RESPONSE_TIMEOUT_MS,
  HUMAN_DECISION_TIMEOUT_MS,
  INTERACTIVE_RESPONSE_TIMEOUT_MS,
  isInteractiveOperation,
  responseTimeoutMs
} from '../src/shared/agent-access/interactive'

// BL-01 回归：人工决定操作在返回前要等人点确认，CLI 不能再用 15s 默认超时，
// 否则人还没点就会收到误导性的 OUTCOME_UNKNOWN（phase=connect），而 main 仍会继续执行，
// 造成「客户端以为失败、服务端后来生效」的错位。
const HUMAN_DECISION_OPERATIONS = [
  'flowGraph.confirm',
  'flowAgent.build.commit',
  'humanTask.submit',
  'flowAgent.cooperate',
  'flowAgent.run',
  'provider.package.import',
  'provider.package.importProviders'
]

describe('本地 Agent 客户端响应超时口径', () => {
  it('人工决定操作按人工上限等待，不再 15s 误报 OUTCOME_UNKNOWN', () => {
    for (const operationId of HUMAN_DECISION_OPERATIONS) {
      expect(isInteractiveOperation(operationId), operationId).toBe(true)
      expect(responseTimeoutMs(operationId, 0), operationId).toBe(INTERACTIVE_RESPONSE_TIMEOUT_MS)
    }
    expect(INTERACTIVE_RESPONSE_TIMEOUT_MS).toBe(HUMAN_DECISION_TIMEOUT_MS + 30_000)
    expect(INTERACTIVE_RESPONSE_TIMEOUT_MS).toBeGreaterThan(HUMAN_DECISION_TIMEOUT_MS)
  })

  it('run.wait 仍按请求的等待时长（长轮询不能被截断）', () => {
    expect(responseTimeoutMs('run.wait', 120_000)).toBe(150_000)
  })

  it('普通只读/写入操作保持 15s 快速失败', () => {
    for (const operationId of ['project.list', 'graph.get', 'humanTask.get']) {
      expect(isInteractiveOperation(operationId), operationId).toBe(false)
      expect(responseTimeoutMs(operationId, 0), operationId).toBe(DEFAULT_RESPONSE_TIMEOUT_MS)
    }
  })

  it('交互标记只落在真实存在的操作上', () => {
    for (const operationId of HUMAN_DECISION_OPERATIONS)
      expect(Object.hasOwn(ACCESS_OPERATIONS, operationId), operationId).toBe(true)
  })
})
