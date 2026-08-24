// 工作流执行编排层：端口声明、真实输入和节点输出在这里一一对应。
// 节点卡片内的手动操作仍保留原有 UI；全局运行时统一从同一网关调用生成能力。
import type { Editor, TLShapeId } from 'tldraw'
import type {
  CanvasEdge,
  CanvasNode,
  ChatMessage,
  ExecStatus,
  ProviderConfig,
  VideoGenParams
} from '@shared/types'
import { deriveGraph } from '../canvas/graph'
import { markUndoPoint } from '../canvas/history'
import type { NodeCardShape } from '../canvas/NodeCardShape'
import { modelsByModality } from '../stores/gateway'
import { toast } from '../stores/toast'
import { runCodeTransform } from './codeRuntime'
import {
  buildOutputPackets,
  collectContractInputs,
  inputJson,
  inputMedia,
  inputText,
  inputValue,
  type ContractInputMap,
  type ContractOutputs
} from './contracts'
import { projectNodeOutputs, type NodeValue } from '../nodes/nodeValues'
import { useEngineStore } from './store'

interface CancelToken {
  cancelled: boolean
}

type ExecResult = { status: 'done' | 'skipped' | 'failed'; reason?: string }

interface ImageGenData {
  prompt: string
  modelKey: string
  size: string
}

interface VideoGenData {
  prompt: string
  modelKey: string
  params: VideoGenParams
  taskId: string
}

interface AudioData {
  mode: 'upload' | 'generate'
  modelKey: string
  text: string
  voice: string
  format: string
}

interface ScriptShot {
  id: string
  scene: string
  dialogue: string
  duration: string
  [key: string]: unknown
}

interface ScriptOutputField {
  path: string
  label: string
  type: string
  description?: string
}

interface ScriptData {
  source: string
  shots: ScriptShot[]
  modelKey?: string
  outputFields: ScriptOutputField[]
}

type VariableValueType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any'

interface ProcessorData {
  inputName: string
  outputName: string
  valueType: VariableValueType
  fallback: string
}

interface CodeConfig {
  source: string
  inputName: string
  inputType: VariableValueType
  outputName: string
  outputType: VariableValueType
}

interface StoryboardData {
  shots: ScriptShot[]
  imageModelKey?: string
}

const DEFAULT_SCRIPT_FIELDS: ScriptOutputField[] = [
  { path: 'scene', label: '画面描述', type: 'string' },
  { path: 'dialogue', label: '台词', type: 'string' },
  { path: 'sound', label: '音效', type: 'string' },
  { path: 'duration', label: '时长', type: 'string' }
]

function scriptSystemPrompt(fields: ScriptOutputField[]): string {
  const rows = fields
    .map((field) => `- ${field.path} (${field.type})：${field.description || field.label}`)
    .join('\n')
  return `你是一位专业的影视分镜导演。请将剧本文本拆解为分镜 JSON 数组。
只输出 JSON 数组，不要添加 Markdown。每个元素必须严格使用以下字段；点号表示嵌套层级：
${rows}`
}

