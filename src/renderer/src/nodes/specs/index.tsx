// 节点 Spec 注册（见《技术框架与规范》§5.1）
// 端口声明对齐路线图的节点类型表；any 万能口，其余类型需一致才可连
import type { PortCardinality, PortDecl, PortSchemaRef } from '@shared/types'
import { registerNodeType, unregisterNodeType } from '../registry'
import { readNodeConfig } from '../../canvas/node-persistence'
import {
  AudioBody,
  AiProcessBody,
  ChatBody,
  CodeBody,
  DirectorBody,
  ImageBody,
  ImageCropBody,
  ImageCropSettings,
  ImageGenerateBody,
  IterateBody,
  JsonBody,
  ProcessorBody,
  ScriptBody,
  StoryboardBody,
  StructuredBody,
  TextBody,
  VideoBody,
  VideoAudioBody,
  VideoAudioSettings,
  VideoClipBody,
  VideoClipSettings,
  VideoFrameBody,
  VideoFrameSettings
} from './bodies'
import { aiProcessExecutor } from '../../engine/executors/aiProcess'
import { audioExecutor } from '../../engine/executors/audio'
import { chatExecutor } from '../../engine/executors/chat'
import {
  codeExecutor,
  codePortConfigErrors,
  mapVarTypeToPortType,
  outputPortId,
  paramPortId,
  parseCodeConfigs
} from '../../engine/executors/code'
import { imageGenExecutor } from '../../engine/executors/imageGen'
import { imageExecutor } from '../../engine/executors/image'
import { imageCropExecutor } from '../../engine/executors/imageCrop'
import { iterateExecutor } from '../../engine/executors/iterate'
import { jsonExecutor } from '../../engine/executors/json'
import { structuredExecutor } from '../../engine/executors/structured'
import { processorExecutor } from '../../engine/executors/processor'
import { scriptExecutor } from '../../engine/executors/script'
import { storyboardExecutor } from '../../engine/executors/storyboard'
import { textExecutor } from '../../engine/executors/text'
import { videoExecutor } from '../../engine/executors/video'
import {
  videoAudioExecutor,
  videoClipExecutor,
  videoFrameExecutor
} from '../../engine/executors/videoTransforms'
import { directorExecutor } from '../../engine/executors/director'
import {
  projectAiProcessOutputs,
  projectAudioOutputs,
  projectChatOutputs,
  projectCodeOutputs,
  projectDirectorOutputs,
  projectImageGenOutputs,
  projectImageCropOutputs,
  projectImageOutputs,
  projectIterateOutputs,
  projectJsonOutputs,
  projectProcessorOutputs,
  projectScriptOutputs,
  projectStoryboardOutputs,
  projectStructuredOutputs,
  projectTextOutputs,
  projectVideoOutputs,
  projectVideoAudioOutputs,
  projectVideoClipOutputs,
  projectVideoFrameOutputs
} from './outputProjections'
import { parseStructuredDataConfig } from '../structured-data'

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
const LIST_ITEMS: PortSchemaRef = { id: 'list.items', version: 1 }
const PROMPT_BUNDLE: PortSchemaRef = { id: 'prompt.bundle', version: 1 }
const PREVIS_CAMERA: PortSchemaRef = { id: 'previs.camera', version: 1 }
const PREVIS_PROJECT: PortSchemaRef = { id: 'previs.project', version: 1 }

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
    projectOutputs: projectTextOutputs,
    executor: textExecutor,
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
    projectOutputs: projectImageOutputs,
    executor: imageExecutor,
    Body: ImageBody
  })
  registerNodeType({
    type: 'image-crop',
    contractVersion: 1,
    label: '裁剪',
    icon: 'crop',
    color: '#22c55e',
    defaultSize: { w: 340, h: 260 },
    description:
      '对一张上游图片执行本地矩形或四角透视裁剪。每次运行产生新的图片资产，原图保持不变。',
    ports: {
      in: [
        input('in-image', '原图', 'image', '必须连接的一张源图片；裁剪参数按其原始比例解释。', {
          required: true
        })
      ],
      out: [output('out-image', '裁剪图', 'image', '本地裁剪完成并落盘的新图片资产。')]
    },
    projectOutputs: projectImageCropOutputs,
    executor: imageCropExecutor,
    SettingsPanel: ImageCropSettings,
    Body: ImageCropBody
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
        input(
          'in-prompt',
          '提示词包',
          'json',
          '可选的 prompt.bundle@1；读取其中的 prompt 与 style。',
          {
            schema: PROMPT_BUNDLE
          }
        ),
        input('in-text', '提示词', 'text', '生成图片使用的提示文本，可由多个文本上游合并。', {
          cardinality: 'many'
        })
      ],
      out: [output('out-image', '图片', 'image', '模型生成并落盘后的图片资产引用。')]
    },
    projectOutputs: projectImageGenOutputs,
    executor: imageGenExecutor,
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
        input(
          'in-prompt',
          '提示词包',
          'json',
          '可选的 prompt.bundle@1；读取其中的 prompt 与 style。',
          {
            schema: PROMPT_BUNDLE
          }
        ),
        input('in-text', '提示词', 'text', '描述视频内容和运动方式的提示文本。', {
          cardinality: 'many'
        })
      ],
      out: [output('out-video', '视频', 'video', '生成并落盘后的视频资产引用。')]
    },
    projectOutputs: projectVideoOutputs,
    executor: videoExecutor,
    Body: VideoBody
  })
  registerNodeType({
    type: 'video-frame',
    contractVersion: 1,
    label: '取帧',
    icon: 'frame',
    color: '#fb7185',
    defaultSize: { w: 340, h: 260 },
    description: '在指定毫秒位置从一段上游视频取出一帧，输出新的 PNG 图片资产。',
    ports: {
      in: [input('in-video', '源视频', 'video', '必须连接的一段源视频。', { required: true })],
      out: [output('out-image', '视频帧', 'image', '指定时间点解码得到的新 PNG 图片资产。')]
    },
    projectOutputs: projectVideoFrameOutputs,
    executor: videoFrameExecutor,
    SettingsPanel: VideoFrameSettings,
    Body: VideoFrameBody
  })
  registerNodeType({
    type: 'video-clip',
    contractVersion: 1,
    label: '截取',
    icon: 'clip',
    color: '#ec4899',
    defaultSize: { w: 340, h: 260 },
    description: '从上游视频按起止毫秒精确截取片段，输出新的 MP4 视频资产。',
    ports: {
      in: [input('in-video', '源视频', 'video', '必须连接的一段源视频。', { required: true })],
      out: [output('out-video', '视频片段', 'video', '精确重编码后的 MP4 视频片段。')]
    },
    projectOutputs: projectVideoClipOutputs,
    executor: videoClipExecutor,
    SettingsPanel: VideoClipSettings,
    Body: VideoClipBody
  })
  registerNodeType({
    type: 'video-audio',
    contractVersion: 1,
    label: '提音',
    icon: 'audio',
    color: '#f59e0b',
    defaultSize: { w: 340, h: 260 },
    description: '从上游视频的指定时间范围提取音轨，输出新的 M4A 音频资产。',
    ports: {
      in: [input('in-video', '源视频', 'video', '必须连接的一段源视频。', { required: true })],
      out: [output('out-audio', '音频片段', 'audio', '从指定范围提取并转码的新 M4A 音频资产。')]
    },
    projectOutputs: projectVideoAudioOutputs,
    executor: videoAudioExecutor,
    SettingsPanel: VideoAudioSettings,
    Body: VideoAudioBody
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
    projectOutputs: projectAudioOutputs,
    executor: audioExecutor,
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
    projectOutputs: projectChatOutputs,
    executor: chatExecutor,
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
    projectOutputs: projectScriptOutputs,
    executor: scriptExecutor,
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
    projectOutputs: projectProcessorOutputs,
    executor: processorExecutor,
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
    projectOutputs: projectJsonOutputs,
    executor: jsonExecutor,
    Body: JsonBody
  })
  registerNodeType({
    type: 'structured',
    contractVersion: 1,
    label: '结构数据',
    icon: 'json',
    color: '#c084fc',
    defaultSize: { w: 340, h: 260 },
    description:
      '通用结构编辑与字段映射节点。选择输出 Schema，在正文中维护 JSON，并只通过已连接的上下文端口引用数据。',
    ports: {
      in: [
        input(
          'in-context',
          '结构上下文',
          'json',
          '一个或多个已连接的结构化输入，可在正文中用 {{input[0].field}} 显式引用。',
          {
            cardinality: 'many',
            schema: JSON_ANY
          }
        ),
        input('in-text', '文本上下文', 'text', '可在正文中用 {{text}} 显式引用的上游文本。', {
          cardinality: 'many'
        })
      ],
      out: [
        output('out-json', '结构数据', 'json', '经所选 Schema 校验后的结构化数据。', {
          schema: JSON_ANY
        })
      ]
    },
    resolvePorts: (shape) => {
      const schema = parseStructuredDataConfig(readNodeConfig(shape)).schema
      return {
        in: [
          input(
            'in-context',
            '结构上下文',
            'json',
            '一个或多个已连接的结构化输入，可在正文中用 {{input[0].field}} 显式引用。',
            {
              cardinality: 'many',
              schema: JSON_ANY
            }
          ),
          input('in-text', '文本上下文', 'text', '可在正文中用 {{text}} 显式引用的上游文本。', {
            cardinality: 'many'
          })
        ],
        out: [
          output('out-json', '结构数据', 'json', '经所选 Schema 校验后的结构化数据。', { schema })
        ]
      }
    },
    projectOutputs: projectStructuredOutputs,
    executor: structuredExecutor,
    Body: StructuredBody
  })
  registerNodeType({
    type: 'code',
    contractVersion: 2,
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
        output(
          'out-output',
          '输出变量',
          'any',
          '代码 return 的默认输出变量；实际端口由节点配置解析。'
        )
      ]
    },
    resolvePorts: (shape) => {
      const cfg = parseCodeConfigs(readNodeConfig(shape))
      // 配置有冲突时不暴露半真半假的动态端口；执行器会提供相同的硬错误。
      const paramPorts: PortDecl[] = (
        codePortConfigErrors(readNodeConfig(shape)).length ? [] : cfg.params
      ).map((p) => {
        const type = mapVarTypeToPortType(p.type)
        return {
          id: paramPortId(p.name),
          name: p.name,
          dir: 'in',
          type,
          description: `自定义参数：${p.name}（${p.type}）`,
          required: false,
          cardinality: 'one',
          ...(type === 'json' ? { schema: JSON_ANY } : {})
        }
      })
      return {
        in: [
          input('in-text', '文本输入', 'text', '代码运行时 input.text 读取的合并文本。', {
            cardinality: 'many'
          }),
          input('in-json', '数据输入', 'json', '代码运行时 input.json 读取的结构化值列表。', {
            cardinality: 'many',
            schema: JSON_ANY
          }),
          ...paramPorts
        ],
        out: [
          output(
            outputPortId(cfg.outputName),
            cfg.outputName,
            mapVarTypeToPortType(cfg.outputType),
            `代码 return 写入变量 ${cfg.outputName}（${cfg.outputType}）。`,
            {
              ...(mapVarTypeToPortType(cfg.outputType) === 'json' ? { schema: JSON_ANY } : {})
            }
          )
        ]
      }
    },
    projectOutputs: projectCodeOutputs,
    executor: codeExecutor,
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
    projectOutputs: projectStoryboardOutputs,
    executor: storyboardExecutor,
    Body: StoryboardBody
  })
  registerNodeType({
    type: 'ai-process',
    contractVersion: 1,
    label: 'AI 处理',
    icon: 'spark',
    color: '#c084fc',
    defaultSize: { w: 340, h: 260 },
    description:
      '一次性、可复跑的工作流转换：把上游文本或 JSON 交给文本模型，输出文本、Markdown 或符合指定 Schema 的 JSON。不保留多轮历史，脚本/数据转换用它，对话节点用于多轮交互。',
    ports: {
      in: [
        input('in-text', '文本', 'text', '一个或多个上游文本，作为本次转换的输入。', {
          cardinality: 'many'
        }),
        input('in-json', 'JSON 上下文', 'json', '可选的结构化上下文，注入本次转换。', {
          schema: JSON_ANY
        })
      ],
      out: [
        output('out-text', '文本', 'text', '模型返回的纯文本结果。', { required: false }),
        output('out-markdown', 'Markdown', 'markdown', '模型返回的 Markdown 结果。', {
          required: false
        }),
        output('out-json', 'JSON', 'json', '模型返回并校验后的结构化值（按所选 Schema）。', {
          required: false,
          schema: JSON_ANY
        })
      ]
    },
    projectOutputs: projectAiProcessOutputs,
    executor: aiProcessExecutor,
    Body: AiProcessBody
  })
  registerNodeType({
    type: 'iterate',
    contractVersion: 1,
    label: '循环',
    icon: 'grid',
    color: '#8b5cf6',
    defaultSize: { w: 340, h: 260 },
    description:
      '列表批处理控制：把 in-list 的每个元素按顺序作为一次「循环体」执行，逐项驱动下游子流程节点（如生图/视频/文本节点），并输出结构化结果列表。支持失败策略、重试、限数与取消。',
    ports: {
      in: [
        input('in-list', '列表', 'json', '要逐项批量处理的列表（每个元素作为一次循环体输入）。', {
          schema: LIST_ITEMS
        })
      ],
      out: [
        output(
          'out-item',
          '当前项',
          'json',
          '只在循环体内按项提供的临时数据。请连接循环体第一个节点；循环结束后不作为项目级输出。',
          { required: false, schema: JSON_ANY }
        ),
        output(
          'out-items',
          '结果列表',
          'json',
          '每项处理结果的结构化列表（含来源、状态、各节点产物）。',
          {
            schema: LIST_ITEMS
          }
        )
      ]
    },
    projectOutputs: projectIterateOutputs,
    executor: iterateExecutor,
    Body: IterateBody
  })
  registerNodeType({
    type: 'director',
    contractVersion: 1,
    label: '导演台',
    icon: 'director',
    color: '#f59e0b',
    defaultSize: { w: 340, h: 260 },
    description:
      '镜头预演工作区。接收分镜、参考图与摄像机参数；只有用户在导演台明确发布后，帧、预演视频和摄像机参数才会成为下游真实输入。',
    executionMode: 'manual-publish',
    ports: {
      in: [
        input('in-storyboard', '分镜', 'json', '可选的分镜列表；在导演台中同步为镜头。', {
          schema: STORYBOARD_SHOTS
        }),
        input(
          'in-reference-images',
          '参考图',
          'image',
          '人物、场景或构图参考图，会进入导演台资源区。',
          {
            cardinality: 'many'
          }
        ),
        input('in-camera-preset', '机位参数', 'json', '可选的初始摄像机参数。', {
          schema: PREVIS_CAMERA
        })
      ],
      out: [
        output('out-frame', '预演帧', 'image', '用户发布的当前镜头静帧。', { required: false }),
        output('out-preview-video', '预演视频', 'video', '用户导出的 WebM 预演视频。', {
          required: false
        }),
        output('out-camera', '机位参数', 'json', '已发布镜头的焦距、画幅、时长和机位参数。', {
          required: false,
          schema: PREVIS_CAMERA
        }),
        output(
          'out-project',
          '工程摘要',
          'json',
          '导演工程中可交换的镜头和机位摘要，不包含媒体二进制。',
          {
            required: false,
            schema: PREVIS_PROJECT
          }
        )
      ]
    },
    projectOutputs: projectDirectorOutputs,
    executor: directorExecutor,
    Body: DirectorBody
  })
}
