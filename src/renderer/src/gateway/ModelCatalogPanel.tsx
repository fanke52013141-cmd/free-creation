import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  Capability,
  Connection,
  FeatureBinding,
  ModelDefinition,
  ModelOperation
} from '@free-creation/model-contracts'
import { useGatewayStore } from '../stores/gateway'
import { toast } from '../stores/toast'
import { useConfirmStore } from '../stores/confirm'
import './ModelCatalogPanel.css'

type FeatureChoice = { key: string; label: string; hint: string; operation: ModelOperation }

const featureChoices: FeatureChoice[] = [
  { key: 'chat.generate', label: 'AI 对话', hint: '用于对话节点', operation: 'text.generate' },
  { key: 'text.process', label: '文本处理', hint: '用于 AI 处理节点', operation: 'text.generate' },
  { key: 'script.breakdown', label: '剧本拆解', hint: '用于剧本节点', operation: 'text.generate' },
  { key: 'image.generate', label: '图片生成', hint: '用于生图节点', operation: 'image.generate' },
  { key: 'image.edit', label: '图片编辑', hint: '用于图片编辑节点', operation: 'image.edit' },
  { key: 'video.generate', label: '视频生成', hint: '用于视频节点', operation: 'video.generate' },
  {
    key: 'speech.synthesize',
    label: '语音合成',
    hint: '用于配音节点',
    operation: 'speech.synthesize'
  },
  { key: 'voice.clone', label: '语音克隆', hint: '用于音色复刻节点', operation: 'voice.clone' },
  { key: 'voice.design', label: '音色设计', hint: '用于音色设计节点', operation: 'voice.design' }
]

const protocolOptions: Array<{ value: Connection['protocol']; label: string }> = [
  { value: 'openai-compatible', label: 'OpenAI 兼容（中转站 / 自定义）' },
  { value: 'openai', label: 'OpenAI 官方' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'google', label: 'Google Gemini' },
  { value: 'anthropic', label: 'Anthropic Claude' },
  { value: 'minimax', label: 'MiniMax' },
  { value: 'volcengine', label: '火山引擎 / 豆包' },
  { value: 'toapis', label: 'ToAPIs' },
  { value: 'custom', label: '其他自定义协议' }
]

const id = (): string => crypto.randomUUID()

