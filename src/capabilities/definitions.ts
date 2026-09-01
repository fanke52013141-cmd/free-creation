/**
 * 能力定义：23 个活跃节点类型的完整 Capability 定义
 *
 * 这些定义是系统的「单一事实来源」。每个定义包含：
 * - 输入/输出端口（与现有 NodeTypeSpec 的 ports 对齐）
 * - 配置 Schema（桌面端 UI、CLI 参数和 MCP Schema 都从这里派生）
 * - 命令映射（执行引擎据此分发）
 * - 运行时特性和暴露控制
 *
 * 修改节点能力时的固定流程：
 * 1. 修改本文件中的能力定义
 * 2. 判断是否属于公共接口变化
 * 3. 更新契约版本
 * 4. 运行测试和自动生成
 *
 * 对齐基准：src/renderer/src/nodes/specs/index.tsx 中的 NodeTypeSpec 注册。
 * 2026-09-01 全量对齐：端口 ID、类型、基数、必填性、contractVersion、category、title。
 */

import type { Capability } from './types'
import { defineCapability, listCapabilities } from './registry'

// ── 辅助函数 ───────────────────────────────────────────────

const ALL_EXPOSED = { desktop: true, cli: true, mcp: true } as const

// ── 素材输入类节点 ─────────────────────────────────────────

