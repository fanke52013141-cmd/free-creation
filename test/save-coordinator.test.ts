// @vitest-environment jsdom
// T04（F01）：保存协调器状态机。固化四条不变量：
// ① 在途合并 ② 旧响应不误标 ③ failed 持续到成功 ④ 冲突交渲染层且不显示已保存。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSaveCoordinator } from '@renderer/stores/save-coordinator'

interface Deferred {
  resolve: (v: { graphVersion: number }) => void
  reject: (e: { code?: string; message?: string }) => void
  promise: Promise<{ graphVersion: number }>
}

const deferred = (): Deferred => {
  let resolve!: Deferred['resolve']
  let reject!: Deferred['reject']
  const promise = new Promise<{ graphVersion: number }>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { resolve, reject, promise }
}

const resetStore = (): void => {
  useSaveCoordinator.setState({
    phase: 'saved',
    dirtyVersion: 0,
    persistedVersion: 0,
    lastSavedAt: null,
    lastError: null,
    inFlight: false,
    flushPending: false,
    savingFrom: -1,
    deps: null
  })
}

describe('SaveCoordinator · 不变量①（在途合并，最多一个事务）', () => {
  beforeEach(resetStore)

  it('保存期间继续编辑：在途事务完成后自动补发保存新版本', async () => {
    const first = deferred()
    const calls: number[] = []
    const save = vi.fn((from: number) => {
      calls.push(from)
      return from === 1 ? first.promise : Promise.resolve({ graphVersion: from })
    })
    useSaveCoordinator
      .getState()
      .bind({ save, onConflict: () => undefined, onFailure: () => undefined })

    useSaveCoordinator.getState().markDirty() // v1
    const p1 = useSaveCoordinator.getState().flush()
    expect(useSaveCoordinator.getState().inFlight).toBe(true)

    useSaveCoordinator.getState().markDirty() // v2（在途期间编辑）
    first.resolve({ graphVersion: 1 })
    await p1
    // 第一次保存只带 v1；完成后发现 v2 待存，自动再发
    await vi.waitFor(() => expect(calls).toEqual([1, 2]))
    expect(useSaveCoordinator.getState().phase).toBe('saved')
    expect(useSaveCoordinator.getState().persistedVersion).toBe(2)
  })

  it('在途中再次 flush（无新编辑）不产生并发事务，也无需重复保存', async () => {
    const first = deferred()
    const save = vi.fn(() => first.promise)
    useSaveCoordinator
      .getState()
      .bind({ save, onConflict: () => undefined, onFailure: () => undefined })
    useSaveCoordinator.getState().markDirty()
    const p1 = useSaveCoordinator.getState().flush()
    void useSaveCoordinator.getState().flush() // 在途中的第二次 flush
    expect(save).toHaveBeenCalledTimes(1)
    first.resolve({ graphVersion: 1 })
    await p1
    await new Promise((r) => setTimeout(r, 10))
    // 没有新修改：补发无意义，单事务完成即 saved
    expect(save).toHaveBeenCalledTimes(1)
    expect(useSaveCoordinator.getState().phase).toBe('saved')
  })
})

describe('SaveCoordinator · 不变量②（旧响应不误标已保存）', () => {
  beforeEach(resetStore)

  it('磁盘版本号回退的旧确认不得把较新的 dirty 标成 saved', async () => {
    // 场景：保存 A(v1) 在途 → reset（重载，persisted=5）+ 新修改 v6 → A 响应迟到 →
    // 补发保存 v6（挂起中）。此刻不得显示已保存。
    const first = deferred()
    const second = deferred()
    const save = vi.fn((from: number) => (from === 1 ? first.promise : second.promise))
    useSaveCoordinator
      .getState()
      .bind({ save, onConflict: () => undefined, onFailure: () => undefined })
    useSaveCoordinator.getState().markDirty() // v1
    const p1 = useSaveCoordinator.getState().flush()
    // 在途期间发生重载：基线被外部推进，随后本地又有新修改
    useSaveCoordinator.getState().reset(5)
    useSaveCoordinator.getState().markDirty() // v6
    first.resolve({ graphVersion: 1 }) // 旧事务响应迟到
    await p1
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2)) // 自动补发 v6
    const s = useSaveCoordinator.getState()
    expect(s.phase).toBe('saving') // v6 仍在保存，绝不是 saved
    expect(s.dirtyVersion).toBe(6)
    expect(s.persistedVersion).toBe(5) // 旧确认没有推进序号
  })
})

describe('SaveCoordinator · 不变量③（failed 持续到成功）', () => {
  beforeEach(resetStore)

  it('保存失败进入 failed 并保留原因；成功后清除', async () => {
    let fail = true
    const onFailure = vi.fn()
    const save = vi.fn(() =>
      fail
        ? Promise.reject({ code: 'SAVE_FAILED', message: '磁盘已满' })
        : Promise.resolve({ graphVersion: 2 })
    )
    useSaveCoordinator.getState().bind({ save, onConflict: () => undefined, onFailure })
    useSaveCoordinator.getState().markDirty()
    await useSaveCoordinator.getState().flush()
    let s = useSaveCoordinator.getState()
    expect(s.phase).toBe('failed')
    expect(s.lastError).toBe('磁盘已满')
    expect(onFailure).toHaveBeenCalledOnce()

    // markDirty 不清除 failed 展示；再次 flush 成功才回 saved
    useSaveCoordinator.getState().markDirty()
    expect(useSaveCoordinator.getState().phase).toBe('failed') // 仍显示失败
    fail = false
    await useSaveCoordinator.getState().flush()
    s = useSaveCoordinator.getState()
    expect(s.phase).toBe('saved')
    expect(s.lastError).toBeNull()
    expect(s.lastSavedAt).not.toBeNull()
  })
})

describe('SaveCoordinator · 不变量④（冲突走渲染层，不显示已保存）', () => {
  beforeEach(resetStore)

  it('REVISION_CONFLICT 回调 onConflict，phase 停在 dirty 等 reset', async () => {
    const onConflict = vi.fn()
    const save = vi.fn(() => Promise.reject({ code: 'REVISION_CONFLICT' }))
    useSaveCoordinator.getState().bind({ save, onConflict, onFailure: () => undefined })
    useSaveCoordinator.getState().markDirty()
    await useSaveCoordinator.getState().flush()
    const s = useSaveCoordinator.getState()
    expect(onConflict).toHaveBeenCalledOnce()
    expect(s.phase).toBe('dirty')
    expect(s.phase).not.toBe('saved')
    // 重载完成后 reset 恢复正常
    useSaveCoordinator.getState().reset(9)
    expect(useSaveCoordinator.getState().phase).toBe('saved')
  })

  it('paused（恢复失败）期间 flush 不发起保存', async () => {
    const save = vi.fn(() => Promise.resolve({ graphVersion: 1 }))
    useSaveCoordinator
      .getState()
      .bind({ save, onConflict: () => undefined, onFailure: () => undefined })
    useSaveCoordinator.getState().setPaused(true)
    useSaveCoordinator.getState().markDirty()
    await useSaveCoordinator.getState().flush()
    expect(save).not.toHaveBeenCalled()
    expect(useSaveCoordinator.getState().phase).toBe('paused')
    useSaveCoordinator.getState().setPaused(false)
    expect(useSaveCoordinator.getState().phase).toBe('dirty') // 有待存修改则回 dirty
  })
})
