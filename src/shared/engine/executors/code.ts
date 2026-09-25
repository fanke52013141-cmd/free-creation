// 代码节点执行器：把命名输入交给受限执行环境，按返回值类型投影到命名输出。
// 支持 Coze 风格 async function main(args) 写法和旧版纯代码片段（向后兼容）。
// 支持自定义参数端口：用户可在 UI 表格中声明额外输入参数，每个参数生成一个独立输入端口。
//
// P3 变化：代码执行通过 ctx.runCode 注入，不再直接导入 renderer 的 codeRuntime 模块。
// renderer 运行器注入 Web Worker 实现；headless 运行器可注入 Node.js vm 实现。
import type { MediaKind, PortType } from '@shared/types'
import { inputJson, inputPackets, inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { readNodeConfig } from '../node-config'
import { parseJsonObj, type VariableValueType } from '../helpers'
import type { NodeValue } from '../values'
import { validateNodeSchema } from '../../node-schemas'
import type { DirectorCamera } from '../../director-data'

/** 自定义参数声明：用户在 UI 表格中添加的额外输入端口。 */
export interface CodeParam {
  name: string
  type: CodeValueType
  /** one 收一个值；many 把来自多个上游的数据按连线顺序组成数组。 */
  cardinality?: 'one' | 'many'
  /** 配置后名称可以调整而不改变已保存连线所引用的端口 ID。 */
  portId?: string
}

export type CodeValueType = VariableValueType | MediaKind | 'camera'

export interface CodeOutputField {
  name: string
  type: CodeValueType
  /** 可选的稳定端口 ID；旧配置仍由 name 推导。 */
  portId?: string
}

export interface CodeConfig {
  source: string
  inputName: string
  inputType: VariableValueType
  outputName: string
  outputType: CodeValueType
  params: CodeParam[]
  /** fields 模式按返回对象的同名字段映射多个输出端口；single 是历史行为。 */
  outputMode: 'single' | 'fields'
  outputs: CodeOutputField[]
}

export const CODE_VALUE_TYPES: Array<{ value: CodeValueType; label: string }> = [
  { value: 'any', label: '任意' },
  { value: 'string', label: '文本' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '布尔' },
  { value: 'object', label: '对象' },
  { value: 'array', label: '数组' },
  { value: 'camera', label: '机位参数' },
  { value: 'image', label: '图片引用' },
  { value: 'video', label: '视频引用' },
  { value: 'audio', label: '音频引用' },
  { value: 'file', label: '文件引用' }
]

const ALLOWED_VAR_TYPES = CODE_VALUE_TYPES.map((item) => item.value)
const ALLOWED_INPUT_TYPES: VariableValueType[] = [
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'any'
]
const BUILTIN_ARGUMENT_NAMES = new Set([
  'text',
  'json',
  'images',
  'videos',
  'audios',
  'files',
  'params'
])

/** 把参数名转换为合法的 kebab-case 端口 ID 后缀。 */
export function sanitizePortId(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed'
  )
}

/** 把 UI 变量类型映射到端口类型。 */
export function mapVarTypeToPortType(type: CodeValueType): PortType {
  switch (type) {
    case 'string':
      return 'text'
    case 'number':
    case 'boolean':
    case 'object':
    case 'array':
      return 'json'
    case 'camera':
      return 'camera'
    case 'image':
    case 'video':
    case 'audio':
    case 'file':
      return type
    default:
      return 'any'
  }
}

function isCodeValueType(value: unknown): value is CodeValueType {
  return typeof value === 'string' && ALLOWED_VAR_TYPES.includes(value as CodeValueType)
}

function isVariableValueType(value: unknown): value is VariableValueType {
  return typeof value === 'string' && ALLOWED_INPUT_TYPES.includes(value as VariableValueType)
}

function paramPort(param: CodeParam): string {
  return param.portId || paramPortId(param.name)
}

