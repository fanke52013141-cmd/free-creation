// 画布右侧抽屉面板：资产中心 / 节点库 / 历史记录（LibTV 侧栏入口落地）
// 资产中心：项目级媒体库——导入/搜索/筛选/缩略图预览/点击拖到画布/删除
// 节点库：列出用户保存的单节点或多节点组合，并允许搜索、添加和删除。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import type { MediaAsset } from '@shared/types'
import type { NodeCardShape } from './NodeCardShape'
import {
  buildRunIndex,
  filterRunIndex,
  type IndexedNodeRun,
  type RunStatusFilter
} from '../engine/run-index'
import { runNodeManually } from '../engine/executor'
import { useGatewayStore } from '../stores/gateway'
import { useWorkflowStore, type WorkflowTemplate } from '../stores/workflow'
import { addNodeLibraryEntry } from './node-library'
import { markUndoPoint } from './history'
import { toast } from '../stores/toast'
import { useConfirmStore } from '../stores/confirm'
import { mapRunError, statusText } from '../engine/error-mapping'
import {
  restoreSnapshotSafely,
  snapshotNodeCount,
  verifyRestoredSnapshot
} from './snapshot-restore'
import { DiagnosticsProducer, newProducerId, newSpanId, newTraceId } from '@shared/observability'
import { emitDiagnosticsEvent } from '../engine/diagnosticsReporter'
import { useHistorySnapshots, type HistorySnapshot } from '../stores/history-snapshots'
import { Icon, type IconName } from '../components/Icon'
import { AppSelect } from '../components/AppSelect'
import { AssetsPanel } from './side-panel/AssetsPanel'

export type SidePanelTab = 'assets' | 'workflow' | 'history' | 'runs'

interface CanvasSidePanelProps {
  tab: SidePanelTab | null
  projectId: string
  editor: Editor | null
  onClose: () => void
  onImport: () => void
  onAddToCanvas: (asset: MediaAsset) => void
  onOpenRuns: () => void
}

const TAB_META: Record<SidePanelTab, { title: string; icon: IconName }> = {
  assets: { title: '资产中心', icon: 'assets' },
  workflow: { title: '节点库', icon: 'workflow' },
  history: { title: '历史记录', icon: 'history' },
  runs: { title: '运行中心', icon: 'play' }
}

const RUN_CENTER_FILTERS: { key: RunStatusFilter; label: string }[] = [
  { key: 'all', label: '全部状态' },
  { key: 'running', label: '运行中' },
  { key: 'success', label: '成功' },
  { key: 'failed', label: '失败' },
  { key: 'skipped', label: '跳过' },
  { key: 'cancelled', label: '已取消' }
]

const restoreDiagnostics = new DiagnosticsProducer({
  process: 'renderer',
  producerId: newProducerId('renderer')
})

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

