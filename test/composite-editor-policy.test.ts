// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { CompositeManifest } from '../src/shared/composite/manifest'
import {
  applyCompositeEditorPolicy,
  compositeEditorPolicyFromManifest,
  type CompositeEditorPolicy
} from '../src/renderer/src/composite/editor-policy'

function manifest(policy?: CompositeManifest['executionPolicy']): CompositeManifest {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'policy-editor',
    version: '1.0',
    name: '策略编辑',
    inputs: [],
    outputs: [
      {
        id: 'result',
        label: '结果',
        type: 'text',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'n1', portId: 'out-text' }
      }
    ],
    graph: {
      nodes: [
        {
          id: 'n1',
          nodeType: 'text',
          contractVersion: 3,
          title: '文本',
          dx: 0,
          dy: 0,
          w: 340,
          h: 300,
          text: '正文'
        }
      ],
      edges: []
    },
    executionPolicy: {
      timeoutMs: 60000,
      waitForInput: true,
      ...policy
    }
  }
}

describe('节点流运行策略编辑状态', () => {
  it('修改→完成→保存，并以已保存 base 连续第二次保存，策略不回滚', () => {
    let base = manifest({ onBranchFailure: 'fail-fast', maxConcurrency: 1 })
    let policyOpen = true
    const edited: CompositeEditorPolicy = { onBranchFailure: 'continue', maxConcurrency: 4 }

    // “完成”只改变可见性；持久 policy 不参与关闭动作。
    policyOpen = false
    const firstSaved = applyCompositeEditorPolicy(base, edited)
    expect(policyOpen).toBe(false)
    expect(firstSaved.executionPolicy).toMatchObject({
      onBranchFailure: 'continue',
      maxConcurrency: 4,
      timeoutMs: 60000,
      waitForInput: true
    })

    // 与 saveDraft 成功路径一致：下一次从已落盘 manifest 继续。
    base = firstSaved
    const secondSaved = applyCompositeEditorPolicy(base, edited)
    expect(secondSaved.executionPolicy).toEqual(firstSaved.executionPolicy)
    expect(secondSaved).not.toBe(firstSaved)
  })

  it('从历史版本或已保存 base 重新派生策略，同时保留显式选择', () => {
    expect(compositeEditorPolicyFromManifest(null)).toEqual({
      onBranchFailure: 'fail-fast',
      maxConcurrency: 1
    })
    const historical = manifest({ onBranchFailure: 'continue', maxConcurrency: 3 })
    expect(compositeEditorPolicyFromManifest(historical)).toEqual({
      onBranchFailure: 'continue',
      maxConcurrency: 3
    })
    const selected = { onBranchFailure: 'fail-fast' as const, maxConcurrency: 2 }
    expect(applyCompositeEditorPolicy(historical, selected).executionPolicy).toMatchObject(selected)
  })
})