export function codeParamPortId(param: CodeParam): string {
  return paramPort(param)
}

export function outputFieldPortId(output: CodeOutputField): string {
  return output.portId || outputPortId(output.name)
}

function normalizeParam(value: unknown): CodeParam | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const name = typeof item.name === 'string' ? item.name.trim() : ''
  if (!name) return null
  return {
    name,
    type: isCodeValueType(item.type) ? item.type : 'any',
    cardinality: item.cardinality === 'many' ? 'many' : 'one',
    ...(typeof item.portId === 'string' ? { portId: item.portId } : {})
  }
}

function normalizeOutput(value: unknown): CodeOutputField | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const name = typeof item.name === 'string' ? item.name.trim() : ''
  if (!name) return null
  return {
    name,
    type: isCodeValueType(item.type) ? item.type : 'any',
    ...(typeof item.portId === 'string' ? { portId: item.portId } : {})
  }
}

/** 根据参数名生成端口 ID（供 resolvePorts 与执行器共用）。 */
export function paramPortId(name: string): string {
  return `in-param-${sanitizePortId(name)}`
}

/** 根据代码输出变量名生成稳定输出端口 ID。 */
export function outputPortId(name: string): string {
  return `out-${sanitizePortId(name)}`
}

export function parseCodeConfigs(text: string): CodeConfig {
  const value = parseJsonObj(text)
  if (value && typeof value.source === 'string') {
    const rawParams = Array.isArray(value.params) ? value.params : []
    const seenInputIds = new Set<string>()
    const params = rawParams
      .map(normalizeParam)
      .filter((p): p is CodeParam => p !== null)
      .filter((p) => {
        const portId = paramPort(p)
        if (seenInputIds.has(portId)) return false
        seenInputIds.add(portId)
        return true
      })
    const outputName = typeof value.outputName === 'string' ? value.outputName : 'output'
    const outputType = isCodeValueType(value.outputType) ? value.outputType : 'any'
    const rawOutputs = Array.isArray(value.outputs) ? value.outputs : null
    const outputs = rawOutputs
      ? rawOutputs.map(normalizeOutput).filter((p): p is CodeOutputField => p !== null)
      : [{ name: outputName, type: outputType }]
    return {
      source: value.source,
      inputName: typeof value.inputName === 'string' ? value.inputName : 'input',
      inputType: isVariableValueType(value.inputType) ? value.inputType : 'any',
      outputName,
      outputType,
      params,
      outputMode:
        value.outputMode === 'fields' || (value.outputMode !== 'single' && rawOutputs !== null)
          ? 'fields'
          : 'single',
      outputs
    }
  }
  return {
    source: text,
    inputName: 'input',
    inputType: 'any',
    outputName: 'output',
    outputType: 'any',
    params: [],
    outputMode: 'single',
    outputs: [{ name: 'output', type: 'any' }]
  }
}