function parseJsonObj(text: string): Record<string, unknown> | null {
  if (!text) return null
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function parseImageGen(text: string): ImageGenData {
  const value = parseJsonObj(text)
  if (value && typeof value.prompt === 'string') {
    return {
      prompt: value.prompt,
      modelKey: typeof value.modelKey === 'string' ? value.modelKey : '',
      size: typeof value.size === 'string' ? value.size : 'auto'
    }
  }
  return { prompt: text, modelKey: '', size: 'auto' }
}

function parseVideoGen(text: string): VideoGenData {
  const value = parseJsonObj(text)
  if (value && typeof value.prompt === 'string') {
    const rawParams = parseJsonObj(JSON.stringify(value.params ?? {})) ?? {}
    return {
      prompt: value.prompt,
      modelKey: typeof value.modelKey === 'string' ? value.modelKey : '',
      params: {
        ratio: typeof rawParams.ratio === 'string' ? rawParams.ratio : undefined,
        duration: typeof rawParams.duration === 'number' ? rawParams.duration : undefined,
        resolution: typeof rawParams.resolution === 'string' ? rawParams.resolution : undefined
      },
      taskId: typeof value.taskId === 'string' ? value.taskId : ''
    }
  }
  return { prompt: text, modelKey: '', params: {}, taskId: '' }
}

function parseAudio(text: string): AudioData {
  const value = parseJsonObj(text)
  if (value && (value.mode === 'upload' || value.mode === 'generate')) {
    return {
      mode: value.mode,
      modelKey: typeof value.modelKey === 'string' ? value.modelKey : '',
      text: typeof value.text === 'string' ? value.text : '',
      voice: typeof value.voice === 'string' ? value.voice : 'alloy',
      format: typeof value.format === 'string' ? value.format : 'mp3'
    }
  }
  return { mode: 'upload', modelKey: '', text: '', voice: 'alloy', format: 'mp3' }
}

function parseProcessor(text: string): ProcessorData {
  const value = parseJsonObj(text)
  return {
    inputName: typeof value?.inputName === 'string' ? value.inputName : 'input',
    outputName: typeof value?.outputName === 'string' ? value.outputName : 'output',
    valueType: (typeof value?.valueType === 'string'
      ? value.valueType
      : 'any') as VariableValueType,
    fallback: typeof value?.fallback === 'string' ? value.fallback : ''
  }
}

function parseCodeConfig(text: string): CodeConfig {
  const value = parseJsonObj(text)
  if (value && typeof value.source === 'string') {
    return {
      source: value.source,
      inputName: typeof value.inputName === 'string' ? value.inputName : 'input',
      inputType: (typeof value.inputType === 'string'
        ? value.inputType
        : 'any') as VariableValueType,
      outputName: typeof value.outputName === 'string' ? value.outputName : 'output',
      outputType: (typeof value.outputType === 'string'
        ? value.outputType
        : 'any') as VariableValueType
    }
  }
  return {
    source: text,
    inputName: 'input',
    inputType: 'any',
    outputName: 'output',
    outputType: 'any'
  }
}

function parseChat(text: string): { system: string; modelKey: string; messages: ChatMessage[] } {
  const value = parseJsonObj(text)
  if (value && Array.isArray(value.messages)) {
    const messages = value.messages
      .map((message) => message as { role?: unknown; content?: unknown })
      .filter(
        (message): message is { role: 'user' | 'assistant'; content: string } =>
          (message.role === 'user' || message.role === 'assistant') &&
          typeof message.content === 'string'
      )
    return {
      system: typeof value.system === 'string' ? value.system : '',
      modelKey: typeof value.modelKey === 'string' ? value.modelKey : '',
      messages
    }
  }
  return { system: '', modelKey: '', messages: [] }
}

function normalizeShot(value: unknown): ScriptShot {
  const shot = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return {
    ...shot,
    id: typeof shot.id === 'string' ? shot.id : Math.random().toString(36).slice(2, 9),
    scene: typeof shot.scene === 'string' ? shot.scene : '',
    dialogue: typeof shot.dialogue === 'string' ? shot.dialogue : '',
    duration: typeof shot.duration === 'string' ? shot.duration : ''
  }
}

function parseScript(text: string): ScriptData {
  const value = parseJsonObj(text)
  if (value && Array.isArray(value.shots)) {
    const outputFields = Array.isArray(value.outputFields)
      ? value.outputFields
          .map((field) => field as Partial<ScriptOutputField>)
          .filter(
            (field): field is ScriptOutputField =>
              typeof field.path === 'string' &&
              typeof field.label === 'string' &&
              typeof field.type === 'string'
          )
      : DEFAULT_SCRIPT_FIELDS
    return {
      source: typeof value.source === 'string' ? value.source : '',
      shots: value.shots.map(normalizeShot),
      modelKey: typeof value.modelKey === 'string' ? value.modelKey : undefined,
      outputFields: outputFields.length > 0 ? outputFields : DEFAULT_SCRIPT_FIELDS
    }
  }
  return { source: text, shots: [], outputFields: DEFAULT_SCRIPT_FIELDS }
}

function parseStoryboard(value: unknown): StoryboardData | null {
  const raw = Array.isArray(value)
    ? { shots: value }
    : typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : null
  if (!raw || !Array.isArray(raw.shots)) return null
  return {
    shots: raw.shots.map(normalizeShot),
    imageModelKey: typeof raw.imageModelKey === 'string' ? raw.imageModelKey : undefined
  }
}

function extractShots(raw: string): ScriptShot[] | null {
  const trimmed = raw.trim()
  const candidates = [trimmed]
  const start = trimmed.indexOf('[')
  const end = trimmed.lastIndexOf(']')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate)
      if (Array.isArray(value)) return value.map(normalizeShot)
    } catch {
      // 尝试下一个候选 JSON 块。
    }
  }
  return null
}

