// 工作流执行引擎状态（Zustand）。
// 持有运行进度、错误汇总，以及由 CanvasEditor 注册的 run/stop 闭包——
// 顶部工具栏通过此 store 触发执行，无需直接访问 editor（editor 生命周期由 CanvasEditor 管）。
import { create } from 'zustand'
import type { RunLogEntry } from '@shared/contracts'
import { sanitizeRunError } from '@shared/sanitize'

export type EnginePhase = 'idle' | 'running' | 'stopping'

/** 错误发生的阶段 */
export type ErrorPhase = 'input' | 'execution' | 'output' | 'topology' | 'timeout'

export interface RunError {
  label: string
  reason: string
  /** 出错节点的 shape ID（用于诊断定位） */
  nodeId?: string
  /** 出错端口 ID */
  portId?: string
  /** 错误阶段：输入校验 / 执行过程 / 输出校验 / 拓扑 */
  phase?: ErrorPhase
  /** 节点类型（诊断用） */
  nodeType?: string
  /** 节点契约版本（诊断用） */
  contractVersion?: number
  /** 所属运行的唯一 ID（区分每次全局运行） */
  runId?: string
  /** 时间戳（ms） */
  timestamp: number
}

/** addError 的附加诊断信息 */
export interface AddErrorDetail {
  nodeId?: string
  portId?: string
  phase?: ErrorPhase
  nodeType?: string
  contractVersion?: number
  runId?: string
}

interface EngineState {
  phase: EnginePhase
  total: number
  done: number
  currentLabel: string
  errors: RunError[]
  /** 每轮全局运行自增；UI 据此派生"新一轮运行重置面板可见性"，无需在 effect 里 setState */
  runSeq: number
  /** CanvasEditor 挂载时注册、卸载时清空（捕获 editor + projectId 闭包） */
  run: (() => void) | null
  /** runWorkflow 启动时注册 cancel 令牌、结束时清空 */
  stop: (() => void) | null
  register: (run: (() => void) | null) => void
  setStop: (stop: (() => void) | null) => void
  beginRun: (total: number) => void
  setCurrent: (label: string) => void
  nodeDone: () => void
  addError: (label: string, reason: string, detail?: AddErrorDetail) => void
  setStopping: () => void
  endRun: () => void
}

/** 当前运行的 runId（非 Zustand 状态，模块级变量，供 addError 引用） */
let currentRunId: string | undefined

export function setRunId(id: string | undefined): void {
  currentRunId = id
}

/**
 * 把错误条目脱敏后 fire-and-forget 发送到主进程落盘。
 * window.api 可能在测试环境不存在，安全跳过。
 */
function reportToLog(entry: RunError): void {
  try {
    const safe = sanitizeRunError(entry)
    const logEntry: RunLogEntry = {
      label: safe.label,
      reason: safe.reason,
      nodeId: safe.nodeId,
      portId: safe.portId,
      phase: safe.phase,
      nodeType: safe.nodeType,
      contractVersion: safe.contractVersion,
      runId: safe.runId,
      timestamp: safe.timestamp
    }
    window.api?.log?.write(logEntry)
  } catch {
    // 日志上报失败不应影响运行流程
  }
}

export const useEngineStore = create<EngineState>((set) => ({
  phase: 'idle',
  total: 0,
  done: 0,
  currentLabel: '',
  errors: [],
  runSeq: 0,
  run: null,
  stop: null,
  register: (run) => set({ run }),
  setStop: (stop) => set({ stop }),
  beginRun: (total) =>
    set((s) => ({
      phase: 'running',
      total,
      done: 0,
      currentLabel: '',
      errors: [],
      runSeq: s.runSeq + 1
    })),
  setCurrent: (label) => set({ currentLabel: label }),
  nodeDone: () => set((s) => ({ done: s.done + 1 })),
  addError: (label, reason, detail) => {
    const entry: RunError = {
      label,
      reason,
      nodeId: detail?.nodeId,
      portId: detail?.portId,
      phase: detail?.phase,
      nodeType: detail?.nodeType,
      contractVersion: detail?.contractVersion,
      runId: detail?.runId ?? currentRunId,
      timestamp: Date.now()
    }
    reportToLog(entry)
    set((s) => ({ errors: [...s.errors, entry] }))
  },
  setStopping: () => set({ phase: 'stopping' }),
  endRun: () => set({ phase: 'idle', currentLabel: '' })
}))
