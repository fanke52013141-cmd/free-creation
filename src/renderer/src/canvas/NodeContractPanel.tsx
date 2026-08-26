import { useEffect } from 'react'
import type { Editor } from 'tldraw'
import type { PortDecl } from '@shared/types'
import { getNodeType } from '../nodes/registry'
import type { NodeCardShape } from './NodeCardShape'
import { Icon } from '../components/Icon'
import { projectNodeOutputs, type NodeValue } from '../nodes/nodeValues'
import { useNodePanelStore } from '../stores/nodePanel'

interface NodeContractPanelProps {
  editor: Editor
  onClose: () => void
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
  if (value.kind === 'text') {
    const compact = value.text.replace(/\s+/g, ' ').trim()
    return compact.length > 70 ? `${compact.slice(0, 70)}…` : compact
  }
  if (value.kind === 'json') {
    const compact = JSON.stringify(value.data)
    return compact.length > 70 ? `${compact.slice(0, 70)}…` : compact
  }
  return `${value.mime || value.kind} · ${value.mediaId || '本地资产'}`
}

export function NodeContractPanel({
  editor,
  onClose
}: NodeContractPanelProps): React.JSX.Element | null {
  const shapeId = useNodePanelStore((s) => s.shapeId)

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
  if (!shape || shape.props.nodeType === 'chat') return null
  const spec = getNodeType(shape.props.nodeType)
  if (!spec) return null

  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  const inputPreviews = new Map<string, string>()
  const outputPreviews = new Map<string, string>()
  const ownOutputs = projectNodeOutputs(shape)
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
        <p className="contract-description">{spec.description}</p>
        <div className="contract-rule">
          连线会把上游端口的真实输出填入对应输入；没有连线时才使用节点内的固定内容。
        </div>
        <PortRows
          title="输入"
          ports={spec.ports.in}
          connections={incoming}
          previews={inputPreviews}
        />
        <PortRows
          title="输出"
          ports={spec.ports.out}
          connections={outgoing}
          previews={outputPreviews}
        />
      </div>
    </aside>
  )
}
