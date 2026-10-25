// T05（F02）：快照恢复媒体预检的纯函数测试。
// 五步恢复流程（检查点→预检→应用→验证→回滚）在 CanvasSidePanel 中，纯逻辑在此固化。
import { describe, expect, it, vi } from 'vitest'
import {
  checkSnapshotMedia,
  extractSnapshotMediaIds,
  diffSnapshotMedia,
  restoreSnapshotSafely,
  verifyRestoredSnapshot,
  type SnapshotRestoreSteps
} from '@renderer/canvas/snapshot-restore'

const makeSnapshot = (mediaIds: Array<string | undefined>) => ({
  store: Object.fromEntries(
    mediaIds.map((id, i) => [
      `shape:node-${i}`,
      {
        type: 'node-card',
        props: { nodeType: 'image', mediaId: id, mediaPath: id ? `projects/p/media/${id}.png` : '' }
      }
    ])
  )
})

describe('extractSnapshotMediaIds', () => {
  it('提取全部节点引用的媒体 ID 并去重', () => {
    expect(extractSnapshotMediaIds(makeSnapshot(['m1', 'm2', 'm1']))).toEqual(['m1', 'm2'])
  })

  it('空 mediaId（未生成结果的节点）被跳过', () => {
    expect(extractSnapshotMediaIds(makeSnapshot([undefined, 'm1', '']))).toEqual(['m1'])
  })

  it('快照缺少 store 字段时返回空数组而非抛错', () => {
    expect(extractSnapshotMediaIds(null)).toEqual([])
    expect(extractSnapshotMediaIds({})).toEqual([])
  })

  it('校验生成结果、参考输入和导演引用，不扫描用户正文', () => {
    const snapshot = makeSnapshot(['asset'])
    Object.assign(snapshot.store['shape:node-0'], {
      props: {
        mediaId: 'asset',
        text: '{"mediaId":"not-a-reference"}',
        config: JSON.stringify({
          refMediaId: 'audio',
          referenceMediaIds: ['ref'],
          prompt: '{"mediaId":"prompt-content"}',
          shots: [{ sourceMediaIds: ['scene'], backgroundMediaId: 'background' }]
        })
      },
      meta: {
        nodeResult: JSON.stringify({
          selectedMediaId: 'old',
          items: [{ mediaId: 'old' }, { mediaId: 'new' }]
        })
      }
    })
    expect(extractSnapshotMediaIds(snapshot)).toEqual([
      'asset',
      'audio',
      'ref',
      'scene',
      'background',
      'old',
      'new'
    ])
  })

  it('损坏的历史记录和非节点内容不会中断预检', () => {
    expect(
      extractSnapshotMediaIds({
        store: {
          bad: null,
          document: { type: 'document', props: { mediaId: 'not-an-asset' } },
          node: { type: 'node-card', props: { mediaId: 'valid', config: '{' } }
        }
      })
    ).toEqual(['valid'])
  })
})

function restoreFixture(): { steps: SnapshotRestoreSteps; events: string[]; order: string[] } {
  const current = makeSnapshot(['before'])
  const target = makeSnapshot(['after'])
  const events: string[] = []
  const order: string[] = []
  const steps: SnapshotRestoreSteps = {
    current,
    target,
    prepare: vi.fn((snapshot) => snapshot),
    listAvailableMedia: vi.fn(async () => {
      order.push('precheck')
      return new Set(['after'])
    }),
    confirm: vi.fn(async () => {
      order.push('preview')
      return true
    }),
    saveCheckpoint: vi.fn(async () => {
      order.push('checkpoint')
    }),
    isCurrent: vi.fn(() => true),
    isUnchanged: vi.fn(() => true),
    apply: vi.fn(() => {
      order.push('apply')
    }),
    verify: vi.fn(),
    observe: (event) => {
      events.push(event)
    }
  }
  return { steps, events, order }
}

