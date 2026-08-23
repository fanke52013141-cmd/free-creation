// 节点 Spec 注册（见《技术框架与规范》§5.1）
// 端口声明对齐路线图的节点类型表；any 万能口，其余类型需一致才可连
import type { PortDecl } from '@shared/types'
import { registerNodeType } from '../registry'
import {
  AudioBody,
  ChatBody,
  CodeBody,
  ComposeBody,
  GroupBody,
  ImageBody,
  JsonBody,
  ScriptBody,
  StoryboardBody,
  TextBody,
  VideoBody
} from './bodies'

const port = (id: string, name: string, type: PortDecl['type']): PortDecl => ({
  id,
  name,
  dir: 'in',
  type
})

const out = (id: string, name: string, type: PortDecl['type']): PortDecl => ({
  id,
  name,
  dir: 'out',
  type
})

export function registerBaseNodeTypes(): void {
  registerNodeType({
    type: 'text',
    label: '文本',
    icon: '📝',
    color: '#8ab4f8',
    defaultSize: { w: 2340, h: 300 },
    ports: { in: [port('in-text', '文本', 'text')], out: [out('out-text', '文本', 'text')] },
    Body: TextBody
  })
  registerNodeType({
    type: 'image',
    label: '图片',
    icon: '🖼️',
    color: '#34d399',
    defaultSize: { w: 2880, h: 480 },
    ports: {
      in: [port('in-image', '图片', 'image'), port('in-text', '提示词', 'text')],
      out: [out('out-image', '图片', 'image')]
    },
    Body: ImageBody
  })
  registerNodeType({
    type: 'video',
    label: '视频',
    icon: '🎥',
    color: '#f472b6',
    defaultSize: { w: 2880, h: 480 },
    ports: {
      in: [
        port('in-video', '视频', 'video'),
        port('in-image', '首帧图', 'image'),
        port('in-text', '提示词', 'text')
      ],
      out: [out('out-video', '视频', 'video')]
    },
    Body: VideoBody
  })
  registerNodeType({
    type: 'audio',
    label: '音频',
    icon: '🎵',
    color: '#fbbf24',
    defaultSize: { w: 2520, h: 240 },
    ports: {
      in: [port('in-audio', '音频', 'audio'), port('in-text', '提示词', 'text')],
      out: [out('out-audio', '音频', 'audio')]
    },
    Body: AudioBody
  })
  registerNodeType({
    type: 'chat',
    label: '对话',
    icon: '💬',
    color: '#a78bfa',
    defaultSize: { w: 2520, h: 340 },
    ports: { in: [port('in-text', '文本', 'text')], out: [out('out-text', '文本', 'text')] },
    Body: ChatBody
  })
}

// 脚本节点（LibTV 1.2.6 基础版）：剧本文本 + 手工分镜表；
// AI 拆解 / 批量生图在 M4 模型接入后开放
export function registerScriptNodeType(): void {
  registerNodeType({
    type: 'script',
    label: '脚本',
    icon: '🎬',
    color: '#fb923c',
    defaultSize: { w: 3240, h: 640 },
    ports: {
      in: [port('in-text', '剧本文本', 'text'), port('in-image', '参考图', 'image')],
      out: [out('out-json', '分镜数据', 'json'), out('out-text', '分镜文本', 'text')]
    },
    Body: ScriptBody
  })
}

// M5 新增节点注册
export function registerExtendedNodeTypes(): void {
  registerNodeType({
    type: 'json',
    label: 'JSON',
    icon: '🔧',
    color: '#c084fc',
    defaultSize: { w: 2520, h: 400 },
    ports: {
      in: [port('in-json', '数据', 'json'), port('in-text', '文本', 'text')],
      out: [out('out-json', '数据', 'json')]
    },
    Body: JsonBody
  })
  registerNodeType({
    type: 'code',
    label: '代码',
    icon: '⌨',
    color: '#94a3b8',
    defaultSize: { w: 2880, h: 440 },
    ports: {
      in: [port('in-text', '文本输入', 'text'), port('in-json', '数据输入', 'json')],
      out: [out('out-text', '文本输出', 'text'), out('out-json', '数据输出', 'json')]
    },
    Body: CodeBody
  })
  registerNodeType({
    type: 'group',
    label: '分组',
    icon: '📦',
    color: '#64748b',
    defaultSize: { w: 1800, h: 200 },
    ports: { in: [], out: [] },
    Body: GroupBody
  })
  registerNodeType({
    type: 'storyboard',
    label: '分镜板',
    icon: '📋',
    color: '#60a5fa',
    defaultSize: { w: 3420, h: 640 },
    ports: {
      in: [port('in-json', '分镜数据', 'json'), port('in-text', '分镜文本', 'text')],
      out: [out('out-json', '分镜数据', 'json'), out('out-text', '合成文本', 'text')]
    },
    Body: StoryboardBody
  })
  registerNodeType({
    type: 'compose',
    label: '合成',
    icon: '🎞',
    color: '#f472b6',
    defaultSize: { w: 2340, h: 320 },
    ports: {
      in: [port('in-video', '视频片段', 'video')],
      out: [out('out-video', '合成视频', 'video')]
    },
    Body: ComposeBody
  })
}
