// 可注入时钟：测试控制批量写时机与轮转日期，不依赖真实等待。
export interface DiagnosticsClock {
  nowMs(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export function systemClock(): DiagnosticsClock {
  return {
    nowMs: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}

/** 手动时钟：测试里用 advance() 驱动定时器。 */
export function manualClock(startMs = 0): DiagnosticsClock & {
  advance(ms: number): void
  currentMs(): number
} {
  let now = startMs
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let nextId = 1
  return {
    nowMs: () => now,
    currentMs: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++
      timers.push({ at: now + ms, fn, id })
      return id
    },
    clearTimeout: (handle) => {
      const index = timers.findIndex((timer) => timer.id === handle)
      if (index >= 0) timers.splice(index, 1)
    },
    advance(ms: number) {
      now += ms
      const due = timers.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at)
      for (const timer of due) {
        const index = timers.findIndex((item) => item.id === timer.id)
        if (index >= 0) timers.splice(index, 1)
        timer.fn()
      }
    }
  }
}
