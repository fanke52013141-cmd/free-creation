// 对话节点模型就绪检查的读法：与执行器同源（parseChat + 同一功能键）。
// 旧实现读 props.config（对话节点并不写这里）并用功能键 text.chat，
// 导致只绑定 chat.generate 时节点永远显示「模型尚未配置」并禁用运行。
import { parseChat } from '@shared/engine/chat-data'
import { CHAT_FEATURE_KEY, featureKeyOf, modelKeyOf } from '@shared/engine/models'

export interface ChatModelBinding {
  featureKey: string
  modelKey?: string
}

export function chatModelBinding(text: string): ChatModelBinding {
  const data = parseChat(text)
  return {
    featureKey: featureKeyOf(data, CHAT_FEATURE_KEY),
    modelKey: modelKeyOf(data)
  }
}