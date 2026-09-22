import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Capability, Connection, ModelDefinition, ModelOperation } from '@free-creation/model-contracts'
import { useGatewayStore } from '../stores/gateway'
import { toast } from '../stores/toast'
import { useConfirmStore } from '../stores/confirm'
import './ModelCatalogPanel.css'

type Category = 'text' | 'image' | 'video' | 'speech' | 'clone' | 'design'
const categories: Array<{ value: Category; label: string; operations: ModelOperation[] }> = [
  { value: 'text', label: '文本模型', operations: ['text.generate'] },
  { value: 'image', label: '图片模型', operations: ['image.generate', 'image.edit'] },
  { value: 'video', label: '视频模型', operations: ['video.generate'] },
  { value: 'speech', label: '语音合成', operations: ['speech.synthesize'] },
  { value: 'clone', label: '语音克隆', operations: ['voice.clone'] },
  { value: 'design', label: '音色设计', operations: ['voice.design'] }
]
const protocolOptions: Array<{ value: Connection['protocol']; label: string }> = [
  { value: 'openai-compatible', label: 'OpenAI 兼容（中转站 / 自定义）' }, { value: 'openai', label: 'OpenAI 官方' }, { value: 'openrouter', label: 'OpenRouter' }, { value: 'google', label: 'Google Gemini' }, { value: 'anthropic', label: 'Anthropic Claude' }, { value: 'minimax', label: 'MiniMax' }, { value: 'volcengine', label: '火山引擎 / 豆包' }, { value: 'toapis', label: 'ToAPIs' }, { value: 'custom', label: '其他自定义协议' }
]
const uuid = (): string => crypto.randomUUID()
const categoryOf = (model: ModelDefinition): Category => {
  const ops = model.capabilities.map((x) => x.operation)
  if (ops.some((x) => x.startsWith('image.'))) return 'image'
  if (ops.some((x) => x.startsWith('video.'))) return 'video'
  if (ops.includes('speech.synthesize')) return 'speech'
  if (ops.includes('voice.clone')) return 'clone'
  if (ops.includes('voice.design')) return 'design'
  return 'text'
}
const makeCapabilities = (category: Category, imageEdit: boolean): Capability[] => {
  const all = categories.find((x) => x.value === category)!.operations
  const ops: ModelOperation[] = category === 'image' && !imageEdit ? ['image.generate'] : all
  return ops.map((operation) => ({ operation, asynchronous: ['video.generate', 'voice.clone', 'voice.design'].includes(operation), streaming: operation === 'text.generate', acceptedAssetKinds: [], producedAssetKinds: [], controls: {} }))
}