/** 动态端口冲突不能被静默去重，否则画布、连线和执行器会看到不同的契约。 */
export function codePortConfigErrors(text: string): string[] {
  const value = parseJsonObj(text)
  if (!value) return []
  const errors: string[] = []
  const validateNames = (
    rawFields: unknown,
    direction: '输入参数' | '输出字段',
    idFor: (field: Record<string, unknown>, name: string) => string,
    idPattern: RegExp
  ): void => {
    if (rawFields === undefined) return
    if (!Array.isArray(rawFields)) {
      errors.push(`${direction}必须是数组`)
      return
    }
    const seenIds = new Set<string>()
    const seenNames = new Set<string>()
    rawFields.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object') {
        errors.push(`${direction} ${index + 1} 必须是对象`)
        return
      }
      const field = raw as Record<string, unknown>
      const name = typeof field.name === 'string' ? field.name.trim() : ''
      if (!name) {
        errors.push(`${direction} ${index + 1} 缺少名称`)
        return
      }
      if (seenNames.has(name)) errors.push(`${direction}名称重复：${name}`)
      seenNames.add(name)
      const portId = idFor(field, name)
      if (!idPattern.test(portId)) errors.push(`${direction}端口 ID 无效：${portId}`)
      if (seenIds.has(portId)) errors.push(`${direction}端口重复：${portId}`)
      seenIds.add(portId)
    })
  }
  validateNames(
    value.params,
    '输入参数',
    (field, name) => (typeof field.portId === 'string' ? field.portId : paramPortId(name)),
    /^in-param-[a-z0-9]+(?:-[a-z0-9]+)*$/
  )
  const inputName = value.inputName === undefined ? 'input' : value.inputName
  if (typeof inputName !== 'string' || !inputName.trim()) {
    errors.push('主输入变量名必须是非空文本')
  } else if (BUILTIN_ARGUMENT_NAMES.has(inputName.trim())) {
    errors.push(`主输入变量名不能覆盖内置代码变量：${inputName.trim()}`)
  }
  const reserved = new Set(BUILTIN_ARGUMENT_NAMES)
  if (typeof inputName === 'string') reserved.add(inputName.trim())
  if (
    value.outputMode !== undefined &&
    value.outputMode !== 'single' &&
    value.outputMode !== 'fields'
  ) {
    errors.push('输出模式必须是 single 或 fields')
  }
  if (Array.isArray(value.params)) {
    for (const raw of value.params) {
      if (!raw || typeof raw !== 'object') continue
      const param = raw as Record<string, unknown>
      if (typeof param.name === 'string' && reserved.has(param.name.trim())) {
        errors.push(`输入参数名称与内置代码变量冲突：${param.name.trim()}`)
      }
      if (param.type !== undefined && !isCodeValueType(param.type)) {
        errors.push(`输入参数 ${String(param.name ?? '')} 的类型无效`)
      }
      if (
        param.cardinality !== undefined &&
        param.cardinality !== 'one' &&
        param.cardinality !== 'many'
      ) {
        errors.push(`输入参数 ${String(param.name ?? '')} 的基数必须是 one 或 many`)
      }
    }
  }
  if (Array.isArray(value.outputs)) {
    for (const raw of value.outputs) {
      if (!raw || typeof raw !== 'object') continue
      const output = raw as Record<string, unknown>
      if (output.type !== undefined && !isCodeValueType(output.type)) {
        errors.push(`输出字段 ${String(output.name ?? '')} 的类型无效`)
      }
    }
  } else if (value.outputs !== undefined) {
    errors.push('输出字段必须是数组')
  }
  if (value.outputMode !== 'fields') {
    if (
      value.outputName !== undefined &&
      (typeof value.outputName !== 'string' || !value.outputName.trim())
    ) {
      errors.push('输出变量名必须是非空文本')
    }
    if (value.outputType !== undefined && !isCodeValueType(value.outputType)) {
      errors.push(`输出变量 ${String(value.outputName ?? '')} 的类型无效`)
    }
  }
  if (value.outputMode === 'fields') {
    validateNames(
      value.outputs,
      '输出字段',
      (field, name) => (typeof field.portId === 'string' ? field.portId : outputPortId(name)),
      /^out-[a-z0-9]+(?:-[a-z0-9]+)*$/
    )
    if (!Array.isArray(value.outputs) || value.outputs.length === 0) {
      errors.push('多字段模式至少需要一个输出字段')
    }
  }
  return errors
}

/** 把契约层 NodeValue 还原为代码运行时可消费的普通值。 */
function toCodeArgument(value: NodeValue | null): unknown {
  if (!value) return undefined
  if (value.kind === 'text' || value.kind === 'markdown') return value.text
  if (value.kind === 'json') return value.data
  if (value.kind === 'camera') return value.data
  // 媒体在代码中传递的是可序列化引用，不暴露二进制内容。
  return {
    kind: value.kind,
    mediaId: value.mediaId,
    mediaPath: value.mediaPath,
    mime: value.mime,
    ...(value.name ? { name: value.name } : {})
  }
}