function topoSort(graph: { nodes: CanvasNode[]; edges: CanvasEdge[] }): CanvasNode[] | null {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]))
  const adjacency = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (!byId.has(edge.from.nodeId) || !byId.has(edge.to.nodeId)) continue
    indegree.set(edge.to.nodeId, (indegree.get(edge.to.nodeId) ?? 0) + 1)
    const next = adjacency.get(edge.from.nodeId) ?? []
    next.push(edge.to.nodeId)
    adjacency.set(edge.from.nodeId, next)
  }
  const queue = graph.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  const ordered: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    ordered.push(id)
    for (const next of adjacency.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 1) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  return ordered.length === graph.nodes.length ? ordered.map((id) => byId.get(id)!) : null
}

function mergedPrompt(nodeValue: string, upstreamValue: string): string {
  if (!upstreamValue.trim()) return nodeValue
  if (!nodeValue.trim()) return upstreamValue
  const prefix = `${upstreamValue}\n\n---\n\n`
  // 节点运行会持久化文本/脚本内容；相同上游再次运行时不重复拼接。
  return nodeValue.startsWith(prefix) ? nodeValue : `${prefix}${nodeValue}`
}

function setExec(editor: Editor, id: TLShapeId, status: ExecStatus): void {
  editor.updateShape({ id, type: 'node-card', props: { exec: status } })
}

function updateShapeProps(
  editor: Editor,
  id: TLShapeId,
  props: Partial<NodeCardShape['props']>
): void {
  editor.updateShape({ id, type: 'node-card', props })
}

function updateNodeResult(editor: Editor, shape: NodeCardShape, result: string): void {
  editor.updateShape({
    id: shape.id,
    type: 'node-card',
    meta: { ...shape.meta, nodeResult: result }
  })
}

function findTextModel(
  providers: ProviderConfig[],
  modelKey: string,
  allowDefault = false
): ReturnType<typeof modelsByModality>[number] | undefined {
  const options = modelsByModality(providers, 'text')
  return (
    options.find((option) => option.key === modelKey) ?? (allowDefault ? options[0] : undefined)
  )
}

function waitForChat(
  input: { providerId: string; modelId: string; system?: string; messages: ChatMessage[] },
  token: CancelToken
): Promise<string> {
  return new Promise((resolve, reject) => {
    let taskId = ''
    let text = ''
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      off()
      window.clearInterval(cancelTimer)
    }
    const off = window.api.gateway.onEvent((event) => {
      if (!taskId || event.taskId !== taskId) return
      if (event.kind === 'chat-delta') text += event.text
      if (event.kind === 'chat-done') {
        finish()
        resolve(text)
      }
      if (event.kind === 'chat-error') {
        finish()
        reject(new Error(event.error))
      }
    })
    const cancelTimer = window.setInterval(() => {
      if (!token.cancelled) return
      if (taskId) void window.api.gateway.chatCancel(taskId)
      finish()
      reject(new Error('已取消'))
    }, 400)
    void window.api.gateway
      .chatStart(input)
      .then((result) => {
        if (result.ok) taskId = result.data.taskId
        else {
          finish()
          reject(new Error(result.error.message))
        }
      })
      .catch((error) => {
        finish()
        reject(error instanceof Error ? error : new Error(String(error)))
      })
  })
}

function waitForVideo(
  taskId: string,
  token: CancelToken
): Promise<{ mediaId: string; mediaPath: string; name: string; mime: string }> {
  return new Promise((resolve, reject) => {
    let stopped = false
    const timers: { timeout?: number } = {}
    const stop = (): void => {
      stopped = true
      window.clearInterval(timer)
      if (timers.timeout !== undefined) window.clearTimeout(timers.timeout)
    }
    const timer = window.setInterval(async () => {
      if (token.cancelled) {
        stop()
        void window.api.gateway.videoCancel(taskId)
        reject(new Error('已取消'))
        return
      }
      const result = await window.api.gateway.videoTask(taskId)
      if (!result.ok || !result.data) return
      if (result.data.status === 'success' && result.data.mediaPath) {
        stop()
        resolve({
          mediaId: result.data.mediaId ?? '',
          mediaPath: result.data.mediaPath,
          name: 'video',
          mime: 'video/mp4'
        })
      } else if (result.data.status === 'failed' || result.data.status === 'cancelled') {
        stop()
        reject(new Error(result.data.error ?? '视频生成失败'))
      }
    }, 3_000)
    timers.timeout = window.setTimeout(() => {
      if (!stopped) {
        stop()
        reject(new Error('视频生成超时（10 分钟）'))
      }
    }, 600_000)
  })
}

