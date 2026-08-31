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
 */

import type { Capability } from './types'
import { defineCapability } from './registry'

// ── 辅助函数 ───────────────────────────────────────────────

const ALL_EXPOSED = { desktop: true, cli: true, mcp: true } as const

// ── 输入类节点 ─────────────────────────────────────────────

const textCapability = defineCapability({
  id: 'text.source',
  version: '2.0.0',
  contractVersion: 2,
  nodeType: 'text',
  title: '文本',
  description: '可编辑的原始文本。连线输出会作为下游节点的文本输入。',
  category: 'input',
  inputs: [
    { id: 'in-text', name: '文本', type: 'text', required: false, cardinality: 'many', description: '上游文本会拼接后作为基础内容' }
  ],
  outputs: [
    { id: 'out-text', name: '文本', type: 'text', required: true, cardinality: 'one', description: '节点最终保存的纯文本内容' }
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
  description: '导入本地图片文件，作为下游节点的图片输入。',
  category: 'input',
  inputs: [],
  outputs: [
    { id: 'out-image', name: '图片', type: 'image', required: true, cardinality: 'one', description: '导入的图片资产' }
  ],
  configSchema: {
    mediaId: { type: 'string', required: false, description: '已导入的媒体资产 ID' }
  },
  commands: { execute: 'image.source.execute' },
  runtime: { headless: true, preview: true, batch: false, executionMode: 'manual-publish' },
  expose: ALL_EXPOSED
})

const videoCapability = defineCapability({
  id: 'video.source',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'video',
  title: '视频',
  description: '导入本地视频文件，作为下游节点的视频输入。',
  category: 'input',
  inputs: [],
  outputs: [
    { id: 'out-video', name: '视频', type: 'video', required: true, cardinality: 'one', description: '导入的视频资产' }
  ],
  configSchema: {
    mediaId: { type: 'string', required: false, description: '已导入的媒体资产 ID' }
  },
  commands: { execute: 'video.source.execute' },
  runtime: { headless: true, preview: true, batch: false, executionMode: 'manual-publish' },
  expose: ALL_EXPOSED
})

const audioCapability = defineCapability({
  id: 'audio.source',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'audio',
  title: '音频',
  description: '导入本地音频文件，作为下游节点的音频输入。',
  category: 'input',
  inputs: [],
  outputs: [
    { id: 'out-audio', name: '音频', type: 'audio', required: true, cardinality: 'one', description: '导入的音频资产' }
  ],
  configSchema: {
    mediaId: { type: 'string', required: false, description: '已导入的媒体资产 ID' }
  },
  commands: { execute: 'audio.source.execute' },
  runtime: { headless: true, preview: true, batch: false, executionMode: 'manual-publish' },
  expose: ALL_EXPOSED
})

const jsonCapability = defineCapability({
  id: 'json.source',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'json',
  title: 'JSON',
  description: '结构化 JSON 数据，作为下游节点的 JSON 输入。',
  category: 'input',
  inputs: [
    { id: 'in-json', name: 'JSON', type: 'json', required: false, cardinality: 'many', description: '上游 JSON 会合并后输出' }
  ],
  outputs: [
    { id: 'out-json', name: 'JSON', type: 'json', required: true, cardinality: 'one', description: '节点保存的 JSON 数据' }
  ],
  configSchema: {
    data: { type: 'object', required: false, description: 'JSON 数据内容' }
  },
  commands: { execute: 'json.source.execute' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

// ── 图片处理类 ─────────────────────────────────────────────

const imageCropCapability = defineCapability({
  id: 'image.crop',
  version: '2.0.0',
  contractVersion: 2,
  nodeType: 'image-crop',
  title: '图片裁剪',
  description: '按照固定比例或自由区域裁剪图片。',
  category: 'image-process',
  inputs: [
    { id: 'in-image', name: '图片', type: 'image', required: true, cardinality: 'one', description: '待裁剪的图片' }
  ],
  outputs: [
    { id: 'out-image', name: '裁剪结果', type: 'image', required: true, cardinality: 'one', description: '裁剪后的图片' }
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
  title: '宫格拆分',
  description: '将一张图片按 N×M 宫格拆分为多张子图。',
  category: 'image-process',
  inputs: [
    { id: 'in-image', name: '图片', type: 'image', required: true, cardinality: 'one', description: '待拆分的图片' }
  ],
  outputs: [
    { id: 'out-images', name: '子图列表', type: 'image', required: true, cardinality: 'many', description: '拆分后的子图列表' }
  ],
  configSchema: {
    rows: { type: 'number', required: true, defaultValue: 2, minimum: 1, maximum: 10, description: '行数' },
    cols: { type: 'number', required: true, defaultValue: 2, minimum: 1, maximum: 10, description: '列数' }
  },
  commands: { execute: 'image.split.execute' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const imageGenCapability = defineCapability({
  id: 'image.generate',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'image-gen',
  title: '图片生成',
  description: '使用 AI 模型根据提示词生成图片。',
  category: 'ai-generate',
  inputs: [
    { id: 'in-prompt', name: '提示词', type: 'text', required: true, cardinality: 'many', description: '图片生成提示词' },
    { id: 'in-reference', name: '参考图', type: 'image', required: false, cardinality: 'one', description: '可选的参考图片' }
  ],
  outputs: [
    { id: 'out-image', name: '生成图片', type: 'image', required: true, cardinality: 'one', description: 'AI 生成的图片' }
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

const imageEditCapability = defineCapability({
  id: 'image.edit',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'image-edit',
  title: '图片修改',
  description: '使用 AI 模型对已有图片进行修改和重绘。',
  category: 'ai-generate',
  inputs: [
    { id: 'in-image', name: '原图', type: 'image', required: true, cardinality: 'one', description: '待修改的图片' },
    { id: 'in-prompt', name: '修改指令', type: 'text', required: true, cardinality: 'many', description: '修改描述' }
  ],
  outputs: [
    { id: 'out-image', name: '修改结果', type: 'image', required: true, cardinality: 'one', description: '修改后的图片' }
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

// ── 视频处理类 ─────────────────────────────────────────────

const videoFrameCapability = defineCapability({
  id: 'video.frame',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'video-frame',
  title: '视频取帧',
  description: '从视频中按时间点提取帧画面。',
  category: 'video-process',
  inputs: [
    { id: 'in-video', name: '视频', type: 'video', required: true, cardinality: 'one', description: '源视频' }
  ],
  outputs: [
    { id: 'out-frames', name: '帧列表', type: 'image', required: true, cardinality: 'many', description: '提取的帧画面列表' }
  ],
  configSchema: {
    timestamps: { type: 'array', required: false, description: '取帧时间点列表（秒）', items: { type: 'number' } },
    count: { type: 'number', required: false, minimum: 1, maximum: 100, description: '均匀取帧数量' }
  },
  commands: { execute: 'video.frame.extract' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const videoClipCapability = defineCapability({
  id: 'video.clip',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'video-clip',
  title: '视频截取',
  description: '截取视频的指定时间段。',
  category: 'video-process',
  inputs: [
    { id: 'in-video', name: '视频', type: 'video', required: true, cardinality: 'one', description: '源视频' }
  ],
  outputs: [
    { id: 'out-video', name: '片段', type: 'video', required: true, cardinality: 'one', description: '截取的视频片段' }
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
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'video-audio',
  title: '视频提取音频',
  description: '从视频中提取音轨。',
  category: 'video-process',
  inputs: [
    { id: 'in-video', name: '视频', type: 'video', required: true, cardinality: 'one', description: '源视频' }
  ],
  outputs: [
    { id: 'out-audio', name: '音频', type: 'audio', required: true, cardinality: 'one', description: '提取的音轨' }
  ],
  configSchema: {},
  commands: { execute: 'video.audio.extract' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

// ── 音频处理类 ─────────────────────────────────────────────

const vocalSeparateCapability = defineCapability({
  id: 'audio.vocal',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'vocal-separate',
  title: '人声分离',
  description: '将音频分离为人声和伴奏。',
  category: 'audio-process',
  inputs: [
    { id: 'in-audio', name: '音频', type: 'audio', required: true, cardinality: 'one', description: '待分离的音频' }
  ],
  outputs: [
    { id: 'out-vocal', name: '人声', type: 'audio', required: true, cardinality: 'one', description: '分离出的人声' },
    { id: 'out-accompaniment', name: '伴奏', type: 'audio', required: true, cardinality: 'one', description: '分离出的伴奏' }
  ],
  configSchema: {},
  commands: { execute: 'audio.vocal.separate' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const ttsCapability = defineCapability({
  id: 'audio.tts',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'tts',
  title: '语音合成',
  description: '将文本转换为语音。',
  category: 'audio-process',
  inputs: [
    { id: 'in-text', name: '文本', type: 'text', required: true, cardinality: 'many', description: '待合成的文本' }
  ],
  outputs: [
    { id: 'out-audio', name: '语音', type: 'audio', required: true, cardinality: 'one', description: '合成的语音' }
  ],
  configSchema: {
    voice: { type: 'string', required: false, description: '音色 ID' },
    speed: { type: 'number', required: false, minimum: 0.5, maximum: 2, defaultValue: 1, description: '语速' }
  },
  commands: { execute: 'audio.tts.synthesize' },
  runtime: { headless: true, preview: false, batch: true, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

// ── AI 对话与推理类 ────────────────────────────────────────

const chatCapability = defineCapability({
  id: 'ai.chat',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'chat',
  title: 'AI 对话',
  description: '使用大语言模型进行文本对话。',
  category: 'ai-reasoning',
  inputs: [
    { id: 'in-text', name: '输入', type: 'text', required: true, cardinality: 'many', description: '对话输入文本' }
  ],
  outputs: [
    { id: 'out-text', name: '回复', type: 'text', required: true, cardinality: 'one', description: 'AI 回复文本' }
  ],
  configSchema: {
    providerId: { type: 'string', required: true, description: '供应商 ID' },
    modelId: { type: 'string', required: true, description: '模型 ID' },
    systemPrompt: { type: 'string', required: false, description: '系统提示词' },
    temperature: { type: 'number', required: false, minimum: 0, maximum: 2, defaultValue: 0.7, description: '温度参数' }
  },
  commands: { execute: 'ai.chat.execute' },
  runtime: { headless: true, preview: false, batch: true, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const speechCapability = defineCapability({
  id: 'ai.speech',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'speech',
  title: '语音对话',
  description: '语音输入与 AI 对话。',
  category: 'ai-reasoning',
  inputs: [
    { id: 'in-audio', name: '语音', type: 'audio', required: false, cardinality: 'one', description: '语音输入' },
    { id: 'in-text', name: '文本', type: 'text', required: false, cardinality: 'many', description: '文本输入' }
  ],
  outputs: [
    { id: 'out-text', name: '回复', type: 'text', required: true, cardinality: 'one', description: 'AI 回复文本' }
  ],
  configSchema: {
    providerId: { type: 'string', required: true, description: '供应商 ID' },
    modelId: { type: 'string', required: true, description: '模型 ID' }
  },
  commands: { execute: 'ai.speech.execute' },
  runtime: { headless: false, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const processorCapability = defineCapability({
  id: 'text.processor',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'processor',
  title: '文本处理器',
  description: '对文本执行格式化、提取或变换。',
  category: 'text-process',
  inputs: [
    { id: 'in-text', name: '文本', type: 'text', required: true, cardinality: 'many', description: '待处理的文本' }
  ],
  outputs: [
    { id: 'out-text', name: '结果', type: 'text', required: true, cardinality: 'one', description: '处理后的文本' }
  ],
  configSchema: {
    template: { type: 'string', required: true, description: '处理模板（支持变量替换）' }
  },
  commands: { execute: 'text.processor.execute' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const codeCapability = defineCapability({
  id: 'code.execute',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'code',
  title: '代码执行',
  description: '执行 JavaScript/TypeScript 代码片段。',
  category: 'text-process',
  inputs: [
    { id: 'in-data', name: '输入数据', type: 'json', required: false, cardinality: 'many', description: '代码输入数据' }
  ],
  outputs: [
    { id: 'out-text', name: '输出', type: 'text', required: true, cardinality: 'one', description: '代码执行结果' },
    { id: 'out-json', name: 'JSON 输出', type: 'json', required: false, cardinality: 'one', description: '结构化输出' }
  ],
  configSchema: {
    code: { type: 'string', required: true, description: '代码内容' }
  },
  commands: { execute: 'code.execute.run' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const structuredCapability = defineCapability({
  id: 'ai.structured',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'structured',
  title: '结构化提取',
  description: '使用 AI 从文本中提取结构化 JSON 数据。',
  category: 'ai-reasoning',
  inputs: [
    { id: 'in-text', name: '文本', type: 'text', required: true, cardinality: 'many', description: '待提取的文本' }
  ],
  outputs: [
    { id: 'out-json', name: '结构化数据', type: 'json', required: true, cardinality: 'one', description: '提取的 JSON 数据' }
  ],
  configSchema: {
    providerId: { type: 'string', required: true, description: '供应商 ID' },
    modelId: { type: 'string', required: true, description: '模型 ID' },
    schema: { type: 'object', required: false, description: '期望的 JSON Schema' }
  },
  commands: { execute: 'ai.structured.extract' },
  runtime: { headless: true, preview: false, batch: true, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const storyboardCapability = defineCapability({
  id: 'ai.storyboard',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'storyboard',
  title: '分镜生成',
  description: '根据文本生成分镜脚本（镜头列表 JSON）。',
  category: 'ai-reasoning',
  inputs: [
    { id: 'in-text', name: '剧本', type: 'text', required: true, cardinality: 'many', description: '剧本文本' }
  ],
  outputs: [
    { id: 'out-json', name: '分镜', type: 'json', required: true, cardinality: 'one', description: '分镜 JSON 数据' }
  ],
  configSchema: {
    providerId: { type: 'string', required: true, description: '供应商 ID' },
    modelId: { type: 'string', required: true, description: '模型 ID' },
    shotCount: { type: 'number', required: false, minimum: 1, maximum: 50, description: '期望镜头数' }
  },
  commands: { execute: 'ai.storyboard.generate' },
  runtime: { headless: true, preview: false, batch: true, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const aiProcessCapability = defineCapability({
  id: 'ai.process',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'ai-process',
  title: 'AI 流程',
  description: '自定义多步 AI 处理流程。',
  category: 'ai-reasoning',
  inputs: [
    { id: 'in-text', name: '输入', type: 'text', required: false, cardinality: 'many', description: '流程输入' },
    { id: 'in-image', name: '图片', type: 'image', required: false, cardinality: 'one', description: '图片输入' }
  ],
  outputs: [
    { id: 'out-text', name: '输出', type: 'text', required: false, cardinality: 'one', description: '流程输出文本' },
    { id: 'out-image', name: '图片', type: 'image', required: false, cardinality: 'one', description: '流程输出图片' }
  ],
  configSchema: {
    steps: { type: 'array', required: true, description: '处理步骤', items: { type: 'object' } }
  },
  commands: { execute: 'ai.process.run' },
  runtime: { headless: true, preview: false, batch: true, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

// ── 控制流类 ───────────────────────────────────────────────

const iterateCapability = defineCapability({
  id: 'flow.iterate',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'iterate',
  title: '循环迭代',
  description: '对列表中的每一项执行循环体子流程。',
  category: 'control-flow',
  inputs: [
    { id: 'in-list', name: '列表', type: 'json', required: true, cardinality: 'one', description: '待迭代的列表' }
  ],
  outputs: [
    { id: 'out-items', name: '逐项输出', type: 'any', required: false, cardinality: 'many', description: '循环体内的逐项输出（连接循环体节点）' },
    { id: 'out-results', name: '汇总结果', type: 'json', required: false, cardinality: 'one', description: '所有迭代结果的汇总列表' }
  ],
  configSchema: {
    variableName: { type: 'string', required: false, defaultValue: 'item', description: '循环变量名' }
  },
  commands: { execute: 'flow.iterate.run' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

const directorCapability = defineCapability({
  id: 'ai.director',
  version: '1.0.0',
  contractVersion: 1,
  nodeType: 'director',
  title: '导演台',
  description: '编排多步骤创作流程的总控节点。',
  category: 'control-flow',
  inputs: [
    { id: 'in-text', name: '需求', type: 'text', required: true, cardinality: 'many', description: '创作需求描述' }
  ],
  outputs: [
    { id: 'out-plan', name: '执行计划', type: 'json', required: true, cardinality: 'one', description: '生成的执行计划' }
  ],
  configSchema: {
    providerId: { type: 'string', required: true, description: '供应商 ID' },
    modelId: { type: 'string', required: true, description: '模型 ID' }
  },
  commands: { execute: 'ai.director.orchestrate' },
  runtime: { headless: true, preview: false, batch: false, executionMode: 'auto' },
  expose: ALL_EXPOSED
})

// ── 导出全部定义 ──────────────────────────────────────────

export const capabilityDefinitions: Capability[] = [
  textCapability,
  imageCapability,
  videoCapability,
  audioCapability,
  jsonCapability,
  imageCropCapability,
  imageSplitCapability,
  imageGenCapability,
  imageEditCapability,
  videoFrameCapability,
  videoClipCapability,
  videoAudioCapability,
  vocalSeparateCapability,
  ttsCapability,
  chatCapability,
  speechCapability,
  processorCapability,
  codeCapability,
  structuredCapability,
  storyboardCapability,
  aiProcessCapability,
  iterateCapability,
  directorCapability
]

/** 确保全部能力已注册 */
export function ensureAllCapabilitiesRegistered(): void {
  // defineCapability 在导入时已执行，这里仅做完整性验证
  const { listCapabilities } = require('./registry')
  const registered = listCapabilities()
  if (registered.length !== capabilityDefinitions.length) {
    throw new Error(
      `[CapabilityRegistry] 注册数量不匹配: 期望 ${capabilityDefinitions.length}, 实际 ${registered.length}`
    )
  }
}
