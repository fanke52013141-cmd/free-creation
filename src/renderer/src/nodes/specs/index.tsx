// 节点 Spec 注册（见《技术框架与规范》§5.1）
// 端口声明对齐路线图的节点类型表；any 万能口，其余类型需一致才可连
import type { PortCardinality, PortDecl, PortSchemaRef } from '@shared/types'
import { registerNodeType, unregisterNodeType } from '../registry'
import {
  AudioBody,
  ChatBody,
  CodeBody,
  ImageBody,
  ImageGenerateBody,
  JsonBody,
  ProcessorBody,
  ScriptBody,
  StoryboardBody,
  TextBody,
  VideoBody
} from './bodies'

interface PortOptions {
  required?: boolean
  cardinality?: PortCardinality
  schema?: PortSchemaRef
}

const input = (
  id: string,
  name: string,
  type: PortDecl['type'],
  description: string,
  options: PortOptions = {}
): PortDecl => ({
  id,
  name,
  dir: 'in',
  type,
  description,
  required: options.required ?? false,
  cardinality: options.cardinality ?? 'one',
  schema: options.schema
})

const output = (
  id: string,
  name: string,
  type: PortDecl['type'],
  description: string,
  options: PortOptions = {}
): PortDecl => ({
  id,
  name,
  dir: 'out',
  type,
  description,
  required: options.required ?? true,
  cardinality: options.cardinality ?? 'one',
  schema: options.schema
})

const JSON_ANY: PortSchemaRef = { id: 'json.any', version: 1 }
const STORYBOARD_SHOTS: PortSchemaRef = { id: 'storyboard.shots', version: 1 }

export function registerBaseNodeTypes(): void {
  registerNodeType({
    type: 'text',
    contractVersion: 1,
    label: '文本',
    icon: 'text',
    color: '#8ab4f8',
    defaultSize: { w: 340, h: 260 },
    description: '可编辑的原始文本。连线输出会作为下游节点的文本输入。',
    ports: {
      in: [
        input('in-text', '文本', 'text', '一个或多个上游文本，执行时与节点内文本合并。', {
          cardinality: 'many'
        })
      ],
      out: [output('out-text', '文本', 'text', '节点最终保存的纯文本内容。')]
    },
    Body: TextBody
  })
  registerNodeType({
    type: 'image',
    contractVersion: 1,
    label: '图片',
    icon: 'image',
    color: '#34d399',
    defaultSize: { w: 340, h: 260 },
    description: '图片资产节点，只负责保存和输出一张已导入的图片，不承担生成逻辑。',
    ports: {
      in: [],
      out: [output('out-image', '图片', 'image', '已导入并落盘的图片资产引用。')]
    },
    Body: ImageBody
  })
  registerNodeType({
    type: 'image-gen',
    contractVersion: 1,
    label: '生图',
    icon: 'image-gen',
    color: '#10b981',
    defaultSize: { w: 340, h: 260 },
    description: '根据提示词生成图片；可连接一张图片资产作为参考图，生成结果从图片端口输出。',
    ports: {
      in: [
        input('in-image', '参考图', 'image', '可选的一张参考图片，用于图生图或风格参考。'),
        input('in-text', '提示词', 'text', '生成图片使用的提示文本，可由多个文本上游合并。', {
          cardinality: 'many'
        })
      ],
      out: [output('out-image', '图片', 'image', '模型生成并落盘后的图片资产引用。')]
    },
    Body: ImageGenerateBody
  })
  registerNodeType({
    type: 'video',
    contractVersion: 1,
    label: '视频',
    icon: 'video',
    color: '#f472b6',
    defaultSize: { w: 340, h: 260 },
    description: '根据文本和可选首帧图片生成一段视频，输出可供预览或下载的视频资产。',
    ports: {
      in: [
        input('in-image', '首帧图', 'image', '可选的单张首帧图片，用于图生视频。'),
        input('in-text', '提示词', 'text', '描述视频内容和运动方式的提示文本。', {
          cardinality: 'many'
        })
      ],
      out: [output('out-video', '视频', 'video', '生成并落盘后的视频资产引用。')]
    },
    Body: VideoBody
  })
  registerNodeType({
    type: 'audio',
    contractVersion: 1,
    label: '音频',
    icon: 'audio',
    color: '#fbbf24',
    defaultSize: { w: 340, h: 260 },
    description: '导入或生成音频；上游文本可作为语音生成的朗读内容。',
    ports: {
      in: [
        input('in-audio', '音频', 'audio', '可选的上游音频资产；接入后作为本节点音频来源。'),
        input('in-text', '文本', 'text', '语音合成模式下需要朗读的文本。', {
          cardinality: 'many'
        })
      ],
      out: [output('out-audio', '音频', 'audio', '导入或生成并落盘后的音频资产引用。')]
    },
    Body: AudioBody
  })
  registerNodeType({
    type: 'chat',
    contractVersion: 1,
    label: '对话',
    icon: 'chat',
    color: '#a78bfa',
    defaultSize: { w: 340, h: 260 },
    description: '与文本模型对话。上游文本会成为本轮输入，最后一条助手回复作为文本输出。',
    ports: {
      in: [
        input('in-text', '文本', 'text', '作为本轮用户消息或上下文注入的上游文本。', {
          cardinality: 'many'
        })
      ],
      out: [output('out-markdown', '回复', 'markdown', '模型最后一条回复，保留 Markdown 语义。')]
    },
    Body: ChatBody
  })
}