describe('安全恢复事务', () => {
  it('预检与预览在前、检查点成功后才应用版本，且只记录一次完成', async () => {
    const { steps, events, order } = restoreFixture()
    expect(await restoreSnapshotSafely(steps)).toEqual({ kind: 'restored' })
    expect(order).toEqual(['precheck', 'preview', 'checkpoint', 'apply'])
    expect(steps.confirm).toHaveBeenCalledWith({
      currentNodes: 1,
      targetNodes: 1,
      media: { available: ['after'], missing: [] }
    })
    expect(events).toEqual(['started', 'checkpoint_created', 'completed'])
  })

  it('媒体清单读取失败中止，不能伪装成空清单并让用户继续', async () => {
    const { steps, events } = restoreFixture()
    steps.listAvailableMedia = vi.fn(async () => {
      throw new Error('读取失败')
    })
    expect(await restoreSnapshotSafely(steps)).toEqual({
      kind: 'failed',
      stage: 'media-precheck',
      rollback: 'not-needed'
    })
    expect(steps.confirm).not.toHaveBeenCalled()
    expect(steps.saveCheckpoint).not.toHaveBeenCalled()
    expect(steps.apply).not.toHaveBeenCalled()
    expect(events).toEqual(['started', 'failed'])
  })

  it('缺媒体在预览中列出，用户取消不产生检查点也不改画布', async () => {
    const { steps } = restoreFixture()
    steps.listAvailableMedia = vi.fn(async () => new Set())
    steps.confirm = vi.fn(async () => false)
    expect(await restoreSnapshotSafely(steps)).toEqual({ kind: 'cancelled', reason: 'user' })
    expect(steps.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ media: { available: [], missing: ['after'] } })
    )
    expect(steps.saveCheckpoint).not.toHaveBeenCalled()
    expect(steps.apply).not.toHaveBeenCalled()
  })

  it('检查点保存失败不得执行恢复', async () => {
    const { steps } = restoreFixture()
    steps.saveCheckpoint = vi.fn(async () => {
      throw new Error('拒写')
    })
    expect(await restoreSnapshotSafely(steps)).toEqual({
      kind: 'failed',
      stage: 'checkpoint',
      rollback: 'not-needed'
    })
    expect(steps.apply).not.toHaveBeenCalled()
  })

  it.each(['precheck', 'confirmation', 'checkpoint'])(
    '等待%s时继续编辑不会覆盖新内容',
    async (stage) => {
      const { steps, events } = restoreFixture()
      let unchanged = true
      steps.isUnchanged = () => unchanged
      if (stage === 'precheck')
        steps.listAvailableMedia = async () => {
          unchanged = false
          return new Set()
        }
      if (stage === 'confirmation')
        steps.confirm = async () => {
          unchanged = false
          return true
        }
      if (stage === 'checkpoint')
        steps.saveCheckpoint = async () => {
          unchanged = false
        }
      expect(await restoreSnapshotSafely(steps)).toEqual({
        kind: 'cancelled',
        reason: 'content-changed'
      })
      expect(steps.apply).not.toHaveBeenCalled()
      expect(events.at(-1)).toBe('cancelled')
    }
  )

  it('切换项目或卸载面板后不再加载旧项目版本', async () => {
    const { steps } = restoreFixture()
    steps.isCurrent = () => false
    expect(await restoreSnapshotSafely(steps)).toEqual({
      kind: 'cancelled',
      reason: 'context-changed'
    })
    expect(steps.confirm).not.toHaveBeenCalled()
    expect(steps.apply).not.toHaveBeenCalled()
  })

  it('应用部分失败用本地捕获的原始状态回滚，不按版本标题查找', async () => {
    const { steps, events } = restoreFixture()
    steps.apply = vi.fn().mockImplementationOnce(() => {
      throw new Error('部分写入')
    })
    expect(await restoreSnapshotSafely(steps)).toEqual({
      kind: 'failed',
      stage: 'apply',
      rollback: 'succeeded'
    })
    expect(steps.apply).toHaveBeenNthCalledWith(2, steps.current)
    expect(events).toEqual(['started', 'checkpoint_created', 'failed', 'rollback_completed'])
  })

  it('恢复后节点验证失败也回滚；回滚失败保留明确结果', async () => {
    const { steps, events } = restoreFixture()
    steps.verify = vi.fn(() => {
      throw new Error('节点丢失')
    })
    expect(await restoreSnapshotSafely(steps)).toEqual({
      kind: 'failed',
      stage: 'apply',
      rollback: 'failed'
    })
    expect(steps.apply).toHaveBeenCalledTimes(2)
    expect(events.at(-1)).toBe('rollback_failed')
  })

  it('版本验证失败不创建检查点或进入加载', async () => {
    const { steps } = restoreFixture()
    steps.prepare = () => {
      throw new Error('非法快照')
    }
    expect(await restoreSnapshotSafely(steps)).toEqual({
      kind: 'failed',
      stage: 'validation',
      rollback: 'not-needed'
    })
    expect(steps.listAvailableMedia).not.toHaveBeenCalled()
    expect(steps.apply).not.toHaveBeenCalled()
  })

  it('日志上报失败不改变恢复结果', async () => {
    const { steps } = restoreFixture()
    steps.observe = () => {
      throw new Error('logger离线')
    }
    expect(await restoreSnapshotSafely(steps)).toEqual({ kind: 'restored' })
  })
})

