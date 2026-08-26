// 工作流执行引擎状态（Zustand）。
// 持有运行进度、错误汇总，以及由 CanvasEditor 注册的 run/stop 闭包——
// 顶部工具栏通过此 store 触发执行，无需直接访问 editor（editor 生命周期由 CanvasEditor 管）。
import { create } from 'zustand'

export type EnginePhase = 'idle' | 'running' | 'stopping'

/** 错误发生的阶段 */
export type ErrorPhase = 'input' | 'execution' | 'output'

export interface RunError {
  label: string
  reason: string
  /** 出错节点的 shape ID（用于诊断定位） */
  nodeId?: string
  /** 错误阶段：输入校验 / 执行过程 / 输出校验 */
  phase?: ErrorPhase
  /** 时间戳（ms） */
  timestamp: number
}

interface EngineState {
  phase: EnginePhase
  total: number
  done: number
  currentLabel: string
  errors: RunError[]
  /** CanvasEditor 挂载时注册、卸载时清空（捕获 editor + projectId 闭包） */
  run: (() => void) | null
  /** runWorkflow 启动时注册 cancel 令牌、结束时清空 */
  stop: (() => void) | null
  register: (run: (() => void) | null) => void
  setStop: (stop: (() => void) | null) => void
  beginRun: (total: number) => void
  setCurrent: (label: string) => void
  nodeDone: () => void
  addError: (label: string, reason: string, detail?: { nodeId?: string; phase?: ErrorPhase }) => void
  setStopping: () => void
  endRun: () => void
}

export const useEngineStore = create<EngineState>((set) => ({
  phase: 'idle',
  total: 0,
  done: 0,
  currentLabel: '',
  errors: [],
  run: null,
  stop: null,
  register: (run) => set({ run }),
  setStop: (stop) => set({ stop }),
  beginRun: (total) => set({ phase: 'running', total, done: 0, currentLabel: '', errors: [] }),
  setCurrent: (label) => set({ currentLabel: label }),
  nodeDone: () => set((s) => ({ done: s.done + 1 })),
  addError: (label, reason, detail) =>
    set((s) => ({
      errors: [
        ...s.errors,
        {
          label,
          reason,
          nodeId: detail?.nodeId,
          phase: detail?.phase,
          timestamp: Date.now()
        }
      ]
    })),
  setStopping: () => set({ phase: 'stopping' }),
  endRun: () => set({ phase: 'idle', currentLabel: '' })
}))