// 脚本节点（LibTV 1.2.6 基础版）：剧本文本 + 手工分镜表；
// AI 拆解 / 批量生图在 M4 模型接入后开放
export function registerScriptNodeType(): void {
  registerNodeType({
    type: 'script',
    contractVersion: 1,
    label: '脚本',
    icon: 'script',
    color: '#fb923c',
    defaultSize: { w: 340, h: 260 },
    description: '旧版复合脚本节点，仅为已有项目兼容保留；新流程请使用“文本 → 处理 → JSON”。',
    creatable: false,
    ports: {
      in: [
        input('in-text', '剧本文本', 'text', '待拆解为分镜结构的剧本文本。', {
          cardinality: 'many'
        })
      ],
      out: [
        output('out-json', '分镜数据', 'json', '按字段定义生成的分镜列表。', {
          schema: STORYBOARD_SHOTS
        }),
        output('out-text', '分镜文本', 'text', '旧版兼容使用的分镜文字摘要。', {
          required: false
        })
      ]
    },
    Body: ScriptBody
  })
}

// M5 新增节点注册
export function registerExtendedNodeTypes(): void {
  // 分组改用 tldraw 原生 group 状态；视频合成退出画布职责。
  unregisterNodeType('group')
  unregisterNodeType('compose')

  registerNodeType({
    type: 'processor',
    contractVersion: 1,
    label: '处理',
    icon: 'processor',
    color: '#22d3ee',
    defaultSize: { w: 340, h: 260 },
    description: '通用变量处理节点。收到上游值后原样传递；未连线时可使用固定值。',
    ports: {
      in: [input('in-value', '输入变量', 'any', '需要原样传递或后续转换的单个变量。')],
      out: [output('out-value', '输出变量', 'any', '处理完成后的变量；实际类型由配置决定。')]
    },
    Body: ProcessorBody
  })
  registerNodeType({
    type: 'json',
    contractVersion: 1,
    label: 'JSON',
    icon: 'json',
    color: '#c084fc',
    defaultSize: { w: 340, h: 260 },
    description: '结构化 JSON 数据节点。可接收 JSON 或可解析的文本，并以字段卡片形式呈现。',
    ports: {
      in: [
        input('in-json', '数据', 'json', '一个或多个需要汇总或展示的结构化值。', {
          cardinality: 'many',
          schema: JSON_ANY
        }),
        input('in-text', '文本', 'text', '可被 JSON.parse 解析的单段文本。')
      ],
      out: [output('out-json', '数据', 'json', '校验并格式化后的结构化值。', { schema: JSON_ANY })]
    },
    Body: JsonBody
  })
  registerNodeType({
    type: 'code',
    contractVersion: 1,
    label: '代码',
    icon: 'code',
    color: '#94a3b8',
    defaultSize: { w: 340, h: 260 },
    description: '代码转换节点。读取命名输入变量，执行后将 return 值写入命名输出变量。',
    ports: {
      in: [
        input('in-text', '文本输入', 'text', '代码运行时 input.text 读取的合并文本。', {
          cardinality: 'many'
        }),
        input('in-json', '数据输入', 'json', '代码运行时 input.json 读取的结构化值列表。', {
          cardinality: 'many',
          schema: JSON_ANY
        })
      ],
      out: [
        output('out-text', '文本输出', 'text', '代码 return 字符串时产生的文本结果。', {
          required: false
        }),
        output('out-json', '数据输出', 'json', '代码 return 对象或数组时产生的结构化结果。', {
          required: false,
          schema: JSON_ANY
        })
      ]
    },
    Body: CodeBody
  })
  registerNodeType({
    type: 'storyboard',
    contractVersion: 1,
    label: '分镜板',
    icon: 'storyboard',
    color: '#60a5fa',
    defaultSize: { w: 340, h: 260 },
    description: '将分镜 JSON 呈现为可编辑的镜头卡片，并输出结构化分镜数据与文字摘要。',
    ports: {
      in: [
        input('in-json', '分镜数据', 'json', '符合分镜 Schema 的镜头列表。', {
          schema: STORYBOARD_SHOTS
        }),
        input('in-text', '分镜文本', 'text', '可解析为分镜 JSON 的兼容文本输入。')
      ],
      out: [
        output('out-json', '分镜数据', 'json', '编辑后的完整分镜结构。', {
          schema: STORYBOARD_SHOTS
        }),
        output('out-text', '合成文本', 'text', '由画面、台词和时长生成的可读摘要。', {
          required: false
        })
      ]
    },
    Body: StoryboardBody
  })
}
