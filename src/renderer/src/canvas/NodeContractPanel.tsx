import { useEffect, useState } from 'react'
import type { Editor } from 'tldraw'
import type { MediaAsset, PortDecl, PortType, ProviderSummary } from '@shared/types'
import { getNodePorts, getNodeType } from '../nodes/registry'
import type { NodeCardShape } from './NodeCardShape'
import { Icon } from '../components/Icon'
import { projectNodeOutputs, type NodeValue } from '../nodes/nodeValues'
import { useNodePanelStore } from '../stores/nodePanel'
import { readNodeRunHistory, readNodeRunRecord, type NodeRunRecord } from '../engine/runRecord'
import { readNodeConfig } from './node-persistence'
import { markUndoPoint } from './history'
import {
  runNodeManually,
  runNodeTest,
  runWorkflowToNode,
  type NodeTestInputs
} from '../engine/executor'
import { useMediaStore } from '../stores/media'

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
  // 隐藏内部测试输入字段，不干扰用户查看节点配置
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const filtered = { ...(value as Record<string, unknown>) }
    delete filtered['_testInputs']
    value = filtered
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

/** 保存在节点 config 中的测试输入键名（执行器不会读取此键）。 */
const TEST_INPUTS_KEY = '_testInputs'

/** 从节点 config 中恢复之前保存的测试输入值。文本节点额外读取 props.text。 */
function loadTestInputsFromConfig(shape: NodeCardShape): Partial<Record<string, string>> {
  const result: Partial<Record<string, string>> = {}
  if (shape.props.nodeType === 'text') {
    result['in-text'] = shape.props.text
  }
  try {
    const config = shape.props.config ? JSON.parse(shape.props.config) : {}
    const saved = config[TEST_INPUTS_KEY] as
      Record<string, { type: string; value: string }> | undefined
    if (saved) {
      for (const [portId, input] of Object.entries(saved)) {
        if (!result[portId]) result[portId] = input.value
      }
    }
  } catch {
    // ignore parse errors
  }
  return result
}

type TestDraft = { type: PortType; value: string }

function defaultDraft(port: PortDecl): TestDraft {
  return { type: port.type === 'any' ? 'text' : port.type, value: '' }
}

function previewTestValue(value: NodeValue): string {
  if (value.kind === 'text' || value.kind === 'markdown') return value.text || '（空文本）'
  if (value.kind === 'json') return JSON.stringify(value.data, null, 2)
  return `${value.kind} · ${value.mime} · ${value.mediaId}`
}