function readCodeParam(ctx: NodeExecutionContext, param: CodeParam): unknown {
  const packets = inputPackets(ctx.inputs, paramPort(param))
  const values = packets.map((packet) => toCodeArgument(packet.value))
  for (const value of values) {
    if (value === undefined || param.type === 'any') continue
    if (!matchesCodeValueType(value, param.type)) {
      throw new Error(`输入参数 ${param.name} 实际值不符合声明类型 ${param.type}`)
    }
  }
  return param.cardinality === 'many' ? values : values[0]
}

function matchesCodeValueType(value: unknown, type: CodeValueType): boolean {
  if (type === 'any') return true
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'object') return Boolean(value && typeof value === 'object' && !Array.isArray(value))
  if (type === 'array') return Array.isArray(value)
  if (type === 'camera') {
    return validateNodeSchema({ id: 'previs.camera', version: 1 }, value).ok
  }
  return Boolean(value && typeof value === 'object' && (value as { kind?: unknown }).kind === type)
}

function inputMediaRefs(ctx: NodeExecutionContext, kind: MediaKind): unknown[] {
  const values: unknown[] = []
  for (const packets of ctx.inputs.values()) {
    for (const packet of packets) {
      if (packet.value.kind === kind) values.push(toCodeArgument(packet.value))
    }
  }
  return values
}

function mediaRef<K extends MediaKind>(
  value: unknown,
  kind: K
): Extract<NodeValue, { kind: K }> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    record.kind !== kind ||
    typeof record.mediaId !== 'string' ||
    !record.mediaId ||
    typeof record.mediaPath !== 'string' ||
    typeof record.mime !== 'string'
  )
    return null
  return {
    kind,
    mediaId: record.mediaId,
    mediaPath: record.mediaPath,
    mime: record.mime,
    ...(typeof record.name === 'string' ? { name: record.name } : {})
  } as Extract<NodeValue, { kind: K }>
}

function outputNodeValue(
  value: unknown,
  type: CodeValueType,
  allowedMedia: ReadonlySet<string>
): NodeValue {
  if (type === 'string') {
    if (typeof value !== 'string') throw new Error('应返回字符串')
    return { kind: 'text', text: value }
  }
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('应返回有限数字')
    return { kind: 'json', data: value }
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error('应返回布尔值')
    return { kind: 'json', data: value }
  }
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('应返回对象')
    return { kind: 'json', data: value }
  }
  if (type === 'array') {
    if (!Array.isArray(value)) throw new Error('应返回数组')
    return { kind: 'json', data: value }
  }
  if (type === 'camera') {
    if (!validateNodeSchema({ id: 'previs.camera', version: 1 }, value).ok) {
      throw new Error('应返回符合 previs.camera@1 的机位参数对象')
    }
    return { kind: 'camera', data: value as Partial<DirectorCamera> }
  }
  if (type === 'image' || type === 'video' || type === 'audio' || type === 'file') {
    const ref = mediaRef(value, type)
    if (!ref || !allowedMedia.has(`${ref.kind}:${ref.mediaId}:${ref.mediaPath}:${ref.mime}`)) {
      throw new Error(`应返回本节点输入中的有效 ${type} 资产引用`)
    }
    return ref
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (
      record.kind === 'image' ||
      record.kind === 'video' ||
      record.kind === 'audio' ||
      record.kind === 'file'
    ) {
      const ref = mediaRef(value, record.kind)
      if (!ref || !allowedMedia.has(`${ref.kind}:${ref.mediaId}:${ref.mediaPath}:${ref.mime}`)) {
        throw new Error('媒体引用必须来自本节点已接收的输入资产')
      }
      return ref
    }
  }
  if (typeof value === 'string') return { kind: 'text', text: value }
  if (JSON.stringify(value) === undefined) throw new Error('输出必须是可序列化的文本或 JSON 数据')
  return { kind: 'json', data: value }
}