async function executeNode(
  editor: Editor,
  shape: NodeCardShape,
  inputs: ContractInputMap,
  projectId: string,
  providers: ProviderConfig[],
  token: CancelToken
): Promise<ExecResult> {
  const id = shape.id
  const p = shape.props
  switch (p.nodeType) {
    case 'text': {
      const text = mergedPrompt(p.text, inputText(inputs, 'in-text'))
      if (!text.trim()) return { status: 'skipped', reason: '无文本输入' }
      if (text !== p.text) updateShapeProps(editor, id, { text })
      return { status: 'done' }
    }
    case 'image': {
      // 图片资产节点只输出已导入的媒体，绝不在执行时隐式触发模型调用。
      return p.mediaPath ? { status: 'done' } : { status: 'skipped', reason: '未导入图片资产' }
    }
    case 'image-gen': {
      // 已生成的图片是稳定的数据源；不应在每次整图运行时重复生成。
      if (p.mediaPath) return { status: 'done' }
      const data = parseImageGen(p.text)
      const option = modelsByModality(providers, 'image').find((item) => item.key === data.modelKey)
      if (!option) return { status: 'skipped', reason: '未选择可用图片模型' }
      const prompt = mergedPrompt(data.prompt, inputText(inputs, 'in-text'))
      const referenceImage = inputMedia(inputs, 'in-image', 'image')[0]
      if (!prompt.trim()) return { status: 'skipped', reason: '无提示词' }
      const result = await window.api.gateway.imageGenerate({
        projectId,
        providerId: option.provider.id,
        modelId: option.model.id,
        prompt,
        size: data.size,
        ...(referenceImage ? { referenceMediaId: referenceImage.mediaId } : {})
      })
      if (token.cancelled) return { status: 'skipped', reason: '已取消' }
      if (!result.ok) return { status: 'failed', reason: result.error.message }
      updateShapeProps(editor, id, {
        mediaId: result.data.id,
        mediaPath: result.data.path,
        mediaMime: result.data.mime,
        title: result.data.name || result.data.id
      })
      return { status: 'done' }
    }
    case 'video': {
      // 与图片节点一致，已有成片优先作为下游合成/引用的视频输出。
      if (p.mediaPath) return { status: 'done' }
      const data = parseVideoGen(p.text)
      const option = modelsByModality(providers, 'video').find((item) => item.key === data.modelKey)
      if (!option) return { status: 'skipped', reason: '未选择可用视频模型' }
      const prompt = mergedPrompt(data.prompt, inputText(inputs, 'in-text'))
      const firstFrame = inputMedia(inputs, 'in-image', 'image')[0]
      if (!prompt.trim()) return { status: 'skipped', reason: '无提示词' }
      const submitted = await window.api.gateway.videoSubmit({
        projectId,
        nodeId: id,
        providerId: option.provider.id,
        modelId: option.model.id,
        prompt,
        params: data.params,
        ...(firstFrame ? { firstFrameMediaId: firstFrame.mediaId } : {})
      })
      if (token.cancelled) return { status: 'skipped', reason: '已取消' }
      if (!submitted.ok) return { status: 'failed', reason: submitted.error.message }
      const result = await waitForVideo(submitted.data.taskId, token)
      if (token.cancelled) return { status: 'skipped', reason: '已取消' }
      updateShapeProps(editor, id, {
        mediaId: result.mediaId,
        mediaPath: result.mediaPath,
        mediaMime: result.mime,
        title: result.name
      })
      return { status: 'done' }
    }
    case 'audio': {
      const audioInput = inputMedia(inputs, 'in-audio', 'audio')[0]
      if (audioInput) {
        const source = audioInput
        updateShapeProps(editor, id, {
          mediaId: source.mediaId,
          mediaPath: source.mediaPath,
          mediaMime: source.mime
        })
        return { status: 'done' }
      }
      if (p.mediaPath) return { status: 'done' }
      const data = parseAudio(p.text)
      if (data.mode !== 'generate')
        return { status: 'skipped', reason: '请上传音频或切换到语音合成' }
      const option = modelsByModality(providers, 'audio').find((item) => item.key === data.modelKey)
      if (!option) return { status: 'skipped', reason: '未选择可用音频模型' }
      const text = mergedPrompt(data.text, inputText(inputs, 'in-text'))
      if (!text.trim()) return { status: 'skipped', reason: '无朗读文本' }
      const result = await window.api.gateway.audioGenerate({
        projectId,
        providerId: option.provider.id,
        modelId: option.model.id,
        text,
        voice: data.voice,
        format: data.format
      })
      if (!result.ok) return { status: 'failed', reason: result.error.message }
      updateShapeProps(editor, id, {
        mediaId: result.data.id,
        mediaPath: result.data.path,
        mediaMime: result.data.mime,
        title: result.data.name || result.data.id
      })
      return { status: 'done' }
    }
    case 'chat': {
      const data = parseChat(p.text)
      const option = findTextModel(providers, data.modelKey)
      if (!option) return { status: 'skipped', reason: '未选择可用对话模型' }
      const textInput = inputText(inputs, 'in-text')
      if (!textInput.trim() && data.messages.length > 0) return { status: 'done' }
      const messages: ChatMessage[] = [
        ...data.messages,
        { role: 'user', content: textInput || '（开始对话）' }
      ]
      const reply = await waitForChat(
        { providerId: option.provider.id, modelId: option.model.id, system: data.system, messages },
        token
      )
      if (token.cancelled) return { status: 'skipped', reason: '已取消' }
      updateShapeProps(editor, id, {
        text: JSON.stringify({
          ...data,
          modelKey: option.key,
          messages: [...messages, { role: 'assistant', content: reply }]
        })
      })
      return { status: 'done' }
    }
    case 'script': {
      const data = parseScript(p.text)
      const source = mergedPrompt(data.source, inputText(inputs, 'in-text'))
      if (!source.trim()) return { status: 'skipped', reason: '无剧本文本' }
      if (data.shots.length > 0) {
        if (source !== data.source)
          updateShapeProps(editor, id, { text: JSON.stringify({ ...data, source }) })
        return { status: 'done' }
      }
      const option = findTextModel(providers, data.modelKey ?? '', true)
      if (!option) return { status: 'skipped', reason: 'AI 拆解需要可用对话模型' }
      const reply = await waitForChat(
        {
          providerId: option.provider.id,
          modelId: option.model.id,
          system: scriptSystemPrompt(data.outputFields),
          messages: [{ role: 'user', content: source }]
        },
        token
      )
      const shots = extractShots(reply)
      if (!shots?.length) return { status: 'failed', reason: '模型未返回可解析的分镜 JSON' }
      updateShapeProps(editor, id, {
        text: JSON.stringify({
          source,
          shots,
          modelKey: option.key,
          outputFields: data.outputFields
        })
      })
      return { status: 'done' }
    }
    case 'json': {
      const jsonInputs = inputJson(inputs, 'in-json')
      const textInput = inputText(inputs, 'in-text')
      const candidate =
        jsonInputs.length > 0
          ? jsonInputs.length === 1
            ? jsonInputs[0]
            : jsonInputs
          : textInput.trim() || p.text
      try {
        const value = typeof candidate === 'string' ? JSON.parse(candidate) : candidate
        updateShapeProps(editor, id, { text: JSON.stringify(value, null, 2) })
        return { status: 'done' }
      } catch {
        return { status: 'failed', reason: 'JSON 输入格式无效' }
      }
    }
    case 'processor': {
      const data = parseProcessor(p.text)
      let output: NodeValue | null = inputValue(inputs, 'in-value')
      if (!output && data.fallback.trim()) {
        if (data.valueType === 'string') {
          output = { kind: 'text', text: data.fallback }
        } else {
          try {
            output = { kind: 'json', data: JSON.parse(data.fallback) }
          } catch {
            output = { kind: 'text', text: data.fallback }
          }
        }
      }
      if (!output) return { status: 'skipped', reason: '处理节点没有输入变量或固定值' }
      updateNodeResult(editor, shape, JSON.stringify({ ...output, variableName: data.outputName }))
      return { status: 'done' }
    }
    case 'code': {
      const data = parseCodeConfig(p.text)
      const textInputs = inputText(inputs, 'in-text')
      const jsonInputs = inputJson(inputs, 'in-json')
      const primaryValue =
        data.inputType === 'string'
          ? textInputs
          : data.inputType === 'array'
            ? jsonInputs
            : (jsonInputs[0] ?? textInputs)
      const output = await runCodeTransform(data.source, {
        text: textInputs,
        json: jsonInputs,
        images: [],
        videos: [],
        audios: [],
        [data.inputName]: primaryValue
      })
      updateNodeResult(
        editor,
        shape,
        output.kind === 'text'
          ? JSON.stringify({ kind: 'text', text: output.text, variableName: data.outputName })
          : JSON.stringify({ kind: 'json', data: output.data, variableName: data.outputName })
      )
      return { status: 'done' }
    }
    case 'storyboard': {
      const fromJson = inputJson(inputs, 'in-json')[0]
      const fromText = inputText(inputs, 'in-text').trim()
      let data = parseStoryboard(fromJson)
      if (!data && fromText) {
        try {
          data = parseStoryboard(JSON.parse(fromText))
        } catch {
          return { status: 'failed', reason: '分镜板需要分镜 JSON 输入' }
        }
      }
      if (!data) data = parseStoryboard(parseJsonObj(p.text))
      if (!data) return { status: 'skipped', reason: '无分镜数据' }
      updateShapeProps(editor, id, { text: JSON.stringify(data) })
      return { status: 'done' }
    }
    default:
      return { status: 'failed', reason: `未实现节点类型：${p.nodeType}` }
  }
}

