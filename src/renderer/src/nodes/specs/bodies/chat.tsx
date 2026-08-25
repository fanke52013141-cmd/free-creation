// 对话节点 Body（路线图 R6：bodies.tsx 拆分）
import { useEffect } from 'react'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import { parseChat } from '../../chatData'
import { Icon } from '../../../components/Icon'
import type { NodeBodyProps } from '../../registry'

export function ChatBody({ shape }: NodeBodyProps): React.JSX.Element {
  const providers = useGatewayStore((s) => s.providers)
  const loaded = useGatewayStore((s) => s.loaded)
  const loadProviders = useGatewayStore((s) => s.load)
  const options = modelsByModality(providers, 'text')
  const data = parseChat(shape.props.text)

  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

  const selectedModel = options.find((o) => o.key === data.modelKey)
  const modelName = selectedModel
    ? selectedModel.model.name || selectedModel.model.id
    : '未选择模型'

  return (
    <div className="chat-body-compact">
      <div className="chat-compact-model">
        <Icon name="chat" size={14} />
        {modelName}
      </div>
      <div className="chat-compact-stats">
        {data.messages.length > 0 ? `${data.messages.length} 条对话` : '暂无对话'}
        {' · '}T{data.temperature.toFixed(1)} · {data.maxTokens} tok
      </div>
      <div className="chat-compact-hint">选中此节点 → 右侧面板对话</div>
    </div>
  )
}