export function ModelCatalogPanel(): React.JSX.Element | null {
  const open = useGatewayStore((s) => s.catalogOpen)
  const close = useGatewayStore((s) => s.closeCatalog)
  const [connections, setConnections] = useState<Connection[]>([])
  const [models, setModels] = useState<ModelDefinition[]>([])
  const [bindings, setBindings] = useState<FeatureBinding[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [connectionName, setConnectionName] = useState('')
  const [modelId, setModelId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1')
  const [protocol, setProtocol] = useState<Connection['protocol']>('openai-compatible')
  const [featureKey, setFeatureKey] = useState('image.generate')
  const [busy, setBusy] = useState(false)

  const selectedFeature = useMemo(
    () => featureChoices.find((choice) => choice.key === featureKey) ?? featureChoices[0],
    [featureKey]
  )

  const load = async (): Promise<void> => {
    const [connectionResult, modelResult, bindingResult] = await Promise.all([
      window.api.models.listConnections(),
      window.api.models.listDefinitions(),
      window.api.models.listBindings()
    ])
    if (connectionResult.ok) {
      setConnections(connectionResult.data)
      setConnectionId((current) => current || connectionResult.data[0]?.id || '')
    }
    if (modelResult.ok) setModels(modelResult.data)
    if (bindingResult.ok) setBindings(bindingResult.data)
  }

  useEffect(() => {
    if (open) void load()
  }, [open])
  if (!open) return null

  const saveConnection = async (): Promise<void> => {
    if (!connectionName.trim() || !baseUrl.trim() || !apiKey.trim())
      return toast('请填写连接名称、API 地址和 API Key')
    setBusy(true)
    const result = await window.api.models.saveConnection({
      id: id(),
      name: connectionName.trim(),
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      protocol
    })
    setBusy(false)
    if (!result.ok) return toast(`保存连接失败：${result.error.message}`)
    setConnectionId(result.data.id)
    setApiKey('')
    await load()
    toast('连接已保存。下一步填写模型 ID。')
  }

  const saveModel = async (): Promise<void> => {
    if (!connectionId || !modelId.trim())
      return toast(connectionId ? '请填写模型 ID' : '请先保存或选择一个连接')
    const capabilities: Capability[] = [
      {
        operation: selectedFeature.operation,
        asynchronous: ['video.generate', 'voice.clone', 'voice.design'].includes(
          selectedFeature.operation
        ),
        streaming: selectedFeature.operation === 'text.generate',
        acceptedAssetKinds: [],
        producedAssetKinds: [],
        controls: {}
      }
    ]
    setBusy(true)
    const result = await window.api.models.saveDefinition({
      id: id(),
      connectionId,
      modelId: modelId.trim(),
      name: modelId.trim(),
      capabilities,
      metadata: { defaultFeatureKey: selectedFeature.key }
    })
    setBusy(false)
    if (!result.ok) return toast(`添加模型失败：${result.error.message}`)
    setModelId('')
    await load()
    toast('模型已添加。点击“验证并启用”后即可在节点中使用。')
  }

  const validateAndEnable = async (
    model: ModelDefinition,
    operation: ModelOperation,
    feature: FeatureChoice
  ): Promise<void> => {
    const approved = await useConfirmStore.getState().confirm({
      title: `验证并启用「${feature.label}」`,
      message: `将使用 ${model.name} 发起一次最低成本的真实调用，可能产生费用。成功后会自动在对应节点启用它。`,
      confirmText: '验证并启用',
      danger: true
    })
    if (!approved) return
    setBusy(true)
    const validation = await window.api.models.validate({
      connectionId: model.connectionId,
      modelDefinitionId: model.id,
      operation,
      allowCost: true
    })
    if (!validation.ok || validation.data.status !== 'verified') {
      setBusy(false)
      return toast(
        validation.ok
          ? `验证未通过：${validation.data.message}`
          : `验证失败：${validation.error.message}`
      )
    }
    const binding = await window.api.models.saveBinding({
      featureKey: feature.key,
      connectionId: model.connectionId,
      modelDefinitionId: model.id,
      operation
    })
    setBusy(false)
    if (!binding.ok) return toast(`验证通过，但启用失败：${binding.error.message}`)
    await Promise.all([load(), useGatewayStore.getState().load()])
    toast(`已启用：${feature.label}`)
  }

  const modelsForConnection = models.filter((model) => model.connectionId === connectionId)
  const bindingFor = (
    model: ModelDefinition,
    operation: ModelOperation
  ): FeatureBinding | undefined =>
    bindings.find(
      (binding) => binding.modelDefinitionId === model.id && binding.target.operation === operation
    )

  return createPortal(
    <div className="gw-mask" onClick={close}>
      <section
        className="gw-panel gw-catalog"
        role="dialog"
        aria-modal="true"
        aria-label="添加模型"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="gw-head">
          <div>
            <span className="gw-title">添加模型</span>
            <span className="gw-subtitle">配置一次，节点直接使用</span>
          </div>
          <button className="icon-btn" onClick={close} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="gw-body">
          <aside className="gw-side gw-connections">
            <div className="gw-side-head">
              <b>连接</b>
              <span>{connections.length}</span>
            </div>
            {connections.map((connection) => (
              <button
                key={connection.id}
                className={`gw-item ${connectionId === connection.id ? 'active' : ''}`}
                onClick={() => setConnectionId(connection.id)}
              >
                <span className="gw-item-name">{connection.name}</span>
                <span className="gw-item-sub">
                  {protocolOptions.find((item) => item.value === connection.protocol)?.label ??
                    connection.protocol}
                </span>
              </button>
            ))}
            {!connections.length && <p className="gw-empty">还没有连接。先在右侧添加一个。</p>}
          </aside>
          <main className="gw-main gw-catalog-main">
            <div className="gw-steps" aria-label="添加模型步骤">
              <span className="active">1 连接</span>
              <span>2 模型</span>
              <span>3 验证并启用</span>
            </div>
            <section className="gw-card">
              <div className="gw-card-head">
                <div>
                  <h2>连接到服务商</h2>
                  <p>可填写官方 API，也可填写中转站的 OpenAI 兼容地址。</p>
                </div>
              </div>
              <div className="gw-grid">
                <label>
                  <span>连接名称</span>
                  <input
                    className="gw-input"
                    value={connectionName}
                    placeholder="例如：我的 ToAPIs"
                    onChange={(event) => setConnectionName(event.target.value)}
                  />
                </label>
                <label>
                  <span>服务商类型</span>
                  <select
                    className="gw-input"
                    value={protocol}
                    onChange={(event) => setProtocol(event.target.value as Connection['protocol'])}
                  >
                    {protocolOptions.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="wide">
                  <span>API 地址</span>
                  <input
                    className="gw-input"
                    value={baseUrl}
                    placeholder="https://api.example.com/v1"
                    onChange={(event) => setBaseUrl(event.target.value)}
                  />
                </label>
                <label className="wide">
                  <span>API Key</span>
                  <input
                    className="gw-input"
                    type="password"
                    value={apiKey}
                    placeholder="粘贴 API Key，仅加密保存于本机"
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                </label>
              </div>
              <button className="btn-primary" disabled={busy} onClick={() => void saveConnection()}>
                保存连接
              </button>
            </section>
            <section className={`gw-card ${connectionId ? '' : 'is-disabled'}`}>
              <div className="gw-card-head">
                <div>
                  <h2>添加一个模型</h2>
                  <p>选择它在项目里要做的事；系统会自动配置对应节点。</p>
                </div>
              </div>
              <div className="gw-grid">
                <label className="wide">
                  <span>用于什么</span>
                  <select
                    className="gw-input"
                    disabled={!connectionId}
                    value={featureKey}
                    onChange={(event) => setFeatureKey(event.target.value)}
                  >
                    {featureChoices.map((choice) => (
                      <option key={choice.key} value={choice.key}>
                        {choice.label} · {choice.hint}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="wide">
                  <span>模型 ID</span>
                  <input
                    className="gw-input"
                    disabled={!connectionId}
                    value={modelId}
                    placeholder="例如 gpt-image-1、seedance-2.0、MiniMax-H3"
                    onChange={(event) => setModelId(event.target.value)}
                  />
                </label>
              </div>
              <button
                className="btn-ghost"
                disabled={busy || !connectionId}
                onClick={() => void saveModel()}
              >
                添加模型
              </button>
            </section>
            <section className="gw-model-section">
              <div className="gw-card-head">
                <div>
                  <h2>已添加的模型</h2>
                  <p>验证会真实调用一次；成功后自动出现在对应节点。</p>
                </div>
              </div>
              <div className="gw-models">
                {modelsForConnection.flatMap((model) =>
                  model.capabilities.map((capability) => {
                    const binding = bindingFor(model, capability.operation)
                    const savedFeatureKey =
                      typeof model.metadata.defaultFeatureKey === 'string'
                        ? model.metadata.defaultFeatureKey
                        : undefined
                    const choice =
                      (binding
                        ? featureChoices.find((item) => item.key === binding.featureKey)
                        : featureChoices.find((item) => item.key === savedFeatureKey)) ??
                      featureChoices.find((item) => item.operation === capability.operation) ??
                      selectedFeature
                    return (
                      <article
                        className="gw-model-card"
                        key={`${model.id}:${capability.operation}`}
                      >
                        <div>
                          <strong>{model.name}</strong>
                          <span>
                            {choice.label} · {choice.hint}
                          </span>
                        </div>
                        {binding ? (
                          <span className="gw-status ok">已启用</span>
                        ) : (
                          <button
                            className="btn-primary small"
                            disabled={busy}
                            onClick={() =>
                              void validateAndEnable(model, capability.operation, choice)
                            }
                          >
                            验证并启用
                          </button>
                        )}
                      </article>
                    )
                  })
                )}
                {!modelsForConnection.length && (
                  <div className="gw-empty big">
                    保存连接后，在上方填写模型 ID。
                    <br />
                    添加的模型会显示在这里。
                  </div>
                )}
              </div>
            </section>
          </main>
        </div>
      </section>
    </div>,
    document.body
  )
}
