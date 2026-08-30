import { useEffect, useState } from 'react'
import type { Editor } from 'tldraw'
import type { PortDecl, ProviderSummary } from '@shared/types'
import { getNodePorts, getNodeType } from '../nodes/registry'
import type { NodeCardShape } from './NodeCardShape'
import { Icon } from '../components/Icon'
import { projectNodeOutputs, type NodeValue } from '../nodes/nodeValues'
import { useNodePanelStore } from '../stores/nodePanel'
import { readNodeRunHistory, readNodeRunRecord, type NodeRunRecord } from '../engine/runRecord'
import { readNodeConfig } from './node-persistence'
import { runNodeManually, runWorkflowToNode } from '../engine/executor'

interface NodeContractPanelProps {
  editor: Editor
  projectId: string
  providers: ProviderSummary[]
  onClose: () => void
}

function runSummary(record: NodeRunRecord): string {
  const time = new Date(record.startedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  const duration = typeof record.durationMs === 'number' ? ` · ${record.durationMs} ms` : ''
  return `${time} · ${record.status}${duration}`
}

function PortRows({
  title,
  ports,
  connections,
  previews
}: {
  title: string
  ports: PortDecl[]
  connections: Map<string, string[]>
  previews: Map<string, string>
}): React.JSX.Element {
  return (
    <section className="contract-section">
      <h4>{title}</h4>
      {ports.length === 0 ? (
        <p className="contract-empty">无{title}</p>
      ) : (
        ports.map((port) => {
          const links = connections.get(port.id) ?? []
          const preview = previews.get(port.id)
          return (
            <div className="contract-port" key={port.id}>
              <span className={links.length > 0 ? 'contract-dot connected' : 'contract-dot'} />
              <div>
                <strong>{port.name}</strong>
                <small>
                  {port.type}
                  {port.required ? ' · 必填' : ''}
                  {port.cardinality === 'many' ? ' · 多值' : ' · 单值'}
                </small>
                <p>{port.description}</p>
                <code>
                  {port.id}
                  {port.schema ? ` · ${port.schema.id}@${port.schema.version}` : ''}
                </code>
                {links.map((link) => (
                  <small className="contract-link" key={link}>
                    {link}
                  </small>
                ))}
                {preview && <small className="contract-preview">当前值：{preview}</small>}
              </div>
              <em>{links.length > 0 ? `${links.length} 条` : '未连接'}</em>
            </div>
          )
        })
      )}
    </section>
  )
}

function valuePreview(value: NodeValue | undefined): string | null {
  if (!value) return null
  if (value.kind === 'text' || value.kind === 'markdown') {
    const compact = value.text.replace(/\s+/g, ' ').trim()
    return compact.length > 70 ? `${compact.slice(0, 70)}…` : compact
  }
  if (value.kind === 'json') {
    const compact = JSON.stringify(value.data)
    return compact.length > 70 ? `${compact.slice(0, 70)}…` : compact
  }
  return `${value.mime || value.kind} · ${value.mediaId || '本地资产'}`
}

type InspectorTab = 'overview' | 'io' | 'settings' | 'run'

function safeConfigPreview(text: string): string {
  if (!text.trim()) return '此节点没有固定配置；全部值来自连线或媒体资产。'
  let value: unknown = text
  try {
    value = JSON.parse(text)
  } catch {
    return text.length > 1200 ? `${text.slice(0, 1200)}\n…（内容已截断）` : text
  }
  const redact = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(redact)
    if (!input || typeof input !== 'object') return input
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([key, item]) => [
        key,
        /key|token|secret|password/i.test(key) ? '***' : redact(item)
      ])
    )
  }
  const formatted = JSON.stringify(redact(value), null, 2)
  return formatted.length > 2400 ? `${formatted.slice(0, 2400)}\n…（配置已截断）` : formatted
}