// ── 节点库面板 ──
function WorkflowPanel({ editor }: { editor: Editor | null }): React.JSX.Element {
  const templates = useWorkflowStore((s) => s.templates)
  const wfLoad = useWorkflowStore((s) => s.load)
  const wfRemove = useWorkflowStore((s) => s.remove)
  const [query, setQuery] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const needle = query.trim().toLocaleLowerCase()
  const visibleTemplates = templates.filter((template) =>
    [template.name, ...template.nodes.flatMap((node) => [node.title, node.nodeType])].some(
      (value) => value.toLocaleLowerCase().includes(needle)
    )
  )

  useEffect(() => {
    void wfLoad().catch((error) => toast(`加载节点库失败：${String(error)}`))
  }, [wfLoad])

  // 将节点库条目添加到画布视角中心
  const handleApply = (tmpl: WorkflowTemplate): void => {
    if (!editor) return
    const { skippedEdges } = addNodeLibraryEntry(editor, tmpl)
    toast(
      skippedEdges > 0
        ? `已从节点库添加「${tmpl.name}」，${skippedEdges} 条旧连线因端口不明确未恢复`
        : `已从节点库添加「${tmpl.name}」（${tmpl.nodes.length} 个节点）`
    )
  }

  const handleRemoveTemplate = async (tmpl: WorkflowTemplate): Promise<void> => {
    if (
      !(await useConfirmStore.getState().confirm({
        title: `删除节点库条目「${tmpl.name}」`,
        message: '删除后该节点库条目不可恢复，画布上已创建的节点不受影响。',
        confirmText: '删除',
        danger: true
      }))
    )
      return
    await wfRemove(tmpl.id).catch((error) => toast(`删除节点库条目失败：${String(error)}`))
  }

  return (
    <div className="side-panel-body workflow-panel" ref={scrollRef}>
      <label className="wf-search">
        <Icon name="search" size={16} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索节点库"
          aria-label="搜索节点库"
        />
      </label>
      {templates.length === 0 ? (
        <div className="side-panel-empty">
          节点库还是空的。右键点击画布节点，选择「保存到节点库」；也可以多选节点后使用浮动工具栏保存。
        </div>
      ) : visibleTemplates.length === 0 ? (
        <div className="side-panel-empty">没有找到匹配的节点库条目。</div>
      ) : (
        <div className="wf-template-list">
          {visibleTemplates.map((tmpl) => (
            <div key={tmpl.id} className="wf-template-card">
              <div className="wf-template-info">
                <strong className="wf-template-name">{tmpl.name}</strong>
                <span className="wf-template-meta">
                  {tmpl.nodeCount} 个节点 · {tmpl.edges.length} 条连线 ·{' '}
                  {formatTime(tmpl.createdAt)}
                </span>
              </div>
              <div className="wf-template-actions">
                <button
                  className="wf-action-btn apply"
                  aria-label={`从节点库添加 ${tmpl.name} 到画布`}
                  onClick={() => handleApply(tmpl)}
                >
                  <Icon name="add" size={13} /> 添加
                </button>
                <button
                  className="wf-action-btn delete"
                  aria-label={`删除节点库条目 ${tmpl.name}`}
                  onClick={() => void handleRemoveTemplate(tmpl)}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

type RunFocus = { nodeId: string; runId: string } | null

type TimelineEntry = import('@shared/observability').DiagnosticsEvent

/**
 * L05：按根 trace 拉取独立诊断事件并渲染阶段时间线。
 * 查询失败或无事件显示「诊断记录不完整」，绝不显示为成功；不解析中文 message。
 */
function RunTimeline({ traceId }: { traceId: string }): React.JSX.Element {
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
        const incomplete =
          result.data.badLines > 0
            ? `存在 ${result.data.badLines} 条损坏记录（可能非正常退出）`
            : result.data.events.length === 0
              ? null
              : null
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
  if (incomplete) {
    return (
      <div className="run-timeline">
        <small className="run-timeline-incomplete">诊断记录不完整：{incomplete}</small>
      </div>
    )
  }
  if (entries.length === 0) {
    return (
      <div className="run-timeline">
        <small className="run-timeline-incomplete">
          独立诊断事件未覆盖或已按保留策略清理（节点摘要仍可见）
        </small>
      </div>
    )
  }
  return (
    <div className="run-timeline">
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

function runInputSummary(run: IndexedNodeRun): string {
  const items = Object.entries(run.inputs).flatMap(([targetPort, sources]) =>
    sources.map((source) => `${source.portId} → ${targetPort}`)
  )
  return items.length > 0 ? items.join('、') : '无上游输入'
}

// ── 跨节点运行中心 ──
function RunsPanel({
  editor,
  projectId,
  focus,
  onClearFocus
}: {
  editor: Editor | null
  projectId: string
  focus: RunFocus
  onClearFocus: () => void
}): React.JSX.Element {
  const providers = useGatewayStore((s) => s.providers)
  const [status, setStatus] = useState<RunStatusFilter>('all')
  const [keyword, setKeyword] = useState('')
  const [retrying, setRetrying] = useState<string | null>(null)
  const [timelineRunId, setTimelineRunId] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const exportBundle = async (traceId: string): Promise<void> => {
    setExporting(true)
    try {
      const result = await window.api.exportDiagnosticsBundle({
        scope: { traceId },
        label: '流程诊断包（运行中心）'
      })
      if (result.ok) toast(`诊断包已导出（${result.data.totalEvents} 条事件）`)
      else if (result.error.code !== 'CANCELLED') toast(`导出失败：${result.error.message}`)
    } finally {
      setExporting(false)
    }
  }

  // 运行结束会更新 retrying 并触发重渲染，从持久化记录重建列表。
  // 画布节点数量有限，避免为这份状态快照增加额外的同步副作用。
  const entries = editor
    ? buildRunIndex(
        editor
          .getCurrentPageShapes()
          .filter((shape): shape is NodeCardShape => shape.type === 'node-card')
      )
    : []
  const visible = filterRunIndex(entries, {
    status,
    keyword,
    ...(focus ? { nodeId: focus.nodeId, runId: focus.runId } : {})
  })

  const locate = (run: IndexedNodeRun): void => {
    if (!editor) return toast('画布尚未就绪')
    const shape = editor.getShape(run.nodeId as TLShapeId)
    if (!shape || shape.type !== 'node-card') return toast('来源节点已删除或不可用')
    editor.setSelectedShapes([shape.id])
    editor.zoomToSelection({ animation: { duration: 220 } })
    toast(`已定位到「${run.nodeTitle}」`)
  }

  const retry = async (run: IndexedNodeRun): Promise<void> => {
    if (!editor) return
    const shape = editor.getShape(run.nodeId as TLShapeId)
    if (!shape || shape.type !== 'node-card') return toast('来源节点已删除或不可用')
    setRetrying(run.runId)
    try {
      await runNodeManually(editor, projectId, providers, shape.id)
    } finally {
      setRetrying(null)
    }
  }

  return (
    <div className="side-panel-body runs-panel">
      <div className="runs-toolbar">
        <input
          className="assets-search"
          placeholder="搜索节点、运行 ID 或端口…"
          aria-label="搜索运行记录"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        />
        <AppSelect
          className="runs-filter-select"
          value={status}
          onChange={(event) => setStatus(event.target.value as RunStatusFilter)}
          onPointerDown={(event) => event.stopPropagation()}
          title="按运行状态筛选"
        >
          {RUN_CENTER_FILTERS.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </AppSelect>
      </div>
      {focus && (
        <div className="runs-focus-note">
          正在查看来自资产的对应运行记录
          <button onClick={onClearFocus}>查看全部</button>
        </div>
      )}
      {visible.length === 0 ? (
        <div className="side-panel-empty">
          {entries.length === 0 ? '当前项目还没有节点运行记录。' : '没有匹配的运行记录。'}
        </div>
      ) : (
        <div className="runs-list">
          {visible.map((run) => (
            <article className={`run-card ${run.status}`} key={`${run.nodeId}:${run.runId}`}>
              <div className="run-card-head">
                <div>
                  <strong>{run.nodeTitle}</strong>
                  <small>
                    {run.nodeType} · {formatTime(run.startedAt)}
                    {run.isLatest ? ' · 最近' : ''}
                  </small>
                </div>
                <span className={`run-status ${run.status}`}>{statusText(run.status)}</span>
              </div>
              <small className="run-id">{run.runId}</small>
              <p className="run-inputs">输入：{runInputSummary(run)}</p>
              {run.outputPorts && (
                <p className="run-outputs">输出：{run.outputPorts.join('、') || '无'}</p>
              )}
              {(() => {
                const guidance = mapRunError(run.status, run.error)
                return guidance ? (
                  <div className="run-error">
                    <p>
                      {guidance.stage}：{guidance.reason}
                    </p>
                    <p className="run-error-action">{guidance.action}</p>
                  </div>
                ) : null
              })()}
              {run.traceId && (
                <div className="run-card-actions">
                  <button
                    onClick={() => setTimelineRunId(timelineRunId === run.runId ? null : run.runId)}
                  >
                    <Icon name="history" size={12} />
                    {timelineRunId === run.runId ? '收起时间线' : '流程时间线'}
                  </button>
                  <button
                    disabled={exporting}
                    onClick={() => {
                      if (run.traceId) void exportBundle(run.traceId)
                    }}
                  >
                    <Icon name="download" size={12} />
                    {exporting ? '导出中…' : '导出诊断包'}
                  </button>
                </div>
              )}
              {timelineRunId === run.runId && run.traceId && <RunTimeline traceId={run.traceId} />}
              <div className="run-card-actions">
                <button onClick={() => locate(run)}>
                  <Icon name="target" size={12} /> 回到节点
                </button>
                {run.status === 'failed' && (
                  <button disabled={retrying !== null} onClick={() => void retry(run)}>
                    <Icon name="reset" size={12} />
                    {retrying === run.runId ? '重试中…' : '重试节点'}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {entries.length > 0 && <div className="assets-footer">共 {visible.length} 条运行记录</div>}
    </div>
  )
}

// ── 历史版本面板 ──
function HistoryPanel({
  projectId,
  editor
}: {
  projectId: string
  editor: Editor | null
}): React.JSX.Element {
  const snapshots = useHistorySnapshots((s) => s.snapshots)
  const load = useHistorySnapshots((s) => s.load)
  const add = useHistorySnapshots((s) => s.add)
  const remove = useHistorySnapshots((s) => s.remove)
  const [label, setLabel] = useState('')
  const [restoring, setRestoring] = useState(false)
  const restoreBusy = useRef(false)
  const restoreContext = useRef({ projectId, editor, mounted: true })
  useLayoutEffect(() => {
    restoreContext.current = { projectId, editor, mounted: true }
    return () => {
      restoreContext.current.mounted = false
    }
  }, [projectId, editor])

  useEffect(() => {
    void load(projectId).catch((error) => toast(`加载历史版本失败：${String(error)}`))
  }, [projectId, load])

  // 保存当前画布状态为版本快照
  const handleSave = async (): Promise<void> => {
    if (!editor || restoreBusy.current) return
    const snapshot = editor.store.getStoreSnapshot()
    let nodeCount = 0
    for (const s of editor.getCurrentPageShapes()) {
      if (s.type === 'node-card') nodeCount++
    }
    try {
      await add(projectId, snapshot, nodeCount, label)
      setLabel('')
      toast(`已保存版本（${nodeCount} 节点）`)
    } catch (error) {
      toast(`保存版本失败：${String(error)}`)
    }
  }

  // T05: validate and preview before mutation; protect edits made during any await.
  const handleRestore = async (snap: HistorySnapshot): Promise<void> => {
    if (!editor || restoreBusy.current) return
    restoreBusy.current = true
    setRestoring(true)
    const context = { projectId, traceId: newTraceId(), spanId: newSpanId() }
    const checkpointLabel = `恢复前检查点 · ${new Date().toLocaleTimeString('zh-CN')}`
    try {
      const current = editor.store.getStoreSnapshot()
      const originalContent = JSON.stringify(current)
      const result = await restoreSnapshotSafely({
        target: snap.snapshot,
        current,
        prepare: (snapshot) => editor.store.migrateSnapshot(snapshot as never),
        listAvailableMedia: async () => {
          const available = await window.api.listMedia(projectId)
          if (!available.ok) throw new Error('无法读取媒体列表')
          return new Set(available.data.map((asset) => asset.id))
        },
        confirm: ({ currentNodes, targetNodes, media }) =>
          useConfirmStore.getState().confirm({
            title: `恢复「${snap.label}」`,
            message: `当前 ${currentNodes} 个节点 → 此版本 ${targetNodes} 个节点。该版本引用 ${media.available.length + media.missing.length} 个媒体，其中 ${media.missing.length} 个不在当前媒体库中。${media.missing.length ? '恢复后缺失媒体无法显示。' : ''}确认后先保存恢复前检查点；恢复不会重新执行节点或重新生成素材。`,
            confirmText: media.missing.length ? '仍要恢复' : '备份并恢复',
            danger: true
          }),
        saveCheckpoint: async () => {
          await add(projectId, current, snapshotNodeCount(current), checkpointLabel)
        },
        isCurrent: () =>
          restoreContext.current.mounted &&
          restoreContext.current.projectId === projectId &&
          restoreContext.current.editor === editor,
        isUnchanged: () => JSON.stringify(editor.store.getStoreSnapshot()) === originalContent,
        apply: (snapshot) => editor.store.loadStoreSnapshot(snapshot as never),
        verify: (snapshot) => verifyRestoredSnapshot(snapshot, editor.store.getStoreSnapshot()),
        observe: (event, stage) => {
          const failure = event === 'failed' || event === 'rollback_failed'
          const record = restoreDiagnostics.build(
            `project.restore.${event}`,
            undefined,
            `历史版本恢复阶段：${stage}`,
            context,
            {
              ...(failure
                ? {
                    status: 'failed' as const,
                    normalizedError: {
                      code: 'RESTORE_FAILED',
                      category: 'storage',
                      retryable: false
                    }
                  }
                : event === 'completed'
                  ? { status: 'success' as const }
                  : event === 'cancelled'
                    ? { status: 'cancelled' as const }
                    : {})
            }
          )
          emitDiagnosticsEvent(record ? { ...record, phase: stage } : null)
        }
      })
      if (!restoreContext.current.mounted || restoreContext.current.projectId !== projectId) return
      if (result.kind === 'restored') {
        markUndoPoint(editor, 'restore-snapshot')
        toast(`已回溯到「${snap.label}」；如需返回，可恢复「${checkpointLabel}」`, 5000)
      } else if (result.kind === 'cancelled') {
        toast(
          result.reason === 'content-changed'
            ? '等待恢复期间画布已有新修改，已停止恢复；请重新预览后操作'
            : '已取消恢复'
        )
      } else if (result.rollback === 'succeeded') {
        toast('版本恢复失败，已回到恢复前状态')
      } else if (result.rollback === 'failed') {
        toast(`恢复与回滚均失败；已保留「${checkpointLabel}」，请勿关闭项目`, 8000)
      } else {
        const reasons = {
          validation: '版本内容无法加载',
          'media-precheck': '无法读取媒体列表',
          confirmation: '恢复确认失败',
          checkpoint: '恢复前检查点保存失败',
          apply: '版本恢复失败'
        }
        toast(`${reasons[result.stage]}，已停止恢复，当前画布未改变`)
      }
    } finally {
      restoreBusy.current = false
      if (restoreContext.current.mounted) setRestoring(false)
    }
  }

  const handleRemove = async (snap: HistorySnapshot): Promise<void> => {
    if (restoreBusy.current) return
    if (
      !(await useConfirmStore.getState().confirm({
        title: `删除历史版本「${snap.label}」`,
        message: '删除后该版本快照不可恢复，当前画布不受影响。',
        confirmText: '删除',
        danger: true
      }))
    )
      return
    if (restoreBusy.current) return
    try {
      await remove(projectId, snap.id)
    } catch (error) {
      toast(`删除历史版本失败：${String(error)}`)
    }
  }

  return (
    <div className="side-panel-body history-panel">
      <div className="history-toolbar">
        <input
          className="wf-name-input"
          placeholder="版本名称（可选）…"
          aria-label="版本名称（可选）"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') void handleSave()
          }}
        />
        <button
          className="side-panel-primary"
          onClick={() => void handleSave()}
          disabled={!editor || restoring}
        >
          <Icon name="history" size={14} /> 保存版本
        </button>
      </div>
      <p className="side-panel-hint">
        手动保存当前画布为版本快照，随时可回溯。最多保留 {30} 个版本。
      </p>
      {snapshots.length === 0 ? (
        <div className="side-panel-empty">暂无历史版本。点击「保存版本」记录当前画布状态。</div>
      ) : (
        <div className="history-list">
          {snapshots.map((snap) => (
            <div key={snap.id} className="history-card">
              <span className="history-card-icon">
                <Icon name="history" size={16} />
              </span>
              <div className="history-card-info">
                <span className="history-card-label">{snap.label}</span>
                <span className="history-card-meta">
                  {formatTime(snap.timestamp)} · {snap.nodeCount} 节点
                </span>
              </div>
              <div className="history-card-actions">
                <button
                  className="history-action-btn restore"
                  aria-label="回溯到此版本"
                  disabled={restoring || !editor}
                  onClick={() => void handleRestore(snap)}
                >
                  ↩ 回溯
                </button>
                <button
                  className="history-action-btn delete"
                  aria-label={`删除历史版本 ${snap.label}`}
                  disabled={restoring}
                  onClick={() => void handleRemove(snap)}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function CanvasSidePanel({
  tab,
  projectId,
  editor,
  onClose,
  onImport,
  onAddToCanvas,
  onOpenRuns
}: CanvasSidePanelProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [runFocus, setRunFocus] = useState<RunFocus>(null)
  const [assetSelectionMode, setAssetSelectionMode] = useState(true)

  useEffect(() => {
    if (!tab) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [tab, onClose])

  if (!tab) return <></>
  const meta = TAB_META[tab]

  return (
    <div className={`side-panel${tab === 'assets' ? ' assets-side-panel' : ''}`} ref={ref}>
      <div className={`side-panel-head${tab === 'assets' ? ' assets-panel-head' : ''}`}>
        <span className="side-panel-icon">
          <Icon name={meta.icon} size={17} />
        </span>
        <strong className="side-panel-title">{meta.title}</strong>
        {tab === 'assets' && (
          <button
            type="button"
            className="assets-selection-toggle"
            aria-pressed={assetSelectionMode}
            onClick={() => setAssetSelectionMode((enabled) => !enabled)}
          >
            <Icon name="check" size={14} />
            {assetSelectionMode ? '退出多选' : '多选导出'}
          </button>
        )}
        <button className="side-panel-close" aria-label="关闭面板" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </div>
      {tab === 'assets' && (
        <AssetsPanel
          key={projectId}
          projectId={projectId}
          editor={editor}
          onImport={onImport}
          onAddToCanvas={onAddToCanvas}
          selectionMode={assetSelectionMode}
          onOpenRun={(nodeId, runId) => {
            setRunFocus({ nodeId, runId })
            onOpenRuns()
          }}
        />
      )}
      {tab === 'workflow' && <WorkflowPanel editor={editor} />}
      {tab === 'history' && <HistoryPanel projectId={projectId} editor={editor} />}
      {tab === 'runs' && (
        <RunsPanel
          editor={editor}
          projectId={projectId}
          focus={runFocus}
          onClearFocus={() => setRunFocus(null)}
        />
      )}
    </div>
  )
}