export function ModelCatalogPanel(): React.JSX.Element | null {
  const open = useGatewayStore((s) => s.catalogOpen)
  const close = useGatewayStore((s) => s.closeCatalog)
  const [connections, setConnections] = useState<Connection[]>([])
  const [models, setModels] = useState<ModelDefinition[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [connectionName, setConnectionName] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1')
  const [apiKey, setApiKey] = useState('')
  const [protocol, setProtocol] = useState<Connection['protocol']>('openai-compatible')
  const [editingModelId, setEditingModelId] = useState('')
  const [modelId, setModelId] = useState('')
  const [modelName, setModelName] = useState('')
  const [category, setCategory] = useState<Category>('text')
  const [imageEdit, setImageEdit] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [discovered, setDiscovered] = useState<Array<{ id: string; name: string }>>([])
  const [busy, setBusy] = useState(false)
  const load = async (): Promise<void> => {
    const [connectionResult, modelResult] = await Promise.all([window.api.models.listConnections(), window.api.models.listDefinitions()])
    if (connectionResult.ok) { setConnections(connectionResult.data); setConnectionId((x) => x || connectionResult.data[0]?.id || '') }
    if (modelResult.ok) setModels(modelResult.data)
  }
  useEffect(() => { if (open) void load() }, [open])
  const dialogRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!open) return
    dialogRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])
  const currentConnection = connections.find((x) => x.id === connectionId)
  const connectionModels = models.filter((x) => x.connectionId === connectionId)
  const visibleModels = useMemo(() => { const needle = query.trim().toLowerCase(); return needle ? connectionModels.filter((x) => `${x.name} ${x.modelId}`.toLowerCase().includes(needle)) : connectionModels }, [connectionModels, query])
  // Hooks must run in the same order while the catalog opens/closes. Keep this return after
  // all hooks; otherwise the first open adds useMemo and React raises production error #310.
  if (!open) return null
  const resetConnection = (): void => { setConnectionId(''); setConnectionName(''); setBaseUrl('https://api.openai.com/v1'); setApiKey(''); setProtocol('openai-compatible'); setDiscovered([]); setSelected(new Set()) }
  const chooseConnection = (x: Connection): void => { setConnectionId(x.id); setConnectionName(x.name); setBaseUrl(x.baseUrl); setProtocol(x.protocol); setApiKey(''); setDiscovered([]); setSelected(new Set()) }
  const resetModel = (): void => { setEditingModelId(''); setModelId(''); setModelName(''); setCategory('text'); setImageEdit(false) }
  const saveConnection = async (): Promise<void> => {
    if (!connectionName.trim() || !baseUrl.trim()) return toast('请填写连接名称和 API 地址')
    if (!connectionId && !apiKey.trim()) return toast('新连接必须填写 API Key')
    setBusy(true); const result = await window.api.models.saveConnection({ id: connectionId || uuid(), name: connectionName.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined, protocol }); setBusy(false)
    if (!result.ok) return toast(`保存连接失败：${result.error.message}`)
    chooseConnection(result.data); await load(); toast('连接已保存')
  }
  const deleteConnection = async (): Promise<void> => {
    if (!currentConnection) return
    if (!await useConfirmStore.getState().confirm({ title: `删除连接「${currentConnection.name}」`, message: '该连接下的模型、验证记录和旧功能绑定会一并删除；画布和已生成素材不会删除。', confirmText: '删除连接', danger: true })) return
    setBusy(true); const result = await window.api.models.deleteConnection({ connectionId }); setBusy(false)
    if (!result.ok) return toast(`删除连接失败：${result.error.message}`)
    resetConnection(); await Promise.all([load(), useGatewayStore.getState().load()]); toast('连接及其模型已删除')
  }
  const saveModel = async (): Promise<void> => {
    if (!connectionId || !modelId.trim()) return toast(connectionId ? '请填写模型 ID' : '请先保存或选择一个连接')
    setBusy(true); const result = await window.api.models.saveDefinition({ id: editingModelId || uuid(), connectionId, modelId: modelId.trim(), name: modelName.trim() || modelId.trim(), capabilities: makeCapabilities(category, imageEdit), metadata: { category } }); setBusy(false)
    if (!result.ok) return toast(`保存模型失败：${result.error.message}`)
    const wasEditing = Boolean(editingModelId); resetModel(); await load(); toast(wasEditing ? '模型已更新' : '模型已添加')
  }
  const editModel = (model: ModelDefinition): void => { const next = categoryOf(model); setEditingModelId(model.id); setModelId(model.modelId); setModelName(model.name); setCategory(next); setImageEdit(next === 'image' && model.capabilities.some((x) => x.operation === 'image.edit')) }
  const validateModel = async (model: ModelDefinition): Promise<void> => {
    const operations = model.capabilities.map((capability) => capability.operation)
    if (!await useConfirmStore.getState().confirm({ title: `验证模型「${model.name}」`, message: `将对 ${operations.join('、')} 发起最低成本的真实请求，供应商可能收费。验证只证明该能力可调用，不会把它自动指定给任何节点。`, confirmText: '开始验证', danger: true })) return
    setBusy(true)
    const results = await Promise.all(operations.map((operation) => window.api.models.validate({ connectionId: model.connectionId, modelDefinitionId: model.id, operation, allowCost: true })))
    setBusy(false)
    const failed = results.find((result) => !result.ok || result.data.status !== 'verified')
    if (failed) return toast(!failed.ok ? `验证失败：${failed.error.message}` : `验证未通过：${failed.data.message}`)
    await useGatewayStore.getState().load(); toast('验证通过；兼容节点现在可以引用该模型')
  }
  const discover = async (): Promise<void> => {
    if (!connectionId) return
    setBusy(true); const result = await window.api.models.discover({ connectionId }); setBusy(false)
    if (!result.ok) return toast(result.error.message)
    setDiscovered(result.data); toast(`已拉取 ${result.data.length} 个可用模型`)
  }
  const deleteModels = async (ids: string[]): Promise<void> => {
    if (!ids.length) return
    if (!await useConfirmStore.getState().confirm({ title: ids.length === 1 ? '删除模型' : `删除 ${ids.length} 个模型`, message: '会解除这些模型的旧功能绑定并删除本地验证记录。画布内已有的模型选择不会被自动替换。', confirmText: '删除模型', danger: true })) return
    setBusy(true); const result = await window.api.models.deleteDefinitions({ modelDefinitionIds: ids }); setBusy(false)
    if (!result.ok) return toast(`删除模型失败：${result.error.message}`)
    setSelected(new Set()); resetModel(); await Promise.all([load(), useGatewayStore.getState().load()]); toast(`已删除 ${result.data} 个模型`)
  }
  const toggle = (modelId: string): void => setSelected((current) => { const next = new Set(current); next.has(modelId) ? next.delete(modelId) : next.add(modelId); return next })
  const options = categories.find((x) => x.value === category)!
  return createPortal(<div className="gw-mask" onClick={close}><section ref={dialogRef} tabIndex={-1} className="gw-panel gw-catalog" role="dialog" aria-modal="true" aria-label="模型管理" onClick={(e) => e.stopPropagation()}>
    <header className="gw-head"><div><span className="gw-title">模型管理</span><span className="gw-subtitle">连接管理“有什么模型”；节点设置决定“引用哪个模型”。</span></div><button className="icon-btn" onClick={close} aria-label="关闭">×</button></header>
    <div className="gw-body"><aside className="gw-side gw-connections"><div className="gw-side-head"><b>连接</b><button className="gw-side-add" onClick={resetConnection}>+ 添加连接</button></div>{connections.map((x) => <button key={x.id} className={`gw-item ${connectionId === x.id ? 'active' : ''}`} onClick={() => chooseConnection(x)}><span className="gw-item-name">{x.name}</span><span className="gw-item-sub">{x.baseUrl}</span></button>)}{!connections.length && <p className="gw-empty">还没有连接</p>}</aside>
    <main className="gw-main gw-catalog-main"><section className="gw-card"><div className="gw-card-head"><div><h2>{connectionId ? '编辑连接' : '添加连接'}</h2><p>编辑时 API Key 留空即保留原值。</p></div>{connectionId && <button className="btn-ghost small danger" disabled={busy} onClick={() => void deleteConnection()}>删除连接</button>}</div><div className="gw-grid"><label><span>连接名称</span><input className="gw-input" value={connectionName} onChange={(e) => setConnectionName(e.target.value)} /></label><label><span>服务商类型</span><select className="gw-input" value={protocol} onChange={(e) => setProtocol(e.target.value as Connection['protocol'])}>{protocolOptions.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select></label><label className="wide"><span>API 地址</span><input className="gw-input" value={baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => setBaseUrl(e.target.value)} /></label><label className="wide"><span>API Key</span><input className="gw-input" type="password" value={apiKey} placeholder={connectionId ? '留空以保留已保存的 API Key' : '粘贴 API Key，仅加密保存于本机'} onChange={(e) => setApiKey(e.target.value)} /></label></div><div className="gw-actions"><button className="btn-primary" disabled={busy} onClick={() => void saveConnection()}>保存连接</button>{connectionId && <button className="btn-ghost" disabled={busy} onClick={() => void discover()}>拉取可用模型</button>}</div></section>
    {connectionId && <section className="gw-card"><div className="gw-card-head"><div><h2>{editingModelId ? '编辑模型' : '添加模型'}</h2><p>只用六种用户可见分类，不再按“用于什么节点”分组。</p></div>{editingModelId && <button className="btn-ghost small" onClick={resetModel}>取消编辑</button>}</div><div className="gw-grid"><label><span>模型 ID</span><input className="gw-input" value={modelId} placeholder="例如 gpt-image-1" onChange={(e) => setModelId(e.target.value)} /></label><label><span>显示名称</span><input className="gw-input" value={modelName} placeholder="默认使用模型 ID" onChange={(e) => setModelName(e.target.value)} /></label><label><span>模型分类</span><select className="gw-input" value={category} onChange={(e) => setCategory(e.target.value as Category)}>{categories.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select></label>{category === 'image' && <label className="gw-check"><input type="checkbox" checked={imageEdit} onChange={(e) => setImageEdit(e.target.checked)} />同时支持图片编辑</label>}</div><p className="gw-capability">声明能力：{options.operations.filter((x) => category !== 'image' || imageEdit || x !== 'image.edit').join('、')}</p><button className="btn-primary" disabled={busy} onClick={() => void saveModel()}>{editingModelId ? '保存模型' : '添加模型'}</button></section>}
    {connectionId && discovered.length > 0 && <section className="gw-discovered"><div className="gw-card-head"><div><h2>可使用模型</h2><p>从当前 URL 拉取；点击“使用”后补充分类并保存。</p></div><button className="btn-ghost small" onClick={() => setDiscovered([])}>收起</button></div><div className="gw-discovered-list">{discovered.map((x) => <button key={x.id} className="gw-discovered-row" onClick={() => { resetModel(); setModelId(x.id); setModelName(x.name) }}><span>{x.name}</span><em>使用</em></button>)}</div></section>}
     {connectionId && <section className="gw-model-section"><div className="gw-card-head"><div><h2>已添加的模型</h2><p>节点只应显示兼容且已验证的模型。</p></div><div className="gw-actions"><input className="gw-input gw-search" value={query} aria-label="搜索模型" placeholder="搜索模型" onChange={(e) => setQuery(e.target.value)} />{selected.size > 0 && <button className="btn-ghost small danger" disabled={busy} onClick={() => void deleteModels([...selected])}>删除所选（{selected.size}）</button>}</div></div><div className="gw-models">{visibleModels.map((x) => <article className="gw-model-card" key={x.id}><input aria-label={`选择 ${x.name}`} type="checkbox" checked={selected.has(x.id)} onChange={() => toggle(x.id)} /><div><strong>{x.name}</strong><span>{x.modelId} · {categories.find((item) => item.value === categoryOf(x))?.label}</span></div><button className="btn-ghost small" disabled={busy} onClick={() => void validateModel(x)}>验证</button><button className="btn-ghost small" disabled={busy} onClick={() => editModel(x)}>编辑</button><button className="btn-ghost small danger" disabled={busy} onClick={() => void deleteModels([x.id])}>删除</button></article>)}{!visibleModels.length && <div className="gw-empty big">{query ? '没有匹配的模型' : '还没有模型。可手动添加，或从 URL 拉取可用模型。'}</div>}</div></section>}</main></div>
  </section></div>, document.body)
}