export function NodeContractPanel({
  editor,
  projectId,
  providers,
  onClose
}: NodeContractPanelProps): React.JSX.Element | null {
  const shapeId = useNodePanelStore((s) => s.shapeId)
  const [tab, setTab] = useState<InspectorTab>('overview')
  const [runningAction, setRunningAction] = useState<'node' | 'subgraph' | null>(null)

  // Esc 关闭面板（与其它浮层面板行为统一）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!shapeId) return null
  const shape = editor.getShape<NodeCardShape>(shapeId)
  // 对话也有真实的 text → markdown 契约；不能因为它另有聊天工作区就隐藏 I/O 说明。
  if (!shape) return null
  const spec = getNodeType(shape.props.nodeType)
  if (!spec) return null
  const ports = getNodePorts(spec, shape)
  const SettingsPanel = spec.SettingsPanel

  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  const inputPreviews = new Map<string, string>()
  const outputPreviews = new Map<string, string>()
  const ownOutputs = projectNodeOutputs(shape)
  const runRecord = readNodeRunRecord(shape.meta?.nodeRun)
  const runHistory = readNodeRunHistory(shape.meta?.nodeRunHistory)
  const executionMode = spec.executionMode ?? 'auto'
  for (const [portId, value] of Object.entries(ownOutputs)) {
    const preview = valuePreview(value)
    if (preview) outputPreviews.set(portId, preview)
  }
  for (const arrow of editor.getCurrentPageShapes()) {
    if (arrow.type !== 'arrow') continue
    const bindings = editor.getBindingsFromShape(arrow.id, 'arrow')
    const start = bindings.find((binding) => binding.props.terminal === 'start')
    const end = bindings.find((binding) => binding.props.terminal === 'end')
    if (
      start &&
      end?.toId === shape.id &&
      typeof arrow.meta?.toPort === 'string' &&
      typeof arrow.meta?.fromPort === 'string'
    ) {
      const source = editor.getShape<NodeCardShape>(start.toId)
      if (source?.type === 'node-card') {
        const portId = arrow.meta.toPort
        const links = incoming.get(portId) ?? []
        links.push(`${source.props.title} · ${arrow.meta.fromPort}`)
        incoming.set(portId, links)
        const preview = valuePreview(projectNodeOutputs(source)[arrow.meta.fromPort])
        if (preview) inputPreviews.set(portId, preview)
      }
    }
    if (
      end &&
      start?.toId === shape.id &&
      typeof arrow.meta?.fromPort === 'string' &&
      typeof arrow.meta?.toPort === 'string'
    ) {
      const target = editor.getShape<NodeCardShape>(end.toId)
      if (target?.type === 'node-card') {
        const portId = arrow.meta.fromPort
        const links = outgoing.get(portId) ?? []
        links.push(`${target.props.title} · ${arrow.meta.toPort}`)
        outgoing.set(portId, links)
      }
    }
  }

  const run = async (kind: 'node' | 'subgraph'): Promise<void> => {
    setRunningAction(kind)
    try {
      if (kind === 'node') await runNodeManually(editor, projectId, providers, shape.id)
      else await runWorkflowToNode(editor, projectId, providers, shape.id)
    } finally {
      setRunningAction(null)
    }
  }

  return (
    <aside className="node-contract-panel" aria-label="节点输入输出说明">
      <header className="contract-head">
        <span style={{ color: spec.color }}>
          <Icon name={spec.icon} size={17} />
        </span>
        <div>
          <strong>{shape.props.title}</strong>
          <small>
            {spec.label}节点 · 契约 v{spec.contractVersion}
          </small>
        </div>
        <button className="side-panel-close" title="关闭说明" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </header>
      <div className="contract-body">
        <nav className="contract-tabs" aria-label="节点详情分页" role="tablist">
          {(
            [
              ['overview', '概览'],
              ['io', '输入输出'],
              ['settings', '设置'],
              ['run', '运行']
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? 'active' : ''}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        {tab === 'overview' && (
          <>
            <p className="contract-description">{spec.description}</p>
            <div className="contract-rule">
              连线会把上游端口的真实输出填入对应输入；没有连线时才使用节点内的固定内容。
            </div>
            <div className="contract-overview-grid">
              <span>
                <small>执行方式</small>
                <strong>
                  {executionMode === 'manual-publish'
                    ? '手动发布'
                    : executionMode === 'display-only'
                      ? '仅展示'
                      : '自动执行'}
                </strong>
              </span>
              <span>
                <small>输入端口</small>
                <strong>{ports.in.length} 个</strong>
              </span>
              <span>
                <small>输出端口</small>
                <strong>{ports.out.length} 个</strong>
              </span>
              <span>
                <small>当前状态</small>
                <strong>{shape.props.exec}</strong>
              </span>
            </div>
          </>
        )}
        {tab === 'io' && (
          <>
            <PortRows
              title="输入"
              ports={ports.in}
              connections={incoming}
              previews={inputPreviews}
            />
            <PortRows
              title="输出"
              ports={ports.out}
              connections={outgoing}
              previews={outputPreviews}
            />
          </>
        )}
        {tab === 'settings' &&
          (SettingsPanel ? (
            <SettingsPanel key={shape.id} shape={shape} editor={editor} projectId={projectId} />
          ) : (
            <section className="contract-section">
              <h4>节点固定配置</h4>
              <p className="contract-settings-hint">连线值优先于固定值；敏感字段会自动隐藏。</p>
              <pre className="contract-settings-code">
                {safeConfigPreview(readNodeConfig(shape))}
              </pre>
            </section>
          ))}
        {tab === 'run' && (
          <>
            <section className="contract-section">
              <h4>运行操作</h4>
              <div className="contract-run-actions">
                <button disabled={runningAction !== null} onClick={() => void run('node')}>
                  {runningAction === 'node'
                    ? '运行中…'
                    : runRecord?.status === 'failed'
                      ? '重试此节点'
                      : '运行此节点'}
                </button>
                <button disabled={runningAction !== null} onClick={() => void run('subgraph')}>
                  {runningAction === 'subgraph' ? '运行中…' : '运行至此节点'}
                </button>
              </div>
            </section>
            {runRecord ? (
              <section className="contract-section">
                <h4>最近运行</h4>
                <div className="contract-run-info">
                  <small>运行 ID：{runRecord.runId}</small>
                  <small>状态：{runRecord.status}</small>
                  {typeof runRecord.durationMs === 'number' && (
                    <small>耗时：{runRecord.durationMs} ms</small>
                  )}
                  {runRecord.outputPorts && (
                    <small>输出端口：{runRecord.outputPorts.join('、') || '无'}</small>
                  )}
                  {runRecord.error && (
                    <small className="contract-run-error">
                      {runRecord.error.phase}：{runRecord.error.reason}
                    </small>
                  )}
                </div>
              </section>
            ) : (
              <p className="contract-empty">尚无运行记录</p>
            )}
            {runHistory.length > 0 && (
              <section className="contract-section">
                <h4>最近 {runHistory.length} 次运行</h4>
                <div className="contract-run-history">
                  {runHistory.map((record) => (
                    <div
                      key={record.runId}
                      className={`contract-run-history-item ${record.status}`}
                    >
                      <strong>{runSummary(record)}</strong>
                      {record.error && <small>{record.error.reason}</small>}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
