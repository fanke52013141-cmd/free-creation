import { RunTimeline } from './RunTimeline'
// 画布右侧抽屉面板：资产中心 / 节点流 / 历史记录（LibTV 侧栏入口落地）
// 资产中心：项目级媒体库——导入/搜索/筛选/缩略图预览/点击拖到画布/删除
// 节点流：列出用户保存的单节点或多节点组合，并允许搜索、添加和删除。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createShapeId, useValue, type Editor, type TLShapeId } from 'tldraw'
import type { MediaAsset } from '@shared/types'
import type { CompositeCapabilitySummary } from '@shared/composite/types'
import type { NodeCardShape } from './NodeCardShape'
import {
  buildRunIndex,
  filterRunIndex,
  type IndexedNodeRun,
  type RunStatusFilter
} from '../engine/run-index'
import { requestWorkflowInput, guiWorkflowInputOptions } from '../stores/workflowInput'
import { useEngineStore } from '../engine/store'
import { runNodeManually, runWorkflowForNodes } from '../engine/executor'
import { useGatewayStore } from '../stores/gateway'
import { useWorkflowStore, type WorkflowTemplate } from '../stores/workflow'
import { addNodeLibraryEntry } from './node-library'
import { CompositeVersionDialog } from '../composite/CompositeVersionDialog'
import { CompositeCanvasEditor } from '../composite/CompositeCanvasEditor'
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
import { getNodeType } from '../nodes/registry'
import { LibraryCardCover } from '../library/LibraryCardCover'
import { AppSelect } from '../components/AppSelect'
import { AssetsPanel } from './side-panel/AssetsPanel'
import { useDragToCanvas } from './drag-to-canvas'
import { deriveHumanInbox, type HumanInboxItem } from '@shared/agent-flow/human-inbox'

export type SidePanelTab = 'assets' | 'workflow' | 'history' | 'runs' | 'tasks'

interface CanvasSidePanelProps {
  tab: SidePanelTab | null
  projectId: string
  editor: Editor | null
  onClose: () => void
  onImport: () => void
  onDropMedia: (asset: MediaAsset, x: number, y: number) => void
}