const textCapability = defineCapability({
  id: 'text.source',
  version: '2.0.0',
  contractVersion: 2,
  nodeType: 'text',
  title: '文本',
  description: '可编辑的原始文本。连线输出会作为下游节点的文本输入。',
  category: 'input',
  inputs: [
    {
      id: 'in-text',
      name: '文本',
      type: 'text',
      required: false,
      cardinality: 'many',
      description: '一个或多个上游文本，执行时与节点内文本合并。'
    }
  ],
  outputs: [
    {
      id: 'out-text',
      name: '文本',
      type: 'text',
      required: true,
      cardinality: 'one',
      description: '节点最终保存的纯文本内容。'
    }
  ],
  configSchema: {
    text: { type: 'string', required: false, description: '节点文本内容' }
  },
  commands: { execute: 'text.source.execute' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const imageCapability = defineCapability({
  id: 'image.source',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'image',
  title: '图片',
  description: '图片资产节点，只负责保存和输出一张已导入的图片，不承担生成逻辑。',
  category: 'input',
  inputs: [],
  outputs: [
    {
      id: 'out-image',
      name: '图片',
      type: 'image',
      required: true,
      cardinality: 'one',
      description: '已导入并落盘的图片资产引用。'
    }
  ],
  configSchema: {
    mediaId: { type: 'string', required: false, description: '已导入的媒体资产 ID' }
  },
  commands: { execute: 'image.source.execute' },
  runtime: {
    headless: true,
    preview: true,
    batch: false,
    executionMode: 'manual-publish',
    agentRunnable: false
  },
  expose: ALL_EXPOSED
})

const imageGenCapability = defineCapability({
  id: 'image.generate',
  version: '2.0.0',
  contractVersion: 2,
  nodeType: 'image-gen',
  title: '生图',
  description:
    '根据提示词生成图片；可连接一张旧版参考图及最多四张有序参考图，生成结果从图片端口输出。',
  category: 'input',
  inputs: [
    {
      id: 'in-image',
      name: '参考图',
      type: 'image',
      required: false,
      cardinality: 'one',
      description: '可选的一张旧版参考图片，用于兼容图生图或风格参考。'
    },
    {
      id: 'in-reference-images',
      name: '多参考图',
      type: 'image',
      required: false,
      cardinality: 'many',
      description: '可选的多张参考图片，按真实连线顺序作为图片 1-4 提交给模型。'
    },
    {
      id: 'in-prompt',
      name: '提示词包',
      type: 'json',
      required: false,
      cardinality: 'one',
      description: '可选的 prompt.bundle；读取其中的 prompt 与 style。'
    },
    {
      id: 'in-text',
      name: '提示词',
      type: 'text',
      required: false,
      cardinality: 'many',
      description: '生成图片使用的提示文本，可由多个文本上游合并。'
    }
  ],
  outputs: [
    {
      id: 'out-image',
      name: '图片',
      type: 'image',
      required: true,
      cardinality: 'one',
      description: '模型生成并落盘后的图片资产引用。'
    }
  ],
  configSchema: {
    providerId: { type: 'string', required: true, description: '供应商 ID' },
    modelId: { type: 'string', required: true, description: '模型 ID' },
    ratio: {
      type: 'enum',
      required: false,
      enumValues: ['1:1', '16:9', '9:16', '4:3', '3:4'],
      defaultValue: '1:1',
      description: '图片比例'
    },
    seed: { type: 'number', required: false, description: '随机种子（-1 为随机）' }
  },
  commands: { execute: 'image.generate.execute' },
  runtime: { headless: true, preview: false, batch: true, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const videoCapability = defineCapability({
  id: 'video.generate',
  version: '3.0.0',
  contractVersion: 3,
  nodeType: 'video',
  title: '视频',
  description:
    '根据文本、首尾帧或多模态参考生成视频。所有参考素材都必须通过明确端口连入，输出可供预览或下载的视频资产。',
  category: 'input',
  inputs: [
    {
      id: 'in-image',
      name: '首帧图',
      type: 'image',
      required: false,
      cardinality: 'one',
      description: '可选的单张首帧图片，用于图生视频。'
    },
    {
      id: 'in-last-image',
      name: '尾帧图',
      type: 'image',
      required: false,
      cardinality: 'one',
      description: '可选的单张尾帧图片；仅支持首尾帧模式的模型可用。'
    },
    {
      id: 'in-reference-images',
      name: '参考图',
      type: 'image',
      required: false,
      cardinality: 'many',
      description: '可选的多张参考图；顺序是提示词中"图片 1、图片 2"的稳定顺序。'
    },
    {
      id: 'in-reference-video',
      name: '运动参考',
      type: 'video',
      required: false,
      cardinality: 'many',
      description: '可选的真实参考视频。预演台白模视频可在此传入。'
    },
    {
      id: 'in-reference-audio',
      name: '参考音频',
      type: 'audio',
      required: false,
      cardinality: 'many',
      description: '可选的参考音频；仅在当前模型支持时按真实输入提交。'
    },
    {
      id: 'in-prompt',
      name: '提示词包',
      type: 'json',
      required: false,
      cardinality: 'one',
      description: '可选的 prompt.bundle；读取其中的 prompt 与 style。'
    },
    {
      id: 'in-text',
      name: '提示词',
      type: 'text',
      required: false,
      cardinality: 'many',
      description: '描述视频内容和运动方式的提示文本。'
    }
  ],
  outputs: [
    {
      id: 'out-video',
      name: '视频',
      type: 'video',
      required: true,
      cardinality: 'one',
      description: '生成并落盘后的视频资产引用。'
    }
  ],
  configSchema: {
    providerId: { type: 'string', required: true, description: '供应商 ID' },
    modelId: { type: 'string', required: true, description: '模型 ID' }
  },
  commands: { execute: 'video.generate.execute' },
  runtime: { headless: true, preview: true, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const audioCapability = defineCapability({
  id: 'audio.source',
  version: '2.0.0',
  contractVersion: 2,
  nodeType: 'audio',
  title: '音频',
  description: '音频资产节点：导入本地音频或承接一段上游音频，只负责保存、预览和输出资产。',
  category: 'input',
  inputs: [
    {
      id: 'in-audio',
      name: '音频',
      type: 'audio',
      required: false,
      cardinality: 'one',
      description: '可选的上游音频资产；接入后作为本节点音频来源。'
    }
  ],
  outputs: [
    {
      id: 'out-audio',
      name: '音频',
      type: 'audio',
      required: true,
      cardinality: 'one',
      description: '已导入或承接的音频资产引用。'
    }
  ],
  configSchema: {
    mediaId: { type: 'string', required: false, description: '已导入的媒体资产 ID' }
  },
  commands: { execute: 'audio.source.execute' },
  runtime: {
    headless: true,
    preview: true,
    batch: false,
    executionMode: 'manual-publish',
    agentRunnable: false
  },
  expose: ALL_EXPOSED
})

// ── 图像处理类节点 ─────────────────────────────────────────

const imageCropCapability = defineCapability({
  id: 'image.crop',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'image-crop',
  title: '裁剪',
  description: '对一张上游图片执行本地矩形或四角透视裁剪。每次运行产生新的图片资产，原图保持不变。',
  category: 'image',
  inputs: [
    {
      id: 'in-image',
      name: '原图',
      type: 'image',
      required: true,
      cardinality: 'one',
      description: '必须连接的一张源图片；裁剪参数按其原始比例解释。'
    }
  ],
  outputs: [
    {
      id: 'out-image',
      name: '裁剪图',
      type: 'image',
      required: true,
      cardinality: 'one',
      description: '本地裁剪完成并落盘的新图片资产。'
    }
  ],
  configSchema: {
    mode: {
      type: 'enum',
      required: true,
      defaultValue: 'fixed-ratio',
      enumValues: ['fixed-ratio', 'free'],
      description: '裁剪模式：固定比例或自由裁剪'
    },
    ratio: {
      type: 'enum',
      required: false,
      enumValues: ['1:1', '16:9', '9:16', '4:3', '3:4'],
      description: '裁剪比例（仅 fixed-ratio 模式有效）'
    },
    cropRect: {
      type: 'rect',
      required: false,
      description: '自定义裁剪区域 {x, y, w, h}'
    }
  },
  commands: { execute: 'image.crop.execute', preview: 'image.crop.preview' },
  runtime: { headless: true, preview: true, batch: true, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const imageSplitCapability = defineCapability({
  id: 'image.split',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'image-split',
  title: '拆分',
  description:
    '把一张上游图片按行列派生为多张独立图片。面积缩放以每个格子的中心为锚点；输出同时提供当前图片和可批处理的图片集合。',
  category: 'image',
  inputs: [
    {
      id: 'in-image',
      name: '原图',
      type: 'image',
      required: true,
      cardinality: 'one',
      description: '必须连接的一张源图片；按行列从左到右、从上到下拆分。'
    }
  ],
  outputs: [
    {
      id: 'out-image',
      name: '当前图片',
      type: 'image',
      required: true,
      cardinality: 'one',
      description: '从图片集合中选中的一格，可直接连接图片类下游。'
    },
    {
      id: 'out-images',
      name: '图片集合',
      type: 'json',
      required: true,
      cardinality: 'one',
      description: '所有格子对应的真实图片资产引用列表，可连接循环节点批处理。'
    }
  ],
  configSchema: {
    rows: {
      type: 'number',
      required: true,
      defaultValue: 2,
      minimum: 1,
      maximum: 10,
      description: '行数'
    },
    cols: {
      type: 'number',
      required: true,
      defaultValue: 2,
      minimum: 1,
      maximum: 10,
      description: '列数'
    }
  },
  commands: { execute: 'image.split.execute' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const imageEditCapability = defineCapability({
  id: 'image.edit',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'image-edit',
  title: '修改',
  description: '以一张上游图片为原图，结合标注与文字说明生成新的图片；原图保持不变。',
  category: 'image',
  inputs: [
    {
      id: 'in-image',
      name: '原图',
      type: 'image',
      required: true,
      cardinality: 'one',
      description: '必须连接的一张待修改图片。'
    },
    {
      id: 'in-text',
      name: '修改说明',
      type: 'text',
      required: false,
      cardinality: 'many',
      description: '可选的文本修改说明，可由多个文本上游合并。'
    }
  ],
  outputs: [
    {
      id: 'out-image',
      name: '修改图',
      type: 'image',
      required: true,
      cardinality: 'one',
      description: '模型修改并落盘后的新图片资产。'
    }
  ],
  configSchema: {
    providerId: { type: 'string', required: true, description: '供应商 ID' },
    modelId: { type: 'string', required: true, description: '模型 ID' },
    mask: { type: 'string', required: false, description: '蒙版区域（base64 或区域描述）' }
  },
  commands: { execute: 'image.edit.execute' },
  runtime: { headless: true, preview: false, batch: true, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

// ── 视频处理类节点 ─────────────────────────────────────────

const videoFrameCapability = defineCapability({
  id: 'video.frame',
  version: '2.0.0',
  contractVersion: 2,
  nodeType: 'video-frame',
  title: '取帧',
  description: '从上游视频提取首帧、尾帧或任意指定时刻的画面，输出新的 PNG/JPG 图片资产。',
  category: 'video',
  inputs: [
    {
      id: 'in-video',
      name: '源视频',
      type: 'video',
      required: true,
      cardinality: 'one',
      description: '必须连接的一段源视频。'
    }
  ],
  outputs: [
    {
      id: 'out-image',
      name: '视频帧',
      type: 'image',
      required: true,
      cardinality: 'one',
      description: '指定时间点解码得到的新图片资产。'
    }
  ],
  configSchema: {
    timestamps: {
      type: 'array',
      required: false,
      description: '取帧时间点列表（秒）',
      items: { type: 'number' }
    },
    count: {
      type: 'number',
      required: false,
      minimum: 1,
      maximum: 100,
      description: '均匀取帧数量'
    }
  },
  commands: { execute: 'video.frame.extract' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const videoClipCapability = defineCapability({
  id: 'video.clip',
  version: '2.0.0',
  contractVersion: 2,
  nodeType: 'video-clip',
  title: '截取',
  description: '从上游视频按起止毫秒精确截取片段，默认重编码输出 MP4 视频资产。',
  category: 'video',
  inputs: [
    {
      id: 'in-video',
      name: '源视频',
      type: 'video',
      required: true,
      cardinality: 'one',
      description: '必须连接的一段源视频。'
    }
  ],
  outputs: [
    {
      id: 'out-video',
      name: '视频片段',
      type: 'video',
      required: true,
      cardinality: 'one',
      description: '精确重编码后的 MP4 视频片段。'
    }
  ],
  configSchema: {
    startTime: { type: 'number', required: true, minimum: 0, description: '开始时间（秒）' },
    endTime: { type: 'number', required: true, minimum: 0, description: '结束时间（秒）' }
  },
  commands: { execute: 'video.clip.extract' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const videoAudioCapability = defineCapability({
  id: 'video.audio',
  version: '2.0.0',
  contractVersion: 2,
  nodeType: 'video-audio',
  title: '提音',
  description: '从上游视频的指定时间范围忠实提取原始音轨，输出 WAV 或 M4A 音频资产。',
  category: 'video',
  inputs: [
    {
      id: 'in-video',
      name: '源视频',
      type: 'video',
      required: true,
      cardinality: 'one',
      description: '必须连接的一段源视频。'
    }
  ],
  outputs: [
    {
      id: 'out-audio',
      name: '音频片段',
      type: 'audio',
      required: true,
      cardinality: 'one',
      description: '从指定范围提取并转码的新音频资产。'
    }
  ],
  configSchema: {},
  commands: { execute: 'video.audio.extract' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

// ── 音频语音类节点 ─────────────────────────────────────────

const vocalSeparateCapability = defineCapability({
  id: 'audio.vocal',
  version: '2.0.0',
  contractVersion: 2,
  nodeType: 'vocal-separate',
  title: '人声分离',
  description:
    '将一段音频分离为人声与伴奏。快速模式使用 FFmpeg 滤镜增强，高质量模式使用本地 AI 模型。',
  category: 'audio',
  inputs: [
    {
      id: 'in-audio',
      name: '源音频',
      type: 'audio',
      required: true,
      cardinality: 'one',
      description: '必须连接的一段完整音频资产。'
    }
  ],
  outputs: [
    {
      id: 'out-vocals',
      name: '人声',
      type: 'audio',
      required: true,
      cardinality: 'one',
      description: '分离产出的人声音轨。'
    },
    {
      id: 'out-accompaniment',
      name: '伴奏',
      type: 'audio',
      required: false,
      cardinality: 'one',
      description: '高质量模型真实分离出的可选伴奏音轨。'
    }
  ],
  configSchema: {},
  commands: { execute: 'audio.vocal.separate' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const speechCapability = defineCapability({
  id: 'audio.speech',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'speech',
  title: '配音',
  description: '通用文本配音节点：将节点内或上游文本交给已配置的语音模型，生成新的音频资产。',
  category: 'audio',
  inputs: [
    {
      id: 'in-text',
      name: '朗读文本',
      type: 'text',
      required: false,
      cardinality: 'many',
      description: '节点内文本与一个或多个上游文本合并后进行朗读。'
    }
  ],
  outputs: [
    {
      id: 'out-audio',
      name: '配音',
      type: 'audio',
      required: true,
      cardinality: 'one',
      description: '模型生成并落盘的配音资产。'
    }
  ],
  configSchema: {},
  commands: { execute: 'audio.speech.execute' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const ttsCapability = defineCapability({
  id: 'audio.tts',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'tts',
  title: '语音克隆',
  description:
    '语音克隆节点：用本地 ComfyUI IndexTTS-2.5 参考一段音色并朗读文本，输出新的音频资产。',
  category: 'audio',
  inputs: [
    {
      id: 'in-audio',
      name: '参考语音',
      type: 'audio',
      required: false,
      cardinality: 'one',
      description: '可选的上游参考音频；也可在节点内上传。'
    },
    {
      id: 'in-text',
      name: '文本',
      type: 'text',
      required: false,
      cardinality: 'many',
      description: '需要朗读的文本（与节点内文本合并）。'
    }
  ],
  outputs: [
    {
      id: 'out-audio',
      name: '音频',
      type: 'audio',
      required: true,
      cardinality: 'one',
      description: '语音复刻合成并落盘后的音频资产引用。'
    }
  ],
  configSchema: {
    voice: { type: 'string', required: false, description: '音色 ID' },
    speed: {
      type: 'number',
      required: false,
      minimum: 0.5,
      maximum: 2,
      defaultValue: 1,
      description: '语速'
    }
  },
  commands: { execute: 'audio.tts.synthesize' },
  runtime: { headless: true, preview: false, batch: true, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const chatCapability = defineCapability({
  id: 'ai.chat',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'chat',
  title: '对话',
  description: '与文本模型对话。上游文本会成为本轮输入，最后一条助手回复作为文本输出。',
  category: 'audio',
  inputs: [
    {
      id: 'in-text',
      name: '文本',
      type: 'text',
      required: false,
      cardinality: 'many',
      description: '作为本轮用户消息或上下文注入的上游文本。'
    }
  ],
  outputs: [
    {
      id: 'out-markdown',
      name: '回复',
      type: 'markdown',
      required: true,
      cardinality: 'one',
      description: '模型最后一条回复，保留 Markdown 语义。'
    }
  ],
  configSchema: {
    providerId: { type: 'string', required: true, description: '供应商 ID' },
    modelId: { type: 'string', required: true, description: '模型 ID' },
    systemPrompt: { type: 'string', required: false, description: '系统提示词' },
    temperature: {
      type: 'number',
      required: false,
      minimum: 0,
      maximum: 2,
      defaultValue: 0.7,
      description: '温度参数'
    }
  },
  commands: { execute: 'ai.chat.execute' },
  runtime: { headless: true, preview: false, batch: true, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

// ── 逻辑流程类节点 ─────────────────────────────────────────

const processorCapability = defineCapability({
  id: 'text.processor',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'processor',
  title: '处理',
  description: '通用变量处理节点。收到上游值后原样传递；未连线时可使用固定值。',
  category: 'logic',
  inputs: [
    {
      id: 'in-value',
      name: '输入变量',
      type: 'any',
      required: false,
      cardinality: 'one',
      description: '需要原样传递或后续转换的单个变量。'
    }
  ],
  outputs: [
    {
      id: 'out-value',
      name: '输出变量',
      type: 'any',
      required: true,
      cardinality: 'one',
      description: '处理完成后的变量；实际类型由配置决定。'
    }
  ],
  configSchema: {},
  commands: { execute: 'text.processor.execute' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const jsonCapability = defineCapability({
  id: 'json.source',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'json',
  title: 'JSON',
  description: '结构化 JSON 数据节点。可接收 JSON 或可解析的文本，并以字段卡片形式呈现。',
  category: 'logic',
  inputs: [
    {
      id: 'in-json',
      name: '数据',
      type: 'json',
      required: false,
      cardinality: 'many',
      description: '一个或多个需要汇总或展示的结构化值。'
    },
    {
      id: 'in-text',
      name: '文本',
      type: 'text',
      required: false,
      cardinality: 'one',
      description: '可被 JSON.parse 解析的单段文本。'
    }
  ],
  outputs: [
    {
      id: 'out-json',
      name: '数据',
      type: 'json',
      required: true,
      cardinality: 'one',
      description: '校验并格式化后的结构化值。'
    }
  ],
  configSchema: {
    data: { type: 'object', required: false, description: 'JSON 数据内容' }
  },
  commands: { execute: 'json.source.execute' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const structuredCapability = defineCapability({
  id: 'ai.structured',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'structured',
  title: '结构数据',
  description:
    '通用结构编辑与字段映射节点。选择输出 Schema，在正文中维护 JSON，并只通过已连接的上下文端口引用数据。',
  category: 'logic',
  inputs: [
    {
      id: 'in-context',
      name: '结构上下文',
      type: 'json',
      required: false,
      cardinality: 'many',
      description: '一个或多个已连接的结构化输入，可在正文中用 {{input[0].field}} 显式引用。'
    },
    {
      id: 'in-text',
      name: '文本上下文',
      type: 'text',
      required: false,
      cardinality: 'many',
      description: '可在正文中用 {{text}} 显式引用的上游文本。'
    }
  ],
  outputs: [
    {
      id: 'out-json',
      name: '结构数据',
      type: 'json',
      required: true,
      cardinality: 'one',
      description: '经所选 Schema 校验后的结构化数据。'
    }
  ],
  configSchema: {
    schemaId: { type: 'string', required: false, description: '所选输出 Schema 的 ID' }
  },
  commands: { execute: 'ai.structured.execute' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const codeCapability = defineCapability({
  id: 'code.execute',
  version: '2.0.0',
  contractVersion: 2,
  nodeType: 'code',
  title: '代码',
  description: '代码转换节点。读取命名输入变量，执行后将 return 值写入命名输出变量。',
  category: 'logic',
  inputs: [
    {
      id: 'in-text',
      name: '文本输入',
      type: 'text',
      required: false,
      cardinality: 'many',
      description: '代码运行时 input.text 读取的合并文本。'
    },
    {
      id: 'in-json',
      name: '数据输入',
      type: 'json',
      required: false,
      cardinality: 'many',
      description: '代码运行时 input.json 读取的结构化值列表。'
    }
  ],
  outputs: [
    {
      id: 'out-output',
      name: '输出变量',
      type: 'any',
      required: true,
      cardinality: 'one',
      description: '代码 return 的默认输出变量；实际端口由节点配置解析。'
    }
  ],
  configSchema: {
    code: { type: 'string', required: true, description: '代码内容' }
  },
  commands: { execute: 'code.execute.run' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const storyboardCapability = defineCapability({
  id: 'ai.storyboard',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'storyboard',
  title: '分镜板',
  description: '将分镜 JSON 呈现为可编辑的镜头卡片，并输出结构化分镜数据与文字摘要。',
  category: 'logic',
  inputs: [
    {
      id: 'in-json',
      name: '分镜数据',
      type: 'json',
      required: false,
      cardinality: 'one',
      description: '符合分镜 Schema 的镜头列表。'
    },
    {
      id: 'in-text',
      name: '分镜文本',
      type: 'text',
      required: false,
      cardinality: 'one',
      description: '可解析为分镜 JSON 的兼容文本输入。'
    }
  ],
  outputs: [
    {
      id: 'out-json',
      name: '分镜数据',
      type: 'json',
      required: true,
      cardinality: 'one',
      description: '编辑后的完整分镜结构。'
    },
    {
      id: 'out-text',
      name: '合成文本',
      type: 'text',
      required: false,
      cardinality: 'one',
      description: '由画面、台词和时长生成的可读摘要。'
    }
  ],
  configSchema: {},
  commands: { execute: 'ai.storyboard.execute' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const aiProcessCapability = defineCapability({
  id: 'ai.process',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'ai-process',
  title: 'AI 处理',
  description:
    '一次性、可复跑的工作流转换：把上游文本或 JSON 交给文本模型，输出文本、Markdown 或符合指定 Schema 的 JSON。不保留多轮历史，脚本/数据转换用它，对话节点用于多轮交互。',
  category: 'logic',
  inputs: [
    {
      id: 'in-text',
      name: '文本',
      type: 'text',
      required: false,
      cardinality: 'many',
      description: '一个或多个上游文本，作为本次转换的输入。'
    },
    {
      id: 'in-json',
      name: 'JSON 上下文',
      type: 'json',
      required: false,
      cardinality: 'one',
      description: '可选的结构化上下文，注入本次转换。'
    }
  ],
  outputs: [
    {
      id: 'out-text',
      name: '文本',
      type: 'text',
      required: false,
      cardinality: 'one',
      description: '模型返回的纯文本结果。'
    },
    {
      id: 'out-markdown',
      name: 'Markdown',
      type: 'markdown',
      required: false,
      cardinality: 'one',
      description: '模型返回的 Markdown 结果。'
    },
    {
      id: 'out-json',
      name: 'JSON',
      type: 'json',
      required: false,
      cardinality: 'one',
      description: '模型返回并校验后的结构化值（按所选 Schema）。'
    }
  ],
  configSchema: {
    providerId: { type: 'string', required: true, description: '供应商 ID' },
    modelId: { type: 'string', required: true, description: '模型 ID' }
  },
  commands: { execute: 'ai.process.run' },
  runtime: { headless: true, preview: false, batch: true, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const iterateCapability = defineCapability({
  id: 'flow.iterate',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'iterate',
  title: '循环',
  description:
    '列表批处理控制：把 in-list 的每个元素按顺序作为一次「循环体」执行，逐项驱动下游子流程节点（如生图/视频/文本节点），并输出结构化结果列表。支持失败策略、重试、限数与取消。',
  category: 'logic',
  inputs: [
    {
      id: 'in-list',
      name: '列表',
      type: 'json',
      required: true,
      cardinality: 'one',
      description: '要逐项批量处理的列表（每个元素作为一次循环体输入）。'
    }
  ],
  outputs: [
    {
      id: 'out-item',
      name: '当前项',
      type: 'json',
      required: false,
      cardinality: 'one',
      description:
        '只在循环体内按项提供的临时数据。请连接循环体第一个节点；循环结束后不作为项目级输出。'
    },
    {
      id: 'out-items',
      name: '结果列表',
      type: 'json',
      required: true,
      cardinality: 'one',
      description: '每项处理结果的结构化列表（含来源、状态、各节点产物）。'
    }
  ],
  configSchema: {
    variableName: {
      type: 'string',
      required: false,
      defaultValue: 'item',
      description: '循环变量名'
    }
  },
  commands: { execute: 'flow.iterate.run' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const directorCapability = defineCapability({
  id: 'ai.director',
  version: '2.0.0',
  contractVersion: 2,
  nodeType: 'director',
  title: '3D 预演台',
  description:
    '3D 白模预演工作区。接收分镜、场景参考图与机位参数；只有用户明确发布后，帧、预演视频和机位参数才会成为下游真实输入。',
  category: 'logic',
  inputs: [
    {
      id: 'in-storyboard',
      name: '分镜',
      type: 'json',
      required: false,
      cardinality: 'one',
      description: '可选的分镜列表；在导演台中同步为镜头。'
    },
    {
      id: 'in-reference-images',
      name: '场景参考图',
      type: 'image',
      required: false,
      cardinality: 'many',
      description: '1-3 张参考图建议用于建立白模空间；真实连线输入，不读取其他节点内部状态。'
    },
    {
      id: 'in-camera-preset',
      name: '机位参数',
      type: 'json',
      required: false,
      cardinality: 'one',
      description: '可选的初始摄像机参数。'
    }
  ],
  outputs: [
    {
      id: 'out-frame',
      name: '预演帧',
      type: 'image',
      required: false,
      cardinality: 'one',
      description: '用户发布的当前镜头静帧。'
    },
    {
      id: 'out-preview-video',
      name: '预演视频',
      type: 'video',
      required: false,
      cardinality: 'one',
      description: '用户导出的 WebM 预演视频。'
    },
    {
      id: 'out-camera',
      name: '机位参数',
      type: 'json',
      required: false,
      cardinality: 'one',
      description: '已发布镜头的焦距、画幅、时长和机位参数。'
    },
    {
      id: 'out-project',
      name: '工程摘要',
      type: 'json',
      required: false,
      cardinality: 'one',
      description: '导演工程中可交换的镜头和机位摘要，不包含媒体二进制。'
    }
  ],
  configSchema: {},
  commands: { execute: 'ai.director.orchestrate' },
  runtime: {
    headless: true,
    preview: false,
    batch: false,
    executionMode: 'manual-publish',
    agentRunnable: false
  },
  expose: ALL_EXPOSED
})

// ── 导出全部定义 ──────────────────────────────────────────

export const capabilityDefinitions: Capability[] = [
  textCapability,
  imageCapability,
  imageGenCapability,
  videoCapability,
  audioCapability,
  imageCropCapability,
  imageSplitCapability,
  imageEditCapability,
  videoFrameCapability,
  videoClipCapability,
  videoAudioCapability,
  vocalSeparateCapability,
  speechCapability,
  ttsCapability,
  chatCapability,
  processorCapability,
  jsonCapability,
  structuredCapability,
  codeCapability,
  storyboardCapability,
  aiProcessCapability,
  iterateCapability,
  directorCapability
]

/** 确保全部能力已注册 */
export function ensureAllCapabilitiesRegistered(): void {
  // defineCapability 在导入时已执行，这里仅做完整性验证
  const registered = listCapabilities()
  if (registered.length !== capabilityDefinitions.length) {
    throw new Error(
      `[CapabilityRegistry] 注册数量不匹配: 期望 ${capabilityDefinitions.length}, 实际 ${registered.length}`
    )
  }
}
