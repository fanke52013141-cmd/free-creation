// 对话节点 Body（路线图 R6：bodies.tsx 拆分）
//
// 执行器取本轮提问的顺序是「历史里最后一条 user 消息」优先，其次才是 in-text 连线，
// 两者都没有时直接跳过。紧凑卡片必须把这一点写出来，否则用户只会看到点了运行没反应。
import { useEffect } from 'react'
import { useEditor, useValue } from 'tldraw'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import { parseChat } from '../../chatData'
import { countIncomingConnections } from '../../../canvas/graph'
import { Icon } from '../../../components/Icon'
import { NoModelHint } from './shared'
import type { NodeBodyProps } from '../../registry'

export function ChatBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const providers = useGatewayStore((s) => s.providers)
  const loaded = useGatewayStore((s) => s.loaded)
  const loadProviders = useGatewayStore((s) => s.load)
  const openSettings = useGatewayStore((s) => s.openSettings)
  const options = modelsByModality(providers, 'text')
  const data = parseChat(shape.props.text)
  const textCount = useValue(
    'chat text inputs',
    () => countIncomingConnections(editor, shape.id, 'in-text'),
    [editor, shape.id]
  )

  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

  const selectedModel = options.find((o) => o.key === data.modelKey)

  if (options.length === 0) {
    return <NoModelHint onOpen={() => openSettings()} />
  }

  const modelName = selectedModel
    ? selectedModel.model.name || selectedModel.model.id
    : '未选择模型'
  // 与 chatExecutor 的分支顺序一致：末条 user 消息优先，且此时忽略 in-text。
  const pendingQuestion = data.messages.at(-1)?.role === 'user'
  const documentCount = data.documents?.length ?? 0
  const runState: { tone: 'ok' | 'warn'; text: string } = pendingQuestion
    ? { tone: 'ok', text: '最后一条是你的提问，本轮直接发送' }
    : textCount > 0
      ? { tone: 'ok', text: `in-text ${textCount} 条拼接成本轮提问` }
      : { tone: 'warn', text: '无待发送提问且 in-text 未连线，运行会跳过' }

  return (
    <div className="chat-body-compact">
      <div className="chat-compact-model">
        <Icon name="chat" size={14} />
        {modelName}
      </div>
      <div className="chat-compact-stats">
        <span>
          {data.messages.length > 0 ? `${data.messages.length} 条对话` : '暂无对话'}
          {' · 温度 '}
          {data.temperature.toFixed(1)}
          {' · 上限 '}
          {data.maxTokens}
        </span>
        {documentCount > 0 && (
          <span title="参考文档随每轮请求写入系统提示词">{` · 文档 ${documentCount} 篇`}</span>
        )}
        {Boolean(data.summary) && (
          <span title="超过 20 轮后自动压缩出的历史摘要">{' · 含摘要'}</span>
        )}
      </div>
      <div className={`chat-compact-run ${runState.tone}`}>
        <span>{runState.text}</span>
        <code className="variable-expr">out-markdown</code>
      </div>
      <div className="chat-compact-hint">选中此节点 → 右侧面板对话</div>
    </div>
  )
}