function TestHarness({
  projectId,
  ports,
  onRun,
  onTextInputCommit,
  initialTextInputs = {}
}: {
  projectId: string
  ports: PortDecl[]
  onRun: (
    inputs: NodeTestInputs
  ) => Promise<{ status: string; reason?: string; outputs: Record<string, unknown> }>
  onTextInputCommit?: (port: PortDecl, type: PortType, value: string) => void
  initialTextInputs?: Partial<Record<string, string>>
}): React.JSX.Element {
  const assets = useMediaStore((state) => state.assets)
  const loadAssets = useMediaStore((state) => state.load)
  const [drafts, setDrafts] = useState<Record<string, TestDraft>>({})
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{
    status: string
    reason?: string
    outputs: Record<string, unknown>
  } | null>(null)

  useEffect(() => {
    void loadAssets(projectId)
  }, [loadAssets, projectId])

  const readDraft = (port: PortDecl): TestDraft =>
    drafts[port.id] ?? { ...defaultDraft(port), value: initialTextInputs[port.id] ?? '' }
  const updateDraft = (port: PortDecl, patch: Partial<TestDraft>): void => {
    setDrafts((current) => ({ ...current, [port.id]: { ...readDraft(port), ...patch } }))
  }
  const usableAssets = (type: PortType): MediaAsset[] =>
    assets.filter((asset) => type === 'any' || type === 'file' || asset.kind === type)

  const runTest = async (): Promise<void> => {
    const inputs: NodeTestInputs = {}
    try {
      for (const port of ports) {
        const draft = readDraft(port)
        const type = port.type === 'any' ? draft.type : port.type
        if (!draft.value) continue
        let value: NodeValue
        if (type === 'text' || type === 'markdown') value = { kind: type, text: draft.value }
        else if (type === 'json') value = { kind: 'json', data: JSON.parse(draft.value) }
        else {
          const asset = assets.find((item) => item.id === draft.value)
          if (!asset) throw new Error(`${port.name} 请选择一个已导入的资产`)
          const mediaKind = type === 'file' ? 'file' : asset.kind
          if (mediaKind === 'file' && asset.kind !== 'file' && type !== 'file') {
            throw new Error(`${port.name} 的资产类型不匹配`)
          }
          value = { kind: mediaKind, mediaId: asset.id, mediaPath: asset.path, mime: asset.mime }
        }
        inputs[port.id] = [value]
      }
      setRunning(true)
      setResult(await onRun(inputs))
    } catch (error) {
      setResult({
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        outputs: {}
      })
    } finally {
      setRunning(false)
    }
  }

  return (
    <section className="contract-section contract-test-harness">
      <h4>未连线测试</h4>
      <p className="contract-settings-hint">
        输入内容在失焦时自动保存到节点，下次打开面板会自动回填；也可直接点击下方测试运行。
      </p>
      {ports.length === 0 ? (
        <p className="contract-empty">此节点没有可注入的输入，可直接点击下方测试运行。</p>
      ) : (
        ports.map((port) => {
          const draft = readDraft(port)
          const type = port.type === 'any' ? draft.type : port.type
          const isText = type === 'text' || type === 'markdown' || type === 'json'
          return (
            <label className="contract-test-input" key={port.id}>
              <span>
                <strong>{port.name}</strong>
                <small>
                  {port.required ? '必填' : '可选'} ·{' '}
                  {port.cardinality === 'many' ? '多值（本次注入一项）' : '单值'}
                </small>
              </span>
              {port.type === 'any' && (
                <select
                  value={draft.type}
                  onChange={(event) =>
                    updateDraft(port, { type: event.target.value as PortType, value: '' })
                  }
                >
                  {(
                    ['text', 'markdown', 'json', 'image', 'video', 'audio', 'file'] as PortType[]
                  ).map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              )}
              {isText ? (
                <textarea
                  value={draft.value}
                  placeholder={
                    type === 'json' ? '输入合法 JSON，例如 {"title":"示例"}' : `输入${port.name}`
                  }
                  onChange={(event) => updateDraft(port, { value: event.target.value })}
                  onBlur={(event) => onTextInputCommit?.(port, type, event.target.value)}
                />
              ) : (
                <select
                  value={draft.value}
                  onChange={(event) => updateDraft(port, { value: event.target.value })}
                >
                  <option value="">选择已导入的 {type} 资产</option>
                  {usableAssets(type).map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.name || asset.id} · {asset.mime}
                    </option>
                  ))}
                </select>
              )}
            </label>
          )
        })
      )}
      <button className="contract-test-run" disabled={running} onClick={() => void runTest()}>
        {running ? '测试运行中…' : '测试此节点'}
      </button>
      {result && (
        <div className={`contract-test-result ${result.status}`}>
          <strong>{result.status === 'done' ? '测试成功' : '测试未通过'}</strong>
          {result.reason && <small>{result.reason}</small>}
          {Object.entries(result.outputs).map(([portId, packet]) => {
            const item = packet as { value?: NodeValue }
            return item.value ? (
              <pre key={portId}>
                {portId}\n{previewTestValue(item.value)}
              </pre>
            ) : null
          })}
        </div>
      )}
    </section>
  )
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

  const testNode = async (inputs: NodeTestInputs): ReturnType<typeof runNodeTest> => {
    return runNodeTest(editor, projectId, providers, shape.id, inputs)
  }

  const syncTextInputOnBlur = (port: PortDecl, type: PortType, value: string): void => {
    if (type !== 'text' && type !== 'markdown' && type !== 'json') return

    // 文本节点的 in-text 直接写入 props.text（节点正文）
    if (shape.props.nodeType === 'text' && port.id === 'in-text') {
      const current = editor.getShape<NodeCardShape>(shape.id)
      if (!current || current.props.text === value) return
      editor.updateShape({ id: shape.id, type: 'node-card', props: { text: value } })
      markUndoPoint(editor, 'contract-text-input')
      return
    }

    // 其他节点的文本测试输入：持久化到 config._testInputs，下次打开面板自动回填
    try {
      const config = shape.props.config ? JSON.parse(shape.props.config) : {}
      const testInputs = (config[TEST_INPUTS_KEY] ?? {}) as Record<
        string,
        { type: PortType; value: string }
      >
      if (testInputs[port.id]?.value === value) return
      if (value) {
        testInputs[port.id] = { type, value }
      } else {
        delete testInputs[port.id]
      }
      const hasInputs = Object.keys(testInputs).length > 0
      if (hasInputs) config[TEST_INPUTS_KEY] = testInputs
      else delete config[TEST_INPUTS_KEY]
      const configStr = JSON.stringify(config)
      const current = editor.getShape<NodeCardShape>(shape.id)
      if (!current || current.props.config === configStr) return
      editor.updateShape({ id: shape.id, type: 'node-card', props: { config: configStr } })
      markUndoPoint(editor, 'contract-test-input')
    } catch {
      // 配置解析失败时静默跳过，不影响测试本身
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
        <div className="contract-scroll">
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
            <TestHarness
              key={shape.id}
              projectId={projectId}
              ports={ports.in}
              onRun={testNode}
              onTextInputCommit={syncTextInputOnBlur}
              initialTextInputs={loadTestInputsFromConfig(shape)}
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
      </div>
    </aside>
  )
}
