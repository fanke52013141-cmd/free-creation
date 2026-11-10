/* eslint-disable react-hooks/set-state-in-effect -- 弹窗异步加载版本与历史后填充表单 */
import { useEffect, useState } from 'react'
import type { CompositeCapabilitySummary, CompositeVersionRecord } from '@shared/composite/types'
import type { CompositeManifest } from '@shared/composite/manifest'
import { Icon } from '../components/Icon'
import { toast } from '../stores/toast'
import { CompositeBoundaryEditor } from '../composite/CompositeBoundaryEditor'
import './composite-editor.css'
import '../library/library.css'

type Tab = 'graph' | 'io' | 'versions'

interface Props {
  capability: CompositeCapabilitySummary
  mode: 'edit' | 'next'
  onClose: () => void
  onPublished: () => void
}

function nextVersion(version: string | null): string {
  const major = Number.parseInt(version ?? '0', 10)
  return `${Number.isFinite(major) ? major + 1 : 1}.0`
}

function versionLabel(version: string | null): string {
  return (version ?? '—').replace(/\.0\.0$/, '.0')
}

function nodeTitle(node: CompositeManifest['graph']['nodes'][number]): string {
  return node.title || node.nodeType
}

export function CompositeVersionDialog({
  capability,
  mode,
  onClose,
  onPublished
}: Props): React.JSX.Element {
  const [manifest, setManifest] = useState<CompositeManifest | null>(null)
  const [versions, setVersions] = useState<CompositeVersionRecord[]>([])
  const [name, setName] = useState(capability.name)
  const [description, setDescription] = useState(capability.description)
  const [version, setVersion] = useState(nextVersion(capability.latestVersion))
  const [tab, setTab] = useState<Tab>('graph')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const latest = capability.latestVersion
    if (!latest) {
      setError('该组合还没有已发布版本')
      return
    }
    void Promise.all([
      window.api.composite.versionGet({ capabilityId: capability.id, version: latest }),
      window.api.composite.versionList(capability.id)
    ]).then(([current, history]) => {
      if (!current.ok || !current.data) {
        setError('读取组合版本失败')
        return
      }
      setManifest(current.data.manifest)
      setName(current.data.manifest.name)
      setDescription(current.data.manifest.description ?? '')
      setVersion(mode === 'edit' ? versionLabel(latest) : nextVersion(latest))
      setSelectedNodeId(current.data.manifest.graph.nodes[0]?.id ?? null)
      if (history.ok) setVersions(history.data)
    })
  }, [capability, mode])

  const loadVersion = async (record: CompositeVersionRecord): Promise<void> => {
    const result = await window.api.composite.versionGet({
      capabilityId: capability.id,
      version: record.version
    })
    if (!result.ok || !result.data) return setError('读取版本失败')
    setManifest(result.data.manifest)
    setName(result.data.manifest.name)
    setDescription(result.data.manifest.description ?? '')
    setVersion(versionLabel(record.version))
    setSelectedNodeId(result.data.manifest.graph.nodes[0]?.id ?? null)
    setError('')
    toast(`已载入 v${versionLabel(record.version)}，保存会更新该版本`)
  }

  const updateNodeConfig = (nodeId: string, config: string): void => {
    setManifest((current) =>
      current
        ? {
            ...current,
            graph: {
              ...current.graph,
              nodes: current.graph.nodes.map((node) =>
                node.id === nodeId ? { ...node, config } : node
              )
            }
          }
        : current
    )
  }

  const publish = async (): Promise<void> => {
    if (!manifest) return setError('版本尚未加载')
    const edited: CompositeManifest = {
      ...manifest,
      version,
      name: name.trim() || manifest.name,
      description: description.trim() || undefined
    }
    setBusy(true)
    setError('')
    try {
      const validated = await window.api.composite.validate({ manifest: edited })
      if (!validated.ok) throw new Error(validated.error.message)
      if (!validated.data.ok) {
        throw new Error(
          validated.data.issues.map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`).join('；')
        )
      }
      const published = await window.api.composite.publish({ manifest: edited })
      if (!published.ok) throw new Error(published.error.message)
      toast(`已发布「${edited.name}」v${versionLabel(version)}`)
      onPublished()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const selectedNode = manifest?.graph.nodes.find((node) => node.id === selectedNodeId) ?? null
  const inputCount = manifest?.inputs.length ?? 0
  const outputCount = manifest?.outputs.length ?? 0

  return (
    <div
      className="composite-sheet-mask"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      <section className="composite-sheet" role="dialog" aria-modal="true" aria-label="组合能力编辑">
        <header className="composite-sheet-header">
          <button type="button" className="btn-ghost small" aria-label="关闭" onClick={onClose} disabled={busy}>
            <Icon name="close" size={16} />
          </button>
          <div className="composite-sheet-heading">
            <h2>{name || capability.name}</h2>
            <span className="composite-version-pill">v{versionLabel(version)}</span>
            <span className="composite-status-pill">{mode === 'edit' ? '已发布' : '草稿'}</span>
          </div>
        </header>

        <div className="composite-sheet-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'graph'} className={`composite-sheet-tab ${tab === 'graph' ? 'is-active' : ''}`} onClick={() => setTab('graph')}>
            节点图
          </button>
          <button type="button" role="tab" aria-selected={tab === 'io'} className={`composite-sheet-tab ${tab === 'io' ? 'is-active' : ''}`} onClick={() => setTab('io')}>
            输入输出
          </button>
          <button type="button" role="tab" aria-selected={tab === 'versions'} className={`composite-sheet-tab ${tab === 'versions' ? 'is-active' : ''}`} onClick={() => setTab('versions')}>
            版本历史
          </button>
        </div>

        <div className="composite-sheet-body">
          {tab === 'graph' && manifest && (
            <>
              <div className="composite-section">
                <div className="composite-section-title">
                  <span>内部节点 · {manifest.graph.nodes.length} 个</span>
                  <span style={{ color: '#78869c', fontWeight: 400 }}>点击节点编辑配置</span>
                </div>
                <div className="composite-graph-strip">
                  {manifest.graph.nodes.map((node, index) => (
                    <span key={node.id} style={{ display: 'contents' }}>
                      {index > 0 && <span className="composite-graph-link">→</span>}
                      <button
                        type="button"
                        className={`composite-graph-node ${node.id === selectedNodeId ? 'is-selected' : ''}`}
                        onClick={() => setSelectedNodeId(node.id)}
                      >
                        {nodeTitle(node)}
                        <span>{node.nodeType} · {node.id}</span>
                      </button>
                    </span>
                  ))}
                </div>
                {selectedNode && (
                  <div className="composite-node-editor">
                    <label className="composite-section-title" style={{ marginBottom: 6 }}>
                      <span>{nodeTitle(selectedNode)} · 节点配置（JSON）</span>
                    </label>
                    <textarea
                      aria-label={`${nodeTitle(selectedNode)} 节点配置`}
                      value={selectedNode.config ?? ''}
                      placeholder="{}"
                      onChange={(event) => updateNodeConfig(selectedNode.id, event.target.value)}
                    />
                    <p style={{ color: '#78869c', fontSize: 10, margin: '6px 0 0' }}>
                      这里修改的是该内部节点的固定配置（模型、系统提示词等）；文本正文在文本节点中单独维护。
                    </p>
                  </div>
                )}
              </div>
              <div className="composite-section">
                <div className="composite-section-title"><span>组合信息</span></div>
                <label className="library-form-field">
                  <span>名称</span>
                  <input value={name} onChange={(event) => setName(event.target.value)} />
                </label>
                <label className="library-form-field">
                  <span>说明</span>
                  <input value={description} onChange={(event) => setDescription(event.target.value)} />
                </label>
                <label className="library-form-field">
                  <span>版本（主版本整数）</span>
                  <input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="1.0" />
                </label>
              </div>
            </>
          )}

          {tab === 'io' && manifest && (
            <>
              <div className="composite-section">
                <div className="composite-section-title"><span>公开端口</span><span style={{ color: '#78869c', fontWeight: 400 }}>{inputCount} 输入 · {outputCount} 输出</span></div>
                {manifest.inputs.map((input) => (
                  <div className="composite-io-row" key={`in-${input.id}`}>
                    <span className="composite-io-badge">IN</span>
                    <span>{input.label}</span>
                    <span style={{ color: '#78869c' }}>{input.type}</span>
                  </div>
                ))}
                {manifest.outputs.map((output) => (
                  <div className="composite-io-row" key={`out-${output.id}`}>
                    <span className="composite-io-badge">OUT</span>
                    <span>{output.label}</span>
                    <span style={{ color: '#78869c' }}>{output.type}</span>
                  </div>
                ))}
              </div>
              <CompositeBoundaryEditor manifest={manifest} disabled={busy} onChange={setManifest} />
            </>
          )}

          {tab === 'versions' && (
            <div className="composite-section">
              <div className="composite-section-title"><span>版本历史</span><span style={{ color: '#78869c', fontWeight: 400 }}>{versions.length} 个版本</span></div>
              {versions.length === 0 && <p style={{ color: '#78869c', fontSize: 11 }}>暂无历史版本</p>}
              {versions.map((record) => (
                <div className={`composite-version-row ${versionLabel(record.version) === versionLabel(version) ? 'is-current' : ''}`} key={record.version}>
                  <span>v{versionLabel(record.version)}</span>
                  <span style={{ color: '#78869c' }}>{new Date(record.publishedAt).toLocaleString()}</span>
                  <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void loadVersion(record)}>
                    查看/载入
                  </button>
                </div>
              ))}
              <p style={{ color: '#78869c', fontSize: 10, margin: '8px 0 0' }}>
                载入旧版本后发布，会以当前版本号保存；要保留旧版请先把版本号改成新的主版本。
              </p>
            </div>
          )}

          {error && <div className="composite-sheet-error" role="alert">{error}</div>}
        </div>

        <footer className="composite-sheet-footer">
          <span className="hint">修改保存为草稿；发布后按主版本号生成/更新版本</span>
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="library-form-primary" disabled={busy || !manifest} onClick={() => void publish()}>
            {busy ? '发布中…' : '发布新版本'}
          </button>
        </footer>
      </section>
    </div>
  )
}
