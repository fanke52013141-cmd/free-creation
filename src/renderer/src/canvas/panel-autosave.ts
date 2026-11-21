import { useCallback, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'

interface PanelDraftState {
  /** 面板里尚未写入节点的编辑控件数（防抖窗口内或 IME 组词中）。 */
  pending: number
  begin: () => void
  end: () => void
}

/** 「已保存」指示的数据源之一：有未落盘草稿时面板显示“输入中…”。 */
export const usePanelDraftPending = create<PanelDraftState>((set) => ({
  pending: 0,
  begin: () => set((state) => ({ pending: state.pending + 1 })),
  end: () => set((state) => ({ pending: Math.max(0, state.pending - 1) }))
}))

const DEFAULT_DELAY_MS = 600

export interface PanelAutosaveField {
  value: string
  onChange: (event: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => void
  onBlur: () => void
  onCompositionStart: () => void
  onCompositionEnd: (
    event: React.CompositionEvent<HTMLTextAreaElement | HTMLInputElement>
  ) => void
  /** 立即把未写入的草稿提交给节点；blur 与组件卸载时 hook 会自动调用。 */
  flush: () => void
}

/**
 * 侧边面板字段的实时保存：受控草稿 + 防抖写入节点 + 失焦/卸载强制落盘。
 *
 * 背景（2026-11-21 用户反馈）：面板的 X/Esc/点击外部/切换节点不会让输入框失焦，
 * `defaultValue + onBlur` 控件的草稿直接丢失。统一约定：
 * - 每次输入防抖写入 `editor.updateShape`（落盘仍由 save-coordinator 800ms 防抖负责）；
 * - blur 与组件卸载立即写入，任何关闭路径都不再丢字；
 * - 中文输入法组词期间只保留本地草稿（避免拼音上屏被打断），组词结束立即写入；
 * - 每次提交是防抖会话粒度的一个撤销步，不会每键一条历史；
 * - 撤销/重做/外部写入（值不是本控件刚写的）会回灌草稿，与画布保持一致。
 */
export function usePanelAutosave(
  externalValue: string,
  commit: (value: string) => void,
  options?: { delay?: number }
): PanelAutosaveField {
  const delay = options?.delay ?? DEFAULT_DELAY_MS
  const [value, setValue] = useState(externalValue)
  // 最近一次写回节点的值：外部值只有确实不同（撤销/重做/Agent 写入）才回灌草稿。
  const lastSentRef = useRef(externalValue)
  const pendingRef = useRef<string | null>(null)
  const registeredRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const composingRef = useRef(false)
  const commitRef = useRef(commit)
  const externalValueRef = useRef(externalValue)
  // ref 同步放在渲染后的 effect 里（react-hooks/refs 禁止渲染期访问 ref）；
  // 离散事件（输入/blur/定时器）触发前 React 会先冲刷被动 effect，读到的一定是最新值。
  useEffect(() => {
    commitRef.current = commit
    externalValueRef.current = externalValue
  })

  const settle = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (!registeredRef.current) return
    registeredRef.current = false
    pendingRef.current = null
    usePanelDraftPending.getState().end()
  }, [])

  const write = useCallback(
    (next: string): void => {
      settle()
      if (next === externalValueRef.current) return
      lastSentRef.current = next
      commitRef.current(next)
    },
    [settle]
  )

  const flush = useCallback((): void => {
    if (pendingRef.current !== null) write(pendingRef.current)
  }, [write])

  const schedule = useCallback(
    (next: string): void => {
      pendingRef.current = next
      if (!registeredRef.current) {
        registeredRef.current = true
        usePanelDraftPending.getState().begin()
      }
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => write(pendingRef.current ?? next), delay)
    },
    [delay, write]
  )

  // 外部真值变化：不是本控件刚写的值才回灌草稿，保持与画布/撤销一致。
  useEffect(() => {
    if (externalValue === lastSentRef.current) return
    lastSentRef.current = externalValue
    settle()
    setValue(externalValue)
  }, [externalValue, settle])

  // 卸载前强制落盘：面板关闭/切换 tab/切换节点不触发 blur，这里兜底。
  useEffect(() => {
    return () => {
      if (pendingRef.current !== null) {
        const next = pendingRef.current
        pendingRef.current = null
        if (next !== externalValueRef.current) commitRef.current(next)
      }
      if (registeredRef.current) {
        registeredRef.current = false
        usePanelDraftPending.getState().end()
      }
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [settle])

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>): void => {
      const next = event.currentTarget.value
      setValue(next)
      if (composingRef.current) return
      schedule(next)
    },
    [schedule]
  )

  const onBlur = useCallback((): void => {
    if (composingRef.current) return
    flush()
  }, [flush])

  const onCompositionStart = useCallback((): void => {
    composingRef.current = true
    // 组词中的拼音也是未落盘草稿，指示器要如实显示。
    if (!registeredRef.current) {
      registeredRef.current = true
      usePanelDraftPending.getState().begin()
    }
  }, [])

  const onCompositionEnd = useCallback(
    (event: React.CompositionEvent<HTMLTextAreaElement | HTMLInputElement>): void => {
      composingRef.current = false
      const next = event.currentTarget.value
      setValue(next)
      // 组词结束立即写入，不等待防抖。
      write(next)
    },
    [write]
  )

  return { value, onChange, onBlur, onCompositionStart, onCompositionEnd, flush }
}