const TAB_META: Record<SidePanelTab, { title: string; icon: IconName }> = {
  assets: { title: '资产中心', icon: 'assets' },
  workflow: { title: '节点流', icon: 'node-library' },
  history: { title: '历史记录', icon: 'history' },
  runs: { title: '运行中心', icon: 'play' },
  tasks: { title: '待你处理', icon: 'edit' }
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

// ── 节点流面板 ──
function versionLabel(version: string): string {
  return version.replace(/\.0\.0$/, '.0')
}

function nextVersionLabel(version: string | null): string {
  const major = Number.parseInt(version ?? '0', 10)
  return `${Number.isFinite(major) ? major + 1 : 1}.0`
}

function WorkflowPanel({
  editor,
  projectId
}: {
  editor: Editor | null
  projectId: string
}): React.JSX.Element {
  const templates = useWorkflowStore((s) => s.templates)
  const wfLoad = useWorkflowStore((s) => s.load)
  const wfRemove = useWorkflowStore((s) => s.remove)
  const [query, setQuery] = useState('')
  const [composites, setComposites] = useState<CompositeCapabilitySummary[]>([])
  const [settingsDialog, setSettingsDialog] = useState<CompositeCapabilitySummary | null>(null)
  const [canvasEdit, setCanvasEdit] = useState<{
    capability: CompositeCapabilitySummary
    manifest: import('@shared/composite/manifest').CompositeManifest
    draftRevision: number | null
  } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const needle = query.trim().toLocaleLowerCase()
  const visibleTemplates = templates.filter((template) =>
    [template.name, ...template.nodes.flatMap((node) => [node.title, node.nodeType])].some(
      (value) => value.toLocaleLowerCase().includes(needle)
    )
  )
  const visibleComposites = composites.filter((capability) =>
    [capability.name, capability.id, ...(capability.tags ?? [])].some((value) =>
      value.toLocaleLowerCase().includes(needle)
    )
  )

  useEffect(() => {
    void wfLoad().catch((error) => toast(`加载节点流失败：${String(error)}`))
  }, [wfLoad])

  useEffect(() => {
    void window.api.composite.search({}).then((result) => {
      if (result.ok) setComposites(result.data)
    })
  }, [])

  const refreshComposites = (): void => {
    void window.api.composite.search({}).then((result) => {
      if (result.ok) setComposites(result.data)
    })
  }

  // W3 删除：先做与 CLI/MCP 同一份引用检查；有引用则阻断，无引用需二次确认。
  const handleDeleteComposite = async (
    capability: CompositeCapabilitySummary
  ): Promise<boolean> => {
    const references = await window.api.composite.references({ capabilityId: capability.id })
    if (!references.ok) {
      toast(`引用检查失败：${references.error.message}`)
      return false
    }
    const { projectInstances, nestedVersions } = references.data
    if (projectInstances.length > 0 || nestedVersions.length > 0) {
      const parts: string[] = []
      if (projectInstances.length > 0) {
        const projects = [...new Set(projectInstances.map((instance) => instance.projectName))]
        parts.push(
          `${projectInstances.length} 个画布实例（${projects.slice(0, 3).join('、')}${projects.length > 3 ? ' 等' : ''}）`
        )
      }
      if (nestedVersions.length > 0) {
        parts.push(`${nestedVersions.length} 个其他节点流发布版本的嵌套引用`)
      }
      toast(`无法删除「${capability.name}」：仍被 ${parts.join('、')} 使用。请先移除引用。`)
      return false
    }
    if (
      !(await useConfirmStore.getState().confirm({
        title: `删除节点流「${capability.name}」`,
        message: '将物理删除全部发布版本与草稿，不可恢复。当前没有画布实例或嵌套引用。',
        confirmText: '删除',
        danger: true
      }))
    )
      return false
    const result = await window.api.composite.delete({ capabilityId: capability.id })
    if (!result.ok) {
      toast(`删除失败：${result.error.message}`)
      return false
    }
    toast(`已删除节点流「${capability.name}」`)
    refreshComposites()
    return true
  }

  // 将节点流条目添加到画布：点击放在视口中心，拖拽则落在光标位置。
  const handleApply = (tmpl: WorkflowTemplate, dropScreen?: { x: number; y: number }): void => {
    if (!editor) return
    const { skippedEdges } = addNodeLibraryEntry(editor, tmpl, true, dropScreen)
    toast(
      skippedEdges > 0
        ? `已从节点流添加「${tmpl.name}」，${skippedEdges} 条旧连线因端口不明确未恢复`
        : `已从节点流添加「${tmpl.name}」（${tmpl.nodes.length} 个节点）`
    )
  }

  const insertComposite = async (
    capability: CompositeCapabilitySummary,
    dropScreen?: { x: number; y: number }
  ): Promise<void> => {
    if (!editor) return
    const version = capability.latestVersion
    if (!version) return toast('该组合还没有已发布版本')
    const result = await window.api.composite.versionGet({ capabilityId: capability.id, version })
    if (!result.ok || !result.data) return toast('读取组合版本失败')
    // 拖拽落在光标处，点击放在视口中心。
    const center = dropScreen
      ? editor.screenToPage(dropScreen)
      : editor.getViewportPageBounds().center
    const id = createShapeId()
    markUndoPoint(editor, 'insert-composite-node')
    editor.createShape({
      id,
      type: 'node-card',
      x: center.x - 170,
      y: center.y - 130,
      props: {
        nodeType: 'composite',
        title: capability.name,
        w: 340,
        h: 260,
        // W3 引用形态：config 存固定版本引用，快照缓存 meta。
        config: JSON.stringify({
          capabilityId: capability.id,
          version,
          contentHash: result.data.contentHash
        })
      },
      meta: { compositeManifest: result.data.manifest }
    } as never)
    editor.select(id)
    toast(`已添加节点流「${capability.name} v${versionLabel(version)}」`)
  }

  // 编辑节点：优先恢复未发布草稿；没有草稿时以最新发布版本为基准铺开画布。
  const openCanvasEdit = async (capability: CompositeCapabilitySummary): Promise<void> => {
    const latest = capability.latestVersion
    if (!latest) return toast('该节点流还没有已发布版本')
    const draft = await window.api.composite.draftGet(capability.id)
    if (!draft.ok) return toast('读取节点流草稿失败')
    if (draft.data) {
      const manifest = structuredClone(draft.data.manifest)
      manifest.version = nextVersionLabel(latest)
      setCanvasEdit({ capability, manifest, draftRevision: draft.data.revision })
      toast('已恢复上次保存的内容')
      return
    }
    const result = await window.api.composite.versionGet({
      capabilityId: capability.id,
      version: latest
    })
    if (!result.ok || !result.data) return toast('读取节点流版本失败')
    const manifest = structuredClone(result.data.manifest)
    // 已发布版本不可变：全屏编辑默认准备下一个主版本，保存/另存为新版本分离。
    manifest.version = nextVersionLabel(latest)
    setCanvasEdit({ capability, manifest, draftRevision: null })
  }

  const handleRun = async (template: WorkflowTemplate): Promise<void> => {
    if (!editor || useEngineStore.getState().phase !== 'idle') return
    const { nodeIds, skippedEdges } = addNodeLibraryEntry(editor, template)
    if (skippedEdges > 0) {
      toast('部分旧连线无法恢复，请检查画布中的连线后再运行')
      return
    }
    await runWorkflowForNodes(editor, projectId, useGatewayStore.getState().providers, nodeIds, {
      requestInput: requestWorkflowInput
    })
  }

  const handleRemoveTemplate = async (tmpl: WorkflowTemplate): Promise<void> => {
    if (
      !(await useConfirmStore.getState().confirm({
        title: `删除节点流条目「${tmpl.name}」`,
        message: '删除后该节点流条目不可恢复，画布上已创建的节点不受影响。',
        confirmText: '删除',
        danger: true
      }))
    )
      return
    await wfRemove(tmpl.id).catch((error) => toast(`删除节点流条目失败：${String(error)}`))
  }

  return (
    <>
      <div className="side-panel-body workflow-panel" ref={scrollRef}>
        <label className="assets-search-row">
          <Icon name="search" size={14} />
          <input
            className="assets-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索节点流"
            aria-label="搜索节点流"
          />
        </label>
        {templates.length === 0 && composites.length === 0 ? (
          <div className="side-panel-empty">
            节点流还是空的。右键点击画布节点，选择「保存节点」中的流程模板；也可以多选节点后使用浮动工具栏保存。
          </div>
        ) : visibleTemplates.length === 0 && visibleComposites.length === 0 ? (
          <div className="side-panel-empty">没有找到匹配的节点流条目。</div>
        ) : (
          <div className="assets-grid">
            {visibleComposites.map((capability) => (
              <CompositeCard
                key={`composite-${capability.id}`}
                capability={capability}
                onInsert={(dropScreen) => void insertComposite(capability, dropScreen)}
                onEditNodes={() => void openCanvasEdit(capability)}
                onEditInfo={() => setSettingsDialog(capability)}
                onDelete={() => void handleDeleteComposite(capability)}
              />
            ))}
            {visibleTemplates.map((tmpl) => (
              <WorkflowCard
                key={tmpl.id}
                template={tmpl}
                onApply={(dropScreen) => handleApply(tmpl, dropScreen)}
                onRun={() => void handleRun(tmpl)}
                onRemove={() => void handleRemoveTemplate(tmpl)}
              />
            ))}
          </div>
        )}
      </div>
      {canvasEdit && (
        <CompositeCanvasEditor
          capability={canvasEdit.capability}
          manifest={canvasEdit.manifest}
          projectId={projectId}
          draftRevision={canvasEdit.draftRevision}
          onClose={() => setCanvasEdit(null)}
          onSaved={refreshComposites}
        />
      )}
      {settingsDialog && (
        <CompositeVersionDialog
          capability={settingsDialog}
          onClose={() => setSettingsDialog(null)}
          onPublished={refreshComposites}
        />
      )}
    </>
  )
}

/** 组合能力卡片：与资产中心一致的悬浮纯图标动作；点击/拖拽到画布即插入固定版本实例。 */
function CompositeCard({
  capability,
  onInsert,
  onEditNodes,
  onEditInfo,
  onDelete
}: {
  capability: CompositeCapabilitySummary
  onInsert: (dropScreen?: { x: number; y: number }) => void
  onEditNodes: () => void
  onEditInfo: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { startDrag, handleClick } = useDragToCanvas()
  return (
    <article
      className="asset-card"
      title="点击添加到画布，或直接拖到画布"
      onPointerDown={(e) =>
        startDrag(e, { label: capability.name, icon: 'layers' }, (x, y) => onInsert({ x, y }))
      }
      onClick={() => handleClick(() => onInsert())}
    >
      <LibraryCardCover icon="layers" compact />
      <button
        type="button"
        className="composite-card-edit"
        title="铺开画布编辑内部节点：可添加任意节点、调整内容与连线"
        aria-label={`编辑节点 ${capability.name}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          onEditNodes()
        }}
      >
        <Icon name="edit" size={12} />
      </button>
      <button
        type="button"
        className="composite-card-settings"
        title="编辑名称与说明（与创建时同一弹窗，不产生新版本）"
        aria-label={`编辑信息 ${capability.name}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          onEditInfo()
        }}
      >
        <Icon name="settings" size={12} />
      </button>
      <div className="asset-info">
        <span className="asset-name" title={capability.name}>
          {capability.name}
        </span>
      </div>
      <button
        type="button"
        className="asset-delete"
        title="删除节点流（先检查引用，再二次确认）"
        aria-label={`删除 ${capability.name}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          onDelete()
        }}
      >
        <Icon name="trash" size={12} />
      </button>
    </article>
  )
}

/** 节点流卡片：与项目素材共用 .asset-card 材质；只显示名称，点击/拖拽到画布即用。 */
function WorkflowCard({
  template,
  onApply,
  onRun,
  onRemove
}: {
  template: WorkflowTemplate
  onApply: (dropScreen?: { x: number; y: number }) => void
  onRun: () => void
  onRemove: () => void
}): React.JSX.Element {
  const { startDrag, handleClick } = useDragToCanvas()
  const outputTypes = new Set(
    template.nodes.flatMap(
      (node) => getNodeType(node.nodeType)?.ports.out.map((port) => port.type) ?? []
    )
  )
  const coverIcon =
    (['video', 'image', 'audio', 'text'] as const).find((kind) => outputTypes.has(kind)) ??
    (template.nodes.some((node) => node.text?.trim()) ? 'text' : 'node-library')
  return (
    <article
      className="asset-card"
      title="点击添加到画布，或直接拖到画布"
      onPointerDown={(e) =>
        startDrag(e, { label: template.name, icon: coverIcon }, (x, y) => onApply({ x, y }))
      }
      onClick={() => handleClick(() => onApply())}
    >
      <LibraryCardCover icon={coverIcon} compact />
      <button
        type="button"
        className="asset-template-run btn-ghost small"
        aria-label={`运行 ${template.name}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          onRun()
        }}
      >
        <Icon name="play" size={13} /> 运行
      </button>
      <div className="asset-info">
        <span className="asset-name" title={template.name}>
          {template.name}
        </span>
      </div>
      <button
        type="button"
        className="asset-delete"
        aria-label={`删除节点流条目 ${template.name}`}
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
      >
        <Icon name="trash" size={12} />
      </button>
    </article>
  )
}