export async function runWorkflow(
  editor: Editor,
  projectId: string,
  providers: ProviderConfig[]
): Promise<void> {
  const store = useEngineStore.getState()
  if (store.phase === 'running') return
  const graph = deriveGraph(editor)
  if (graph.nodes.length === 0) return toast('画布上没有节点')
  const order = topoSort(graph)
  if (!order) return toast('工作流存在循环连线，无法执行')

  const token: CancelToken = { cancelled: false }
  useEngineStore.getState().setStop(() => {
    token.cancelled = true
    useEngineStore.getState().setStopping()
  })
  store.beginRun(order.length)
  const runId = crypto.randomUUID()
  const outputs = new Map<string, ContractOutputs>()
  for (const node of order) {
    if (token.cancelled) break
    const shapeId = node.id as TLShapeId
    const shape = editor.getShape<NodeCardShape>(shapeId)
    if (!shape) {
      store.nodeDone()
      continue
    }
    store.setCurrent(node.title || node.type)
    setExec(editor, shapeId, 'running')
    try {
      const collected = collectContractInputs(node, graph.edges, outputs)
      if (collected.errors.length > 0) {
        throw new Error(`输入契约校验失败：${collected.errors.join('；')}`)
      }
      const result = await executeNode(editor, shape, collected.value, projectId, providers, token)
      const latest = editor.getShape<NodeCardShape>(shapeId)
      if (token.cancelled) setExec(editor, shapeId, 'cancelled')
      else if (result.status === 'done') {
        if (!latest) throw new Error('节点执行后已不存在')
        const projected = buildOutputPackets(node, projectNodeOutputs(latest), runId)
        if (projected.errors.length > 0) {
          setExec(editor, shapeId, 'failed')
          store.addError(
            node.title || node.type,
            `输出契约校验失败：${projected.errors.join('；')}`
          )
        } else {
          outputs.set(node.id, projected.value)
          setExec(editor, shapeId, 'success')
        }
      } else if (result.status === 'failed') {
        setExec(editor, shapeId, 'failed')
        store.addError(node.title || node.type, result.reason ?? '执行失败')
      } else setExec(editor, shapeId, 'idle')
    } catch (error) {
      if (token.cancelled) setExec(editor, shapeId, 'cancelled')
      else {
        const reason = error instanceof Error ? error.message : String(error)
        setExec(editor, shapeId, 'failed')
        store.addError(node.title || node.type, reason)
      }
    }
    store.nodeDone()
  }

  const after = useEngineStore.getState()
  after.endRun()
  after.setStop(null)
  if (token.cancelled) toast('工作流已停止')
  else if (after.errors.length > 0) toast(`工作流完成，${after.errors.length} 个节点失败`)
  else toast('工作流执行完成')
  markUndoPoint(editor, 'workflow-run')
}
