// T04（F01）：项目保存协调器。把「修改序号 + 在途合并 + 状态呈现」从 CanvasEditor
// 的散落 ref（saveTimerRef/graphVersionRef/restoreFailedRef）收进一个可单测的状态机。
//
// 不变量（test/save-coordinator.test.ts 逐条固化）：
// ① 同项目同时最多 1 个在途保存事务；在途期间的编辑在事务结束后自动补发保存。
// ② 旧响应（出发序号 ≤ 已确认序号）只做 max 合并，不得把较新的 dirty 标成已保存。
// ③ failed 状态持续保持（markDirty 不清除失败展示），直到一次成功保存或 reset。
// ④ REVISION_CONFLICT 交给注入的 onConflict（渲染层重载），协调器停在 dirty 等 reset，
//    绝不显示「已保存」。
import { create } from 'zustand'

export type SavePhase = 'saved' | 'dirty' | 'saving' | 'failed' | 'paused'

export interface SaveCoordinatorState {
  phase: SavePhase
  /** 本地修改序号：每次 markDirty 自增。 */
  dirtyVersion: number
  /** 已确认落盘的修改序号（多来源确认取 max，见不变量②）。 */
  persistedVersion: number
  /** 最近一次成功保存时间（ms epoch）；从未保存过为 null。 */
  lastSavedAt: number | null
  /** 最近一次失败/冲突原因（呈现用；成功或 reset 后清空）。 */
  lastError: string | null
}

export interface SaveCoordinatorDeps {
  /**
   * 实际保存：读取当前最新状态发起请求。resolve 的 graphVersion 是磁盘新版本号，
   * 仅作诊断记录；确认哪个修改序号以事务出发时的 savingFrom 为准。
   */
  save: (savingFrom: number) => Promise<{ graphVersion: number }>
  /** REVISION_CONFLICT 时调用；协调器随后停在 dirty 等待 reset。 */
  onConflict: () => void
  /** 其他失败时调用（toast 等）。 */
  onFailure: (error: { code?: string; message?: string }) => void
  onSuccess?: () => void
}

interface SaveCoordinatorActions {
  /** 注册保存依赖；必须在首次 markDirty/flush 前调用。 */
  bind: (deps: SaveCoordinatorDeps) => void
  /** 本地发生修改（防抖由调用方做）：dirtyVersion+1；failed 展示保持（不变量③）。 */
  markDirty: () => void
  /** 立即发起保存；在途中调用为无操作（编辑已由 dirty 序号承载，结束后自动补发）。 */
  flush: () => Promise<void>
  /** 重载/初始化完成：以磁盘版本号重置基线。 */
  reset: (persistedVersion: number) => void
  /** 进入/退出暂停（restoreFailed 期间不保存）。 */
  setPaused: (paused: boolean) => void
}

interface CoordinatorInternal extends SaveCoordinatorState, SaveCoordinatorActions {
  inFlight: boolean
  /** 当前在途事务出发时的 dirtyVersion 快照（响应归属判定用）。 */
  savingFrom: number
  deps: SaveCoordinatorDeps | null
}

const idlePhaseAfter = (
  s: Pick<CoordinatorInternal, 'dirtyVersion' | 'persistedVersion' | 'lastError' | 'deps'>,
  wasFailed: boolean
): SavePhase => {
  if (s.dirtyVersion > s.persistedVersion) return 'dirty'
  if (wasFailed && s.lastError !== null) return 'failed'
  return 'saved'
}

export const useSaveCoordinator = create<CoordinatorInternal>((set, get) => {
  const runSave = async (): Promise<void> => {
    const state = get()
    const deps = state.deps
    if (!deps || state.inFlight || state.phase === 'paused') return
    if (state.dirtyVersion === state.persistedVersion && state.phase !== 'failed') {
      if (state.phase !== 'saving') set({ phase: idlePhaseAfter(state, false) })
      return
    }
    // failed 重试：dirty 可能等于 persisted，但失败展示要求至少再成功一次才回 saved。
    const savingFrom = state.dirtyVersion
    set({ inFlight: true, phase: 'saving', savingFrom, lastError: state.lastError })
    try {
      // graphVersion 由 save 返回但仅作诊断；序号确认以 savingFrom 为准（见头注）。
      await deps.save(savingFrom)
      // 不变量②：旧响应只做 max 合并；磁盘版本回退不拉低已确认序号。
      set((s) => ({
        persistedVersion: Math.max(s.persistedVersion, savingFrom),
        lastSavedAt: Date.now(),
        lastError: null
      }))
      const after = get()
      if (after.dirtyVersion > after.persistedVersion) {
        // 不变量①：在途期间的编辑合并为下一次保存，自动补发。
        set({ inFlight: false })
        void runSave()
        return
      }
      set({ inFlight: false, phase: 'saved' })
      deps.onSuccess?.()
    } catch (error) {
      set({ inFlight: false })
      const err = error as { code?: string; message?: string }
      if (err?.code === 'REVISION_CONFLICT') {
        set({ phase: 'dirty', lastError: '外部有更新的修改' })
        deps.onConflict()
        return
      }
      set({ phase: 'failed', lastError: err?.message ?? String(error) })
      deps.onFailure(err ?? {})
    }
  }

  return {
    phase: 'saved',
    dirtyVersion: 0,
    persistedVersion: 0,
    lastSavedAt: null,
    lastError: null,
    inFlight: false,
    savingFrom: -1,
    deps: null,

    bind: (deps) => set({ deps }),
    markDirty: () =>
      set((s) => ({
        dirtyVersion: s.dirtyVersion + 1,
        // 不变量③：failed 期间的新编辑不掩盖「上次保存失败」的展示。
        phase: s.phase === 'paused' ? 'paused' : s.phase === 'failed' ? 'failed' : 'dirty'
      })),
    flush: async () => {
      await runSave()
    },
    reset: (persistedVersion) =>
      set({ persistedVersion, dirtyVersion: persistedVersion, phase: 'saved', lastError: null }),
    setPaused: (paused) =>
      set((s) => ({
        phase: paused ? 'paused' : s.dirtyVersion > s.persistedVersion ? 'dirty' : 'saved'
      }))
  }
})