export const codeExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  const configText = readNodeConfig(ctx.shape)
  const portErrors = codePortConfigErrors(configText)
  if (portErrors.length > 0) {
    const reason = `代码节点端口配置无效：${portErrors.join('；')}`
    ctx.updateResult(JSON.stringify({ kind: 'error', message: reason }))
    return { status: 'failed', reason }
  }
  const data = parseCodeConfigs(configText)
  const textInputs = inputText(ctx.inputs, 'in-text')
  const jsonInputs = inputJson(ctx.inputs, 'in-json')

  // 收集自定义参数端口的输入值，映射到 args[param.name]
  const customArgs: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  try {
    for (const param of data.params) customArgs[param.name] = readCodeParam(ctx, param)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.updateResult(JSON.stringify({ kind: 'error', message: reason }))
    return { status: 'failed', reason }
  }

  const primaryValue =
    data.inputType === 'string'
      ? textInputs
      : data.inputType === 'array'
        ? jsonInputs
        : (jsonInputs[0] ?? textInputs)

  if (data.inputType !== 'any' && !matchesCodeValueType(primaryValue, data.inputType)) {
    const reason = `主输入实际值不符合声明类型 ${data.inputType}`
    ctx.updateResult(JSON.stringify({ kind: 'error', message: reason }))
    return { status: 'failed', reason }
  }

  if (!ctx.runCode) {
    return { status: 'failed', reason: '代码执行环境未注入（ctx.runCode 缺失）' }
  }

  try {
    const allowedMedia = new Set<string>()
    for (const packets of ctx.inputs.values()) {
      for (const packet of packets) {
        const value = packet.value
        if (
          value.kind === 'image' ||
          value.kind === 'video' ||
          value.kind === 'audio' ||
          value.kind === 'file'
        ) {
          allowedMedia.add(`${value.kind}:${value.mediaId}:${value.mediaPath}:${value.mime}`)
        }
      }
    }
    const output = await ctx.runCode(data.source, {
      text: textInputs,
      json: jsonInputs,
      images: inputMediaRefs(ctx, 'image'),
      videos: inputMediaRefs(ctx, 'video'),
      audios: inputMediaRefs(ctx, 'audio'),
      files: inputMediaRefs(ctx, 'file'),
      params: primaryValue,
      [data.inputName]: primaryValue,
      ...customArgs
    })
    if (data.outputMode === 'fields') {
      if (
        output.kind !== 'json' ||
        !output.data ||
        typeof output.data !== 'object' ||
        Array.isArray(output.data)
      ) {
        throw new Error('多字段模式的代码必须 return 一个对象，例如 { title: "...", count: 3 }')
      }
      const returned = output.data as Record<string, unknown>
      const values: Record<string, NodeValue> = {}
      for (const field of data.outputs) {
        if (!Object.prototype.hasOwnProperty.call(returned, field.name)) {
          throw new Error(`代码返回对象缺少输出字段：${field.name}`)
        }
        try {
          values[outputFieldPortId(field)] = outputNodeValue(
            returned[field.name],
            field.type,
            allowedMedia
          )
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          throw new Error(`输出字段 ${field.name}：${reason}`)
        }
      }
      ctx.updateResult(JSON.stringify({ kind: 'code-outputs', values }))
    } else {
      const rawValue = output.kind === 'text' ? output.text : output.data
      ctx.updateResult(JSON.stringify(outputNodeValue(rawValue, data.outputType, allowedMedia)))
    }
    return { status: 'done' }
  } catch (error) {
    // 把错误信息写入 meta，让 Body 可以显示给用户
    const message = error instanceof Error ? error.message : String(error)
    ctx.updateResult(JSON.stringify({ kind: 'error', message }))
    return { status: 'failed', reason: message }
  }
}
