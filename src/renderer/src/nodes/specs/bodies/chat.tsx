import { NodeIdentity, NodePrimaryButton } from '../../../canvas/NodePresentation'
import { useEffect } from 'react'
import { stopEventPropagation } from 'tldraw'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import { parseChat, serializeChat, type ChatData } from '../../chatData'
import { Icon } from '../../../components/Icon'
import { NumberStepper } from '../../../components/NumberStepper'
import { ModelSelect, NoModelHint } from './shared'
import type { NodeBodyProps, NodeSettingsProps } from '../../registry'
import { useNodePanelStore } from '../../../stores/nodePanel'
import { ChatSkillAgentSettings } from './SkillAgentSettings'

export function ChatBody({ shape }: NodeBodyProps): React.JSX.Element {
  return (
    <div className="chat-body-compact">
      <NodeIdentity>
        <NodePrimaryButton
          type="button"
          className="chat-open-button"
          onPointerDown={stopEventPropagation}
          onClick={(event) => {
            event.stopPropagation()
            useNodePanelStore.getState().open('chat', shape.id, 'settings')
          }}
        >
          <Icon name="chat" size={14} />
          打开对话
        </NodePrimaryButton>
      </NodeIdentity>
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
    return (
      <section className="node-settings chat-node-settings">
        <ChatSkillAgentSettings shape={shape} editor={editor} />
        <NoModelHint />
      </section>
    )
  }

  return (
    <section className="node-settings chat-node-settings">
      <ChatSkillAgentSettings shape={shape} editor={editor} />
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
        <span className="opt-label">温度</span>
        <NumberStepper
          ariaLabel="温度"
          min={0}
          max={2}
          step={0.05}
          value={String(data.temperature)}
          onChange={(next) => {
            const value = Number(next)
            if (Number.isFinite(value)) save({ temperature: value })
          }}
        />
        <span className="opt-label">最大输出</span>
        <NumberStepper
          ariaLabel="最大输出"
          min={256}
          max={32768}
          step={256}
          value={String(data.maxTokens)}
          onChange={(next) => {
            const value = Number(next)
            // 清空输入时保留旧值，不把空串折算成 0 个 token。
            if (next.trim() && Number.isFinite(value)) save({ maxTokens: value })
          }}
        />
      </div>
    </section>
  )
}
