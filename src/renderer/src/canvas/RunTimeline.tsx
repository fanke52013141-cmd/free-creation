import { useEffect, useState } from 'react'

type TimelineEntry = import('@shared/observability').DiagnosticsEvent

/**
 * L05：按根 trace 拉取独立诊断事件并渲染阶段时间线。
 * 查询失败或无事件显示「诊断记录不完整」，绝不显示为成功；不解析中文 message。
 */
export function RunTimeline({ traceId }: { traceId: string }): React.JSX.Element {
  // state 携带其所属 traceId：切换 trace 的新渲染按 traceId 不匹配直接视为加载中，
  // 避免 effect 内同步 setState（react-hooks/set-state-in-effect）。
  const [state, setState] = useState<{
    traceId: string
    entries: TimelineEntry[] | null
    incomplete: string | null
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api
      .queryDiagnostics({ traceId, limit: 200 })
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setState({ traceId, entries: null, incomplete: `诊断事件不可用：${result.error.code}` })
          return
        }
        const warnings: string[] = []
        if (result.data.truncated) warnings.push('仅显示前 200 条匹配事件，后续事件已截断')
        if (result.data.badLines > 0)
          warnings.push(`跳过 ${result.data.badLines} 条损坏记录（可能非正常退出）`)
        const incomplete = warnings.join('；') || null
        setState({ traceId, entries: result.data.events, incomplete })
      })
      .catch(() => {
        if (!cancelled) setState({ traceId, entries: null, incomplete: '诊断事件读取失败' })
      })
    return () => {
      cancelled = true
    }
  }, [traceId])

  const current = state && state.traceId === traceId ? state : null
  const incomplete = current?.incomplete ?? null
  const entries: TimelineEntry[] = current?.entries ?? []
  if (current === null) {
    return (
      <div className="run-timeline">
        <small>读取诊断事件…</small>
      </div>
    )
  }
  return (
    <div className="run-timeline">
      {incomplete && (
        <small className="run-timeline-incomplete">诊断记录不完整：{incomplete}</small>
      )}
      {entries.length === 0 && !incomplete && (
        <small className="run-timeline-incomplete">
          独立诊断事件未覆盖或已按保留策略清理（节点摘要仍可见）
        </small>
      )}
      <ol>
        {entries.map((event, index) => (
          <li key={event.eventId ?? index} className={`run-timeline-item level-${event.level}`}>
            <small>
              {(event.timestamp ?? '').slice(11, 23)} · {event.event}
              {event.nodeId ? ` · ${event.nodeId}` : ''}
              {event.requestId ? ` · ${event.requestId}` : ''}
            </small>
            <span>{event.message}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