describe('恢复后验证', () => {
  it.each(['text', 'config', 'media', 'binding', 'arrow'] as const)(
    '拒绝节点ID相同但%s丢失或变更的恢复结果',
    (field) => {
      const expected: { store: Record<string, any> } = makeSnapshot(['a'])
      expected.store['shape:node-0'].props.text = 'saved text'
      expected.store['shape:node-0'].props.config = '{"operation":"pick","path":"saved"}'
      expected.store['shape:edge'] = {
        id: 'shape:edge',
        type: 'arrow',
        meta: { fromPort: 'out-image', toPort: 'in-image' }
      }
      expected.store['binding:edge'] = {
        id: 'binding:edge',
        typeName: 'binding',
        type: 'arrow',
        fromId: 'shape:edge',
        toId: 'shape:node-0'
      }
      const actual = JSON.parse(JSON.stringify(expected))
      if (field === 'text') actual.store['shape:node-0'].props.text = 'wrong text'
      if (field === 'config') actual.store['shape:node-0'].props.config = '{}'
      if (field === 'media') actual.store['shape:node-0'].props.mediaId = 'wrong-media'
      if (field === 'binding') delete actual.store['binding:edge']
      if (field === 'arrow') actual.store['shape:edge'].meta.toPort = 'wrong-port'
      expect(() => verifyRestoredSnapshot(expected, actual)).toThrow('不一致')
    }
  )

  it('忽略会话状态和对象键顺序，保留文档内容验证', () => {
    const expected = makeSnapshot(['a'])
    const actual = JSON.parse(JSON.stringify(expected))
    actual.store['instance:session'] = { typeName: 'instance', selectedShapeIds: ['shape:node-0'] }
    actual.store['shape:node-0'].props = Object.fromEntries(
      Object.entries(actual.store['shape:node-0'].props).reverse()
    )
    expect(() => verifyRestoredSnapshot(expected, actual)).not.toThrow()
  })

  it('同ID正文恢复错误时触发真实验证并回滚到检查点', async () => {
    const { steps, events } = restoreFixture()
    let loaded: unknown = steps.current
    let calls = 0
    steps.apply = (snapshot) => {
      loaded = JSON.parse(JSON.stringify(snapshot))
      if (++calls === 1) (loaded as any).store['shape:node-0'].props.mediaId = 'wrong-restoration'
    }
    steps.verify = (expected) => verifyRestoredSnapshot(expected, loaded)
    expect(await restoreSnapshotSafely(steps)).toEqual({
      kind: 'failed',
      stage: 'apply',
      rollback: 'succeeded'
    })
    expect(loaded).toEqual(steps.current)
    expect(events).toEqual(['started', 'checkpoint_created', 'failed', 'rollback_completed'])
  })
  it('允许恢复有意保存的空画布，不能丢掉非空版本的节点', () => {
    expect(() => verifyRestoredSnapshot(makeSnapshot([]), makeSnapshot([]))).not.toThrow()
    expect(() => verifyRestoredSnapshot(makeSnapshot(['a']), makeSnapshot([]))).toThrow('不一致')
    expect(() => verifyRestoredSnapshot({}, makeSnapshot([]))).toThrow('缺少')
  })
})

describe('diffSnapshotMedia', () => {
  it('按可用集合划分 available / missing', () => {
    const r = diffSnapshotMedia(['a', 'b', 'c'], new Set(['a', 'c']))
    expect(r.available).toEqual(['a', 'c'])
    expect(r.missing).toEqual(['b'])
  })
})

describe('checkSnapshotMedia', () => {
  it('完整流程：快照引用 3 个媒体，其中 1 个缺失', () => {
    const r = checkSnapshotMedia(makeSnapshot(['ok1', 'gone', 'ok2']), new Set(['ok1', 'ok2']))
    expect(r.available).toEqual(['ok1', 'ok2'])
    expect(r.missing).toEqual(['gone'])
  })
})