type RunFocus = { nodeId: string; runId: string } | null

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
  entries,
  focus,
  onClearFocus
}: {
  editor: Editor | null
  projectId: string
  entries: IndexedNodeRun[]
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
      await runNodeManually(
        editor,
        projectId,
        providers,
        shape.id,
        undefined,
        undefined,
        undefined,
        guiWorkflowInputOptions
      )
    } finally {
      setRetrying(null)
    }
  }

  return (
    <div className="side-panel-body runs-panel">
      <div className="runs-toolbar">
        <label className="assets-search-row">
          <Icon name="search" size={14} />
          <input
            className="assets-search"
            placeholder="搜索运行"
            aria-label="搜索运行记录"
            title="搜索节点、运行 ID 或端口"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          />
        </label>
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
          {visible.map((run) => {
            const rowId = `${run.nodeId}:${run.runId}`
            const expanded = timelineRunId === rowId
            return (
              <article className={`run-card ${run.status}`} key={rowId}>
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
                <div className="run-card-actions">
                  {run.traceId && (
                    <>
                      <button
                        aria-expanded={expanded}
                        title="查看本次运行各阶段的诊断事件"
                        onClick={() => setTimelineRunId(expanded ? null : rowId)}
                      >
                        <Icon name="history" size={12} /> 运行详情
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
                    </>
                  )}
                  <button onClick={() => locate(run)}>
                    <Icon name="target" size={12} /> 回到节点
                  </button>
                </div>
                {run.status === 'failed' && (
                  <div className="run-card-actions">
                    <button disabled={retrying !== null} onClick={() => void retry(run)}>
                      <Icon name="reset" size={12} />
                      {retrying === run.runId ? '重试中…' : '重试节点'}
                    </button>
                  </div>
                )}
                {expanded && run.traceId && <RunTimeline traceId={run.traceId} />}
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}

const historyDate = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
})

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
      await add(projectId, snapshot, nodeCount, '')
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
          const files = await window.api.checkProjectMediaFiles(projectId)
          if (!files.ok) throw new Error('无法检查媒体文件')
          const missing = new Set(files.data.missingMediaIds)
          return new Set(
            available.data.filter((asset) => !missing.has(asset.id)).map((asset) => asset.id)
          )
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
        <button
          className="history-save-btn"
          onClick={() => void handleSave()}
          disabled={!editor || restoring}
        >
          <Icon name="history" size={14} /> 保存版本
        </button>
      </div>
      {snapshots.length === 0 ? (
        <div className="side-panel-empty">暂无历史版本。点击「保存版本」记录当前画布状态。</div>
      ) : (
        <div className="history-list">
          {snapshots.map((snap, index) => (
            <div key={snap.id} className="history-card">
              <div className="history-card-info" title={snap.label}>
                <span className="history-card-label">{snapshots.length - index}.0 版本</span>
                <time
                  className="history-card-meta"
                  dateTime={new Date(snap.timestamp).toISOString()}
                >
                  {historyDate.format(snap.timestamp).replaceAll('/', '-')}
                </time>
              </div>
              <div className="history-card-actions">
                <button
                  className="history-action-btn"
                  title="回溯到此版本"
                  aria-label="回溯到此版本"
                  disabled={restoring || !editor}
                  onClick={() => void handleRestore(snap)}
                >
                  <Icon name="undo" size={16} />
                </button>
                <button
                  className="history-action-btn"
                  title="删除版本"
                  aria-label={`删除历史版本 ${snap.label}`}
                  disabled={restoring}
                  onClick={() => void handleRemove(snap)}
                >
                  <Icon name="trash" size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// O2：只读"待你处理"收件箱——聚合等待人工的节点，点击定位。不改变任何提交交互。
function TasksPanel({
  editor,
  items
}: {
  editor: Editor | null
  items: HumanInboxItem[]
}): React.JSX.Element {
  const locate = (item: HumanInboxItem): void => {
    if (!editor) return toast('画布尚未就绪')
    const shape = editor.getShape(item.nodeId as TLShapeId)
    if (!shape || shape.type !== 'node-card') return toast('来源节点已删除或不可用')
    editor.setSelectedShapes([shape.id])
    editor.zoomToSelection({ animation: { duration: 220 } })
    toast(`已定位到「${item.title}」`)
  }
  return (
    <div className="side-panel-body runs-panel">
      {items.length === 0 ? (
        <div className="side-panel-empty">
          暂无待你处理的节点。人工任务待提交、或协作 Agent 等待确认时会出现在这里。
        </div>
      ) : (
        <div className="runs-list">
          {items.map((item) => (
            <article className="run-card" key={item.nodeId}>
              <div className="run-card-head">
                <div>
                  <strong>{item.title}</strong>
                  <small>
                    {item.kind === 'human-task' ? '人工任务' : '协作 Agent'} · {item.reason}
                  </small>
                </div>
              </div>
              <div className="run-card-actions">
                <button onClick={() => locate(item)}>
                  <Icon name="target" size={12} /> 回到节点
                </button>
              </div>
            </article>
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
  onDropMedia
}: CanvasSidePanelProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [runFocus, setRunFocus] = useState<RunFocus>(null)
  const runEntries = useValue(
    'run center entries',
    () =>
      tab === 'runs' && editor
        ? buildRunIndex(
            editor
              .getCurrentPageShapes()
              .filter((shape): shape is NodeCardShape => shape.type === 'node-card')
          )
        : [],
    [tab, editor]
  )
  const humanInbox = useValue(
    'human inbox items',
    () =>
      tab === 'tasks' && editor
        ? deriveHumanInbox(
            editor
              .getCurrentPageShapes()
              .filter((shape): shape is NodeCardShape => shape.type === 'node-card')
          )
        : [],
    [tab, editor]
  )

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
    <div className={`side-panel side-panel--${tab}`} ref={ref}>
      <div className="side-panel-head">
        <span className="side-panel-icon">
          <Icon name={meta.icon} size={17} />
        </span>
        <strong className="side-panel-title">
          {meta.title}
          {tab === 'runs' && <span className="side-panel-count">（{runEntries.length} 条）</span>}
          {tab === 'tasks' && <span className="side-panel-count">（{humanInbox.length} 项）</span>}
        </strong>
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
          onDropMedia={onDropMedia}
        />
      )}
      {tab === 'workflow' && <WorkflowPanel editor={editor} projectId={projectId} />}
      {tab === 'history' && <HistoryPanel projectId={projectId} editor={editor} />}
      {tab === 'runs' && (
        <RunsPanel
          editor={editor}
          projectId={projectId}
          entries={runEntries}
          focus={runFocus}
          onClearFocus={() => setRunFocus(null)}
        />
      )}
      {tab === 'tasks' && <TasksPanel editor={editor} items={humanInbox} />}
    </div>
  )
}
