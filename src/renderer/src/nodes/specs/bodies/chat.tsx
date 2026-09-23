import { useEffect } from 'react'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import { parseChat, serializeChat, type ChatData } from '../../chatData'
import { Icon } from '../../../components/Icon'
import { ModelSelect, NoModelHint } from './shared'
import type { NodeBodyProps, NodeSettingsProps } from '../../registry'

export function ChatBody({ shape }: NodeBodyProps): React.JSX.Element {
  const providers = useGatewayStore((s) => s.providers)
  const loaded = useGatewayStore((s) => s.loaded)
  const loadProviders = useGatewayStore((s) => s.load)
  const openSettings = useGatewayStore((s) => s.openSettings)
  const options = modelsByModality(providers, 'text')
  const data = parseChat(shape.props.text)
  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

  const selectedModel = options.find((o) => o.key === data.modelKey)

  if (options.length === 0) {
    return <NoModelHint onOpen={() => openSettings()} presetIds={['relay']} />
  }

  const modelName = selectedModel
    ? selectedModel.model.name || selectedModel.model.id
    : '未选择模型'

  return (
    <div className="chat-body-compact">
      <div className="chat-compact-model">
        <Icon name="chat" size={14} />
        {modelName}
      </div>
    </div>
  )
}

/**
 * 对话也是标准节点：模型与生成参数由右侧详情的「设置」承担；沉浸式聊天窗口只负责
 * 会话历史和消息编辑。输入/输出端口则由 NodeContractPanel 的 I/O 页统一解释。
 */
export function ChatSettings({ shape, editor }: NodeSettingsProps): React.JSX.Element {
  const providers = useGatewayStore((state) => state.providers)
  const loaded = useGatewayStore((state) => state.loaded)
  const loadProviders = useGatewayStore((state) => state.load)
  const openSettings = useGatewayStore((state) => state.openSettings)
  const data = parseChat(shape.props.text)
  const options = modelsByModality(providers, 'text')

  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

  const save = (patch: Partial<ChatData>): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { text: serializeChat({ ...data, ...patch }) }
    })
  }

  if (options.length === 0) {
    return <NoModelHint onOpen={() => openSettings()} presetIds={['relay']} />
  }

  return (
    <section className="node-settings chat-node-settings">
      <div className="settings-row">
        <span className="opt-label">模型</span>
        <ModelSelect
          value={data.modelKey}
          options={options}
          onChange={(modelKey) => save({ modelKey })}
        />
      </div>
      <p className="contract-settings-hint">
        本节点的上游文本经 <code>in-text</code> 进入当前会话；最后一条助手回复从{' '}
        <code>out-markdown</code> 提供给下游。历史会话和消息编辑在对话工作区中管理。
      </p>
      <label className="settings-field" htmlFor={`chat-system-${shape.id}`}>
        系统提示词
        <textarea
          id={`chat-system-${shape.id}`}
          className="node-textarea"
          defaultValue={data.system}
          rows={4}
          placeholder="人设、输出格式或创作要求…"
          onBlur={(event) => save({ system: event.currentTarget.value })}
        />
      </label>
      <div className="settings-row ai-process-number-settings">
        <label className="opt-label" htmlFor={`chat-temperature-${shape.id}`}>
          温度
        </label>
        <input
          id={`chat-temperature-${shape.id}`}
          type="number"
          min="0"
          max="2"
          step="0.05"
          value={data.temperature}
          onChange={(event) => save({ temperature: Number(event.target.value) || 0 })}
        />
        <label className="opt-label" htmlFor={`chat-tokens-${shape.id}`}>
          最大输出
        </label>
        <input
          id={`chat-tokens-${shape.id}`}
          type="number"
          min="256"
          step="256"
          value={data.maxTokens}
          onChange={(event) => save({ maxTokens: Number(event.target.value) || 4096 })}
        />
      </div>
    </section>
  )
}
