// 五类基础节点 Spec 注册（见《技术框架与规范》§5.1）
import { registerNodeType } from '../registry'
import { AudioBody, ChatBody, ImageBody, TextBody, VideoBody } from './bodies'

export function registerBaseNodeTypes(): void {
  registerNodeType({
    type: 'text',
    label: '文本',
    icon: '📝',
    color: '#8ab4f8',
    defaultSize: { w: 260, h: 150 },
    Body: TextBody
  })
  registerNodeType({
    type: 'image',
    label: '图片',
    icon: '🖼️',
    color: '#34d399',
    defaultSize: { w: 320, h: 240 },
    Body: ImageBody
  })
  registerNodeType({
    type: 'video',
    label: '视频',
    icon: '🎥',
    color: '#f472b6',
    defaultSize: { w: 320, h: 240 },
    Body: VideoBody
  })
  registerNodeType({
    type: 'audio',
    label: '音频',
    icon: '🎵',
    color: '#fbbf24',
    defaultSize: { w: 280, h: 120 },
    Body: AudioBody
  })
  registerNodeType({
    type: 'chat',
    label: '对话',
    icon: '💬',
    color: '#a78bfa',
    defaultSize: { w: 280, h: 170 },
    Body: ChatBody
  })
}
